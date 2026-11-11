import { ensureExtension } from '../files/filename.js';
import { isAbortError } from './errors.js';
import { baseName, foldKey, isIgnoredName, isRepresentable } from './paths.js';
import type { RemoteItem, SyncRemote } from './remote/sync-remote.js';
import type { RemoteEntry, RemoteScan } from './types.js';

/** What the walk needs from the remote. */
export type FolderLister = Pick<SyncRemote, 'listChildren'>;

/** Local key of a native file's export: Drive name + extension unless present (NFC). */
export function exportKey(parentKey: string, remoteName: string, extension: string): string {
  const name = ensureExtension(remoteName.normalize('NFC'), extension);
  return parentKey === '' ? name : `${parentKey}/${name}`;
}

function joinKey(parent: string, name: string): string {
  const nfc = name.normalize('NFC');
  return parent === '' ? nfc : `${parent}/${nfc}`;
}

/** A remote file at `parentKeyValue`; a native file is keyed by its export name. */
export function toRemoteEntry(
  item: RemoteItem,
  parentKeyValue: string,
  parentId: string,
  ancestorIds: string[],
): RemoteEntry {
  const { name, native } = item;
  const key = native
    ? exportKey(parentKeyValue, name, native.exportFormat)
    : joinKey(parentKeyValue, name);
  return {
    id: item.id,
    key,
    foldKey: foldKey(key),
    name,
    parentId,
    ancestorIds,
    mimeType: item.mimeType,
    hash: native ? null : item.hash,
    size: native ? null : item.size,
    modifiedTime: item.modifiedTime,
    createdTime: item.createdTime,
    canEdit: item.canEdit,
    canTrash: item.canTrash,
    native,
  };
}

async function listAll(list: FolderLister, folderId: string): Promise<RemoteItem[]> {
  const items: RemoteItem[] = [];
  let pageToken: string | undefined;
  do {
    const page = await list.listChildren(folderId, pageToken);
    items.push(...page.items);
    pageToken = page.next;
  } while (pageToken);
  return items;
}

/**
 * Breadth-first walk of the pair's Drive folder (spec §4 remote-scanner). Duplicate
 * folder names and failed listings become unknown subtrees. Native files (classified by
 * the remote) are keyed by their export name; unsupported items (shortcuts, natives that
 * cannot be exported), unrepresentable and dot/part names are ignored and reported.
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
    let children: RemoteItem[];
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
      if (f.kind === 'folder') {
        const fold = foldKey(f.name);
        folderFolds.set(fold, (folderFolds.get(fold) ?? 0) + 1);
      }
    }
    for (const f of children) {
      const { id, name } = f;
      const representable = isRepresentable(name);
      const key = representable
        ? joinKey(folder.key, name)
        : folder.key === ''
          ? name
          : `${folder.key}/${name}`;
      const isFolder = f.kind === 'folder';
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
      } else if (f.kind === 'unsupported') {
        scan.ignored.push({
          id,
          path: key,
          reason: f.unsupported ?? 'native-unsupported',
          isFolder: false,
        });
      } else {
        const entry = toRemoteEntry(f, folder.key, folder.id, folder.ancestors);
        if (!isRepresentable(baseName(entry.key))) {
          scan.ignored.push({ id, path: key, reason: 'unrepresentable', isFolder: false });
        } else {
          scan.entries.push(entry);
        }
      }
    }
  }
  scan.entries.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : a.id < b.id ? -1 : 1));
  scan.unknownSubtrees = [...new Set(scan.unknownSubtrees)].sort();
  return scan;
}
