import type { ExportFormat } from '../files/export-formats.js';
import type { ContentHash, RemoteUnsupported } from './remote/sync-remote.js';

/** Pair names: lower-case letters, digits and dashes (spec §3). */
export const PAIR_NAME = /^[a-z0-9-]{1,40}$/;

export interface GoogleExportPrefs {
  document: ExportFormat;
  spreadsheet: ExportFormat;
  presentation: ExportFormat;
  drawing: ExportFormat;
}

/** Export formats used when a pair gives no `googleExport`; validated at sync_create_pair. */
export const DEFAULT_GOOGLE_EXPORT: GoogleExportPrefs = {
  document: 'docx',
  spreadsheet: 'xlsx',
  presentation: 'pptx',
  drawing: 'pdf',
};

export interface Pair {
  name: string;
  id: string;
  account: string;
  localDir: string;
  caseInsensitive: boolean;
  remoteFolderId: string;
  googleExport: GoogleExportPrefs;
  selection: string[];
  excluded: string[];
  remoteBaseline: string[];
  baselineFolders: string[];
  createdAt: string;
  lastAppliedRunAt: string | null;
  firstAppliedRunAt: string | null;
  /** Addendum §4.1: false until the first applied run that baselined Google-native files. */
  nativeBaselineDone: boolean;
  /** OneDrive deletion feed cursor (spec §4.1); always null on Google pairs. */
  remoteCursor: string | null;
  /** Remote ids the deletion feed reported deleted and not yet acted on; empty on Google. */
  remoteDeletedIds: string[];
}

export interface SyncRecord {
  remoteId: string;
  path: string;
  localName: string;
  remoteName: string;
  remoteParentId: string;
  localMd5: string;
  localSize: number;
  localMtimeMs: number;
  localCtimeMs: number;
  /** The remote's hash at the last sync (md5 on Google); null when it reported none. */
  remoteHash: ContentHash | null;
  remoteSize: number | null;
  remoteModifiedTime: string;
  native: null | { mimeType: string; exportFormat: ExportFormat };
  remoteOnly: boolean;
  restorePending: boolean;
  remoteTrashed: boolean;
}

export interface PairFile {
  version: 2;
  pair: Pair;
  records: SyncRecord[];
}

/** A regular local file. `name` is the on-disk relative POSIX path; `key` its NFC form. */
export interface LocalEntry {
  key: string;
  foldKey: string;
  name: string;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  ino: number;
}

export interface LocalScan {
  entries: LocalEntry[];
  /** Keys of existing non-regular or ignored entries (dirs, symlinks, dot-files…). */
  occupied: string[];
  /** Keys of directories/entries that could not be read. */
  unknownSubtrees: string[];
  /** Keys that block everything below them: symlinks, special files, dot-named folders. */
  blocking: string[];
  /** `*.marvin-part` temp files (on-disk relative names). */
  partFiles: Array<{ name: string; mtimeMs: number }>;
}

/** `lstat` of a record key that has no exact scan match (spec §6.1 step 4). */
export interface OnDiskProbe {
  kind: 'file' | 'dir' | 'symlink' | 'other' | 'error';
  ino: number;
}

/**
 * A local file's digests (OneDrive sync spec §3.1): its md5, and the digest of the remote's
 * hash kind (the same md5 on Google). `remote` is null only when it was not computed: a
 * stat-unchanged tracked file on a remote whose kind is not md5 (§3.1 "Stat-unchanged").
 */
export interface LocalDigests {
  md5: string;
  remote: ContentHash | null;
}

/** Export settings of a Google-native Drive file (addendum §4.1). */
export interface NativeInfo {
  mimeType: string;
  exportFormat: ExportFormat;
  exportMime: string;
}

export interface RemoteEntry {
  id: string;
  key: string;
  foldKey: string;
  name: string;
  parentId: string;
  /** Folder ids from the parent up to the pair root (inclusive). */
  ancestorIds: string[];
  mimeType: string;
  /** Content hash of a binary file; null for natives and when the remote reports none. */
  hash: ContentHash | null;
  size: number | null;
  modifiedTime: string;
  createdTime: string;
  canEdit: boolean;
  canTrash: boolean;
  /** Google-native file synced as a read-only export; null for binary files. */
  native: NativeInfo | null;
}

export type RemoteIgnoreReason = RemoteUnsupported | 'unrepresentable' | 'ignored-name';

/** Report texts of the OneDrive items that are never synced (OneDrive sync spec §4.2). */
export const UNSUPPORTED_TEXT: Readonly<Partial<Record<RemoteUnsupported, string>>> = {
  onenote: 'OneNote notebook, cannot be synced',
  special: 'special item, cannot be synced',
  shared: 'shared item, out of scope',
};

export interface RemoteIgnored {
  id: string;
  /** Relative path when representable, else the raw name. */
  path: string;
  reason: RemoteIgnoreReason;
  isFolder: boolean;
}

