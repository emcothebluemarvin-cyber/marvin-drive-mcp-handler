import type { AuditOp, AuditSink } from '../audit/audit-log.js';
import {
  CopyStillRunningError,
  NameConflictError,
  NotFoundError,
  UnsupportedTypeError,
  ValidationError,
} from '../errors.js';
import { resolveDestination, writeUnique } from '../files/destination.js';
import {
  clampPageSize,
  type CopyInput,
  type CreateFolderInput,
  type DeleteInput,
  type DeleteResult,
  type DownloadInput,
  type DownloadResult,
  type FileRef,
  type FileSummary,
  type ListInput,
  type ListResult,
  type MoveInput,
  type OneDriveMetadata,
  type RenameInput,
  type SearchInput,
} from '../files/file-provider.js';
import { logger as defaultLogger, type Logger } from '../logger.js';
import { assertSafeName, childPath, itemPath, type GraphClient } from './graph-client.js';
import {
  FOLDER_MIME,
  PACKAGE_MIME,
  mimeOf,
  toMetadata,
  toSummary,
  type GraphItem,
} from './map-item.js';

export const ITEM_SELECT =
  'id,name,size,eTag,webUrl,createdDateTime,lastModifiedDateTime,file,folder,package,remoteItem,deleted,parentReference,createdBy,lastModifiedBy';

export interface OneDriveFileServiceDeps {
  clients: (alias: string) => Promise<GraphClient>;
  audit: AuditSink;
  downloadsDir: string;
  logger?: Logger;
}

interface DriveInfo {
  driveId: string;
  driveType: string;
  rootId: string;
}

interface GraphPage {
  value?: GraphItem[];
  '@odata.nextLink'?: string;
}

function rejectOption(name: string): never {
  throw new ValidationError(`${name}: this option is not available on OneDrive accounts`);
}

function toResult(page: GraphPage): ListResult {
  return {
    files: (page.value ?? []).filter((item) => !item.remoteItem).map(toSummary),
    ...(page['@odata.nextLink'] ? { nextPageToken: page['@odata.nextLink'] } : {}),
  };
}

/** The `drive_*` operations on a user's own OneDrive through Graph (spec §5). */
export class OneDriveFileService {
  protected readonly log: Logger;
  private readonly driveInfos = new Map<string, Promise<DriveInfo>>();

  constructor(protected readonly deps: OneDriveFileServiceDeps) {
    this.log = deps.logger ?? defaultLogger;
  }

  async list(input: ListInput): Promise<ListResult> {
    if (input.includeTrashed) rejectOption('includeTrashed');
    const { client, alias } = await this.client(input.account);
    if (input.pageToken) return this.nextPage(client, alias, input.pageToken);
    const folder = input.folderId ?? 'root';
    await this.assertOwnItem(client, folder);
    const query = `$top=${clampPageSize(input.pageSize)}&$select=${ITEM_SELECT}`;
    return toResult(await client.get<GraphPage>(`${itemPath(folder)}/children?${query}`, folder));
  }

  async search(input: SearchInput): Promise<ListResult> {
    if (input.rawQuery !== undefined) rejectOption('rawQuery');
    if (input.mimeType !== undefined) rejectOption('mimeType');
    if (input.modifiedAfter !== undefined) rejectOption('modifiedAfter');
    const { client, alias } = await this.client(input.account);
    if (input.pageToken) return this.nextPage(client, alias, input.pageToken);
    if (!input.query?.trim()) throw new ValidationError('query is required on OneDrive accounts');
    const q = encodeURIComponent(input.query.replaceAll("'", "''"));
    const query = `$top=${clampPageSize(input.pageSize)}&$select=${ITEM_SELECT}`;
    return toResult(await client.get<GraphPage>(`/me/drive/root/search(q='${q}')?${query}`));
  }

  async getMetadata(input: FileRef): Promise<OneDriveMetadata> {
    const { client } = await this.client(input.account);
    return toMetadata(await this.readItem(client, input.fileId));
  }

