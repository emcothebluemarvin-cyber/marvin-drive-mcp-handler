import type { DriveFile, DriveFileList } from '../../drive/drive-adapter.js';
import { GOOGLE_MIME } from '../../files/export-formats.js';
import type { FolderLister } from '../remote-scanner.js';

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

/** A FolderLister over an in-memory tree; folders listed in `failing` throw `failWith`. */
export function treeLister(
  files: DriveFile[],
  opts: { failing?: string[]; failWith?: Error; pageSize?: number } = {},
): FolderLister & { calls: string[] } {
  const calls: string[] = [];
  const lister = async (
    folderId: string,
    pageToken: string | undefined,
  ): Promise<DriveFileList> => {
    calls.push(folderId);
    if (opts.failing?.includes(folderId)) throw opts.failWith ?? new Error('listing failed');
    const children = files.filter((f) => f.parents?.includes(folderId) && !f.trashed);
    const size = opts.pageSize ?? 1000;
    const start = pageToken ? Number(pageToken) : 0;
    const page = children.slice(start, start + size);
    const next = start + size < children.length ? String(start + size) : undefined;
    return { files: page, ...(next ? { nextPageToken: next } : {}) };
  };
  return Object.assign(lister, { calls });
}
