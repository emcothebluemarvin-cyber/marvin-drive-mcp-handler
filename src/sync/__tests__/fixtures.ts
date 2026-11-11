import { rename } from 'node:fs/promises';
import path from 'node:path';
import { GOOGLE_MIME } from '../../files/export-formats.js';
import type { LocalTrash } from '../trash.js';
import type { LocalEntry, Pair, PairFile, RemoteEntry, SyncRecord } from '../types.js';
import { DEFAULT_GOOGLE_EXPORT } from '../types.js';
import { foldKey } from '../paths.js';

/** LocalTrash for tests that must never trash anything. */
export const refuseTrash: LocalTrash = {
  trash: async (): Promise<never> => {
    throw new Error('unexpected local trash in this test');
  },
};

/** LocalTrash that moves the file into `dir` (never the user's real trash). */
export function dirTrash(dir: string): LocalTrash {
  return {
    trash: async (abs) => {
      await rename(abs, path.join(dir, path.basename(abs)));
    },
  };
}

export const ROOT_ID = 'root-folder';

export function makePair(overrides: Partial<Pair> = {}): Pair {
  return {
    name: 'docs',
    id: 'pair-id-1',
    account: 'emco',
    localDir: '/tmp/sync-docs',
    caseInsensitive: true,
    remoteFolderId: ROOT_ID,
    googleExport: { ...DEFAULT_GOOGLE_EXPORT },
    selection: [],
    excluded: [],
    remoteBaseline: [],
    baselineFolders: [],
    createdAt: '2026-11-01T00:00:00.000Z',
    lastAppliedRunAt: '2026-11-02T00:00:00.000Z',
    firstAppliedRunAt: '2026-11-02T00:00:00.000Z',
    nativeBaselineDone: true,
    ...overrides,
  };
}

export function makePairFile(pair: Partial<Pair> = {}, records: SyncRecord[] = []): PairFile {
  return { version: 1, pair: makePair(pair), records };
}

export function localEntry(name: string, overrides: Partial<LocalEntry> = {}): LocalEntry {
  const key = name.normalize('NFC');
  return {
    key,
    foldKey: foldKey(key),
    name,
    size: 10,
    mtimeMs: 1000,
    ctimeMs: 1000,
    ino: 1,
    ...overrides,
  };
}

export function remoteEntry(
  id: string,
  key: string,
  overrides: Partial<RemoteEntry> = {},
): RemoteEntry {
  const nfc = key.normalize('NFC');
  const slash = nfc.lastIndexOf('/');
  return {
    id,
    key: nfc,
    foldKey: foldKey(nfc),
    name: key.slice(key.lastIndexOf('/') + 1),
    parentId: slash === -1 ? ROOT_ID : `folder:${nfc.slice(0, slash)}`,
    ancestorIds: slash === -1 ? [ROOT_ID] : [`folder:${nfc.slice(0, slash)}`, ROOT_ID],
    mimeType: 'application/pdf',
    md5: `md5-${id}`,
    size: 10,
    modifiedTime: '2026-11-02T00:00:00.000Z',
    createdTime: '2026-11-01T00:00:00.000Z',
    canEdit: true,
    canTrash: true,
    native: null,
    ...overrides,
  };
}

/** A record in sync with `localEntry(key)` and `remoteEntry(remoteId, key)`. */
export function record(
  remoteId: string,
  key: string,
  overrides: Partial<SyncRecord> = {},
): SyncRecord {
  const nfc = key.normalize('NFC');
  const slash = nfc.lastIndexOf('/');
  return {
    remoteId,
    path: nfc,
    localName: key,
    remoteName: key.slice(key.lastIndexOf('/') + 1),
    remoteParentId: slash === -1 ? ROOT_ID : `folder:${nfc.slice(0, slash)}`,
    localMd5: `md5-${remoteId}`,
    localSize: 10,
    localMtimeMs: 1000,
    localCtimeMs: 1000,
    remoteMd5: `md5-${remoteId}`,
    remoteSize: 10,
    remoteModifiedTime: '2026-11-02T00:00:00.000Z',
    native: null,
    remoteOnly: false,
    restorePending: false,
    remoteTrashed: false,
    ...overrides,
  };
}

export const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

/** A Google Doc exported as docx; `key` is the export key (e.g. `Plan.docx`). */
export function nativeEntry(
  id: string,
  key: string,
  overrides: Partial<RemoteEntry> = {},
): RemoteEntry {
  const base = key.slice(key.lastIndexOf('/') + 1);
  return remoteEntry(id, key, {
    name: base.replace(/\.docx$/, ''),
    mimeType: GOOGLE_MIME.document,
    md5: null,
    size: null,
    native: { mimeType: GOOGLE_MIME.document, exportFormat: 'docx', exportMime: DOCX_MIME },
    ...overrides,
  });
}

/** A native record in sync with `localEntry(key)` and `nativeEntry(remoteId, key)`. */
export function nativeRecord(
  remoteId: string,
  key: string,
  overrides: Partial<SyncRecord> = {},
): SyncRecord {
  const base = key.slice(key.lastIndexOf('/') + 1);
  return record(remoteId, key, {
    remoteName: base.replace(/\.docx$/, ''),
    remoteMd5: null,
    remoteSize: null,
    native: { mimeType: GOOGLE_MIME.document, exportFormat: 'docx' },
    ...overrides,
  });
}
