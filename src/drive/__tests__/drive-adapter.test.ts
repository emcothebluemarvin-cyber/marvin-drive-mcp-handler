import { describe, expect, it } from 'vitest';
import { DRIVE_CLIENT_OPTIONS, isAllowedExportUrl } from '../drive-adapter.js';

describe('isAllowedExportUrl', () => {
  it('accepts https Google hosts', () => {
    expect(isAllowedExportUrl('https://docs.google.com/document/d/x/export?format=pdf')).toBe(true);
    expect(isAllowedExportUrl('https://www.googleapis.com/drive/v3/files/x')).toBe(true);
  });

  it('rejects http, lookalike hosts and non-URLs', () => {
    expect(isAllowedExportUrl('http://docs.google.com/x')).toBe(false);
    expect(isAllowedExportUrl('https://evilgoogle.com/x')).toBe(false);
    expect(isAllowedExportUrl('https://google.com.evil.com/x')).toBe(false);
    expect(isAllowedExportUrl('not a url')).toBe(false);
  });
});

describe('DRIVE_CLIENT_OPTIONS', () => {
  it('disables googleapis built-in retry so withRetry is the only retry layer', () => {
    expect(DRIVE_CLIENT_OPTIONS.retry).toBe(false);
  });
});
