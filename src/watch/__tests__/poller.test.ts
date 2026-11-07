import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DriveApiError, ReauthRequiredError } from '../../errors.js';
import { silentLogger } from '../../files/__tests__/fakes.js';
import { InvalidCursorError } from '../feed.js';
import { Inbox, InboxWriter } from '../inbox.js';
import { BASE_BACKOFF_MS, MAX_BACKOFF_MS, Poller } from '../poller.js';
import { toKnown } from '../relevance.js';
import { emptyState, type KnownFile, type WatchEntry } from '../types.js';
import { WatchStore } from '../watch-store.js';
import {
  MemoryFeed,
  MemorySnapshotter,
  fileEntry,
  folderEntry,
  memoryProvider,
  rawFile,
  testClock,
} from './fakes.js';

const EMAIL = 'me@example.com';
let tmp: string;
let store: WatchStore;
let feed: MemoryFeed;
let inbox: Inbox;
let clock: ReturnType<typeof testClock>;
let log: ReturnType<typeof silentLogger>;
let poller: Poller;

beforeEach(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), 'poller-'));
  store = new WatchStore({ dir: tmp, logger: silentLogger() });
  feed = new MemoryFeed();
  inbox = new Inbox(path.join(tmp, 'inbox.jsonl'));
  const writer = new InboxWriter(inbox);
  await writer.init();
  clock = testClock('2026-11-07T11:00:00.000Z');
  log = silentLogger();
  poller = new Poller({
    store,
    provider: memoryProvider(feed, new MemorySnapshotter()),
    writer,
    inbox,
    now: clock.now,
    log,
  });
});
afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

async function watching(
  entries: WatchEntry[],
  known: Record<string, KnownFile> = {},
): Promise<void> {
  await store.save(EMAIL, {
    ...emptyState(),
    entries,
    cursor: await feed.start(),
    known,
    lastPollAt: 'T0',
  });
}

describe('Poller.runOnce: polling', () => {
  it('stores pending changes, cursor and lastPollAt in one locked write', async () => {
    await watching([folderEntry()]);
    feed.put('M', { parents: ['F'], createdTime: '2026-11-07T10:30:00.000Z' });
    const save = vi.spyOn(store, 'save');
    await poller.runOnce();
    expect(save).toHaveBeenCalledTimes(1);
    const state = await store.load(EMAIL);
    expect(state.pending.M?.flags).toEqual(['added']);
    expect(state.pending.M?.firstSeen).toBe('2026-11-07T11:00:00.000Z');
    expect(state.cursor).toBe('1');
    expect(state.lastPollAt).toBe('2026-11-07T11:00:00.000Z');
  });

  it('advances the cursor past irrelevant changes', async () => {
    await watching([folderEntry()]);
    feed.put('X', { parents: ['OTHER'] });
    await poller.runOnce();
    const state = await store.load(EMAIL);
    expect(state.pending).toEqual({});
    expect(state.cursor).toBe('1');
  });

  it('resolves nested members through parentsOf', async () => {
    await watching([folderEntry()]);
    feed.seed('SUB', { kind: 'folder', parents: ['F'] });
    feed.put('M', { parents: ['SUB'], createdTime: '2026-11-07T10:30:00.000Z' });
    await poller.runOnce();
    expect((await store.load(EMAIL)).pending.M?.flags).toEqual(['added']);
  });

  it('discards the batch when the cursor changed during the poll', async () => {
    await watching([folderEntry()]);
    feed.put('M', { parents: ['F'], createdTime: '2026-11-07T10:30:00.000Z' });
    const poll = feed.poll.bind(feed);
    feed.poll = async (cursor) => {
      const res = await poll(cursor);
      const s = await store.load(EMAIL);
      await store.save(EMAIL, { ...s, cursor: 'other' }); // removed and re-added meanwhile
      return res;
    };
    await poller.runOnce();
    const state = await store.load(EMAIL);
    expect(state.pending).toEqual({});
    expect(state.cursor).toBe('other');
  });

  it('marks a removed watch entry inaccessible and records a pending removal', async () => {
    const D = fileEntry();
    await watching([D], { D: toKnown(rawFile(), ['D']) });
    feed.remove('D');
    await poller.runOnce();
    const state = await store.load(EMAIL);
    expect(state.entries[0]?.inaccessible).toBe(true);
    expect(state.pending.D?.flags).toEqual(['removed']);
  });
});

describe('Poller.runOnce: errors', () => {
  it('restarts an invalid cursor with one gap event', async () => {
    await watching([folderEntry()]);
    feed.put('A', {});
    feed.failures.push(new InvalidCursorError());
    await poller.runOnce();
    const events = await inbox.readAll();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      seq: 1,
      kind: 'gap',
      id: `${EMAIL}:gap:2026-11-07T11:00:00.000Z`,
      note: 'changes between T0 and 2026-11-07T11:00:00.000Z may be missing',
      own: false,
      untrusted: false,
    });
    expect((await store.load(EMAIL)).cursor).toBe('1');
  });

  it('pauses once on reauth, waits 5 minutes, and resumes on success', async () => {
    await watching([folderEntry()]);
    feed.failures.push(new ReauthRequiredError('me'), new ReauthRequiredError('me'));
    await poller.runOnce();
    let state = await store.load(EMAIL);
    expect(state.backoff).toEqual({
      failures: 1,
      until: new Date(clock.now().getTime() + MAX_BACKOFF_MS).toISOString(),
      paused: true,
    });
    await poller.runOnce(); // still backing off: no poll
    expect(feed.calls.filter((c) => c.startsWith('poll'))).toHaveLength(1);
    clock.advance(MAX_BACKOFF_MS + 1);
    await poller.runOnce(); // second reauth failure: no second event
    expect((await inbox.readAll()).map((e) => e.kind)).toEqual(['watch-paused']);
    clock.advance(MAX_BACKOFF_MS + 1);
    await poller.runOnce(); // success
    state = await store.load(EMAIL);
    expect(state.backoff).toBeNull();
  });

  it('backs off exponentially on other errors without events', async () => {
    await watching([folderEntry()]);
    feed.failures.push(new Error('ECONNRESET'), new Error('ECONNRESET'));
    await poller.runOnce();
    expect((await store.load(EMAIL)).backoff).toMatchObject({ failures: 1, paused: false });
    clock.advance(BASE_BACKOFF_MS);
    await poller.runOnce();
    const state = await store.load(EMAIL);
    expect(state.backoff).toEqual({
      failures: 2,
      until: new Date(clock.now().getTime() + 2 * BASE_BACKOFF_MS).toISOString(),
      paused: false,
    });
    expect(await inbox.readAll()).toEqual([]);
    expect(log.warn).toHaveBeenCalled();
  });

  it('backs off on a DriveApiError without a status (network error, missing page token)', async () => {
    await watching([folderEntry()]);
    feed.failures.push(new DriveApiError(undefined, 'changes.list returned no page token'));
    await poller.runOnce();
    const state = await store.load(EMAIL);
    expect(state.backoff).toEqual({
      failures: 1,
      until: new Date(clock.now().getTime() + BASE_BACKOFF_MS).toISOString(),
      paused: false,
    });
    expect(state.cursor).toBe('0');
    expect(await inbox.readAll()).toEqual([]);
  });
});
