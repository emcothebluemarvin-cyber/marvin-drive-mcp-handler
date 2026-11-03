import type { DriveFile } from '../drive/drive-adapter.js';
import { AppError, NotFoundError, PermissionDeniedError } from '../errors.js';
import { GOOGLE_MIME, isGoogleNative } from '../files/export-formats.js';
import { isAbortError } from './errors.js';
import { isIgnoredName, isRepresentable } from './paths.js';
import { toRemoteEntry } from './remote-scanner.js';
import { SYNC_FILE_FIELDS, type Probe, type RemoteScan } from './types.js';

export type FileGetter = (fileId: string, fields: string) => Promise<DriveFile>;

const MAX_DEPTH = 32;

function unknown(reason: string): Probe {
  return { state: 'unknown', reason };
}

function failure(err: unknown, what: string): Probe {
  if (isAbortError(err)) throw err;
  if (err instanceof NotFoundError || err instanceof PermissionDeniedError) {
    return what === 'file' ? { state: 'unavailable' } : unknown('a parent folder cannot be read');
  }
  return unknown(err instanceof AppError ? err.message : 'probe failed');
}

/** Classifies one record missing from the scan (spec §6.2). */
export async function probeRecord(
  remoteId: string,
  scan: RemoteScan,
  get: FileGetter,
): Promise<Probe> {
  let file: DriveFile;
  try {
    file = await get(remoteId, SYNC_FILE_FIELDS);
  } catch (err) {
    return failure(err, 'file');
  }
  if (file.trashed) return { state: 'trashed' };
  const parent = file.parents?.[0];
  if (!parent) return { state: 'moved-out' };
  if (scan.unknownFolderIds.includes(parent)) return unknown('inside an ambiguous Drive folder');
  const parentKey = scan.folders.get(parent);
  if (parentKey !== undefined) {
    const name = file.name ?? '';
    const mime = file.mimeType ?? '';
    if (!isRepresentable(name) || isIgnoredName(name)) {
      return unknown('renamed in Drive to a name that cannot be synced');
    }
    if (mime === GOOGLE_MIME.shortcut || isGoogleNative(mime)) {
      return unknown('is no longer a regular file');
    }
    return { state: 'present', entry: toRemoteEntry(file, parentKey, parent, [parent]) };
  }
  let current = parent;
  for (let depth = 0; depth < MAX_DEPTH; depth++) {
    let folder: DriveFile;
    try {
      folder = await get(current, 'id, parents');
    } catch (err) {
      return failure(err, 'folder');
    }
    const up = folder.parents?.[0];
    if (!up) return { state: 'moved-out' };
    if (scan.folders.has(up) || scan.unknownFolderIds.includes(up)) {
      return unknown('inside a Drive folder that was not scanned');
    }
    current = up;
  }
  return unknown('folder nesting too deep');
}

/** Probes every record id (sequentially) and returns id → probe. */
export async function probeRecords(
  remoteIds: readonly string[],
  scan: RemoteScan,
  get: FileGetter,
): Promise<Map<string, Probe>> {
  const probes = new Map<string, Probe>();
  for (const id of remoteIds) probes.set(id, await probeRecord(id, scan, get));
  return probes;
}