  async download(input: DownloadInput): Promise<DownloadResult> {
    if (input.exportFormat !== undefined) rejectOption('exportFormat');
    const { client } = await this.client(input.account);
    const item = await this.readItem(client, input.fileId);
    if (item.folder) throw new UnsupportedTypeError(FOLDER_MIME);
    if (item.package) throw new UnsupportedTypeError(PACKAGE_MIME);
    const destination = await resolveDestination({
      ...(input.destPath !== undefined ? { destPath: input.destPath } : {}),
      defaultDir: this.deps.downloadsDir,
      driveName: item.name,
      fileId: item.id,
    });
    const written = await writeUnique(destination, () =>
      client.download(`${itemPath(item.id)}/content`, item.name),
    );
    return { path: written.path, size: written.size, mimeType: mimeOf(item), exportFormat: null };
  }

  async createFolder(input: CreateFolderInput): Promise<FileSummary> {
    const { client, alias } = await this.client(input.account);
    const parentId = input.parentId ?? 'root';
    await this.assertOwnItem(client, parentId);
    const created = await client.json<GraphItem>(
      'POST',
      `${itemPath(parentId)}/children?$select=${ITEM_SELECT}`,
      {
        retry: 'create',
        target: input.name,
        body: { name: input.name, folder: {}, '@microsoft.graph.conflictBehavior': 'fail' },
      },
    );
    await this.recordAudit(alias, 'create_folder', created, { parentId });
    return toSummary(created);
  }

  async rename(input: RenameInput): Promise<FileSummary> {
    assertSafeName(input.newName);
    const { client, alias } = await this.client(input.account);
    const item = await this.readItem(client, input.fileId);
    const parentId = item.parentReference?.id;
    if (!parentId) throw new ValidationError('The root folder cannot be renamed');
    await this.assertNameFree(client, parentId, input.newName, item.id);
    const renamed = await client.json<GraphItem>(
      'PATCH',
      `${itemPath(item.id)}?$select=${ITEM_SELECT}`,
      { retry: 'idempotent', target: input.newName, body: { name: input.newName } },
    );
    await this.recordAudit(alias, 'rename', renamed, {
      oldName: item.name,
      newName: input.newName,
    });
    return toSummary(renamed);
  }

  async move(input: MoveInput): Promise<FileSummary> {
    const { client, alias } = await this.client(input.account);
    const item = await this.readItem(client, input.fileId);
    const { rootId } = await this.driveInfo(client, alias);
    const targetId = input.newParentId === 'root' ? rootId : input.newParentId;
    const parent = item.parentReference?.id;
    if (parent === targetId) return toSummary(item);
    await this.assertOwnItem(client, input.newParentId);
    await this.assertNameFree(client, targetId, item.name, item.id);
    const moved = await client.json<GraphItem>(
      'PATCH',
      `${itemPath(item.id)}?$select=${ITEM_SELECT}`,
      { retry: 'idempotent', target: item.name, body: { parentReference: { id: targetId } } },
    );
    await this.recordAudit(alias, 'move', moved, {
      oldParents: parent ? [parent] : [],
      newParentId: input.newParentId,
    });
    return toSummary(moved);
  }

  async copy(input: CopyInput): Promise<FileSummary> {
    if (input.name === undefined && input.parentId === undefined) {
      throw new ValidationError('Give a name or a target folder for the copy on OneDrive');
    }
    const { client, alias } = await this.client(input.account);
    const { driveId, rootId } = await this.driveInfo(client, alias);
    const source = await this.readItem(client, input.fileId);
    const parentId =
      input.parentId === 'root' ? rootId : (input.parentId ?? source.parentReference?.id);
    if (input.parentId !== undefined) await this.assertOwnItem(client, input.parentId);
    if (!parentId) throw new ValidationError('The root folder cannot be copied');
    const target = input.name ?? input.fileId;
    const details = { sourceId: input.fileId, parentId: input.parentId ?? null };
    try {
      const copied = await client.copy<GraphItem>(
        `${itemPath(input.fileId)}/copy`,
        { parentReference: { driveId, id: parentId }, ...(input.name ? { name: input.name } : {}) },
        target,
        (id) =>
          this.readItem(client, id).catch(async (err: unknown) => {
            // The copy exists even though it could not be read back.
            await this.recordAudit(
              alias,
              'copy',
              { id, ...(input.name ? { name: input.name } : {}) },
              details,
            );
            throw err;
          }),
      );
      await this.recordAudit(alias, 'copy', copied, details);
      return toSummary(copied);
    } catch (err) {
      if (err instanceof CopyStillRunningError) {
        await this.recordAudit(
          alias,
          'copy',
          { id: input.fileId, ...(input.name ? { name: input.name } : {}) },
          { ...details, pending: true },
        );
      }
      throw err;
    }
  }

