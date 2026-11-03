import {
  AbusiveFileError,
  AppError,
  DriveApiError,
  ExportTooLargeError,
  NotFoundError,
  PermissionDeniedError,
  QuotaExceededError,
  RateLimitError,
} from '../errors.js';
import type { Logger } from '../logger.js';

type Loose = Record<string, unknown>;

function asObject(value: unknown): Loose | undefined {
  return typeof value === 'object' && value !== null ? (value as Loose) : undefined;
}

export function statusOf(err: unknown): number | undefined {
  const e = asObject(err);
  if (!e) return undefined;
  if (typeof e.status === 'number') return e.status;
  const responseStatus = asObject(e.response)?.status;
  if (typeof responseStatus === 'number') return responseStatus;
  return typeof e.code === 'number' ? e.code : undefined;
}

function firstReason(errors: unknown): string | undefined {
  if (!Array.isArray(errors)) return undefined;
  const reason = asObject(errors[0])?.reason;
  return typeof reason === 'string' ? reason : undefined;
}

export function reasonOf(err: unknown): string | undefined {
  const e = asObject(err);
  if (!e) return undefined;
  const direct = firstReason(e.errors);
  if (direct) return direct;

  let data: unknown = asObject(e.response)?.data;
  if (typeof data === 'string') {
    try {
      data = JSON.parse(data);
    } catch {
      data = undefined; // non-JSON body: no structured reason available
    }
  }
  const fromBody = firstReason(asObject(asObject(data)?.error)?.errors);
  if (fromBody) return fromBody;

  if (typeof e.message === 'string' && /too large to be exported/i.test(e.message)) {
    return 'exportSizeLimitExceeded';
  }
  return undefined;
}

export function isRateLimit(status: number | undefined, reason: string | undefined): boolean {
  return (
    status === 429 ||
    (status === 403 && (reason === 'rateLimitExceeded' || reason === 'userRateLimitExceeded'))
  );
}

export interface MapContext {
  /** File/folder id the call targeted (for messages); undefined → "root". */
  target: string | undefined;
  alias: string;
  logger: Logger;
  /** True for non-idempotent creates: a 5xx may still have created the item. */
  createOp?: boolean;
}

/** Converts a raw googleapis/gaxios error into a safe AppError (spec §9). */
export function mapDriveError(err: unknown, ctx: MapContext): AppError {
  if (err instanceof AppError) return err;
  const status = statusOf(err);
  const reason = reasonOf(err);
  const target = ctx.target ?? 'root';

  if (status === 404) return new NotFoundError(target, { cause: err });
  if (isRateLimit(status, reason)) return new RateLimitError({ cause: err });
  if (status === 403 || reason === 'exportSizeLimitExceeded') {
    switch (reason) {
      case 'storageQuotaExceeded':
        return new QuotaExceededError(ctx.alias, { cause: err });
      case 'cannotDownloadAbusiveFile':
        return new AbusiveFileError(target, { cause: err });
      case 'exportSizeLimitExceeded':
        return new ExportTooLargeError(null, { cause: err });
      default:
        return new PermissionDeniedError(target, { cause: err });
    }
  }

  const detail = err instanceof Error ? err.message.slice(0, 200) : 'Unknown error';
  ctx.logger.error('Drive API call failed', { status, reason, target, error: err });
  const hint =
    ctx.createOp && status !== undefined && status >= 500
      ? '. The item may have been created anyway; check for a duplicate before retrying.'
      : '';
  return new DriveApiError(status, `${detail}${hint}`, { cause: err });
}
