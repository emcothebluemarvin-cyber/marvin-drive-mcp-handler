import { ValidationError } from '../errors.js';
import type { ContentHash, RemoteItem } from './remote/sync-remote.js';
import type { LocalDigests, RemoteEntry, SyncRecord } from './types.js';

/** The item's md5, or null when it reports none (or another hash kind). */
export function md5Of(item: RemoteItem): string | null {
  return md5Value(item.hash);
}

/** The value of an md5 hash; null for none or another kind. */
export function md5Value(hash: ContentHash | null): string | null {
  return hash?.kind === 'md5' ? hash.value : null;
}

/** Equal hashes, or both missing (record bookkeeping: did the remote's hash change?). */
export function sameHashOrNone(a: ContentHash | null, b: ContentHash | null): boolean {
  if (a === null || b === null) return a === b;
  return a.kind === b.kind && a.value === b.value;
}

/** Both hashes known, of one kind and equal (null when either is missing or kinds differ). */
function sameHash(a: ContentHash | null, b: ContentHash | null): boolean | null {
  if (a === null || b === null || a.kind !== b.kind) return null;
  return a.value === b.value;
}

/** R content vs the record: the hash (else size + modifiedTime, `weak`); native modifiedTime. */
export function remoteChanged(
  record: SyncRecord,
  entry: RemoteEntry,
): { changed: boolean; weak: boolean } {
  if (entry.native !== null) {
    return { changed: entry.modifiedTime !== record.remoteModifiedTime, weak: false };
  }
  const same = sameHash(entry.hash, record.remoteHash);
  if (same !== null) return { changed: !same, weak: false };
  return {
    changed: entry.size !== record.remoteSize || entry.modifiedTime !== record.remoteModifiedTime,
    weak: true,
  };
}

/** Executor re-verification: binary hash and modifiedTime equal; native modifiedTime equal. */
export function remoteUnchangedSince(planned: RemoteEntry, current: RemoteItem): boolean {
  if (current.modifiedTime !== planned.modifiedTime) return false;
  if (planned.native !== null) return true;
  if (planned.hash === null || current.hash === null) return planned.hash === current.hash;
  return sameHash(planned.hash, current.hash) === true;
}

/**
 * L's content vs a remote hash (spec §3.2): null when the remote reports none, the local
 * digest of its kind was not computed, or the kinds differ.
 */
export function sameContent(local: LocalDigests, remote: ContentHash | null): boolean | null {
  return sameHash(local.remote, remote);
}

/**
 * L equals R: binary by the remote hash, never by a weaker fallback (record unused: U2/B4
 * adopt, release); native by the md5 of the last export (record required — untracked
 * natives with a local file are U0b).
 */
export function localMatchesRemote(
  local: LocalDigests,
  record: SyncRecord | null,
  entry: RemoteEntry,
): boolean {
  if (entry.native === null) return sameContent(local, entry.hash) === true;
  if (record === null) {
    throw new ValidationError(`Internal: comparing ${entry.key} needs its record`);
  }
  return local.md5 === record.localMd5;
}
