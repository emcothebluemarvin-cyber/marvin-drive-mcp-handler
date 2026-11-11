import { beforeEach, describe, expect, it } from 'vitest';
import { silentLogger } from '../../files/__tests__/fakes.js';
import { enrich, newForeignNotes, type EnrichInput } from '../enrich.js';
import type { StoredSnapshot } from '../types.js';
import {
  AYSE,
  BORA,
  ME,
  MemorySnapshotter,
  T1,
  T2,
  comment,
  knownFile,
  pendingItem,
  textSnap,
} from './fakes.js';

const NOW = new Date('2026-11-07T11:10:00.000Z');
let snap: MemorySnapshotter;
const stored = (text: string): StoredSnapshot => ({ takenAt: T1, snapshot: textSnap(text) });

function input(over: Partial<EnrichInput> = {}): EnrichInput {
  return {
    item: pendingItem(),
    account: 'me@example.com',
    snapshotter: snap,
    previous: stored('a\nb\nc\n'),
    since: T1,
    now: NOW,
    log: silentLogger(),
    ...over,
  };
}

beforeEach(() => {
  snap = new MemorySnapshotter();
  snap.content.set('D', textSnap('a\nB\nc\n'));
});

describe('enrich: natives', () => {
  it('diffs a foreign edit and returns the new snapshot', async () => {
    const r = await enrich(input());
    expect(r.event).toMatchObject({
      id: `me@example.com:D:${T1}`,
      account: 'me@example.com',
      kind: 'edited',
      fileId: 'D',
      name: 'Plan',
      fileKind: 'doc',
      own: false,
      alsoByYou: false,
      diff: '  a\n- b\n+ B\n  c',
      note: null,
      untrusted: true,
    });
    expect(r.snapshot).toEqual({ takenAt: NOW.toISOString(), snapshot: textSnap('a\nB\nc\n') });
    expect(r.commentCheck).toBe(NOW.toISOString());
  });

  it('drops an item without a visible change but keeps the new snapshot', async () => {
    snap.content.set('D', textSnap('a\nb\nc\n'));
    const r = await enrich(input());
    expect(r.event).toBeNull();
    expect(r.snapshot).not.toBe('keep');
    expect(r.commentCheck).toBe(NOW.toISOString());
  });

  it('reports new foreign comments as commented when nothing else changed', async () => {
    snap.content.set('D', textSnap('a\nb\nc\n'));
    snap.comments.set('D', [
      comment(),
      comment({ id: 'c2', author: ME, content: 'mine' }),
      comment({
        id: 'c3',
        author: ME,
        createdTime: '2026-11-01T00:00:00.000Z',
        replies: [{ author: BORA, content: '<b>agree</b>', createdTime: T2 }],
      }),
    ]);
    const r = await enrich(input({ item: pendingItem({ modifiers: [ME] }) }));
    expect(r.event?.kind).toBe('commented');
    expect(r.event?.own).toBe(false);
    expect(r.event?.comments).toEqual([
      { type: 'comment', commentId: 'c1', author: AYSE, content: 'Why 135?', time: T2 },
      { type: 'reply', commentId: 'c3', author: BORA, content: '‹b›agree‹/b›', time: T2 },
    ]);
  });

  it('marks own and mixed authorship', async () => {
    expect((await enrich(input({ item: pendingItem({ modifiers: [ME] }) }))).event?.own).toBe(true);
    const mixed = await enrich(input({ item: pendingItem({ modifiers: [AYSE, ME] }) }));
    expect(mixed.event).toMatchObject({ own: false, alsoByYou: true });
  });

  it('says when there is no earlier version, and diffs an added file against nothing', async () => {
    const first = await enrich(input({ previous: null }));
    expect(first.event?.note).toBe('no earlier version to compare');
    expect(first.event?.diff).toBeNull();
    const added = await enrich(
      input({ previous: null, item: pendingItem({ flags: ['added'], before: null }) }),
    );
    expect(added.event).toMatchObject({ kind: 'added', diff: '+ a\n+ B\n+ c', note: null });
  });

  it('notes first-seen files', async () => {
    const r = await enrich(
      input({
        previous: null,
        item: pendingItem({ flags: ['edited', 'first-seen'], before: null }),
      }),
    );
    expect(r.event?.note).toBe('first seen in a watched folder; no earlier version to compare');
  });

  it('handles too-large and unreadable content', async () => {
    snap.content.set('D', { tooLarge: true });
    const big = await enrich(input());
    expect(big.event?.note).toBe('changed (too large to compare)');
    expect(big.snapshot).toBe('drop');
    snap.content.set('D', new Error('boom'));
    const failed = await enrich(input());
    expect(failed.event?.note).toBe('content could not be read');
    expect(failed.snapshot).toBe('keep');
  });

  it('diffs Sheets cells', async () => {
    snap.content.set('S', { type: 'sheet', sheets: [{ title: 'Sheet1', rows: [['135']] }] });
    const r = await enrich(
      input({
        item: pendingItem({ fileId: 'S', after: knownFile({ kind: 'sheet', modifiedTime: T2 }) }),
        previous: {
          takenAt: T1,
          snapshot: { type: 'sheet', sheets: [{ title: 'Sheet1', rows: [['120']] }] },
        },
      }),
    );
    expect(r.event?.diff).toBe('Sheet1!A1: "120" → "135"');
  });

  it('does not snapshot removed, moved-out or rename-only items', async () => {
    const removed = await enrich(input({ item: pendingItem({ flags: ['removed'], after: null }) }));
    expect(removed.event?.kind).toBe('removed');
    expect(removed.snapshot).toBe('drop');
    const out = await enrich(input({ item: pendingItem({ flags: ['moved-out'] }) }));
    expect(out.event?.kind).toBe('moved-out');
    const renamed = await enrich(
      input({ item: pendingItem({ flags: ['renamed'], after: knownFile({ name: 'P <2>' }) }) }),
    );
    expect(renamed.event).toMatchObject({ kind: 'renamed', name: 'P ‹2›', previousName: 'Plan' });
    expect(snap.calls).toEqual(['comments:D']);
  });
});

