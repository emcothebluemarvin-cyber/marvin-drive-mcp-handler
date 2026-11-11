import { UNKNOWN_READ_SEQ, bySeq, type ChangeEvent, type ReadId, type ReadState } from './types.js';
import type { WatchStore } from './watch-store.js';

/** Spec §7.4: foreign, after readSeq and not read by id. */
export function isUnread(e: ChangeEvent, rs: ReadState): boolean {
  return !e.own && e.seq > rs.readSeq && !rs.readIds.some((r) => r.id === e.id);
}

export function unreadEvents(all: readonly ChangeEvent[], rs: ReadState): ChangeEvent[] {
  const read = new Set(rs.readIds.map((r) => r.id));
  return all.filter((e) => !e.own && e.seq > rs.readSeq && !read.has(e.id)).sort(bySeq);
}

/** What returning `page` marks read (spec §7.4). */
export function readUpdate(
  rs: ReadState,
  page: readonly ChangeEvent[],
  all: readonly ChangeEvent[],
  unfiltered: boolean,
): Pick<ReadState, 'readSeq' | 'readIds'> {
  const pageIds = new Set(page.map((e) => e.id));
  let readSeq = rs.readSeq;
  if (unfiltered) {
    for (const e of unreadEvents(all, rs)) {
      if (!pageIds.has(e.id)) break;
      readSeq = e.seq;
    }
  }
  const readIds = page
    .filter((e) => !e.own && e.seq > readSeq)
    .map((e) => ({ id: e.id, seq: e.seq }));
  return { readSeq, readIds };
}

const byReadId = (a: ReadId, b: ReadId): number =>
  a.seq - b.seq || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * Max / union merge that never moves backwards; ids with seq ≤ readSeq are pruned. With
 * `all`, a legacy id (unknown seq) takes its event's seq, or is dropped when the event left
 * the inbox (legacy ids are older than anything `all` could be missing).
 */
export function mergeRead(
  current: ReadState,
  change: Partial<ReadState>,
  all: readonly ChangeEvent[] | null,
): ReadState {
  const readSeq = Math.max(current.readSeq, change.readSeq ?? 0);
  const pushedSeq = Math.max(current.pushedSeq, change.pushedSeq ?? 0);
  const seqOf = new Map((all ?? []).map((e) => [e.id, e.seq]));
  const ids = new Map<string, number>();
  for (const r of [...current.readIds, ...(change.readIds ?? [])]) {
    let seq = r.seq;
    if (seq === UNKNOWN_READ_SEQ && all !== null) {
      const known = seqOf.get(r.id);
      if (known === undefined) continue;
      seq = known;
    }
    ids.set(r.id, Math.min(seq, ids.get(r.id) ?? seq));
  }
  const readIds = [...ids]
    .map(([id, seq]) => ({ id, seq }))
    .filter((r) => r.seq > readSeq)
    .sort(byReadId);
  return { readSeq, readIds, pushedSeq };
}

/** Read-modify-write of `read.json` under `watch.lock`. */
export function updateReadState(
  store: WatchStore,
  change: Partial<ReadState>,
  all: readonly ChangeEvent[] | null,
  timeoutMs?: number,
): Promise<ReadState> {
  return store.withLock(async () => {
    const next = mergeRead(await store.loadRead(), change, all);
    await store.saveRead(next);
    return next;
  }, timeoutMs);
}
