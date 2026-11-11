import { describe, expect, it } from 'vitest';
import { NotFoundError, QuotaExceededError, ValidationError } from '../../errors.js';
import { createFakeDrive, httpError } from '../../files/__tests__/fakes.js';
import { GOOGLE_MIME } from '../../files/export-formats.js';
import { classifyRemote, toRemoteItem, validateGoogleExport } from '../remote/google-remote.js';
import { DEFAULT_GOOGLE_EXPORT } from '../types.js';
import { binary, folder } from './drive-tree.js';
import { googleRemoteOver } from './fake-remote.js';
import { DOCX_MIME } from './fixtures.js';

const FILE_FIELDS =
  'id, name, mimeType, md5Checksum, size, modifiedTime, createdTime, parents, trashed, capabilities(canEdit, canTrash, canAddChildren)';
const LIST_FIELDS = `nextPageToken, files(${FILE_FIELDS})`;
const FOLDER_Q =
  "'P\\'1' in parents and trashed = false and mimeType = 'application/vnd.google-apps.folder'";

describe('GoogleSyncRemote reads (pinned to the Drive calls sync made before the port)', () => {
  it('read and get: one getFile with the sync fields; get maps 404/403 to null', async () => {
    const drive = createFakeDrive();
    drive.getFile.mockResolvedValueOnce(binary('r', 'a.pdf', 'P'));
    const remote = googleRemoteOver(drive);
    expect(await remote.read('r')).toMatchObject({ id: 'r', parentId: 'P', kind: 'file' });
    expect(drive.getFile).toHaveBeenCalledWith('r', FILE_FIELDS);
    drive.getFile.mockRejectedValueOnce(httpError(404, 'notFound'));
    expect(await remote.get('gone')).toBeNull();
    drive.getFile.mockRejectedValueOnce(httpError(403, 'forbidden'));
    expect(await remote.get('denied')).toBeNull();
    drive.getFile.mockRejectedValueOnce(httpError(404, 'notFound'));
    await expect(remote.read('gone')).rejects.toBeInstanceOf(NotFoundError);
    drive.getFile.mockRejectedValueOnce(httpError(403, 'storageQuotaExceeded'));
    await expect(remote.get('q')).rejects.toBeInstanceOf(QuotaExceededError);
  });

  it('listChildren: the children query, page size 1000 and the list fields', async () => {
    const drive = createFakeDrive();
    drive.listFiles
      .mockResolvedValueOnce({ files: [binary('a', 'a.pdf', 'P')], nextPageToken: 't2' })
      .mockResolvedValueOnce({ files: [folder('f', 'docs', 'P')] });
    const remote = googleRemoteOver(drive);
    const first = await remote.listChildren("P'1", undefined);
    expect(first.items.map((i) => i.id)).toEqual(['a']);
    expect(first.next).toBe('t2');
    const second = await remote.listChildren("P'1", 't2');
    expect(second).toEqual({ items: [expect.objectContaining({ id: 'f', kind: 'folder' })] });
    expect(drive.listFiles.mock.calls.map((c) => c[0])).toEqual([
      { q: "'P\\'1' in parents and trashed = false", pageSize: 1000, fields: LIST_FIELDS },
      {
        q: "'P\\'1' in parents and trashed = false",
        pageSize: 1000,
        pageToken: 't2',
        fields: LIST_FIELDS,
      },
    ]);
  });

  it('findChildren folders: the folder query, paged, id and name only, fold-matched', async () => {
    const drive = createFakeDrive();
    drive.listFiles
      .mockResolvedValueOnce({ files: [{ id: 'f1', name: 'Docs' }], nextPageToken: 'n' })
      .mockResolvedValueOnce({
        files: [
          { id: 'f2', name: 'other' },
          { id: 'f3', name: 'docs' },
        ],
      });
    const found = await googleRemoteOver(drive).findChildren("P'1", 'docs', 'folder');
    expect(found.map((f) => [f.id, f.name, f.kind, f.parentId])).toEqual([
      ['f1', 'Docs', 'folder', "P'1"],
      ['f3', 'docs', 'folder', "P'1"],
    ]);
    expect(drive.listFiles.mock.calls.map((c) => c[0])).toEqual([
      { q: FOLDER_Q, pageSize: 1000, fields: 'nextPageToken, files(id, name)' },
      { q: FOLDER_Q, pageSize: 1000, pageToken: 'n', fields: 'nextPageToken, files(id, name)' },
    ]);
  });

  it('findChildren files: one page of the name query with the list fields', async () => {
    const drive = createFakeDrive();
    drive.listFiles.mockResolvedValueOnce({
      files: [binary('a', "it's.pdf", 'P'), binary('b', 'other.pdf', 'P')],
      nextPageToken: 'ignored',
    });
    const found = await googleRemoteOver(drive).findChildren('P', "it's.pdf");
    expect(found.map((f) => f.id)).toEqual(['a']);
    expect(drive.listFiles).toHaveBeenCalledTimes(1);
    expect(drive.listFiles).toHaveBeenCalledWith({
      q: "'P' in parents and trashed = false and name = 'it\\'s.pdf'",
      pageSize: 100,
      fields: LIST_FIELDS,
    });
  });

  it('is the Google remote with md5 hashes', () => {
    const remote = googleRemoteOver(createFakeDrive());
    expect([remote.provider, remote.hashKind, remote.rootId, remote.account]).toEqual([
      'google',
      'md5',
      'root',
      'emco',
    ]);
  });
});

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
