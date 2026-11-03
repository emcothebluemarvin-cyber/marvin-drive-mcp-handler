import type { AuditOp, AuditSink } from '../audit/audit-log.js';
import { isInvalidGrant } from '../auth/oauth-errors.js';
import type { DriveContext, DriveRunner } from '../drive/client-factory.js';
import type { DriveFile, DriveFileList } from '../drive/drive-adapter.js';
import { logger as defaultLogger, type Logger } from '../logger.js';
import { mapDriveError } from './drive-errors.js';
import { buildListQuery, buildSearchQuery, type SearchCriteria } from './query.js';
import { withRetry, type RetryClass, type RetryOptions } from './retry.js';

export const SUMMARY_FIELDS = 'id, name, mimeType, size, modifiedTime, parents';
export const LIST_FIELDS = `nextPageToken, files(${SUMMARY_FIELDS})`;
export const FILE_FIELDS =
  'id, name, mimeType, size, createdTime, modifiedTime, parents, owners(emailAddress, displayName), webViewLink, trashed, shortcutDetails';

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

export interface FileSummary {
  id: string;
  name: string;
  mimeType: string;
  size?: number;
  modifiedTime?: string;
  parents?: string[];
}

export interface ListResult {
  files: FileSummary[];
  nextPageToken?: string;
}

export interface FileServiceDeps {
  runner: DriveRunner;
  audit: AuditSink;
  downloadsDir: string;
  retry?: RetryOptions;
  logger?: Logger;
}

interface AccountInput {
  account?: string;
}

export interface ListInput extends AccountInput {
  folderId?: string;
  pageSize?: number;
  pageToken?: string;
  includeTrashed?: boolean;
}

export interface SearchInput extends AccountInput, SearchCriteria {
  pageSize?: number;
  pageToken?: string;
}

export interface FileRef extends AccountInput {
  fileId: string;
}

export function toSummary(file: DriveFile): FileSummary {
  return {
    id: file.id ?? '',
    name: file.name ?? '',
    mimeType: file.mimeType ?? '',
    ...(file.size ? { size: Number(file.size) } : {}),
    ...(file.modifiedTime ? { modifiedTime: file.modifiedTime } : {}),
    ...(file.parents ? { parents: file.parents } : {}),
  };
}

function toListResult(list: DriveFileList): ListResult {
  return {
    files: (list.files ?? []).map(toSummary),
    ...(list.nextPageToken ? { nextPageToken: list.nextPageToken } : {}),
  };
}

function clampPageSize(pageSize: number | undefined): number {
  return Math.min(Math.max(Math.trunc(pageSize ?? DEFAULT_PAGE_SIZE), 1), MAX_PAGE_SIZE);
}

export class FileService {
  protected readonly log: Logger;

  constructor(protected readonly deps: FileServiceDeps) {
    this.log = deps.logger ?? defaultLogger;
  }

  list(input: ListInput): Promise<ListResult> {
    const q = buildListQuery(input.folderId ?? 'root', input.includeTrashed ?? false);
    return this.exec(input.account, 'idempotent', input.folderId, async (ctx) =>
      toListResult(
        await ctx.drive.listFiles({
          q,
          pageSize: clampPageSize(input.pageSize),
          ...(input.pageToken ? { pageToken: input.pageToken } : {}),
          fields: LIST_FIELDS,
        }),
      ),
    );
  }

  async search(input: SearchInput): Promise<ListResult> {
    const q = buildSearchQuery(input);
    return this.exec(input.account, 'idempotent', undefined, async (ctx) =>
      toListResult(
        await ctx.drive.listFiles({
          q,
          pageSize: clampPageSize(input.pageSize),
          ...(input.pageToken ? { pageToken: input.pageToken } : {}),
          fields: LIST_FIELDS,
        }),
      ),
    );
  }

  getMetadata(input: FileRef): Promise<DriveFile> {
    return this.exec(input.account, 'idempotent', input.fileId, (ctx) =>
      ctx.drive.getFile(input.fileId, FILE_FIELDS),
    );
  }

  /** Runs `operation` for an account with retry + error mapping (invalid_grant passes through). */
  protected exec<T>(
    account: string | undefined,
    retryClass: RetryClass,
    target: string | undefined,
    operation: (ctx: DriveContext, attempt: number) => Promise<T>,
  ): Promise<T> {
    return this.deps.runner.run(account, async (ctx) => {
      try {
        return await withRetry((attempt) => operation(ctx, attempt), retryClass, this.deps.retry);
      } catch (err) {
        if (isInvalidGrant(err)) throw err;
        throw mapDriveError(err, {
          target,
          alias: ctx.account.alias,
          logger: this.log,
          createOp: retryClass === 'create',
        });
      }
    });
  }

  /** Writes an audit entry; failures are logged, never thrown (the Drive change already happened). */
  protected async recordAudit(
    ctx: DriveContext,
    op: AuditOp,
    file: { id?: string | null; name?: string | null },
    details: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.deps.audit.record({
        account: ctx.account.alias,
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
