import { bySeq, type ChangeEvent, type ReadState } from './types.js';
import type { WatchStore } from './watch-store.js';

/** Spec §7.4: foreign, after readSeq and not read by id. */
export function isUnread(e: ChangeEvent, rs: ReadState): boolean {
  return !e.own && e.seq > rs.readSeq && !rs.readIds.includes(e.id);
}

export function unreadEvents(all: readonly ChangeEvent[], rs: ReadState): ChangeEvent[] {
  return all.filter((e) => isUnread(e, rs)).sort(bySeq);
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
  const readIds = page.filter((e) => !e.own && e.seq > readSeq).map((e) => e.id);
  return { readSeq, readIds };
}

/** Max / union merge that never moves backwards; with `all`, prunes ids whose seq ≤ readSeq (without `all` nothing is pruned). */
export function mergeRead(
  current: ReadState,
  change: Partial<ReadState>,
  all: readonly ChangeEvent[] | null,
): ReadState {
  const readSeq = Math.max(current.readSeq, change.readSeq ?? 0);
  const pushedSeq = Math.max(current.pushedSeq, change.pushedSeq ?? 0);
  const ids = [...new Set([...current.readIds, ...(change.readIds ?? [])])];
  if (all === null) return { readSeq, readIds: ids.sort(), pushedSeq };
  const seqOf = new Map(all.map((e) => [e.id, e.seq]));
  // Prune only ids known to be ≤ readSeq: `all` may be older than read.json (another
  // process may have marked a newer event read), so a missing id is never dropped.
  const readIds = ids
    .filter((id) => {
      const seq = seqOf.get(id);
      return seq === undefined || seq > readSeq;
    })
    .sort();
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
