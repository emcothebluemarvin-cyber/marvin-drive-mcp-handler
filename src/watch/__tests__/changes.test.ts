import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { silentLogger } from '../../files/__tests__/fakes.js';
import { readChanges } from '../changes.js';
import { Inbox } from '../inbox.js';
import { WatchStore } from '../watch-store.js';
import { makeEvent } from './fakes.js';

let tmp: string;
let store: WatchStore;
let inbox: Inbox;
const deps = () => ({ store, inbox });

beforeEach(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), 'changes-'));
  store = new WatchStore({ dir: tmp, logger: silentLogger() });
  inbox = new Inbox(path.join(tmp, 'inbox.jsonl'));
  await inbox.append(makeEvent({ seq: 1 }));
  await inbox.append(makeEvent({ seq: 2, own: true }));
  await inbox.append(makeEvent({ seq: 3, fileId: 'S' }));
  await inbox.append(makeEvent({ seq: 4 }));
});
afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

const seqs = (r: { events: Array<{ seq: number }> }) => r.events.map((e) => e.seq);

describe('readChanges', () => {
  it('returns unread foreign events oldest first and marks them read', async () => {
    const first = await readChanges(deps(), {});
    expect(seqs(first)).toEqual([1, 3, 4]);
    expect(first).toMatchObject({ more: 0, unread: 0 });
    expect(await store.loadRead()).toMatchObject({ readSeq: 4, readIds: [] });
    expect(seqs(await readChanges(deps(), {}))).toEqual([]);
  });

  it('pages with limit and advances readSeq over the contiguous prefix', async () => {
    const page = await readChanges(deps(), { limit: 2 });
    expect(seqs(page)).toEqual([1, 3]);
    expect(page).toMatchObject({ more: 1, unread: 1 });
    expect((await store.loadRead()).readSeq).toBe(3);
  });

  it('includes own and read events on request', async () => {
    await readChanges(deps(), {});
    expect(seqs(await readChanges(deps(), { unreadOnly: false, includeOwn: true }))).toEqual([
      1, 2, 3, 4,
    ]);
  });

  it('filters by file and marks by id only', async () => {
    const res = await readChanges(deps(), { fileId: 'S' });
    expect(seqs(res)).toEqual([3]);
    expect(await store.loadRead()).toMatchObject({
      readSeq: 0,
      readIds: [{ id: makeEvent({ seq: 3 }).id, seq: 3 }],
    });
    expect(res.unread).toBe(2);
  });

  it('returns one event by id even when read', async () => {
    await readChanges(deps(), {});
    const res = await readChanges(deps(), { eventId: makeEvent({ seq: 4 }).id });
    expect(seqs(res)).toEqual([4]);
  });

  it('leaves read state alone with markRead: false', async () => {
    await readChanges(deps(), { markRead: false });
    expect(await store.loadRead()).toEqual({ readSeq: 0, readIds: [], pushedSeq: 0 });
  });
});
