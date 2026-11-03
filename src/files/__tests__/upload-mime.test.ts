import { describe, expect, it } from 'vitest';
import { ValidationError } from '../../errors.js';
import { GOOGLE_MIME } from '../export-formats.js';
import { googleTargetMime, uploadMimeType } from '../upload-mime.js';

describe('uploadMimeType', () => {
  it('detects by extension and falls back to octet-stream', () => {
    expect(uploadMimeType('/x/report.pdf')).toBe('application/pdf');
    expect(uploadMimeType('/x/notes.txt')).toBe('text/plain');
    expect(uploadMimeType('/x/blob')).toBe('application/octet-stream');
  });
});

describe('googleTargetMime', () => {
  it('maps office/text formats to Google types', () => {
    expect(googleTargetMime('a.docx')).toBe(GOOGLE_MIME.document);
    expect(googleTargetMime('a.MD')).toBe(GOOGLE_MIME.document);
    expect(googleTargetMime('a.csv')).toBe(GOOGLE_MIME.spreadsheet);
    expect(googleTargetMime('a.xlsx')).toBe(GOOGLE_MIME.spreadsheet);
    expect(googleTargetMime('a.pptx')).toBe(GOOGLE_MIME.presentation);
  });

  it('rejects unsupported conversions', () => {
    expect(() => googleTargetMime('a.zip')).toThrow(ValidationError);
    expect(() => googleTargetMime('README')).toThrow(/files without an extension/);
  });
});
