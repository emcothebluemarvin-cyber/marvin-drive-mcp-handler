import { describe, expect, it } from 'vitest';
import { ValidationError } from '../../errors.js';
import { GOOGLE_MIME } from '../../files/export-formats.js';
import { classifyRemote, toRemoteItem, validateGoogleExport } from '../remote/google-remote.js';
import { DEFAULT_GOOGLE_EXPORT } from '../types.js';
import { binary, folder } from './drive-tree.js';
import { DOCX_MIME } from './fixtures.js';

describe('classifyRemote', () => {
  it('binary files', () => {
    expect(classifyRemote({ mimeType: 'application/pdf' }, DEFAULT_GOOGLE_EXPORT)).toEqual({
      kind: 'binary',
    });
  });
  it('Google-native files with the pair export format', () => {
    expect(classifyRemote({ mimeType: GOOGLE_MIME.document }, DEFAULT_GOOGLE_EXPORT)).toEqual({
      kind: 'native',
      mimeType: GOOGLE_MIME.document,
      exportFormat: 'docx',
      exportMime: DOCX_MIME,
      extension: 'docx',
    });
    const prefs = { ...DEFAULT_GOOGLE_EXPORT, spreadsheet: 'csv' as const };
    expect(classifyRemote({ mimeType: GOOGLE_MIME.spreadsheet }, prefs)).toMatchObject({
      kind: 'native',
      exportFormat: 'csv',
      exportMime: 'text/csv',
    });
    expect(classifyRemote({ mimeType: GOOGLE_MIME.drawing }, DEFAULT_GOOGLE_EXPORT)).toMatchObject({
      exportFormat: 'pdf',
    });
  });
  it('unsupported Google types (Forms, Sites, Apps Script, Jamboard, Maps)', () => {
    for (const t of ['form', 'site', 'script', 'jam', 'map']) {
      expect(
        classifyRemote({ mimeType: `application/vnd.google-apps.${t}` }, DEFAULT_GOOGLE_EXPORT),
      ).toEqual({ kind: 'unsupported', reason: 'native-unsupported' });
    }
  });
});
describe('validateGoogleExport', () => {
  it('fills omitted types with the defaults', () => {
    expect(validateGoogleExport({})).toEqual(DEFAULT_GOOGLE_EXPORT);
    expect(validateGoogleExport({ document: 'pdf' })).toEqual({
      ...DEFAULT_GOOGLE_EXPORT,
      document: 'pdf',
    });
  });
  it('rejects a format the type cannot be exported as', () => {
    expect(() => validateGoogleExport({ spreadsheet: 'docx' })).toThrow(ValidationError);
    expect(() => validateGoogleExport({ spreadsheet: 'docx' })).toThrow(
      'Google Sheets cannot be exported as "docx"',
    );
  });
});
describe('toRemoteItem', () => {
  it('maps a binary Drive file', () => {
    expect(
      toRemoteItem(binary('b', 'a.pdf', 'P', { trashed: true }), DEFAULT_GOOGLE_EXPORT),
    ).toEqual({
      id: 'b',
      name: 'a.pdf',
      parentId: 'P',
      kind: 'file',
      mimeType: 'application/pdf',
      size: 10,
      modifiedTime: '2026-11-02T00:00:00.000Z',
      createdTime: '2026-11-01T00:00:00.000Z',
      hash: { kind: 'md5', value: 'md5-b' },
      version: null,
      trashed: true,
      canEdit: true,
      canTrash: true,
      canAddChildren: false,
      native: null,
    });
  });
  it('defaults missing fields like the scanner did', () => {
    expect(toRemoteItem({}, DEFAULT_GOOGLE_EXPORT)).toMatchObject({
      id: '',
      name: '',
      parentId: null,
      kind: 'file',
      mimeType: 'application/octet-stream',
      size: null,
      modifiedTime: '',
      createdTime: '',
      hash: null,
      trashed: false,
      canEdit: false,
      canTrash: false,
      canAddChildren: true,
    });
    expect(toRemoteItem({ size: '0' }, DEFAULT_GOOGLE_EXPORT).size).toBe(0);
  });
  it('folders, shortcuts and natives', () => {
    expect(toRemoteItem(folder('f', 'docs', 'P'), DEFAULT_GOOGLE_EXPORT).kind).toBe('folder');
    expect(
      toRemoteItem({ id: 's', mimeType: GOOGLE_MIME.shortcut }, DEFAULT_GOOGLE_EXPORT),
    ).toMatchObject({ kind: 'unsupported', unsupported: 'shortcut' });
    expect(
      toRemoteItem(
        { id: 'x', mimeType: 'application/vnd.google-apps.form' },
        DEFAULT_GOOGLE_EXPORT,
      ),
    ).toMatchObject({ kind: 'unsupported', unsupported: 'native-unsupported' });
    const prefs = { ...DEFAULT_GOOGLE_EXPORT, spreadsheet: 'csv' as const };
    expect(toRemoteItem({ id: 'g', mimeType: GOOGLE_MIME.spreadsheet }, prefs)).toMatchObject({
      kind: 'file',
      hash: null,
      native: { mimeType: GOOGLE_MIME.spreadsheet, exportFormat: 'csv', exportMime: 'text/csv' },
    });
  });
});
