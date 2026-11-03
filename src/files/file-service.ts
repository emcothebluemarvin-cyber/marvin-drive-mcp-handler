import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import type { Readable } from 'node:stream';
import type { AuditOp, AuditSink } from '../audit/audit-log.js';
import { isInvalidGrant } from '../auth/oauth-errors.js';
import type { DriveContext, DriveRunner } from '../drive/client-factory.js';
import type { DriveFile, DriveFileList } from '../drive/drive-adapter.js';
import { ExportTooLargeError, NotFoundError, ValidationError } from '../errors.js';
import { logger as defaultLogger, type Logger } from '../logger.js';
import { mapDriveError, reasonOf, statusOf } from './drive-errors.js';
import { expandHome, resolveDestination, writeUnique } from './destination.js';
import {
  GOOGLE_MIME,
  isGoogleNative,
  resolveExport,
  type ExportFormat,
  type ExportPlan,
} from './export-formats.js';
import { buildListQuery, buildSearchQuery, type SearchCriteria } from './query.js';
import { retryKind, withRetry, type RetryClass, type RetryOptions } from './retry.js';
import { googleTargetMime, uploadMimeType } from './upload-mime.js';

export const SUMMARY_FIELDS = 'id, name, mimeType, size, modifiedTime, parents';
export const LIST_FIELDS = `nextPageToken, files(${SUMMARY_FIELDS})`;
export const FILE_FIELDS =
  'id, name, mimeType, size, createdTime, modifiedTime, parents, owners(emailAddress, displayName), webViewLink, trashed, shortcutDetails';

const DOWNLOAD_FIELDS = 'id, name, mimeType, size, webViewLink, shortcutDetails, exportLinks';

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

export interface UploadInput extends AccountInput {
  localPath: string;
  parentId?: string;
  name?: string;
  convertToGoogle?: boolean;
}

export interface DownloadInput extends FileRef {
  destPath?: string;
  exportFormat?: ExportFormat;
}

export interface DownloadResult {
  path: string;
  size: number;
  mimeType: string;
  exportFormat: ExportFormat | null;
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

/**
 * Summary for a file Drive has just created (upload, copy). For Google-native
 * files Drive fills `size` lazily with storage bytes and returns a placeholder
 * (e.g. "1") in the create response, so it is dropped rather than reported.
 */
function toCreatedSummary(file: DriveFile): FileSummary {
  const summary = toSummary(file);
  if (isGoogleNative(summary.mimeType)) delete summary.size;
  return summary;
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

      const settled = alreadyThere && toRemove.length === 0;
      // Only a no-op if it was already in place before our first attempt (not after a retried success).
      const isNoop = settled && originalParents === oldParents;
      const moved = settled
        ? await ctx.drive.getFile(input.fileId, SUMMARY_FIELDS)
        : await ctx.drive.updateFile({
            fileId: input.fileId,
            ...(alreadyThere ? {} : { addParents: input.newParentId }),
            ...(toRemove.length > 0 ? { removeParents: toRemove.join(',') } : {}),
            fields: SUMMARY_FIELDS,
          });
      if (!isNoop) {
        await this.recordAudit(ctx, 'move', moved, {
          oldParents: originalParents,
          newParentId: input.newParentId,
        });
      }
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
      return toCreatedSummary(copied);
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
    let deleteSent = false;
    return this.exec(input.account, 'idempotent', input.fileId, async (ctx) => {
      if (name === undefined) {
        name = (await ctx.drive.getFile(input.fileId, 'id, name')).name ?? '';
      }
      const sentBefore = deleteSent;
      deleteSent = true;
      try {
        await ctx.drive.deleteFile(input.fileId);
      } catch (err) {
        // A 404 counts as success only if an earlier delete request was already sent.
        if (!(sentBefore && statusOf(err) === 404)) throw err;
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

  async upload(input: UploadInput): Promise<FileSummary> {
    const expanded = expandHome(input.localPath);
    if (!path.isAbsolute(expanded)) {
      throw new ValidationError(`localPath must be an absolute path (got "${input.localPath}")`);
    }
    const localPath = path.resolve(expanded);
    let size: number;
    try {
      const info = await stat(localPath);
      if (!info.isFile()) throw new ValidationError(`${localPath} is not a regular file`);
      size = info.size;
    } catch (err) {
      if (err instanceof ValidationError) throw err;
      throw new ValidationError(`Cannot read ${localPath}`, { cause: err });
    }

    const convert = input.convertToGoogle ?? false;
    const parentId = input.parentId ?? 'root';
    const requestBody = {
      name: input.name ?? path.basename(localPath),
      parents: [parentId],
      ...(convert ? { mimeType: googleTargetMime(localPath) } : {}),
    };
    const mimeType = uploadMimeType(localPath);

    return this.exec(input.account, 'create', input.parentId, async (ctx) => {
      // Streaming multipart for all sizes (spec §6). A new stream per attempt.
      const body = createReadStream(localPath);
      let uploaded: DriveFile;
      try {
        uploaded = await ctx.drive.createFile({
          requestBody,
          media: { mimeType, body },
          fields: SUMMARY_FIELDS,
        });
      } catch (err) {
        body.destroy();
        throw err;
      }
      await this.recordAudit(ctx, 'upload', uploaded, {
        localPath,
        parentId,
        size,
        converted: convert,
      });
      return toCreatedSummary(uploaded);
    });
  }

  download(input: DownloadInput): Promise<DownloadResult> {
    return this.exec(input.account, 'idempotent', input.fileId, async (ctx) => {
      let file = await ctx.drive.getFile(input.fileId, DOWNLOAD_FIELDS);
      if (file.mimeType === GOOGLE_MIME.shortcut) {
        const targetId = file.shortcutDetails?.targetId;
        if (!targetId) throw new NotFoundError(input.fileId);
        file = await ctx.drive.getFile(targetId, DOWNLOAD_FIELDS);
      }
      const fileId = file.id ?? input.fileId;
      const mimeType = file.mimeType ?? 'application/octet-stream';
      const plan = resolveExport(mimeType, input.exportFormat);

      const destination = await resolveDestination({
        ...(input.destPath !== undefined ? { destPath: input.destPath } : {}),
        defaultDir: this.deps.downloadsDir,
        driveName: file.name ?? '',
        fileId,
        ...(plan ? { extension: plan.extension } : {}),
      });
      const written = await writeUnique(destination, () =>
        plan ? this.openExport(ctx, fileId, plan, file) : ctx.drive.downloadMedia(fileId),
      );
      return {
        path: written.path,
        size: written.size,
        mimeType,
        exportFormat: plan?.format ?? null,
      };
    });
  }

  private async openExport(
    ctx: DriveContext,
    fileId: string,
    plan: ExportPlan,
    file: DriveFile,
  ): Promise<Readable> {
    try {
      return await ctx.drive.exportMedia(fileId, plan.mimeType);
    } catch (err) {
      if (reasonOf(err) !== 'exportSizeLimitExceeded') throw err;
      const link = file.exportLinks?.[plan.mimeType];
      if (link) {
        try {
          return await ctx.drive.fetchExportLink(link);
        } catch (fallbackErr) {
          if (retryKind(fallbackErr) !== null) throw fallbackErr;
          this.log.warn('exportLinks fallback failed', { fileId, error: fallbackErr });
        }
      }
      throw new ExportTooLargeError(file.webViewLink ?? null, { cause: err, format: plan.format });
    }
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
