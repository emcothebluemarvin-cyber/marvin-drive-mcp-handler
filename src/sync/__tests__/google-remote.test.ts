import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { OperationRunner } from '../../core/operation.js';
import { NotFoundError, QuotaExceededError, ValidationError } from '../../errors.js';
import {
  createAudit,
  createFakeDrive,
  createRunner,
  httpError,
  noSleep,
} from '../../files/__tests__/fakes.js';
import { GOOGLE_MIME } from '../../files/export-formats.js';
import {
  GoogleSyncRemote,
  classifyRemote,
  toRemoteItem,
  validateGoogleExport,
} from '../remote/google-remote.js';
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

  it('is the Google remote with md5 hashes and no deletion feed', () => {
    const remote = googleRemoteOver(createFakeDrive());
    expect([remote.provider, remote.hashKind, remote.rootId, remote.account]).toEqual([
      'google',
      'md5',
      'root',
      'emco',
    ]);
    expect(remote.deletionFeed()).toBeNull();
  });

  it('open resolves the account alias through the runner without a Drive call', async () => {
    const drive = createFakeDrive();
    const runner = createRunner(drive);
    const ops = new OperationRunner({ runner, audit: createAudit(), retry: noSleep });
    const remote = await GoogleSyncRemote.open(ops, undefined, DEFAULT_GOOGLE_EXPORT);
    expect(remote.account).toBe('emco');
    expect(runner.refs).toEqual([undefined]);
  });
});

describe('GoogleSyncRemote writes and content (pinned)', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'sync-gremote-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('createFolder: folder MIME type, the parent, id and name fields', async () => {
    const drive = createFakeDrive();
    drive.createFile.mockResolvedValueOnce({ id: 'f9', name: 'docs' });
    const created = await googleRemoteOver(drive).createFolder('P', 'docs');
    expect(created).toMatchObject({ id: 'f9', name: 'docs', kind: 'folder', parentId: 'P' });
    expect(drive.createFile).toHaveBeenCalledWith({
      requestBody: { name: 'docs', mimeType: GOOGLE_MIME.folder, parents: ['P'] },
      fields: 'id, name',
    });
  });

  it('uploadNew creates the file with media and sync fields', async () => {
    const drive = createFakeDrive();
    drive.createFile.mockResolvedValueOnce({ id: 'n1', md5Checksum: 'm' });
    const abs = path.join(dir, 'a.pdf');
    await writeFile(abs, 'x');
    const item = await googleRemoteOver(drive).uploadNew('P', 'a.pdf', abs);
    expect(item).toMatchObject({ id: 'n1', hash: { kind: 'md5', value: 'm' }, parentId: null });
    const call = drive.createFile.mock.calls[0]?.[0];
    expect(call?.requestBody).toEqual({ name: 'a.pdf', parents: ['P'] });
    expect(call?.media?.mimeType).toBe('application/pdf');
    expect(call?.fields).toBe(FILE_FIELDS);
  });

  it('replaceContent sends new media for the same fileId', async () => {
    const drive = createFakeDrive();
    drive.updateFile.mockResolvedValueOnce({ id: 'r1' });
    const abs = path.join(dir, 'a.txt');
    await writeFile(abs, 'x');
    const remote = googleRemoteOver(drive);
    await remote.replaceContent(toRemoteItem({ id: 'r1' }, DEFAULT_GOOGLE_EXPORT), abs);
    const call = drive.updateFile.mock.calls[0]?.[0];
    expect(call).toMatchObject({ fileId: 'r1', fields: FILE_FIELDS });
    expect(call?.media?.mimeType).toBe('text/plain');
  });

  it('trash sets trashed=true with id and trashed fields', async () => {
    const drive = createFakeDrive();
    drive.updateFile.mockResolvedValueOnce({ id: 'r1', trashed: true });
    await googleRemoteOver(drive).trash(toRemoteItem({ id: 'r1' }, DEFAULT_GOOGLE_EXPORT));
    expect(drive.updateFile).toHaveBeenCalledWith({
      fileId: 'r1',
      requestBody: { trashed: true },
      fields: 'id, trashed',
    });
  });

  it('download reruns the consumer, which opens the media stream, on a retryable error', async () => {
    const drive = createFakeDrive();
    drive.downloadMedia.mockImplementation(async () => Readable.from([Buffer.from('abc')]));
    let attempts = 0;
    const text = await googleRemoteOver(drive).download('r1', async (open) => {
      const stream = await open();
      if (++attempts === 1) throw httpError(503, 'backendError');
      let out = '';
      for await (const chunk of stream) out += String(chunk);
      return out;
    });
    expect(text).toBe('abc');
    expect(attempts).toBe(2);
    expect(drive.downloadMedia.mock.calls).toEqual([['r1'], ['r1']]);
  });

  it('readNative reads the export fields; exportNative exports with them', async () => {
    const drive = createFakeDrive();
    drive.getFile.mockResolvedValueOnce({
      id: 'g1',
      name: 'Plan',
      mimeType: GOOGLE_MIME.document,
      exportLinks: { [DOCX_MIME]: 'https://docs.google.com/x' },
      webViewLink: 'https://docs.google.com/view',
    });
    drive.exportMedia.mockRejectedValueOnce(httpError(403, 'exportSizeLimitExceeded'));
    drive.fetchExportLink.mockResolvedValueOnce(Readable.from([Buffer.from('big')]));
    const remote = googleRemoteOver(drive);
    const source = await remote.readNative('g1');
    expect(source.item).toMatchObject({ id: 'g1', native: { exportFormat: 'docx' } });
    expect(drive.getFile).toHaveBeenCalledWith('g1', `${FILE_FIELDS}, exportLinks, webViewLink`);
    const plan = { format: 'docx' as const, extension: 'docx', mimeType: DOCX_MIME };
    const stream = await remote.exportNative(source, plan, (open) => open());
    let out = '';
    for await (const chunk of stream) out += String(chunk);
    expect(out).toBe('big');
    expect(drive.exportMedia).toHaveBeenCalledWith('g1', DOCX_MIME);
    expect(drive.fetchExportLink).toHaveBeenCalledWith('https://docs.google.com/x');
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