export interface RemoteScan {
  entries: RemoteEntry[];
  ignored: RemoteIgnored[];
  /** Scanned folder id → key ('' for the pair root). */
  folders: Map<string, string>;
  unknownSubtrees: string[];
  unknownFolderIds: string[];
}

export type Probe =
  | { state: 'trashed' }
  | { state: 'present'; entry: RemoteEntry }
  | { state: 'moved-out' }
  | { state: 'unavailable' }
  | { state: 'unknown'; reason: string };

export type ActionKind =
  | 'upload-new'
  | 'update-remote'
  | 'download-new'
  | 'download-replace'
  | 'export-new'
  | 'export-replace'
  | 'move-local'
  | 'conflict'
  | 'trash-remote'
  | 'trash-local'
  | 'adopt'
  | 'forget'
  | 'untrack'
  | 'refresh';

/** Selection/excluded edits applied only after the action succeeds (spec §6.3). */
export interface SelectionChange {
  add?: string[];
  remove?: string[];
  exclude?: string[];
}

export interface Action {
  kind: ActionKind;
  /** Spec rule that produced it (B3, U1…). */
  rule: string;
  /** Final key (record path after success). */
  key: string;
  record: SyncRecord | null;
  local: LocalEntry | null;
  localMd5: string | null;
  /** The planned local content (md5 and the remote's kind); null when no local file is read. */
  localDigests?: LocalDigests | null;
  remote: RemoteEntry | null;
  selection: SelectionChange;
  /** move-local: rename in place (case-only change on a case-insensitive volume). */
  inPlace?: boolean;
  /** move-local: download R over the moved file afterwards (R changed too). */
  thenDownload?: boolean;
  /** conflict: also upload L over R (false when R is read-only). */
  updateRemote?: boolean;
  /** upload-new: replaces this trashed record (B11). */
  rebaseFrom?: string;
  /** export-new (N5): move the locally edited L aside as `<stem> (local edit …)<ext>` first. */
  localEdit?: boolean;
  /** refresh: record fields to set (remote-only bookkeeping O3–O6); no file is touched. */
  patch?: Partial<SyncRecord>;
  /** B5 only: the local copy was deleted; trash-remote waits for confirmRemoteTrash (addendum §2). */
  reason?: 'local-deleted';
}

export type NoteCode =
  | 'unknown-state'
  | 'ambiguous'
  | 'collision'
  | 'conflict-rename'
  | 'moved-out'
  | 'moved-into-excluded'
  | 'remote-unavailable'
  | 'remote-readonly'
  | 'cannot-trash'
  | 'missing'
  | 'native-unsupported'
  | 'unrepresentable'
  | 'ambiguous-native'
  | 'weak-compare'
  | 'native-readonly-edited'
  | 'native-local-missing'
  | 'native-trashed-edited'
  | 'remote-only-trashed'
  | 'remote-name-invalid'
  | 'ignored';

export interface Note {
  code: NoteCode;
  path: string;
  rule: string;
  remoteId?: string;
  message?: string;
}

export interface Candidate {
  path: string;
  size: number | null;
  modifiedTime: string;
  remoteId?: string;
}

export interface BrakeInfo {
  tripped: boolean;
  trashRemote: number;
  trashLocal: number;
  tracked: number;
}

export interface Plan {
  planId: string;
  actions: Action[];
  notes: Note[];
  candidates: { local: Candidate[]; remote: Candidate[]; truncated: boolean };
  brake: BrakeInfo;
  /** Brake over deletions that run without confirmation (addendum §2.6). */
  brakeUnconfirmed: BrakeInfo;
  /** What the first applied run stores as remoteBaseline / baselineFolders (spec §5 step 7). */
  baseline: { files: string[]; folders: string[] };
  /** Untracked Google-native files seen (upgrade baseline, addendum §4.1). */
  nativeBaseline: string[];
  /** Record paths in sync at planning (B1/N1). */
  inSync: string[];
}

export interface ActionOutcome {
  kind: ActionKind;
  path: string;
  status: 'done' | 'skipped' | 'collision' | 'failed' | 'not-run';
  message?: string;
  conflictCopy?: string;
  /** e.g. `changed-during-upload`. */
  warning?: string;
}

export interface SyncReport {
  pair: string;
  dryRun: boolean;
  planId: string;
  aborted: null | { reason: 'plan-changed' | 'mass-delete'; message: string };
  actions: Partial<Record<ActionKind, string[]>>;
  conflicts: Array<{ path: string; conflictCopy?: string }>;
  collisions: string[];
  ambiguous: string[];
  unknown: Array<{ path: string; reason?: string }>;
  warnings: Array<{ path: string; code: string; message?: string }>;
  failures: Array<{ path: string; kind: ActionKind; message: string }>;
  notRun: string[];
  candidates: { local: Candidate[]; remote: Candidate[]; truncated: boolean };
  /** B5 deletions waiting for confirmRemoteTrash (addendum §2.3). */
  pendingConfirmation: Array<{ path: string; remoteId: string }>;
  /** Applied runs: files sync_release could release now (spec §10). */
  releasable?: string[];
}
