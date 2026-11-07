import type { DriveFile } from '../drive/drive-adapter.js';
import { ValidationError } from '../errors.js';
import type { RemoteEntry, SyncRecord } from './types.js';

/** R content vs the record: binary md5 (else size + modifiedTime, `weak`); native modifiedTime. */
export function remoteChanged(
  record: SyncRecord,
  entry: RemoteEntry,
): { changed: boolean; weak: boolean } {
  if (entry.native !== null) {
    return { changed: entry.modifiedTime !== record.remoteModifiedTime, weak: false };
  }
  if (entry.md5 !== null && record.remoteMd5 !== null) {
    return { changed: entry.md5 !== record.remoteMd5, weak: false };
  }
  return {
    changed: entry.size !== record.remoteSize || entry.modifiedTime !== record.remoteModifiedTime,
    weak: true,
  };
}

/** Executor re-verification: binary md5 and modifiedTime equal; native modifiedTime equal. */
export function remoteUnchangedSince(planned: RemoteEntry, current: DriveFile): boolean {
  if ((current.modifiedTime ?? '') !== planned.modifiedTime) return false;
  return planned.native !== null || (current.md5Checksum ?? null) === planned.md5;
}

/**
 * L equals R: binary by Drive md5 (record unused: U2/B4 adopt); native by the md5 of the
 * last export (record required — untracked natives with a local file are U0b).
 */
export function localMatchesRemote(
  localMd5: string,
  record: SyncRecord | null,
  entry: RemoteEntry,
): boolean {
  if (entry.native === null) return entry.md5 !== null && localMd5 === entry.md5;
  if (record === null) {
    throw new ValidationError(`Internal: comparing ${entry.key} needs its record`);
  }
  return localMd5 === record.localMd5;
}
