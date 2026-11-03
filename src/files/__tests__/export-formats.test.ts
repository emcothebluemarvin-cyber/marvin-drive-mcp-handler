import { describe, expect, it } from 'vitest';
import { UnsupportedTypeError, ValidationError } from '../../errors.js';
import { GOOGLE_MIME, resolveExport } from '../export-formats.js';

describe('resolveExport', () => {
  it('returns null for binary files', () => {
    expect(resolveExport('application/pdf')).toBeNull();
  });

  it('uses per-type defaults', () => {
    expect(resolveExport(GOOGLE_MIME.document)).toEqual({
      format: 'docx',
      extension: 'docx',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    });
    expect(resolveExport(GOOGLE_MIME.spreadsheet)?.format).toBe('xlsx');
    expect(resolveExport(GOOGLE_MIME.presentation)?.format).toBe('pptx');
    expect(resolveExport(GOOGLE_MIME.drawing)?.format).toBe('png');
  });

  it('accepts allowed overrides', () => {
    expect(resolveExport(GOOGLE_MIME.document, 'md')?.mimeType).toBe('text/markdown');
    expect(resolveExport(GOOGLE_MIME.spreadsheet, 'csv')?.mimeType).toBe('text/csv');
    expect(resolveExport(GOOGLE_MIME.presentation, 'txt')?.mimeType).toBe('text/plain');
  });

  it('rejects disallowed combinations with the allowed list', () => {
    expect(() => resolveExport(GOOGLE_MIME.spreadsheet, 'md')).toThrow(ValidationError);
    expect(() => resolveExport(GOOGLE_MIME.spreadsheet, 'md')).toThrow(/xlsx, pdf, csv, ods/);
    expect(() => resolveExport(GOOGLE_MIME.drawing, 'txt')).toThrow(ValidationError);
  });

  it('rejects exportFormat on binary files', () => {
    expect(() => resolveExport('image/png', 'pdf')).toThrow(/only applies to Google/);
  });

  it('rejects non-exportable Google types', () => {
    expect(() => resolveExport(GOOGLE_MIME.folder)).toThrow(UnsupportedTypeError);
    expect(() => resolveExport('application/vnd.google-apps.form')).toThrow(UnsupportedTypeError);
    expect(() => resolveExport('application/vnd.google-apps.site')).toThrow(UnsupportedTypeError);
  });
});
