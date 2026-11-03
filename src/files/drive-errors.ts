import {
  AbusiveFileError,
  ApiDisabledError,
  AppError,
  ConflictError,
  DriveApiError,
  ExportTooLargeError,
  NotFoundError,
  PermissionDeniedError,
  QuotaExceededError,
  RateLimitError,
  type GoogleApi,
} from '../errors.js';
import { scrubText, type Logger } from '../logger.js';

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

/** The `error` object of a Google JSON error body (parsed if the body is a string). */
function bodyError(err: unknown): Loose | undefined {
  let data: unknown = asObject(asObject(err)?.response)?.data;
  if (typeof data === 'string') {
    try {
      data = JSON.parse(data);
    } catch {
      return undefined; // non-JSON body: no structured error available
    }
  }
  return asObject(asObject(data)?.error);
}

/** `reason` of the first google.rpc.ErrorInfo entry (newer error format used by Docs/Sheets/Slides). */
function errorInfoReason(details: unknown): string | undefined {
  if (!Array.isArray(details)) return undefined;
  for (const item of details) {
    const d = asObject(item);
    if (
      d?.['@type'] === 'type.googleapis.com/google.rpc.ErrorInfo' &&
      typeof d.reason === 'string'
    ) {
      return d.reason;
    }
  }
  return undefined;
}

function messageOf(err: unknown): string {
  const parts: string[] = [];
  if (err instanceof Error) parts.push(err.message);
  const bodyMessage = bodyError(err)?.message;
  if (typeof bodyMessage === 'string') parts.push(bodyMessage);
  return parts.join(' ');
}

export function reasonOf(err: unknown): string | undefined {
  const e = asObject(err);
  if (!e) return undefined;
  const direct = firstReason(e.errors);
  if (direct) return direct;

  const body = bodyError(err);
  const fromBody = firstReason(body?.errors) ?? errorInfoReason(body?.details);
  if (fromBody) return fromBody;

  if (typeof e.message === 'string' && /too large to be exported/i.test(e.message)) {
    return 'exportSizeLimitExceeded';
  }
  return undefined;
}

const API_DISABLED_REASONS = new Set(['accessNotConfigured', 'SERVICE_DISABLED']);
const API_DISABLED_MESSAGE = /API has not been used in project|API .* is disabled/;
const REVISION_MISMATCH = /required revision ID .* does not match/i;

function isApiDisabled(
  err: unknown,
  status: number | undefined,
  reason: string | undefined,
): boolean {
  if (status !== 403) return false;
  if (reason && API_DISABLED_REASONS.has(reason)) return true;
  if (errorInfoReason(bodyError(err)?.details) === 'SERVICE_DISABLED') return true;
  return API_DISABLED_MESSAGE.test(messageOf(err));
}

/** HTTP 400 from a Docs/Slides writeControl.requiredRevisionId mismatch (or expired revision). */
export function isRevisionMismatch(err: unknown): boolean {
  return statusOf(err) === 400 && REVISION_MISMATCH.test(messageOf(err));
}

export function isRateLimit(status: number | undefined, reason: string | undefined): boolean {
  return (
    status === 429 ||
    (status === 403 && (reason === 'rateLimitExceeded' || reason === 'userRateLimitExceeded'))
  );
}

/** idempotent: safe to repeat; create: may duplicate; mutate: an in-place edit that may not be repeated. */
export type OperationKind = 'idempotent' | 'create' | 'mutate';

export interface MapContext {
  /** File/folder id the call targeted (for messages); undefined → "root". */
  target: string | undefined;
  alias: string;
  logger: Logger;
  kind: OperationKind;
  /** Which Google API produced the error (default "drive"). */
  api?: GoogleApi;
  /** Human file name, when known, for messages. */
  name?: string;
}

const FIVE_XX_HINT: Record<OperationKind, string> = {
  idempotent: '',
  create: '. The item may have been created anyway; check for a duplicate before retrying.',
  mutate: '. The change may have been applied anyway; re-read the file before retrying.',
};

/** Converts a raw googleapis/gaxios error into a safe AppError (MVP spec §9, content spec §5). */
export function mapDriveError(err: unknown, ctx: MapContext): AppError {
  if (err instanceof AppError) return err;
  const status = statusOf(err);
  const reason = reasonOf(err);
  const api = ctx.api ?? 'drive';
  const target = ctx.target ?? 'root';

  if (status === 404) return new NotFoundError(target, { cause: err });
  if (isRateLimit(status, reason)) return new RateLimitError({ cause: err });
  if (isApiDisabled(err, status, reason)) return new ApiDisabledError(api, { cause: err });
  if ((api === 'docs' || api === 'slides') && isRevisionMismatch(err)) {
    const label = ctx.name ? `"${ctx.name}"` : target;
    return new ConflictError(label, `${api}_read`, { cause: err });
  }
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

  const cap = api === 'drive' ? 200 : 500;
  const detail = err instanceof Error ? scrubText(err.message).slice(0, cap) : 'Unknown error';
  ctx.logger.error('Google API call failed', { api, status, reason, target, error: err });
  const hint = status !== undefined && status >= 500 ? FIVE_XX_HINT[ctx.kind] : '';
  return new DriveApiError(status, `${detail}${hint}`, { cause: err, api });
}
