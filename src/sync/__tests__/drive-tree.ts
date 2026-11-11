import type { DriveFile } from '../../drive/drive-adapter.js';
import { GOOGLE_MIME } from '../../files/export-formats.js';
import { toRemoteItem } from '../remote/google-remote.js';
import type { RemoteItem } from '../remote/sync-remote.js';
import type { FolderLister } from '../remote-scanner.js';
import { DEFAULT_GOOGLE_EXPORT, type GoogleExportPrefs } from '../types.js';

export function folder(id: string, name: string, parent: string): DriveFile {
  return { id, name, mimeType: GOOGLE_MIME.folder, parents: [parent] };
}

export function binary(id: string, name: string, parent: string, extra: DriveFile = {}): DriveFile {
  return {
    id,
    name,
    mimeType: 'application/pdf',
    parents: [parent],
    md5Checksum: `md5-${id}`,
    size: '10',
    modifiedTime: '2026-11-02T00:00:00.000Z',
    createdTime: '2026-11-01T00:00:00.000Z',
    capabilities: { canEdit: true, canTrash: true, canAddChildren: false },
    ...extra,
  };
}

/**
 * A FolderLister over an in-memory Drive tree (items mapped like GoogleSyncRemote does);
 * folders listed in `failing` throw `failWith`.
 */
export function treeLister(
  files: DriveFile[],
  opts: { failing?: string[]; failWith?: Error; pageSize?: number; prefs?: GoogleExportPrefs } = {},
): FolderLister & { calls: string[] } {
  const calls: string[] = [];
  const listChildren = async (
    folderId: string,
    pageToken: string | undefined,
  ): Promise<{ items: RemoteItem[]; next?: string }> => {
    calls.push(folderId);
    if (opts.failing?.includes(folderId)) throw opts.failWith ?? new Error('listing failed');
    const children = files.filter((f) => f.parents?.includes(folderId) && !f.trashed);
    const size = opts.pageSize ?? 1000;
    const start = pageToken ? Number(pageToken) : 0;
    const page = children.slice(start, start + size);
    const next = start + size < children.length ? String(start + size) : undefined;
    const items = page.map((f) => toRemoteItem(f, opts.prefs ?? DEFAULT_GOOGLE_EXPORT));
    return { items, ...(next ? { next } : {}) };
  };
  return { listChildren, calls };
}
