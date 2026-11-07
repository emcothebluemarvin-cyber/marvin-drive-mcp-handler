import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { silentLogger } from '../../files/__tests__/fakes.js';
import { QUIET_MS } from '../coalesce.js';
import { Inbox, InboxWriter, ROTATE_AT_LINES } from '../inbox.js';
import { LeaseLostError, Poller } from '../poller.js';
import { isUnread } from '../read-state.js';
import { toKnown } from '../relevance.js';
import { emptyState } from '../types.js';
import { WatchStore } from '../watch-store.js';
import {
  AYSE,
  ME,
  MemoryFeed,
  MemorySnapshotter,
  fileEntry,
  makeEvent,
  memoryProvider,
  testClock,
  textSnap,
} from './fakes.js';

const EMAIL = 'me@example.com';
let tmp: string;
let store: WatchStore;
let feed: MemoryFeed;
let snap: MemorySnapshotter;
let inbox: Inbox;
let clock: ReturnType<typeof testClock>;

async function newPoller(stillLeader?: () => Promise<boolean>): Promise<Poller> {
  const writer = new InboxWriter(inbox);
  await writer.init();
  return new Poller({
    store,
    provider: memoryProvider(feed, snap),
    writer,
    inbox,
    now: clock.now,
    log: silentLogger(),
    ...(stillLeader ? { stillLeader } : {}),
  });
}

beforeEach(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), 'release-'));
  store = new WatchStore({ dir: tmp, logger: silentLogger() });
  feed = new MemoryFeed();
  snap = new MemorySnapshotter();
  inbox = new Inbox(path.join(tmp, 'inbox.jsonl'));
  clock = testClock('2026-11-07T11:00:00.000Z');
  const doc = feed.seed('D', { parents: ['ROOT'], modifiedTime: '2026-11-06T00:00:00.000Z' });
  await store.save(EMAIL, {
    ...emptyState(),
    entries: [fileEntry()],
    cursor: await feed.start(),
    known: { D: toKnown(doc, ['D']) },
    lastCommentCheck: { D: '2026-11-07T10:00:00.000Z' },
  });
  await store.saveSnapshot(EMAIL, 'D', { takenAt: 't', snapshot: textSnap('a\nb\n') });
});
afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

function edit(modifier = AYSE, text = 'a\nB\n'): void {
  feed.put('D', { modifiedTime: clock.now().toISOString(), modifier });
  snap.content.set('D', textSnap(text));
}

describe('Poller release', () => {
  it('emits one summary event after 120 s of quiet', async () => {
    const poller = await newPoller();
    edit();
    await poller.runOnce();
    clock.advance(QUIET_MS - 1);
    await poller.runOnce();
    expect(await inbox.readAll()).toEqual([]);
    clock.advance(1);
    await poller.runOnce();
    const [event] = await inbox.readAll();
    expect(event).toMatchObject({
      seq: 1,
      kind: 'edited',
      fileId: 'D',
      own: false,
      diff: '  a\n- b\n+ B',
      id: `${EMAIL}:D:2026-11-07T11:00:00.000Z`,
    });
    const state = await store.load(EMAIL);
    expect(state.pending).toEqual({});
    expect(state.lastCommentCheck.D).toBe(clock.now().toISOString());
    expect((await store.loadSnapshot(EMAIL, 'D'))?.snapshot).toEqual(textSnap('a\nB\n'));
  });

  it('stores own edits as own events, never unread', async () => {
    const poller = await newPoller();
    edit(ME);
    await poller.runOnce();
    clock.advance(QUIET_MS);
    await poller.runOnce();
    const [event] = await inbox.readAll();
    expect(event?.own).toBe(true);
    expect(isUnread(event ?? makeEvent(), { readSeq: 0, readIds: [], pushedSeq: 0 })).toBe(false);
  });

  it('drops an item without a visible change', async () => {
    const poller = await newPoller();
    edit(AYSE, 'a\nb\n');
    await poller.runOnce();
    clock.advance(QUIET_MS);
    await poller.runOnce();
    expect(await inbox.readAll()).toEqual([]);
    expect((await store.load(EMAIL)).pending).toEqual({});
  });

  it('does not duplicate an event after a crash between append and pending removal', async () => {
    const first = await newPoller();
    edit();
    await first.runOnce();
    const pending = (await store.load(EMAIL)).pending;
    clock.advance(QUIET_MS);
    await first.runOnce();
    const state = await store.load(EMAIL);
    await store.save(EMAIL, { ...state, pending }); // the removal "never happened"
    await store.saveSnapshot(EMAIL, 'D', { takenAt: 't', snapshot: textSnap('a\nb\n') });
    const restarted = await newPoller();
    await restarted.runOnce();
    expect(await inbox.readAll()).toHaveLength(1);
    expect((await store.load(EMAIL)).pending).toEqual({});
  });

  it('keeps the pending item when a new change arrived during enrichment', async () => {
    const poller = await newPoller();
    edit();
    await poller.runOnce();
    clock.advance(QUIET_MS);
    const original = snap.snapshot.bind(snap);
    snap.snapshot = async (fileId) => {
      const s = await store.load(EMAIL);
      const item = s.pending.D;
      if (item) await store.save(EMAIL, { ...s, pending: { D: { ...item, lastSeen: 'later' } } });
      return original(fileId);
    };
    await poller.runOnce();
    expect(await inbox.readAll()).toHaveLength(1);
    expect((await store.load(EMAIL)).pending.D?.lastSeen).toBe('later');
  });

  it('rotates the inbox after the pass', async () => {
    const lines = Array.from({ length: ROTATE_AT_LINES + 1 }, (_, i) =>
      JSON.stringify(makeEvent({ seq: i + 1, own: true })),
    );
    await writeFile(inbox.file, `${lines.join('\n')}\n`);
    const poller = await newPoller();
    await poller.runOnce();
    expect((await readFile(inbox.file, 'utf8')).trim().split('\n')).toHaveLength(500);
  });

  it('appends nothing and stops the pass once leadership is lost', async () => {
    let leader = true;
    const poller = await newPoller(async () => leader);
    edit();
    await poller.runOnce();
    clock.advance(QUIET_MS);
    leader = false;
    await expect(poller.runOnce()).rejects.toBeInstanceOf(LeaseLostError);
    expect(await inbox.readAll()).toEqual([]);
    expect((await store.load(EMAIL)).pending.D).toBeDefined();
  });
});
