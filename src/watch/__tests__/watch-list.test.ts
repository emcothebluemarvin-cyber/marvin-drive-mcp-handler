import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NotFoundError, ValidationError } from '../../errors.js';
import { silentLogger } from '../../files/__tests__/fakes.js';
import { emptyState } from '../types.js';
import {
  MAX_ENTRIES,
  addWatch,
  listWatches,
  removeWatch,
  type WatchListDeps,
} from '../watch-list.js';
import { WatchStore } from '../watch-store.js';
import {
  MemoryFeed,
  MemorySnapshotter,
  fileEntry,
  knownFile,
  memoryProvider,
  pendingItem,
  testClock,
  textSnap,
} from './fakes.js';

const EMAIL = 'me@example.com';
let tmp: string;
let store: WatchStore;
let feed: MemoryFeed;
let snap: MemorySnapshotter;
let deps: WatchListDeps & { log: ReturnType<typeof silentLogger> };

beforeEach(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), 'watch-list-'));
  store = new WatchStore({ dir: tmp, logger: silentLogger() });
  feed = new MemoryFeed();
  snap = new MemorySnapshotter();
  deps = {
    store,
    provider: memoryProvider(feed, snap),
    now: testClock().now,
    log: silentLogger(),
  };
  feed.seed('D', { name: 'Plan <Q4>', kind: 'doc', parents: ['F'] });
  feed.seed('F', { name: 'Team', kind: 'folder', parents: ['ROOT'] });
  snap.content.set('D', textSnap('hello\n'));
});
afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe('addWatch', () => {
  it('adds a native file with cursor, known state, comment check and baseline', async () => {
    feed.put('OLD', {}); // a change before the watch: the cursor starts after it
    const res = await addWatch(deps, { fileId: 'D' });
    expect(res).toMatchObject({ action: 'add', account: EMAIL, alreadyWatched: false });
    expect(res.entry).toEqual({
      id: 'D',
      name: 'Plan ‹Q4›',
      kind: 'doc',
      folder: false,
      addedAt: '2026-11-07T11:00:00.000Z',
    });
    const state = await store.load(EMAIL);
    expect(state.cursor).toBe('1');
    expect(state.known.D).toMatchObject({ name: 'Plan <Q4>', via: ['D'] });
    expect(state.lastCommentCheck.D).toBe('2026-11-07T11:00:00.000Z');
    expect((await store.loadSnapshot(EMAIL, 'D'))?.snapshot).toEqual(textSnap('hello\n'));
  });

  it('is idempotent', async () => {
    await addWatch(deps, { fileId: 'D' });
    const again = await addWatch(deps, { fileId: 'D', account: 'me' });
    expect(again.alreadyWatched).toBe(true);
    expect((await store.load(EMAIL)).entries).toHaveLength(1);
  });

  it('adds a folder without scanning members and keeps an existing cursor', async () => {
    await addWatch(deps, { fileId: 'D' });
    feed.put('Z', {});
    await addWatch(deps, { fileId: 'F' });
    const state = await store.load(EMAIL);
    expect(state.entries.map((e) => [e.id, e.folder])).toEqual([
      ['D', false],
      ['F', true],
    ]);
    expect(state.cursor).toBe('0');
    expect(snap.calls).toEqual(['snapshot:D']);
    expect(state.lastCommentCheck.F).toBeUndefined();
  });

  it('fails for an inaccessible file and over the limit', async () => {
    await expect(addWatch(deps, { fileId: 'nope' })).rejects.toBeInstanceOf(NotFoundError);
    const full = {
      ...emptyState(),
      cursor: 'c',
      entries: Array.from({ length: MAX_ENTRIES }, (_, i) => fileEntry({ id: `e${i}` })),
    };
    await store.save(EMAIL, full);
    await expect(addWatch(deps, { fileId: 'D' })).rejects.toBeInstanceOf(ValidationError);
  });

  it('still adds the entry when the baseline snapshot fails', async () => {
    snap.content.set('D', new Error('export failed'));
    const res = await addWatch(deps, { fileId: 'D' });
    expect(res.alreadyWatched).toBe(false);
    expect(await store.loadSnapshot(EMAIL, 'D')).toBeNull();
    expect(deps.log.warn).toHaveBeenCalled();
  });
});

describe('removeWatch', () => {
  it('drops members only covered by the removed folder, keeps the others', async () => {
    await addWatch(deps, { fileId: 'D' });
    await addWatch(deps, { fileId: 'F' });
    const state = await store.load(EMAIL);
    state.known.M1 = knownFile({ via: ['F'] });
    state.known.D = knownFile({ via: ['D', 'F'] });
    state.pending.M2 = pendingItem({ fileId: 'M2', after: knownFile({ via: ['F'] }) });
    state.lastCommentCheck.M1 = 'x';
    await store.save(EMAIL, state);
    await store.saveSnapshot(EMAIL, 'M1', { takenAt: 't', snapshot: textSnap('m') });
    const res = await removeWatch(deps, { fileId: 'F' });
    expect(res).toMatchObject({ action: 'remove', account: EMAIL, removed: { id: 'F' } });
    const after = await store.load(EMAIL);
    expect(after.entries.map((e) => e.id)).toEqual(['D']);
    expect(Object.keys(after.known).sort()).toEqual(['D']);
    expect(after.pending).toEqual({});
    expect(after.lastCommentCheck.M1).toBeUndefined();
    expect(await store.loadSnapshot(EMAIL, 'M1')).toBeNull();
    expect(after.cursor).toBe('0');
  });

  it('keeps a file that a folder still covers when its own entry is removed', async () => {
    await addWatch(deps, { fileId: 'F' });
    const state = await store.load(EMAIL);
    state.known.D = knownFile({ via: ['F'] }); // D seen as a member of F
    await store.save(EMAIL, state);
    await addWatch(deps, { fileId: 'D' });
    expect((await store.load(EMAIL)).known.D?.via).toEqual(['D', 'F']);
    await removeWatch(deps, { fileId: 'D' });
    expect((await store.load(EMAIL)).known.D).toBeDefined();
    expect(await store.loadSnapshot(EMAIL, 'D')).not.toBeNull();
  });

  it('resets the account when the list becomes empty', async () => {
    await addWatch(deps, { fileId: 'D' });
    await removeWatch(deps, { fileId: 'D' });
    expect(await store.load(EMAIL)).toEqual(emptyState());
    expect(await store.loadSnapshot(EMAIL, 'D')).toBeNull();
  });

  it('rejects a file that is not watched', async () => {
    await expect(removeWatch(deps, { fileId: 'D' })).rejects.toThrow(
      'D is not watched for me@example.com',
    );
  });
});

describe('listWatches', () => {
  it('lists one account or every account with entries', async () => {
    expect(await listWatches(deps, {})).toEqual({ action: 'list', watches: [] });
    await addWatch(deps, { fileId: 'D' });
    await store.save('b@example.com', emptyState());
    const all = await listWatches(deps, {});
    expect(all.watches.map((w) => [w.account, w.entries.length])).toEqual([[EMAIL, 1]]);
    const one = await listWatches(deps, { account: 'me' });
    expect(one.watches[0]?.entries[0]?.id).toBe('D');
  });
});
