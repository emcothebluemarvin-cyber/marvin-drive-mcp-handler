import {
  AppError,
  FileLockedError,
  GraphApiError,
  GraphThrottledError,
  NameConflictError,
  NotFoundError,
  OneDriveFullError,
  PermissionDeniedError,
  TargetChangedError,
  ValidationError,
} from '../errors.js';
import type { Logger } from '../logger.js';

export interface GraphErrorContext {
  alias: string;
  /** The item's name or ID, for the message. */
  target?: string;
  log: Logger;
}

const MAX_LOGGED_BODY = 2000;

/** Pre-authenticated URLs must never reach a log. */
export function sanitizeForLog(text: string): string {
  return text.replace(/https?:\/\/\S+/g, '[url]').slice(0, MAX_LOGGED_BODY);
}

function parseBody(text: string): { code?: string; message?: string } {
  try {
    const parsed = JSON.parse(text) as { error?: { code?: unknown; message?: unknown } };
    const { code, message } = parsed.error ?? {};
    return {
      ...(typeof code === 'string' ? { code } : {}),
      ...(typeof message === 'string' ? { message } : {}),
    };
  } catch {
    return {};
  }
}

/** The mapping table of spec §7.2. */
export function mapGraphError(status: number, bodyText: string, ctx: GraphErrorContext): AppError {
  const { code, message } = parseBody(bodyText);
  const target = ctx.target ?? 'item';
  if (status === 403 && code?.toLowerCase() === 'accessdenied') {
    return new PermissionDeniedError(`${target} on account "${ctx.alias}"`);
  }
  if (status === 404) return new NotFoundError(target);
  if (status === 409) return new NameConflictError(target);
  if (status === 412) return new TargetChangedError(target);
  if (status === 423) return new FileLockedError(target);
  if (status === 429 || status === 503) return new GraphThrottledError();
  if (status === 507) return new OneDriveFullError(ctx.alias);
  if (status === 400 && message && /name/i.test(message)) return new ValidationError(message);
  ctx.log.warn('Graph request failed', { status, code, body: sanitizeForLog(bodyText) });
  return new GraphApiError(status);
}
