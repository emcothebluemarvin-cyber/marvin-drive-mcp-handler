import { describe, expect, it, vi } from 'vitest';
import {
  FileLockedError,
  GraphApiError,
  GraphThrottledError,
  NameConflictError,
  NotFoundError,
  OneDriveFullError,
  PermissionDeniedError,
  TargetChangedError,
  ValidationError,
} from '../../errors.js';
import { createLogger } from '../../logger.js';
import { mapGraphError, sanitizeForLog } from '../graph-errors.js';

const body = (code: string, message = 'msg'): string =>
  JSON.stringify({ error: { code, message } });
const ctx = { alias: 'work', target: 'a.txt', log: createLogger(() => {}) };

describe('mapGraphError', () => {
  it.each([
    [403, body('accessDenied'), PermissionDeniedError],
    [404, body('itemNotFound'), NotFoundError],
    [409, body('nameAlreadyExists'), NameConflictError],
    [412, body('resourceModified'), TargetChangedError],
    [423, body('resourceLocked'), FileLockedError],
    [429, body('activityLimitReached'), GraphThrottledError],
    [503, 'not json', GraphThrottledError],
    [507, body('quotaLimitReached'), OneDriveFullError],
    [400, body('invalidRequest', 'The name contains invalid characters'), ValidationError],
    [400, body('invalidRequest', 'Bad cursor'), GraphApiError],
    [500, body('generalException'), GraphApiError],
    [403, body('notAllowed'), GraphApiError],
  ])('maps %i %s', (status, text, type) => {
    expect(mapGraphError(status, text, ctx)).toBeInstanceOf(type);
  });

  it('names the account in a permission error', () => {
    expect(mapGraphError(403, body('accessDenied'), ctx).message).toContain('"work"');
  });

  it('returns Graph message for an invalid name, but never for other errors', () => {
    const text = body('invalidRequest', 'The name is bad');
    expect(mapGraphError(400, text, ctx).message).toBe('The name is bad');
    expect(mapGraphError(500, body('x', 'internal detail'), ctx).message).not.toContain('internal');
  });

  it('logs the body of a generic error without URLs', () => {
    const warn = vi.fn();
    const log = { ...createLogger(() => {}), warn };
    mapGraphError(500, body('x', 'see https://upload.example/secret?t=1'), { ...ctx, log });
    expect(JSON.stringify(warn.mock.calls)).not.toContain('secret');
  });

  it('caps what it logs', () => {
    expect(sanitizeForLog('x'.repeat(5000))).toHaveLength(2000);
  });
});
