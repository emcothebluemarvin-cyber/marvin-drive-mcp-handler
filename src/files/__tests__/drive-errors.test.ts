import { describe, expect, it } from 'vitest';
import {
  AbusiveFileError,
  ApiDisabledError,
  ConflictError,
  DriveApiError,
  ExportTooLargeError,
  NotFoundError,
  PermissionDeniedError,
  QuotaExceededError,
  RateLimitError,
  ValidationError,
} from '../../errors.js';
import { createLogger } from '../../logger.js';
import {
  isRateLimit,
  isRevisionMismatch,
  mapDriveError,
  reasonOf,
  statusOf,
} from '../drive-errors.js';

const gaxios = (status: number, reason?: string, asString = false): Error => {
  const body = { error: { code: status, message: 'x', errors: reason ? [{ reason }] : [] } };
  return Object.assign(new Error(`HTTP ${status}`), {
    status,
    response: { status, data: asString ? JSON.stringify(body) : body },
  });
};
const silent = createLogger(() => {});
const ctx = { target: 'file-1', alias: 'emco', logger: silent, kind: 'idempotent' as const };

describe('statusOf / reasonOf', () => {
  it('reads gaxios shapes', () => {
    expect(statusOf(gaxios(404))).toBe(404);
    expect(statusOf(Object.assign(new Error('x'), { response: { status: 502 } }))).toBe(502);
    expect(statusOf(Object.assign(new Error('x'), { code: 429 }))).toBe(429);
    expect(statusOf(new Error('x'))).toBeUndefined();
    expect(reasonOf(gaxios(403, 'storageQuotaExceeded'))).toBe('storageQuotaExceeded');
    expect(reasonOf(gaxios(403, 'rateLimitExceeded', true))).toBe('rateLimitExceeded');
    expect(reasonOf(Object.assign(new Error('x'), { errors: [{ reason: 'forbidden' }] }))).toBe(
      'forbidden',
    );
    expect(reasonOf(new Error('x'))).toBeUndefined();
  });

  it('recognizes the export size limit by message as a fallback', () => {
    expect(reasonOf(new Error('This file is too large to be exported.'))).toBe(
      'exportSizeLimitExceeded',
    );
  });
});

describe('isRateLimit', () => {
  it('covers 429 and 403 rate-limit reasons only', () => {
    expect(isRateLimit(429, undefined)).toBe(true);
    expect(isRateLimit(403, 'userRateLimitExceeded')).toBe(true);
    expect(isRateLimit(403, 'rateLimitExceeded')).toBe(true);
    expect(isRateLimit(403, 'forbidden')).toBe(false);
  });
});

describe('mapDriveError', () => {
  it('maps statuses and 403 reasons to specific errors', () => {
    expect(mapDriveError(gaxios(404), ctx)).toBeInstanceOf(NotFoundError);
    expect(mapDriveError(gaxios(429), ctx)).toBeInstanceOf(RateLimitError);
    expect(mapDriveError(gaxios(403, 'userRateLimitExceeded'), ctx)).toBeInstanceOf(RateLimitError);
    expect(mapDriveError(gaxios(403, 'storageQuotaExceeded'), ctx)).toBeInstanceOf(
      QuotaExceededError,
    );
    expect(mapDriveError(gaxios(403, 'cannotDownloadAbusiveFile'), ctx)).toBeInstanceOf(
      AbusiveFileError,
    );
    expect(mapDriveError(gaxios(403, 'exportSizeLimitExceeded'), ctx)).toBeInstanceOf(
      ExportTooLargeError,
    );
    expect(mapDriveError(gaxios(403, 'insufficientFilePermissions'), ctx)).toBeInstanceOf(
      PermissionDeniedError,
    );
    expect(mapDriveError(gaxios(403), ctx)).toBeInstanceOf(PermissionDeniedError);
  });

  it('wraps other failures in DriveApiError with a safe message', () => {
    const mapped = mapDriveError(gaxios(500), ctx);
    expect(mapped).toBeInstanceOf(DriveApiError);
    expect(mapped.message).toBe('Drive API error (500): HTTP 500');
  });

  it('scrubs secrets from the message detail', () => {
    const err = Object.assign(new Error('failed https://x/upload?upload_id=abc&token=secret123'), {
      status: 500,
    });
    const mapped = mapDriveError(err, ctx);
    expect(mapped.message).not.toContain('secret123');
  });

  it('adds a duplicate hint for failed creates', () => {
    expect(mapDriveError(gaxios(503), { ...ctx, kind: 'create' as const }).message).toMatch(
      /duplicate/,
    );
  });

  it('passes AppErrors through unchanged', () => {
    const own = new ValidationError('mine');
    expect(mapDriveError(own, ctx)).toBe(own);
  });
});

