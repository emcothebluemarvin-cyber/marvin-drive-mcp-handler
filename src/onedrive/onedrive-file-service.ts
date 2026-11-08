import type { AuditOp, AuditSink } from '../audit/audit-log.js';
import { NotFoundError, UnsupportedTypeError, ValidationError } from '../errors.js';
import { resolveDestination, writeUnique } from '../files/destination.js';
import {
  clampPageSize,
  type DownloadInput,
  type DownloadResult,
  type FileRef,
  type ListInput,
  type ListResult,
  type OneDriveMetadata,
  type SearchInput,
} from '../files/file-provider.js';
import { logger as defaultLogger, type Logger } from '../logger.js';
import { itemPath, type GraphClient } from './graph-client.js';
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