  async delete(input: DeleteInput): Promise<DeleteResult> {
    if (input.permanent) rejectOption('permanent');
    const { client, alias } = await this.client(input.account);
    const item = await this.readItem(client, input.fileId);
    if (!item.parentReference?.id) throw new ValidationError('The root folder cannot be deleted');
    await client.json('DELETE', itemPath(item.id), {
      retry: 'idempotent',
      target: item.name,
      notFoundOnRepeatIsOk: true,
    });
    await this.recordAudit(alias, 'delete', item, { permanent: false });
    return { fileId: item.id, name: item.name, permanent: false };
  }

  async restore(input: FileRef): Promise<FileSummary> {
    const { client, alias } = await this.client(input.account);
    const { driveType } = await this.driveInfo(client, alias);
    if (driveType === 'business') {
      throw new ValidationError(
        'Restore works on personal OneDrive only; on a work or school account restore the item from the recycle bin on the OneDrive website.',
      );
    }
    const restored = await client.json<GraphItem>('POST', `${itemPath(input.fileId)}/restore`, {
      retry: 'create',
      target: input.fileId,
      body: {},
    });
    await this.recordAudit(alias, 'restore', restored, {});
    return toSummary(restored);
  }

  /**
   * Graph documents no conflict option for PATCH, so the name is checked first. Finding the item
   * itself (a case-only rename) is fine; any failure other than 404 aborts (spec §5.1).
   */
  private async assertNameFree(
    client: GraphClient,
    parentId: string,
    name: string,
    itemId: string,
  ): Promise<void> {
    const found = await client.getOrNull<GraphItem>(
      `${childPath(parentId, name)}?$select=id`,
      name,
    );
    if (found && found.id !== itemId) throw new NameConflictError(name);
  }

  /** `FileRouter` always passes the account's alias. */
  protected async client(
    account: string | undefined,
  ): Promise<{ client: GraphClient; alias: string }> {
    if (!account) throw new ValidationError('OneDrive operations need an account alias');
    return { client: await this.deps.clients(account), alias: account };
  }

  /** Reads an item of the user's own drive; `remoteItem` entries are out of reach (spec §2). */
  protected async readItem(client: GraphClient, id: string): Promise<GraphItem> {
    const item = await client.get<GraphItem>(`${itemPath(id)}?$select=${ITEM_SELECT}`, id);
    if (item.remoteItem) throw new NotFoundError(id);
    return item;
  }

  /** Reads the ID once, so a `remoteItem` counts as not found; `root` is always the user's own. */
  protected async assertOwnItem(client: GraphClient, id: string): Promise<void> {
    if (id !== 'root') await this.readItem(client, id);
  }

  /** `driveId`, `driveType` and the real root ID, cached per account for the process lifetime. */
  protected driveInfo(client: GraphClient, alias: string): Promise<DriveInfo> {
    let info = this.driveInfos.get(alias);
    if (!info) {
      info = this.fetchDriveInfo(client);
      info.catch(() => this.driveInfos.delete(alias));
      this.driveInfos.set(alias, info);
    }
    return info;
  }

  private async fetchDriveInfo(client: GraphClient): Promise<DriveInfo> {
    const [drive, root] = await Promise.all([
      client.get<{ id: string; driveType: string }>('/me/drive?$select=id,driveType'),
      client.get<{ id: string }>('/me/drive/root?$select=id'),
    ]);
    return { driveId: drive.id, driveType: drive.driveType, rootId: root.id };
  }

  private async nextPage(client: GraphClient, alias: string, token: string): Promise<ListResult> {
    const { driveId } = await this.driveInfo(client, alias);
    client.checkPageToken(token, driveId);
    return toResult(await client.page<GraphPage>(token));
  }

  /** Writes an audit entry; failures are logged, never thrown (the change already happened). */
  protected async recordAudit(
    alias: string,
    op: AuditOp,
    file: { id?: string; name?: string },
    details: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.deps.audit.record({
        account: alias,
        op,
        fileId: file.id ?? '',
        ...(file.name ? { name: file.name } : {}),
        details,
      });
    } catch (err) {
      this.log.warn('Audit log write failed', { op, fileId: file.id, error: err });
    }
  }
}
