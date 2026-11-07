import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { silentLogger } from '../../files/__tests__/fakes.js';
import { isUnread, mergeRead, readUpdate, unreadEvents, updateReadState } from '../read-state.js';
import type { ReadState } from '../types.js';
import { WatchStore } from '../watch-store.js';
import { makeEvent } from './fakes.js';

const fresh: ReadState = { readSeq: 0, readIds: [], pushedSeq: 0 };
const ev = (seq: number, own = false) => makeEvent({ seq, own });

describe('isUnread / unreadEvents', () => {
  it('own events are never unread; read by seq or by id', () => {
    expect(isUnread(ev(1), fresh)).toBe(true);
    expect(isUnread(ev(1, true), fresh)).toBe(false);
    expect(isUnread(ev(1), { ...fresh, readSeq: 1 })).toBe(false);
    expect(isUnread(ev(2), { ...fresh, readIds: [ev(2).id] })).toBe(false);
    expect(isUnread(makeEvent({ seq: 3, kind: 'gap', own: false }), fresh)).toBe(true);
  });

  it('lists unread events oldest first', () => {
    const all = [ev(3), ev(1), ev(2, true)];
    expect(unreadEvents(all, fresh).map((e) => e.seq)).toEqual([1, 3]);
  });
});

describe('readUpdate', () => {
  const all = [ev(1), ev(2), ev(3, true), ev(4), ev(5)];

  it('unfiltered: contiguous prefix of unread events, own seqs skipped', () => {
    const page = [ev(1), ev(2), ev(4)];
    expect(readUpdate(fresh, page, all, true)).toEqual({ readSeq: 4, readIds: [] });
  });

  it('unfiltered with a hole: prefix to the hole, the rest by id', () => {
    const page = [ev(1), ev(4)];
    expect(readUpdate(fresh, page, all, true)).toEqual({ readSeq: 1, readIds: [ev(4).id] });
  });

  it('filtered pages only add ids', () => {
    expect(readUpdate(fresh, [ev(2)], all, false)).toEqual({ readSeq: 0, readIds: [ev(2).id] });
  });

  it('never adds own events to readIds', () => {
    expect(readUpdate(fresh, [ev(3, true)], all, false)).toEqual({ readSeq: 0, readIds: [] });
  });
});

describe('mergeRead', () => {
  const all = [ev(3), ev(6), ev(7)];

  it('takes max seqs, unions ids and prunes ids at or below readSeq', () => {
    const current: ReadState = { readSeq: 5, readIds: [ev(7).id], pushedSeq: 3 };
    const next = mergeRead(
      current,
      { readSeq: 4, readIds: [ev(6).id, ev(3).id], pushedSeq: 9 },
      all,
    );
    expect(next).toEqual({ readSeq: 5, readIds: [ev(6).id, ev(7).id].sort(), pushedSeq: 9 });
  });

  it('keeps an id missing from a stale event list (marked read by another process)', () => {
    const current: ReadState = { readSeq: 0, readIds: [ev(10).id], pushedSeq: 0 };
    expect(mergeRead(current, { pushedSeq: 7 }, all).readIds).toEqual([ev(10).id]);
  });

  it('never moves backwards and keeps ids when no events are given', () => {
    const current: ReadState = { readSeq: 5, readIds: ['x'], pushedSeq: 8 };
    expect(mergeRead(current, { pushedSeq: 2 }, null)).toEqual(current);
  });
});

describe('updateReadState', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'read-state-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('does not lose updates of concurrent writers', async () => {
    const a = new WatchStore({ dir, logger: silentLogger() });
    const b = new WatchStore({ dir, logger: silentLogger() });
    const all = [ev(1), ev(2), ev(3)];
    await Promise.all([
      updateReadState(a, { readSeq: 1, readIds: [ev(3).id] }, all),
      updateReadState(b, { readIds: [ev(2).id], pushedSeq: 3 }, all),
    ]);
    expect(await a.loadRead()).toEqual({
      readSeq: 1,
      readIds: [ev(2).id, ev(3).id].sort(),
      pushedSeq: 3,
    });
  });
});