const errorInfo = (status: number, reason: string, message: string): Error =>
  Object.assign(new Error(message), {
    status,
    response: {
      status,
      data: {
        error: {
          code: status,
          message,
          status: 'PERMISSION_DENIED',
          details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason }],
        },
      },
    },
  });

const withMessage = (status: number, reason: string, message: string): Error =>
  Object.assign(new Error(message), { status, errors: [{ reason }] });

const MISMATCH = "The required revision ID 'abc' does not match the latest revision.";

describe('content API error mapping', () => {
  it('reads ErrorInfo reasons from the newer error format', () => {
    expect(reasonOf(errorInfo(403, 'SERVICE_DISABLED', 'x'))).toBe('SERVICE_DISABLED');
  });

  it('maps a disabled API before the 403 permission branch', () => {
    const disabled = mapDriveError(
      errorInfo(
        403,
        'SERVICE_DISABLED',
        'Google Docs API has not been used in project 1 before or it is disabled.',
      ),
      { ...ctx, api: 'docs' },
    );
    expect(disabled).toBeInstanceOf(ApiDisabledError);
    expect(disabled.message).toContain('Google Docs API');
    expect(mapDriveError(gaxios(403, 'accessNotConfigured'), ctx)).toBeInstanceOf(ApiDisabledError);
    const byMessage = mapDriveError(
      withMessage(
        403,
        'forbidden',
        'Google Sheets API has not been used in project 9 before or it is disabled.',
      ),
      { ...ctx, api: 'sheets' },
    );
    expect(byMessage).toBeInstanceOf(ApiDisabledError);
    expect(mapDriveError(withMessage(403, 'forbidden', 'nope'), ctx).constructor.name).toBe(
      'PermissionDeniedError',
    );
  });

  it('maps a revision mismatch to ConflictError for docs and slides only', () => {
    expect(isRevisionMismatch(withMessage(400, 'badRequest', MISMATCH))).toBe(true);
    expect(isRevisionMismatch(withMessage(400, 'badRequest', 'Invalid range'))).toBe(false);
    const docs = mapDriveError(withMessage(400, 'badRequest', MISMATCH), {
      ...ctx,
      kind: 'mutate',
      api: 'docs',
      name: 'Plan',
    });
    expect(docs).toBeInstanceOf(ConflictError);
    expect(docs.message).toContain('"Plan" changed since it was read');
    expect(docs.message).toContain('docs_read');
    const slides = mapDriveError(withMessage(400, 'badRequest', MISMATCH), {
      ...ctx,
      api: 'slides',
    });
    expect(slides.message).toContain('file-1 changed');
    expect(slides.message).toContain('slides_read');
    expect(mapDriveError(withMessage(400, 'badRequest', MISMATCH), ctx)).toBeInstanceOf(
      DriveApiError,
    );
  });

  it('labels non-Drive errors and keeps up to 500 chars of their message', () => {
    const long = 'x'.repeat(450);
    const sheets = mapDriveError(withMessage(400, 'badRequest', long), { ...ctx, api: 'sheets' });
    expect(sheets.message).toBe(`Google Sheets API error (400): ${long}`);
    const drive = mapDriveError(withMessage(400, 'badRequest', long), ctx);
    expect(drive.message).toBe(`Drive API error (400): ${'x'.repeat(200)}`);
  });

  it('warns that a failed edit may still have been applied', () => {
    expect(mapDriveError(gaxios(503), { ...ctx, kind: 'mutate' }).message).toMatch(
      /may have been applied anyway; re-read the file before retrying/,
    );
    expect(mapDriveError(gaxios(503), ctx).message).not.toMatch(/applied|duplicate/);
  });
});
