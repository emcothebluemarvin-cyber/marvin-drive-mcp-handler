import type { Logger } from '../logger.js';
import { isAbortError } from './errors.js';
import type { SyncRemote } from './remote/sync-remote.js';
import type { Pair, PairFile, SyncRecord } from './types.js';

/*
 * OneDrive deletion evidence (OneDrive sync spec §4.1). A 404 alone never means "deleted":
 * only ids the drive-wide delta feed reported with the `deleted` facet count, and only
 * while no scan or probe sees the item present again.
 */

export const HISTORY_UNAVAILABLE =
  'OneDrive change history unavailable; deletions since the last run are reported, not applied';

export interface FeedRead {
  /** The cursor to store with the evidence (null: the feed could not be restarted). */
  cursor: string | null;
  /** Stored evidence plus the feed's deleted ids; callers remove the ids seen present. */
  evidence: Set<string>;
  /** The stored cursor was null or expired: only the stored evidence is used. */
  unavailable: boolean;
}

/**
 * Reads the feed from the pair's cursor (never writes). Null on remotes without a feed
 * (Google). A null or expired cursor restarts the feed "from now on"; if that fails too,
 * the cursor stays null and the next run warns again. Other read errors throw.
 */
export async function readDeletionFeed(
  remote: SyncRemote,
  pair: Pair,
  log: Logger,
): Promise<FeedRead | null> {
  const feed = remote.deletionFeed();
  if (!feed) return null;
  const evidence = new Set(pair.remoteDeletedIds);
  if (pair.remoteCursor !== null) {
    const read = await feed.read(pair.remoteCursor);
    if (!('expired' in read)) {
      for (const id of read.deletedIds) evidence.add(id);
      return { cursor: read.cursor, evidence, unavailable: false };
    }
  }
  let cursor: string | null = null;
  try {
    cursor = await feed.start();
  } catch (err) {
    if (isAbortError(err)) throw err;
    log.warn('Could not restart the OneDrive change history', { pair: pair.name, error: err });
  }
  return { cursor, evidence, unavailable: true };
}

/** Evidence that matters: ids of records and of their parents (folders have no records). */
export function keptEvidence(ids: Iterable<string>, records: readonly SyncRecord[]): string[] {
  const wanted = new Set(records.flatMap((r) => [r.remoteId, r.remoteParentId]));
  return [...new Set(ids)].filter((id) => wanted.has(id)).sort();
}

/** Drops evidence no record refers to any more (after records were dropped). */
export function pruneEvidence(file: PairFile): void {
  if (file.pair.remoteDeletedIds.length === 0) return;
  file.pair.remoteDeletedIds = keptEvidence(file.pair.remoteDeletedIds, file.records);
}

/** Cursor and evidence of this run on the pair, always together (records untouched). */
export function storeFeed(file: PairFile, feed: FeedRead): void {
  file.pair.remoteCursor = feed.cursor;
  file.pair.remoteDeletedIds = keptEvidence(feed.evidence, file.records);
}
