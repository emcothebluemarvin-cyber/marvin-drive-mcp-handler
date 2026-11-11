import { stat } from 'node:fs/promises';
import {
  GraphApiError,
  NotFoundError,
  PermissionDeniedError,
  TargetChangedError as GraphTargetChangedError,
  ValidationError,
} from '../../errors.js';
import { childPath, itemPath, type GraphClient } from '../../onedrive/graph-client.js';
import { mimeOf, type GraphItem } from '../../onedrive/map-item.js';
import { TargetChangedError } from '../errors.js';
import { foldKey } from '../paths.js';
import type {
  DeletionFeed,
  NativeSource,
  OpenStream,
  RemoteItem,
  SyncRemote,
} from './sync-remote.js';

/** Graph fields every sync read requests; `file` carries `hashes.quickXorHash`. */
export const ONEDRIVE_SYNC_SELECT =
  'id,name,size,eTag,createdDateTime,lastModifiedDateTime,file,folder,package,remoteItem,parentReference';
export const ONEDRIVE_PAGE_SIZE = 200;
/** Up to this size a simple PUT is used, so If-Match is checked when the write happens. */
export const SIMPLE_UPLOAD_MAX = 4 * 1024 * 1024;
const CONFLICT_FAIL = '@microsoft.graph.conflictBehavior';

/** A driveItem as sync reads it (the hashes are inside the `file` facet). */
export interface SyncGraphItem extends Omit<GraphItem, 'file'> {
  file?: { mimeType?: string; hashes?: { quickXorHash?: string; sha1Hash?: string } };
}

interface GraphPage {
  value?: SyncGraphItem[];
  '@odata.nextLink'?: string;
  '@odata.deltaLink'?: string;
}

/** A driveItem as the engine sees it (OneDrive sync spec §2.1, §4.2). */
export function toRemoteItemFromGraph(item: SyncGraphItem): RemoteItem {
  const quickXor = item.file?.hashes?.quickXorHash;
  const base = {
    id: item.id,
    name: item.name,
    parentId: item.parentReference?.id ?? null,
    mimeType: mimeOf(item as GraphItem),
    size: item.file && typeof item.size === 'number' ? item.size : null,
    modifiedTime: item.lastModifiedDateTime ?? '',
    createdTime: item.createdDateTime ?? '',
    hash: quickXor ? { kind: 'quickXor' as const, value: quickXor } : null,
    version: item.eTag ?? null,
    trashed: false,
    canEdit: true,
    canTrash: true,
    canAddChildren: true,
    native: null,
  };
  if (item.remoteItem) return { ...base, kind: 'unsupported', unsupported: 'shared' };
  if (item.package) return { ...base, kind: 'unsupported', unsupported: 'onenote' };
  if (item.folder) return { ...base, kind: 'folder' };
  if (item.file) return { ...base, kind: 'file' };
  return { ...base, kind: 'unsupported', unsupported: 'special' };
}

function noExport(): never {
  throw new ValidationError('Google-native exports do not exist on OneDrive');
}

/** A 412 from Graph is the engine's "changed since the scan" skip (spec §5). */
function changedSinceScan(err: unknown, name: string): unknown {
  if (err instanceof GraphTargetChangedError) {
    return new TargetChangedError(`${name} changed on OneDrive since the scan`, { cause: err });
  }
  return err;
}

/**
 * SyncRemote over sub-project 1's GraphClient (OneDrive sync spec §2.2). Personal drives
 * only: the user's own items; shared items (`remoteItem`) are reported, never followed.
 * The optional signals are checked before each request (GraphClient has no cancellation).
 */
export class OneDriveSyncRemote implements SyncRemote {
  readonly provider = 'microsoft';
  readonly hashKind = 'quickXor';
  readonly rootId = 'root';
  private driveId: Promise<string> | undefined;

  constructor(
    private readonly client: GraphClient,
    readonly account: string,
  ) {}

  /** The drive id, for `checkPageToken` (read once per remote). */
  private drive(): Promise<string> {
    if (!this.driveId) {
      const read = this.client
        .get<{ id: string }>('/me/drive?$select=id')
        .then((drive) => drive.id);
      read.catch(() => {
        this.driveId = undefined;
      });
      this.driveId = read;
    }
    return this.driveId;
  }

  /** Follows a page or delta link after the sub-project 1 host and shape check. */
  private async follow(link: string): Promise<GraphPage> {
    this.client.checkPageToken(link, await this.drive());
    return this.client.page<GraphPage>(link);
  }

  async read(id: string, signal?: AbortSignal): Promise<RemoteItem> {
    signal?.throwIfAborted();
    const item = await this.client.get<SyncGraphItem>(
      `${itemPath(id)}?$select=${ONEDRIVE_SYNC_SELECT}`,
      id,
    );
    return toRemoteItemFromGraph(item);
  }

  async get(id: string, signal?: AbortSignal): Promise<RemoteItem | null> {
    try {
      return await this.read(id, signal);
    } catch (err) {
      if (err instanceof NotFoundError || err instanceof PermissionDeniedError) return null;
      throw err;
    }
  }

  async listChildren(
    folderId: string,
    pageToken: string | undefined,
    signal?: AbortSignal,
  ): Promise<{ items: RemoteItem[]; next?: string }> {
    signal?.throwIfAborted();
    const page = pageToken
      ? await this.follow(pageToken)
      : await this.client.get<GraphPage>(
          `${itemPath(folderId)}/children?$select=${ONEDRIVE_SYNC_SELECT}&$top=${ONEDRIVE_PAGE_SIZE}`,
          folderId,
        );
    const items = (page.value ?? []).map(toRemoteItemFromGraph);
    const next = page['@odata.nextLink'];
    return next ? { items, next } : { items };
  }

