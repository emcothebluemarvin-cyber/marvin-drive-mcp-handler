import type { DriveFile, DriveFileList } from '../drive/drive-adapter.js';
import { GOOGLE_MIME, isGoogleNative } from '../files/export-formats.js';
import { escapeQueryValue } from '../files/query.js';
import { isAbortError } from './errors.js';
import { foldKey, isIgnoredName, isRepresentable } from './paths.js';
import { SYNC_FILE_FIELDS, type RemoteEntry, type RemoteScan } from './types.js';

export const SYNC_LIST_FIELDS = `nextPageToken, files(${SYNC_FILE_FIELDS})`;
export const SYNC_PAGE_SIZE = 1000;

/** Lists one page of a folder's non-trashed children. */
export type FolderLister = (
  folderId: string,
  pageToken: string | undefined,
) => Promise<DriveFileList>;

export function childrenQuery(folderId: string): string {
  return `'${escapeQueryValue(folderId)}' in parents and trashed = false`;
}

function joinKey(parent: string, name: string): string {
  const nfc = name.normalize('NFC');
  return parent === '' ? nfc : `${parent}/${nfc}`;
}

export function toRemoteEntry(
  file: DriveFile,
  parentKeyValue: string,
  parentId: string,
  ancestorIds: string[],
): RemoteEntry {
  const key = joinKey(parentKeyValue, file.name ?? '');
  return {
    id: file.id ?? '',
    key,
    foldKey: foldKey(key),
    name: file.name ?? '',
    parentId,
    ancestorIds,
    mimeType: file.mimeType ?? 'application/octet-stream',
    md5: file.md5Checksum ?? null,
    size: file.size ? Number(file.size) : null,
    modifiedTime: file.modifiedTime ?? '',
    createdTime: file.createdTime ?? '',
    canEdit: file.capabilities?.canEdit ?? false,
    canTrash: file.capabilities?.canTrash ?? false,
  };
}

async function listAll(list: FolderLister, folderId: string): Promise<DriveFile[]> {
  const files: DriveFile[] = [];
  let pageToken: string | undefined;
  do {
    const page = await list(folderId, pageToken);
    files.push(...(page.files ?? []));
    pageToken = page.nextPageToken ?? undefined;
  } while (pageToken);
  return files;
}

/**
 * Breadth-first walk of the pair's Drive folder (spec §4 remote-scanner). Duplicate
 * folder names and failed listings become unknown subtrees; shortcuts, Google-native
 * files (Phase A), unrepresentable and dot/part names are ignored and reported.
 */
export async function scanRemote(rootId: string, list: FolderLister): Promise<RemoteScan> {
  const scan: RemoteScan = {
    entries: [],
    ignored: [],
    folders: new Map([[rootId, '']]),
    unknownSubtrees: [],
    unknownFolderIds: [],
  };
  const queue: Array<{ id: string; key: string; ancestors: string[] }> = [
    { id: rootId, key: '', ancestors: [rootId] },
  ];
  for (let next = queue.shift(); next; next = queue.shift()) {
    const folder = next;
    let children: DriveFile[];
    try {
      children = await listAll(list, folder.id);
    } catch (err) {
      if (isAbortError(err) || folder.id === rootId) throw err;
      scan.folders.delete(folder.id);
      scan.unknownSubtrees.push(folder.key);
      scan.unknownFolderIds.push(folder.id);
      continue;
    }
    const folderFolds = new Map<string, number>();
    for (const f of children) {
      if (f.mimeType === GOOGLE_MIME.folder) {
        const fold = foldKey(f.name ?? '');
        folderFolds.set(fold, (folderFolds.get(fold) ?? 0) + 1);
      }
    }
    for (const f of children) {
      const id = f.id ?? '';
      const name = f.name ?? '';
      const representable = isRepresentable(name);
      const key = representable
        ? joinKey(folder.key, name)
        : folder.key === ''
          ? name
          : `${folder.key}/${name}`;
      const isFolder = f.mimeType === GOOGLE_MIME.folder;
      if (!representable) {
        scan.ignored.push({ id, path: key, reason: 'unrepresentable', isFolder });
      } else if (isIgnoredName(name)) {
        scan.ignored.push({ id, path: key, reason: 'ignored-name', isFolder });
      } else if (isFolder) {
        if ((folderFolds.get(foldKey(name)) ?? 0) > 1) {
          scan.unknownSubtrees.push(key);
          scan.unknownFolderIds.push(id);
        } else {
          scan.folders.set(id, key);
          queue.push({ id, key, ancestors: [id, ...folder.ancestors] });
        }
      } else if (f.mimeType === GOOGLE_MIME.shortcut) {
        scan.ignored.push({ id, path: key, reason: 'shortcut', isFolder: false });
      } else if (isGoogleNative(f.mimeType ?? '')) {
        scan.ignored.push({ id, path: key, reason: 'native-skipped', isFolder: false });
      } else {
        scan.entries.push(toRemoteEntry(f, folder.key, folder.id, folder.ancestors));
      }
    }
  }
  scan.entries.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : a.id < b.id ? -1 : 1));
  scan.unknownSubtrees = [...new Set(scan.unknownSubtrees)].sort();
  return scan;
}
