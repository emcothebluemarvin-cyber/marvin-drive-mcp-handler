import type { DriveFile } from '../drive/drive-adapter.js';
import { ValidationError } from '../errors.js';
import { foldKey } from './paths.js';
import type { StatExpect } from './transfer.js';
import type { LocalEntry, PairFile, RemoteEntry, SelectionChange, SyncRecord } from './types.js';

export interface RemoteFields {
  id: string;
  name: string;
  parentId: string;
  md5: string | null;
  size: number | null;
  modifiedTime: string;
  native: SyncRecord['native'];
}

export interface LocalFields {
  name: string;
  md5: string;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
}

export function fromEntry(e: RemoteEntry): RemoteFields {
  return {
    id: e.id,
    name: e.name,
    parentId: e.parentId,
    md5: e.md5,
    size: e.size,
    modifiedTime: e.modifiedTime,
    native: e.native ? { mimeType: e.native.mimeType, exportFormat: e.native.exportFormat } : null,
  };
}

export function fromDrive(f: DriveFile, fallbackParent: string): RemoteFields {
  return {
    id: f.id ?? '',
    name: f.name ?? '',
    parentId: f.parents?.[0] ?? fallbackParent,
    md5: f.md5Checksum ?? null,
    size: f.size ? Number(f.size) : null,
    modifiedTime: f.modifiedTime ?? '',
    // Uploads are binary files.
    native: null,
  };
}

export function statOf(e: LocalEntry): StatExpect {
  return { size: e.size, mtimeMs: e.mtimeMs, ctimeMs: e.ctimeMs };
}

export function makeRecord(key: string, local: LocalFields, remote: RemoteFields): SyncRecord {
  return {
    remoteId: remote.id,
    path: key,
    localName: local.name,
    remoteName: remote.name,
    remoteParentId: remote.parentId,
    localMd5: local.md5,
    localSize: local.size,
    localMtimeMs: local.mtimeMs,
    localCtimeMs: local.ctimeMs,
    remoteMd5: remote.md5,
    remoteSize: remote.size,
    remoteModifiedTime: remote.modifiedTime,
    native: remote.native,
    remoteOnly: false,
    restorePending: false,
    remoteTrashed: false,
  };
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

function stamped(base: string, label: string, at: Date, attempt: number): string {
  const dot = base.lastIndexOf('.');
  const stem = dot > 0 ? base.slice(0, dot) : base;
  const ext = dot > 0 ? base.slice(dot) : '';
  const stamp = `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}.${pad(at.getMinutes())}`;
  return `${stem} (${label} ${stamp})${attempt === 0 ? '' : ` ${attempt + 1}`}${ext}`;
}

/** `<stem> (Drive conflict YYYY-MM-DD HH.mm)<ext>`, then ` 2`, ` 3`… (spec §6.9, local time). */
export function conflictName(base: string, at: Date, attempt: number): string {
  return stamped(base, 'Drive conflict', at, attempt);
}

/** `<stem> (local edit YYYY-MM-DD HH.mm)<ext>`, then ` 2`, ` 3`… (spec §6.6 N5). */
export function localEditName(base: string, at: Date, attempt: number): string {
  return stamped(base, 'local edit', at, attempt);
}

/** Internal guard: an action lacks a field its kind needs (shared by every executor module). */
export function need<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) {
    throw new ValidationError(`Internal: ${what} missing for sync action`);
  }
  return value;
}

export function applySelection(file: PairFile, change: SelectionChange): void {
  const pair = file.pair;
  const without = (list: string[], keys: string[]): string[] => {
    const folds = new Set(keys.map(foldKey));
    return list.filter((k) => !folds.has(foldKey(k)));
  };
  if (change.remove) pair.selection = without(pair.selection, change.remove);
  if (change.exclude) {
    pair.selection = without(pair.selection, change.exclude);
    pair.excluded = [...without(pair.excluded, change.exclude), ...change.exclude];
  }
  if (change.add) {
    pair.excluded = without(pair.excluded, change.add);
    pair.selection = [...without(pair.selection, change.add), ...change.add];
  }
}

export function putRecord(file: PairFile, record: SyncRecord, replaces?: string): void {
  file.records = file.records.filter(
    (r) => r.remoteId !== record.remoteId && r.remoteId !== replaces,
  );
  file.records.push(record);
}

export function dropRecord(file: PairFile, remoteId: string): void {
  file.records = file.records.filter((r) => r.remoteId !== remoteId);
}