  /** Every child (all pages) whose name folds to `name`'s fold key; folders only on request. */
  async findChildren(parentId: string, name: string, kind?: 'folder'): Promise<RemoteItem[]> {
    const fold = foldKey(name);
    const found: RemoteItem[] = [];
    let token: string | undefined;
    do {
      const page = await this.listChildren(parentId, token);
      for (const item of page.items) {
        if (foldKey(item.name) !== fold) continue;
        if (kind === 'folder' && item.kind !== 'folder') continue;
        found.push(item);
      }
      token = page.next;
    } while (token);
    return found;
  }

  /** conflictBehavior=fail: a taken name raises NameConflictError (never a renamed copy). */
  async createFolder(parentId: string, name: string): Promise<RemoteItem> {
    const created = await this.client.json<SyncGraphItem>(
      'POST',
      `${itemPath(parentId)}/children?$select=${ONEDRIVE_SYNC_SELECT}`,
      { retry: 'create', target: name, body: { name, folder: {}, [CONFLICT_FAIL]: 'fail' } },
    );
    return toRemoteItemFromGraph({ parentReference: { id: parentId }, ...created });
  }

  async uploadNew(parentId: string, name: string, localPath: string): Promise<RemoteItem> {
    const { size } = await stat(localPath);
    const target = childPath(parentId, name);
    const uploaded =
      size <= SIMPLE_UPLOAD_MAX
        ? await this.client.json<SyncGraphItem>('PUT', `${target}:/content?${CONFLICT_FAIL}=fail`, {
            retry: 'create',
            target: name,
            ...(size > 0 ? { file: { localPath, size } } : {}),
          })
        : await this.client.upload<SyncGraphItem>({
            createPath: `${target}:/createUploadSession`,
            body: { item: { [CONFLICT_FAIL]: 'fail' } },
            localPath,
            size,
            target: name,
          });
    return toRemoteItemFromGraph({ parentReference: { id: parentId }, ...uploaded });
  }

  /** If-Match with the re-read eTag; a 412 is TargetChangedError (spec §3.4). */
  async replaceContent(item: RemoteItem, localPath: string): Promise<RemoteItem> {
    if (!item.version) {
      throw new TargetChangedError(`${item.name} has no version on OneDrive; scan again`);
    }
    const { size } = await stat(localPath);
    const headers = { 'If-Match': item.version };
    try {
      const replaced =
        size <= SIMPLE_UPLOAD_MAX
          ? await this.client.json<SyncGraphItem>('PUT', `${itemPath(item.id)}/content`, {
              retry: 'create',
              target: item.name,
              headers,
              ...(size > 0 ? { file: { localPath, size } } : {}),
            })
          : await this.client.upload<SyncGraphItem>({
              createPath: `${itemPath(item.id)}/createUploadSession`,
              body: { item: { [CONFLICT_FAIL]: 'replace' } },
              headers,
              localPath,
              size,
              target: item.name,
            });
      const parentReference = { id: item.parentId ?? '' };
      return toRemoteItemFromGraph({ parentReference, ...replaced });
    } catch (err) {
      throw changedSinceScan(err, item.name);
    }
  }

  download<T>(id: string, consume: (open: OpenStream) => Promise<T>): Promise<T> {
    return consume(() => this.client.download(`${itemPath(id)}/content`, id));
  }

  readNative(): Promise<NativeSource> {
    return Promise.resolve().then(noExport);
  }

  exportNative<T>(): Promise<T> {
    return Promise.resolve().then(noExport);
  }

  /** DELETE with If-Match: OneDrive moves the item to its recycle bin. */
  async trash(item: RemoteItem): Promise<void> {
    if (!item.version) {
      throw new TargetChangedError(`${item.name} has no version on OneDrive; scan again`);
    }
    try {
      await this.client.json('DELETE', itemPath(item.id), {
        retry: 'idempotent',
        target: item.name,
        headers: { 'If-Match': item.version },
        notFoundOnRepeatIsOk: true,
      });
    } catch (err) {
      throw changedSinceScan(err, item.name);
    }
  }

  /** The drive-wide root `delta` feed (spec §4.1); only `deleted` entries are evidence. */
  deletionFeed(): DeletionFeed {
    return {
      start: async (): Promise<string> => {
        const page = await this.client.get<GraphPage>('/me/drive/root/delta?token=latest');
        const link = page['@odata.deltaLink'];
        if (!link) throw new GraphApiError(undefined);
        return link;
      },
      read: async (
        cursor: string,
      ): Promise<{ deletedIds: string[]; cursor: string } | { expired: true }> => {
        const deletedIds: string[] = [];
        try {
          for (let link = cursor; ;) {
            const page = await this.follow(link);
            for (const item of page.value ?? []) if (item.deleted) deletedIds.push(item.id);
            const next = page['@odata.nextLink'];
            if (next) {
              link = next;
              continue;
            }
            const delta = page['@odata.deltaLink'];
            if (!delta) throw new GraphApiError(undefined);
            return { deletedIds, cursor: delta };
          }
        } catch (err) {
          if (err instanceof GraphApiError && err.status === 410) return { expired: true };
          throw err;
        }
      },
    };
  }
}
