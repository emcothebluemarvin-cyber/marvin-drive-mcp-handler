import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { ExportTooLargeError } from '../../errors.js';
import { GOOGLE_MIME, resolveExport, type ExportPlan } from '../export-formats.js';
import { openExport } from '../export-stream.js';
import { createFakeDrive, httpError, silentLogger } from './fakes.js';

const PLAN = resolveExport(GOOGLE_MIME.document, 'docx') as ExportPlan;
const FILE = {
  id: 'd1',
  name: 'Big',
  mimeType: GOOGLE_MIME.document,
  webViewLink: 'https://docs/d1',
  exportLinks: { [PLAN.mimeType]: 'https://export/d1.docx' },
};

async function text(stream: Readable): Promise<string> {
  let out = '';
  for await (const chunk of stream) out += String(chunk);
  return out;
}
describe('openExport', () => {
  it('streams files.export in the planned MIME type', async () => {
    const drive = createFakeDrive();
    drive.exportMedia.mockResolvedValueOnce(Readable.from([Buffer.from('DOCX')]));
    expect(await text(await openExport(drive, FILE, PLAN, silentLogger()))).toBe('DOCX');
    expect(drive.exportMedia).toHaveBeenCalledWith('d1', PLAN.mimeType);
  });
  it('falls back to the exportLinks URL over the 10 MB limit', async () => {
    const drive = createFakeDrive();
    drive.exportMedia.mockRejectedValueOnce(httpError(403, 'exportSizeLimitExceeded'));
    drive.fetchExportLink.mockResolvedValueOnce(Readable.from([Buffer.from('BIG')]));
    expect(await text(await openExport(drive, FILE, PLAN, silentLogger()))).toBe('BIG');
    expect(drive.fetchExportLink).toHaveBeenCalledWith('https://export/d1.docx');
  });
  it('throws ExportTooLargeError with the web link when the fallback fails', async () => {
    const drive = createFakeDrive();
    const log = silentLogger();
    drive.exportMedia.mockRejectedValueOnce(httpError(403, 'exportSizeLimitExceeded'));
    drive.fetchExportLink.mockRejectedValueOnce(httpError(403));
    const err = await openExport(drive, FILE, PLAN, log).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ExportTooLargeError);
    expect((err as Error).message).toContain('https://docs/d1');
    expect(log.warn).toHaveBeenCalledWith(
      'exportLinks fallback failed',
      expect.objectContaining({ fileId: 'd1' }),
    );
  });
  it('rethrows other export errors and retryable fallback errors', async () => {
    const drive = createFakeDrive();
    drive.exportMedia.mockRejectedValueOnce(httpError(500));
    await expect(openExport(drive, FILE, PLAN, silentLogger())).rejects.toMatchObject({
      status: 500,
    });
    drive.exportMedia.mockRejectedValueOnce(httpError(403, 'exportSizeLimitExceeded'));
    drive.fetchExportLink.mockRejectedValueOnce(httpError(503));
    await expect(openExport(drive, FILE, PLAN, silentLogger())).rejects.toMatchObject({
      status: 503,
    });
  });
});
