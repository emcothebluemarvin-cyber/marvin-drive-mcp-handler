import {
  ApiDisabledError,
  AppError,
  QuotaExceededError,
  RateLimitError,
  ReauthRequiredError,
} from '../errors.js';

/** A root check failed (spec §5 step 2); the whole run is aborted. */
export class SyncRootError extends AppError {
  readonly code = 'SYNC_ROOT_CHECK';
}

/** An exclusive local write found its target taken (spec §7). */
export class CollisionError extends AppError {
  readonly code = 'SYNC_COLLISION';

  constructor(readonly target: string) {
    super(`${target} already exists; nothing was overwritten`);
  }
}

/** A re-verification found the file changed since planning; the action is skipped. */
export class TargetChangedError extends AppError {
  readonly code = 'SYNC_TARGET_CHANGED';
}

export class ChecksumMismatchError extends AppError {
  readonly code = 'SYNC_CHECKSUM_MISMATCH';

  constructor(what: string, expected: string, actual: string) {
    super(`${what}: expected md5 ${expected}, got ${actual}`);
  }
}

export class LocalTrashError extends AppError {
  readonly code = 'SYNC_LOCAL_TRASH';
}

/** Errors that stop the whole run; remaining actions are reported `not-run` (spec §7). */
export function isAbortError(err: unknown): boolean {
  return (
    err instanceof ReauthRequiredError ||
    err instanceof QuotaExceededError ||
    err instanceof ApiDisabledError ||
    err instanceof RateLimitError
  );
}
