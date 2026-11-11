import type { Readable } from 'node:stream';
import type { ExportPlan } from '../../files/export-formats.js';
import type { NativeInfo } from '../types.js';

/*
 * The sync engine's only view of a cloud drive (OneDrive sync spec §2.1). Implementations
 * own transport, retries and error mapping; the engine keeps every decision and audit record.
 */

export type HashKind = 'md5' | 'quickXor';

export interface ContentHash {
  kind: HashKind;
  value: string;
}

/** Why a remote item is never synced (reported as `ignored`). */
export type RemoteUnsupported =
  'native-unsupported' | 'shortcut' | 'onenote' | 'special' | 'shared';

export interface RemoteItem {
  id: string;
  name: string;
  /** First parent; null for the drive root. */
  parentId: string | null;
  kind: 'file' | 'folder' | 'unsupported';
  unsupported?: RemoteUnsupported;
  mimeType: string;
  size: number | null;
  /** Google: modifiedTime. OneDrive: item lastModifiedDateTime (renames and moves bump it). */
  modifiedTime: string;
  createdTime: string;
  hash: ContentHash | null;
  /** OneDrive eTag, sent as If-Match; null on Google. */
  version: string | null;
  /** Google trashed flag; always false on OneDrive (deleted items are 404). */
  trashed: boolean;
  canEdit: boolean;
  canTrash: boolean;
  /** Unknown counts as allowed (Drive may omit the capability). */
  canAddChildren: boolean;
  /** Google-native file that exports; null elsewhere. */
  native: NativeInfo | null;
}

/** A native file re-read for an export (Google only); the remote keeps what the export needs. */
export interface NativeSource {
  readonly item: RemoteItem;
}

/** Opens a content stream; called again when the remote retries the consumer. */
export type OpenStream = () => Promise<Readable>;

export interface DeletionFeed {
  /** Cursor for "from now on", without enumerating. */
  start(): Promise<string>;
  /** Ids reported deleted since `cursor`, and the next cursor; an expired cursor → `expired`. */
  read(cursor: string): Promise<{ deletedIds: string[]; cursor: string } | { expired: true }>;
}

export interface SyncRemote {
  readonly provider: 'google' | 'microsoft';
  /** The hash kind this remote reports for files. */
  readonly hashKind: HashKind;
  /** Default pair root when the caller gives none. */
  readonly rootId: string;
  /** The resolved account alias (stored as `pair.account`, used in audit records). */
  readonly account: string;
  /** null when the item does not exist or cannot be read (404/403); other errors throw. */
  get(id: string, signal?: AbortSignal): Promise<RemoteItem | null>;
  /** Like `get`, but a missing or unreadable item throws the provider's error. */
  read(id: string, signal?: AbortSignal): Promise<RemoteItem>;
  listChildren(
    folderId: string,
    pageToken: string | undefined,
    signal?: AbortSignal,
  ): Promise<{ items: RemoteItem[]; next?: string }>;
  /** Children whose name folds to `name`'s fold key; the engine decides what to do. */
  findChildren(parentId: string, name: string, kind?: 'folder'): Promise<RemoteItem[]>;
  createFolder(parentId: string, name: string): Promise<RemoteItem>;
  uploadNew(parentId: string, name: string, localPath: string): Promise<RemoteItem>;
  replaceContent(item: RemoteItem, localPath: string): Promise<RemoteItem>;
  /**
   * Runs `consume` with an opener for the file's content inside one retried operation, so
   * `consume` must open the stream itself. Verification is the caller's.
   */
  download<T>(id: string, consume: (open: OpenStream) => Promise<T>): Promise<T>;
  /** Google only: re-reads a native file with what its export needs. */
  readNative(id: string): Promise<NativeSource>;
  /** Google only: like `download`, for the export of `source` in `plan`'s format. */
  exportNative<T>(
    source: NativeSource,
    plan: ExportPlan,
    consume: (open: OpenStream) => Promise<T>,
  ): Promise<T>;
  /** Moves the item to the provider's trash / recycle bin. */
  trash(item: RemoteItem): Promise<void>;
  /** OneDrive only; Google returns null. */
  deletionFeed(): DeletionFeed | null;
}
