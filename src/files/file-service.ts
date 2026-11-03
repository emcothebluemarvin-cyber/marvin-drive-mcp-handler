import type { AuditOp, AuditSink } from '../audit/audit-log.js';
import { isInvalidGrant } from '../auth/oauth-errors.js';
import type { DriveContext, DriveRunner } from '../drive/client-factory.js';
import type { DriveFile, DriveFileList } from '../drive/drive-adapter.js';
import { ValidationError } from '../errors.js';
import { logger as defaultLogger, type Logger } from '../logger.js';
import { mapDriveError, statusOf } from './drive-errors.js';
import { GOOGLE_MIME } from './export-formats.js';
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

export interface CreateFolderInput extends AccountInput {
  name: string;
  parentId?: string;
}

export interface MoveInput extends FileRef {
  newParentId: string;
}

export interface RenameInput extends FileRef {
  newName: string;
}

export interface CopyInput extends FileRef {
  parentId?: string;
  name?: string;
}

export interface DeleteInput extends FileRef {
  permanent?: boolean;
}

export interface DeleteResult {
  fileId: string;
  name?: string;
  permanent: boolean;
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

  createFolder(input: CreateFolderInput): Promise<FileSummary> {
    const parentId = input.parentId ?? 'root';
    return this.exec(input.account, 'create', input.parentId, async (ctx) => {
      const folder = await ctx.drive.createFile({
        requestBody: { name: input.name, mimeType: GOOGLE_MIME.folder, parents: [parentId] },
        fields: SUMMARY_FIELDS,
      });
      await this.recordAudit(ctx, 'create_folder', folder, { parentId });
      return toSummary(folder);
    });
  }

  move(input: MoveInput): Promise<FileSummary> {
    let originalParents: string[] | undefined; // first read only — used for the audit entry
    return this.exec(input.account, 'idempotent', input.fileId, async (ctx) => {
      // Re-read on every attempt: a "failed" earlier attempt may have succeeded.
      const current = await ctx.drive.getFile(input.fileId, 'id, parents');
      const oldParents = current.parents ?? [];
      originalParents ??= oldParents;
      const alreadyThere = oldParents.includes(input.newParentId);
      const toRemove = oldParents.filter((p) => p !== input.newParentId);

      const moved =
        alreadyThere && toRemove.length === 0
          ? await ctx.drive.getFile(input.fileId, SUMMARY_FIELDS)
          : await ctx.drive.updateFile({
              fileId: input.fileId,
              ...(alreadyThere ? {} : { addParents: input.newParentId }),
              ...(toRemove.length > 0 ? { removeParents: toRemove.join(',') } : {}),
              fields: SUMMARY_FIELDS,
            });
      await this.recordAudit(ctx, 'move', moved, {
        oldParents: originalParents,
        newParentId: input.newParentId,
      });
      return toSummary(moved);
    });
  }

  rename(input: RenameInput): Promise<FileSummary> {
    let originalName: string | null | undefined; // first read only — used for the audit entry
    return this.exec(input.account, 'idempotent', input.fileId, async (ctx) => {
      if (originalName === undefined) {
        originalName = (await ctx.drive.getFile(input.fileId, 'id, name')).name ?? null;
      }
      const renamed = await ctx.drive.updateFile({
        fileId: input.fileId,
        requestBody: { name: input.newName },
        fields: SUMMARY_FIELDS,
      });
      await this.recordAudit(ctx, 'rename', renamed, {
        oldName: originalName,
        newName: input.newName,
      });
      return toSummary(renamed);
    });
  }

  async copy(input: CopyInput): Promise<FileSummary> {
    // Pre-read is idempotent (retried on 5xx); only the copy itself is a non-idempotent create.
    const source = await this.exec(input.account, 'idempotent', input.fileId, (ctx) =>
      ctx.drive.getFile(input.fileId, 'id, mimeType'),
    );
    if (source.mimeType === GOOGLE_MIME.folder) {
      throw new ValidationError('Google Drive cannot copy folders');
    }
    return this.exec(input.account, 'create', input.fileId, async (ctx) => {
      const copied = await ctx.drive.copyFile({
        fileId: input.fileId,
        requestBody: {
          ...(input.name ? { name: input.name } : {}),
          ...(input.parentId ? { parents: [input.parentId] } : {}),
        },
        fields: SUMMARY_FIELDS,
      });
      await this.recordAudit(ctx, 'copy', copied, {
        sourceId: input.fileId,
        parentId: input.parentId ?? null,
      });
      return toSummary(copied);
    });
  }

  delete(input: DeleteInput): Promise<DeleteResult> {
    const permanent = input.permanent ?? false;
    if (!permanent) {
      return this.exec(input.account, 'idempotent', input.fileId, async (ctx) => {
        const trashed = await ctx.drive.updateFile({
          fileId: input.fileId,
          requestBody: { trashed: true },
          fields: 'id, name',
        });
        await this.recordAudit(ctx, 'delete', trashed, { permanent });
        return { fileId: input.fileId, ...(trashed.name ? { name: trashed.name } : {}), permanent };
      });
    }

    let name: string | undefined;
    return this.exec(input.account, 'idempotent', input.fileId, async (ctx, attempt) => {
      if (name === undefined) {
        name = (await ctx.drive.getFile(input.fileId, 'id, name')).name ?? '';
      }
      try {
        await ctx.drive.deleteFile(input.fileId);
      } catch (err) {
        // A 404 on a retry means the previous attempt deleted it.
        if (!(attempt > 0 && statusOf(err) === 404)) throw err;
      }
      await this.recordAudit(ctx, 'delete', { id: input.fileId, name }, { permanent });
      return { fileId: input.fileId, ...(name ? { name } : {}), permanent };
    });
  }

  restore(input: FileRef): Promise<FileSummary> {
    return this.exec(input.account, 'idempotent', input.fileId, async (ctx) => {
      const restored = await ctx.drive.updateFile({
        fileId: input.fileId,
        requestBody: { trashed: false },
        fields: SUMMARY_FIELDS,
      });
      await this.recordAudit(ctx, 'restore', restored, {});
      return toSummary(restored);
    });
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
