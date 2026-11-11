import { describe, expect, it } from 'vitest';
import {
  ApiDisabledError,
  AppError,
  ConflictError,
  CopyStillRunningError,
  DriveApiError,
  ExportTooLargeError,
  FileLockedError,
  GraphApiError,
  GraphThrottledError,
  NameConflictError,
  NotFoundError,
  OneDriveFullError,
  ProviderNotSupportedError,
  ReauthRequiredError,
  TargetChangedError,
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

describe('content API errors', () => {
  it('ConflictError names the file and the re-read tool', () => {
    const e = new ConflictError('"Plan"', 'docs_read');
    expect(e.code).toBe('CONFLICT');
    expect(e.message).toBe(
      '"Plan" changed since it was read (or the revisionId expired); re-read it with docs_read and retry with the new revisionId.',
    );
  });

  it('ApiDisabledError names the API', () => {
    const e = new ApiDisabledError('sheets');
    expect(e.code).toBe('API_DISABLED');
    expect(e.message).toBe(
      'The Google Sheets API is not enabled for this OAuth project. Enable it in Cloud Console → APIs & Services, then retry.',
    );
  });

  it('DriveApiError keeps the Drive prefix by default and labels other APIs', () => {
    expect(new DriveApiError(400, 'bad').message).toBe('Drive API error (400): bad');
    expect(new DriveApiError(400, 'bad', { api: 'drive' }).message).toBe(
      'Drive API error (400): bad',
    );
    expect(new DriveApiError(400, 'bad', { api: 'slides' }).message).toBe(
      'Google Slides API error (400): bad',
    );
  });
});

describe('OneDrive errors', () => {
  it.each([
    [
      new ProviderNotSupportedError('work'),
      'PROVIDER_NOT_SUPPORTED',
      /"work".*not available on OneDrive/,
    ],
    [new NameConflictError('a.txt'), 'NAME_CONFLICT', /"a\.txt" already exists.*another name/],
    [new TargetChangedError('a.txt'), 'TARGET_CHANGED', /"a\.txt" changed.*Check the file/],
    [new GraphThrottledError(), 'GRAPH_THROTTLED', /try again later/],
    [new CopyStillRunningError('a.txt'), 'COPY_STILL_RUNNING', /continues on the server/],
    [new FileLockedError('a.txt'), 'FILE_LOCKED', /locked, probably open in Office/],
    [new OneDriveFullError('work'), 'ONEDRIVE_FULL', /OneDrive storage is full/],
    [new GraphApiError(500), 'GRAPH_API_ERROR', /OneDrive request failed \(500\)/],
  ])('%s has its code and message', (err, code, message) => {
    expect(err).toBeInstanceOf(AppError);
    expect(err.code).toBe(code);
    expect(err.message).toMatch(message);
  });
});
