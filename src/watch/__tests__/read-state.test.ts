import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { silentLogger } from '../../files/__tests__/fakes.js';
import { isUnread, mergeRead, readUpdate, unreadEvents, updateReadState } from '../read-state.js';
import { UNKNOWN_READ_SEQ, type ReadState } from '../types.js';
import { WatchStore } from '../watch-store.js';
import { makeEvent } from './fakes.js';

const fresh: ReadState = { readSeq: 0, readIds: [], pushedSeq: 0 };
const ev = (seq: number, own = false) => makeEvent({ seq, own });
const rid = (seq: number) => ({ id: ev(seq).id, seq });

describe('isUnread / unreadEvents', () => {
  it('own events are never unread; read by seq or by id', () => {
    expect(isUnread(ev(1), fresh)).toBe(true);
    expect(isUnread(ev(1, true), fresh)).toBe(false);
    expect(isUnread(ev(1), { ...fresh, readSeq: 1 })).toBe(false);
    expect(isUnread(ev(2), { ...fresh, readIds: [rid(2)] })).toBe(false);
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
    expect(readUpdate(fresh, page, all, true)).toEqual({ readSeq: 1, readIds: [rid(4)] });
  });

  it('filtered pages only add ids', () => {
    expect(readUpdate(fresh, [ev(2)], all, false)).toEqual({ readSeq: 0, readIds: [rid(2)] });
  });

  it('never adds own events to readIds', () => {
    expect(readUpdate(fresh, [ev(3, true)], all, false)).toEqual({ readSeq: 0, readIds: [] });
  });
});

describe('mergeRead', () => {
  const all = [ev(3), ev(6), ev(7)];

  it('takes max seqs, unions ids and prunes ids at or below readSeq', () => {
    const current: ReadState = { readSeq: 5, readIds: [rid(7)], pushedSeq: 3 };
    const next = mergeRead(current, { readSeq: 4, readIds: [rid(6), rid(3)], pushedSeq: 9 }, all);
    expect(next).toEqual({ readSeq: 5, readIds: [rid(6), rid(7)], pushedSeq: 9 });
  });

  it('keeps an id missing from a stale event list (marked read by another process)', () => {
    const current: ReadState = { readSeq: 0, readIds: [rid(10)], pushedSeq: 0 };
    expect(mergeRead(current, { pushedSeq: 7 }, all).readIds).toEqual([rid(10)]);
  });

  it('never moves backwards and keeps ids when no events are given', () => {
    const current: ReadState = { readSeq: 5, readIds: [{ id: 'x', seq: 9 }], pushedSeq: 8 };
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
      updateReadState(a, { readSeq: 1, readIds: [rid(3)] }, all),
      updateReadState(b, { readIds: [rid(2)], pushedSeq: 3 }, all),
    ]);
    expect(await a.loadRead()).toEqual({
      readSeq: 1,
      readIds: [rid(2), rid(3)],
      pushedSeq: 3,
    });
  });
});

describe('read ids with seqs (review fix)', () => {
  it('prunes ids at or below readSeq even after their event left the inbox', () => {
    const current: ReadState = { readSeq: 0, readIds: [rid(2), rid(8)], pushedSeq: 0 };
    expect(mergeRead(current, { readSeq: 5 }, []).readIds).toEqual([rid(8)]);
    expect(mergeRead(current, { readSeq: 5 }, null).readIds).toEqual([rid(8)]);
  });

  it('fills the seq of a legacy id from the inbox and drops it once it left', () => {
    const legacy = (id: string) => ({ id, seq: UNKNOWN_READ_SEQ });
    const current: ReadState = {
      readSeq: 0,
      readIds: [legacy(ev(3).id), legacy('gone')],
      pushedSeq: 0,
    };
    expect(mergeRead(current, {}, [ev(3)]).readIds).toEqual([rid(3)]);
    expect(mergeRead(current, {}, null).readIds).toHaveLength(2);
  });
});
