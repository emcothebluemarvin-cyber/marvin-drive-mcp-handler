import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { beforeEach, describe, expect, it } from 'vitest';
import { ExportTooLargeError, UnsupportedTypeError, ValidationError } from '../../errors.js';
import { GOOGLE_MIME } from '../export-formats.js';
import { FileService } from '../file-service.js';
import {
  createAudit,
  createFakeDrive,
  createRunner,
  httpError,
  noSleep,
  silentLogger,
  type FakeDrive,
} from './fakes.js';

const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

let dir: string;
let drive: FakeDrive;
let service: FileService;

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'marvin-download-'));
  drive = createFakeDrive();
  service = new FileService({
    runner: createRunner(drive),
    audit: createAudit(),
    downloadsDir: dir,
    retry: noSleep,
    logger: silentLogger(),
  });
});

const stream = (text: string): Readable => Readable.from([text]);

describe('download', () => {
  it('downloads binary files as-is into the default directory', async () => {
    drive.getFile.mockResolvedValueOnce({
      id: 'f1',
      name: 'report.pdf',
      mimeType: 'application/pdf',
    });
    drive.downloadMedia.mockResolvedValueOnce(stream('PDF'));
    const res = await service.download({ fileId: 'f1' });
    expect(res).toEqual({
      path: path.join(dir, 'report.pdf'),
      size: 3,
      mimeType: 'application/pdf',
      exportFormat: null,
    });
    expect(await readFile(res.path, 'utf8')).toBe('PDF');
  });

  it('exports Google Docs with the default format and extension', async () => {
    drive.getFile.mockResolvedValueOnce({ id: 'd1', name: 'Plan', mimeType: GOOGLE_MIME.document });
    drive.exportMedia.mockResolvedValueOnce(stream('DOCX'));
    const res = await service.download({ fileId: 'd1' });
    expect(drive.exportMedia).toHaveBeenCalledWith('d1', DOCX);
    expect(res).toMatchObject({ path: path.join(dir, 'Plan.docx'), exportFormat: 'docx' });
  });

  it('honours exportFormat and rejects invalid combinations without writing', async () => {
    drive.getFile.mockResolvedValue({ id: 'd1', name: 'Plan', mimeType: GOOGLE_MIME.document });
    drive.exportMedia.mockResolvedValueOnce(stream('# md'));
    const res = await service.download({ fileId: 'd1', exportFormat: 'md' });
    expect(drive.exportMedia).toHaveBeenCalledWith('d1', 'text/markdown');
    expect(path.basename(res.path)).toBe('Plan.md');

    drive.getFile.mockResolvedValue({ id: 's1', name: 'Sheet', mimeType: GOOGLE_MIME.spreadsheet });
    await expect(service.download({ fileId: 's1', exportFormat: 'md' })).rejects.toThrow(
      ValidationError,
    );
    expect(await readdir(dir)).toEqual(['Plan.md']);
  });

  it('resolves shortcuts to their target', async () => {
    drive.getFile
      .mockResolvedValueOnce({
        id: 's1',
        name: 'link',
        mimeType: GOOGLE_MIME.shortcut,
        shortcutDetails: { targetId: 't1' },
      })
      .mockResolvedValueOnce({ id: 't1', name: 'target.txt', mimeType: 'text/plain' });
    drive.downloadMedia.mockResolvedValueOnce(stream('T'));
    const res = await service.download({ fileId: 's1' });
    expect(drive.downloadMedia).toHaveBeenCalledWith('t1');
    expect(path.basename(res.path)).toBe('target.txt');
  });

  it('rejects folders and other non-exportable Google types', async () => {
    drive.getFile.mockResolvedValueOnce({ id: 'd1', name: 'Folder', mimeType: GOOGLE_MIME.folder });
    await expect(service.download({ fileId: 'd1' })).rejects.toThrow(UnsupportedTypeError);
  });

  it('never overwrites existing files', async () => {
    await writeFile(path.join(dir, 'report.pdf'), 'old');
    drive.getFile.mockResolvedValueOnce({
      id: 'f1',
      name: 'report.pdf',
      mimeType: 'application/pdf',
    });
    drive.downloadMedia.mockResolvedValueOnce(stream('new'));
    const res = await service.download({ fileId: 'f1' });
    expect(path.basename(res.path)).toBe('report (1).pdf');
    expect(await readFile(path.join(dir, 'report.pdf'), 'utf8')).toBe('old');
  });

  it('keeps hostile names inside the destination directory', async () => {
    drive.getFile.mockResolvedValueOnce({ id: 'x1', name: '../../.zshrc', mimeType: 'text/plain' });
    drive.downloadMedia.mockResolvedValueOnce(stream('evil'));
    const res = await service.download({ fileId: 'x1' });
    expect(path.dirname(res.path)).toBe(dir);
    expect(path.basename(res.path)).toBe('_.._.zshrc');
  });

  it('writes to an explicit full file path', async () => {
    drive.getFile.mockResolvedValueOnce({
      id: 'f1',
      name: 'report.pdf',
      mimeType: 'application/pdf',
    });
    drive.downloadMedia.mockResolvedValueOnce(stream('PDF'));
    const target = path.join(dir, 'sub', 'custom.pdf');
    const res = await service.download({ fileId: 'f1', destPath: target });
    expect(res.path).toBe(target);
  });

  it('falls back to exportLinks when the export exceeds 10 MB', async () => {
    drive.getFile.mockResolvedValueOnce({
      id: 'd1',
      name: 'Big',
      mimeType: GOOGLE_MIME.document,
      webViewLink: 'https://docs/d1',
      exportLinks: { [DOCX]: 'https://export/d1.docx' },
    });
    drive.exportMedia.mockRejectedValueOnce(httpError(403, 'exportSizeLimitExceeded'));
    drive.fetchExportLink.mockResolvedValueOnce(stream('BIG'));
    const res = await service.download({ fileId: 'd1' });
    expect(drive.fetchExportLink).toHaveBeenCalledWith('https://export/d1.docx');
    expect(await readFile(res.path, 'utf8')).toBe('BIG');
  });

  it('reports ExportTooLargeError with the web link when the fallback fails', async () => {
    drive.getFile.mockResolvedValueOnce({
      id: 'd1',
      name: 'Big',
      mimeType: GOOGLE_MIME.document,
      webViewLink: 'https://docs/d1',
      exportLinks: { [DOCX]: 'https://export/d1.docx' },
    });
    drive.exportMedia.mockRejectedValueOnce(httpError(403, 'exportSizeLimitExceeded'));
    drive.fetchExportLink.mockRejectedValueOnce(httpError(403));
    const err = await service.download({ fileId: 'd1' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ExportTooLargeError);
    expect((err as Error).message).toContain('https://docs/d1');
    expect(await readdir(dir)).toEqual([]);
  });

  it('cleans up the partial file when the stream breaks', async () => {
    drive.getFile.mockResolvedValueOnce({
      id: 'f1',
      name: 'big.bin',
      mimeType: 'application/octet-stream',
    });
    drive.downloadMedia.mockResolvedValueOnce(
      new Readable({
        read() {
          this.destroy(new Error('socket hang up'));
        },
      }),
    );
    await expect(service.download({ fileId: 'f1' })).rejects.toThrow(/socket hang up/);
    expect(await readdir(dir)).toEqual([]);
  });
});
