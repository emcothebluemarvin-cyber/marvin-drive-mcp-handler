import { describe, expect, it } from 'vitest';
import {
  AppError,
  DriveApiError,
  ExportTooLargeError,
  NotFoundError,
  ReauthRequiredError,
  ValidationError,
  hasErrorCode,
} from '../errors.js';

describe('errors', () => {
  it('carries code, name and message', () => {
    const err = new ReauthRequiredError('emco');
    expect(err).toBeInstanceOf(AppError);
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe('REAUTH_REQUIRED');
    expect(err.name).toBe('ReauthRequiredError');
    expect(err.alias).toBe('emco');
    expect(err.message).toBe('Session for "emco" expired. Run: marvin-drive auth login emco');
  });

  it('formats file-specific messages', () => {
    expect(new NotFoundError('abc').message).toBe('File not found: abc');
    expect(new ExportTooLargeError('https://x/y').message).toContain('open https://x/y');
    expect(new ExportTooLargeError(null).message).not.toContain('open');
    expect(new ExportTooLargeError(null, { format: 'docx' }).message).toContain(
      'exportFormat "pdf"',
    );
    expect(new ExportTooLargeError(null, { format: 'pdf' }).message).not.toContain('exportFormat');
    expect(new DriveApiError(500, 'boom').message).toBe('Drive API error (500): boom');
    expect(new DriveApiError(undefined, 'boom').message).toBe('Drive API error: boom');
  });

  it('keeps the cause', () => {
    const cause = new Error('root');
    expect(new ValidationError('bad', { cause }).cause).toBe(cause);
  });

  it('detects Node error codes', () => {
    expect(hasErrorCode(Object.assign(new Error('x'), { code: 'ENOENT' }), 'ENOENT')).toBe(true);
    expect(hasErrorCode(new Error('x'), 'ENOENT')).toBe(false);
    expect(hasErrorCode('ENOENT', 'ENOENT')).toBe(false);
  });
});
