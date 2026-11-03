import { describe, expect, it } from 'vitest';
import {
  AbusiveFileError,
  DriveApiError,
  ExportTooLargeError,
  NotFoundError,
  PermissionDeniedError,
  QuotaExceededError,
  RateLimitError,
  ValidationError,
} from '../../errors.js';
import { createLogger } from '../../logger.js';
import { isRateLimit, mapDriveError, reasonOf, statusOf } from '../drive-errors.js';

const gaxios = (status: number, reason?: string, asString = false): Error => {
  const body = { error: { code: status, message: 'x', errors: reason ? [{ reason }] : [] } };
  return Object.assign(new Error(`HTTP ${status}`), {
    status,
    response: { status, data: asString ? JSON.stringify(body) : body },
  });
};
const silent = createLogger(() => {});
const ctx = { target: 'file-1', alias: 'emco', logger: silent };

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

  it('adds a duplicate hint for failed creates', () => {
    expect(mapDriveError(gaxios(503), { ...ctx, createOp: true }).message).toMatch(/duplicate/);
  });

  it('passes AppErrors through unchanged', () => {
    const own = new ValidationError('mine');
    expect(mapDriveError(own, ctx)).toBe(own);
  });
});
