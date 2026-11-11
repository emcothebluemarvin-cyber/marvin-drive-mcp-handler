import { AppError } from '../errors.js';
import { isAbortError } from './errors.js';
import { baseName, isIgnoredName, isRepresentable } from './paths.js';
import type { RemoteItem, SyncRemote } from './remote/sync-remote.js';
import { toRemoteEntry } from './remote-scanner.js';
import { UNSUPPORTED_TEXT, type Probe, type RemoteScan } from './types.js';

/** What a probe needs from the remote. */
export type ItemGetter = Pick<SyncRemote, 'get'>;

const MAX_DEPTH = 32;

function unknown(reason: string): Probe {
  return { state: 'unknown', reason };
}

/** A failed read other than 404/403 (those make `get` return null). */
function failure(err: unknown): Probe {
  if (isAbortError(err)) throw err;
  return unknown(err instanceof AppError ? err.message : 'probe failed');
}

/** Receives the ids a probe found present; a Set works, so does a deleting sink. */
export interface SeenSink {
  add(id: string): unknown;
}

export interface ProbeOptions {
  /** OneDrive (spec §4.1): the feed reported this record (or its parent) deleted. */
  evidenced?: boolean;
  /** Told each id `get` found present (it leaves the deletion evidence at once). */
  seen?: SeenSink;
}

/**
 * Classifies one record missing from the scan (spec §6.2). A missing item is `trashed`
 * only with deletion evidence (OneDrive); without it, `unavailable` (B14, report only).
 */
export async function probeRecord(
  remoteId: string,
  scan: RemoteScan,
  remote: ItemGetter,
  options: ProbeOptions = {},
): Promise<Probe> {
  let file: RemoteItem | null;
  try {
    file = await remote.get(remoteId);
  } catch (err) {
    return failure(err);
  }
  if (file === null) return { state: options.evidenced ? 'trashed' : 'unavailable' };
  options.seen?.add(file.id);
  if (file.trashed) return { state: 'trashed' };
  const parent = file.parentId;
  if (!parent) return { state: 'moved-out' };
  if (scan.unknownFolderIds.includes(parent)) return unknown('inside an ambiguous Drive folder');
  const parentKey = scan.folders.get(parent);
  if (parentKey !== undefined) {
    const name = file.name;
    if (!isRepresentable(name) || isIgnoredName(name)) {
      return unknown('renamed in Drive to a name that cannot be synced');
    }
    if (file.kind === 'folder' || file.unsupported === 'shortcut') {
      return unknown('is no longer a regular file');
    }
    if (file.kind === 'unsupported') {
      const text = file.unsupported ? UNSUPPORTED_TEXT[file.unsupported] : undefined;
      return unknown(text ?? 'is a Google file type that cannot be exported');
    }
    const entry = toRemoteEntry(file, parentKey, parent, [parent]);
    if (!isRepresentable(baseName(entry.key))) {
      return unknown('renamed in Drive to a name that cannot be synced');
    }
    return { state: 'present', entry };
  }
  // The parent walk reads each folder through `get`, so Google requests the full sync
  // fields here (before the port: 'id, parents'); only `parentId` is used.
  let current = parent;
  for (let depth = 0; depth < MAX_DEPTH; depth++) {
    let folder: RemoteItem | null;
    try {
      folder = await remote.get(current);
    } catch (err) {
      return failure(err);
    }
    if (folder === null) return unknown('a parent folder cannot be read');
    options.seen?.add(folder.id);
    const up = folder.parentId;
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
  remote: ItemGetter,
  options: { evidenced?: (id: string) => boolean; seen?: SeenSink } = {},
): Promise<Map<string, Probe>> {
  const probes = new Map<string, Probe>();
  for (const id of remoteIds) {
    const evidenced = options.evidenced?.(id) ?? false;
    probes.set(
      id,
      await probeRecord(id, scan, remote, {
        evidenced,
        ...(options.seen ? { seen: options.seen } : {}),
      }),
    );
  }
  return probes;
}