describe('enrich: comment check time', () => {
  it('never asks for comments since an empty or invalid time', async () => {
    const asked: string[] = [];
    const spy = Object.assign(Object.create(snap) as MemorySnapshotter, {
      commentsSince: async (_id: string, since: string) => {
        asked.push(since);
        return [];
      },
    });
    await enrich(input({ snapshotter: spy, since: '' }));
    await enrich(input({ snapshotter: spy, since: 'x', previous: null }));
    await enrich(
      input({ snapshotter: spy, since: '', previous: null, item: pendingItem({ firstSeen: '' }) }),
    );
    expect(asked).toEqual([T1, T1, NOW.toISOString()]);
  });
});

describe('enrich: other files', () => {
  const other = (over: Parameters<typeof knownFile>[0]) => knownFile({ kind: 'other', ...over });

  it('reports size and md5 changes', async () => {
    const r = await enrich(
      input({
        item: pendingItem({
          before: other({ size: 10, md5: 'a' }),
          after: other({ size: 12, md5: 'b', modifiedTime: T2 }),
        }),
      }),
    );
    expect(r.event?.diff).toBe('size: 10 → 12 bytes');
    const same = await enrich(
      input({
        item: pendingItem({
          before: other({ size: 10, md5: 'a' }),
          after: other({ size: 10, md5: 'b', modifiedTime: T2 }),
        }),
      }),
    );
    expect(same.event?.diff).toBe('content changed');
    expect(snap.calls).toEqual([]);
  });

  it('drops a modifiedTime-only change', async () => {
    const r = await enrich(
      input({
        item: pendingItem({
          before: other({ md5: 'a' }),
          after: other({ md5: 'a', modifiedTime: T2 }),
        }),
      }),
    );
    expect(r.event).toBeNull();
  });
});

describe('newForeignNotes', () => {
  it('keeps comments and replies created since the check by someone else', () => {
    const notes = newForeignNotes(
      [comment({ createdTime: '2026-11-01T00:00:00.000Z' }), comment({ id: 'c2' })],
      T1,
    );
    expect(notes.map((n) => n.commentId)).toEqual(['c2']);
  });
});
