import type { PendingItem } from './types.js';

/** Spec §2/§6: notify when quiet for 120 s, at most 600 s after the first pending change. */
export const QUIET_MS = 120_000;
export const MAX_WAIT_MS = 600_000;

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** PURE: pending items ready for enrichment, oldest first (ISO strings sort as text). */
export function readyToRelease(
  pending: Readonly<Record<string, PendingItem>>,
  now: Date,
  quietMs: number = QUIET_MS,
  maxWaitMs: number = MAX_WAIT_MS,
): PendingItem[] {
  const t = now.getTime();
  return Object.values(pending)
    .filter((p) => {
      const last = Date.parse(p.lastSeen);
      const first = Date.parse(p.firstSeen);
      // An unparseable time would never release: release it now.
      if (Number.isNaN(last) || Number.isNaN(first)) return true;
      return t - last >= quietMs || t - first >= maxWaitMs;
    })
    .sort((a, b) => cmp(a.firstSeen, b.firstSeen) || cmp(a.fileId, b.fileId));
}

/** Own only if there is a modifier and every modifier is the account (resolved ambiguity 3). */
export function isOwnItem(item: Pick<PendingItem, 'modifiers'>): boolean {
  return item.modifiers.length > 0 && item.modifiers.every((m) => m.me);
}
