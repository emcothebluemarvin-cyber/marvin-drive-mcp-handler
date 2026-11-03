import { Readable } from 'node:stream';
import { beforeEach, describe, expect, it } from 'vitest';
import { ValidationError } from '../../errors.js';
import { GOOGLE_MIME } from '../../files/export-formats.js';
import {
  createAudit,
  createFakeDocs,
  createFakeDrive,
  createRunner,
  httpError,
  noSleep,
  silentLogger,
  stubFile,
  type FakeDocs,
  type FakeDrive,
} from '../../files/__tests__/fakes.js';
import { DocsService } from '../docs-service.js';
import { DOC_FIELDS } from '../docs-structure.js';

let drive: FakeDrive;
let docs: FakeDocs;
let audit: ReturnType<typeof createAudit>;
let service: DocsService;

beforeEach(() => {
  drive = createFakeDrive();
  docs = createFakeDocs();
  audit = createAudit();
  service = new DocsService({
    runner: createRunner(drive, { docs }),
    audit,
    retry: noSleep,
    logger: silentLogger(),
  });
});

const doc = (): void => stubFile(drive, 'd1', GOOGLE_MIME.document, 'Plan');

describe('DocsService.read', () => {
  it('reads the revision before exporting Markdown', async () => {
    doc();
    const order: string[] = [];
    docs.getDocument.mockImplementationOnce(async () => {
      order.push('revision');
      return { revisionId: 'r1' };
    });
    drive.exportMedia.mockImplementationOnce(async () => {
      order.push('export');
      return Readable.from([Buffer.from('# Plan\n\nHello')]);
    });
    const res = await service.read({ fileId: 'd1' });
    expect(order).toEqual(['revision', 'export']);
    expect(docs.getDocument).toHaveBeenCalledWith('d1', 'revisionId');
    expect(drive.exportMedia).toHaveBeenCalledWith('d1', 'text/markdown');
    expect(res).toEqual({
      fileId: 'd1',
      name: 'Plan',
      revisionId: 'r1',
      format: 'markdown',
      content: '# Plan\n\nHello',
      totalChars: 13,
      offset: 0,
      truncated: false,
    });
  });

  it('returns the indexed structure', async () => {
    doc();
    docs.getDocument.mockResolvedValueOnce({
      revisionId: 'r2',
      body: {
        content: [
          {
            startIndex: 1,
            endIndex: 6,
            paragraph: { elements: [{ textRun: { content: 'Hey!\n' } }] },
          },
        ],
      },
    });
    const res = await service.read({ fileId: 'd1', format: 'structure' });
    expect(docs.getDocument).toHaveBeenCalledWith('d1', DOC_FIELDS);
    expect(res.content).toBe('[1-6] NORMAL_TEXT "Hey!"');
    expect(res.revisionId).toBe('r2');
  });

  it('pages long content', async () => {
    doc();
    docs.getDocument.mockResolvedValueOnce({ revisionId: 'r1' });
    drive.exportMedia.mockResolvedValueOnce(Readable.from([Buffer.from('a'.repeat(1500))]));
    const res = await service.read({ fileId: 'd1', maxChars: 1000 });
    expect(res).toMatchObject({ truncated: true, nextOffset: 1000, totalChars: 1500 });
    expect(res.content).toHaveLength(1000);
  });

  it('retries a 5xx read', async () => {
    doc();
    docs.getDocument
      .mockRejectedValueOnce(httpError(503))
      .mockResolvedValueOnce({ revisionId: 'r1' });
    drive.exportMedia.mockResolvedValueOnce(Readable.from([Buffer.from('x')]));
    await expect(service.read({ fileId: 'd1' })).resolves.toMatchObject({ content: 'x' });
  });

  it('rejects other file types before calling Docs', async () => {
    stubFile(drive, 's1', GOOGLE_MIME.spreadsheet, 'Budget');
    await expect(service.read({ fileId: 's1' })).rejects.toBeInstanceOf(ValidationError);
    expect(docs.getDocument).not.toHaveBeenCalled();
  });
});
