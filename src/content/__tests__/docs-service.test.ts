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

const END_DOC = {
  revisionId: 'r5',
  body: {
    content: [
      { endIndex: 1, sectionBreak: {} },
      {
        startIndex: 1,
        endIndex: 7,
        paragraph: {
          paragraphStyle: { namedStyleType: 'HEADING_1' },
          elements: [{ textRun: { content: 'Goals\n' } }],
        },
      },
      {
        startIndex: 7,
        endIndex: 12,
        paragraph: {
          paragraphStyle: { namedStyleType: 'NORMAL_TEXT' },
          elements: [{ textRun: { content: 'Ship\n' } }],
        },
      },
      {
        startIndex: 12,
        endIndex: 18,
        paragraph: {
          paragraphStyle: { namedStyleType: 'HEADING_2' },
          elements: [{ textRun: { content: 'Later\n' } }],
        },
      },
    ],
  },
};

describe('DocsService.replaceText', () => {
  it('replaces all occurrences, returns the new revision and audits counts only', async () => {
    doc();
    docs.batchUpdate.mockResolvedValueOnce({
      replies: [{ replaceAllText: { occurrencesChanged: 3 } }],
      writeControl: { requiredRevisionId: 'r9' },
    });
    const res = await service.replaceText({
      fileId: 'd1',
      find: 'a',
      replace: 'b',
      requiredRevisionId: 'r8',
    });
    expect(docs.batchUpdate).toHaveBeenCalledWith(
      'd1',
      [{ replaceAllText: { containsText: { text: 'a', matchCase: true }, replaceText: 'b' } }],
      'r8',
    );
    expect(res).toEqual({ occurrencesChanged: 3, revisionId: 'r9' });
    expect(audit.entries[0]).toEqual({
      account: 'emco',
      op: 'docs_replace_text',
      fileId: 'd1',
      name: 'Plan',
      details: { occurrencesChanged: 3, matchCase: true, guarded: 'caller' },
    });
    expect(JSON.stringify(audit.entries)).not.toContain('"b"');
  });

  it('reports 0 when Docs omits occurrencesChanged', async () => {
    doc();
    docs.batchUpdate.mockResolvedValueOnce({ replies: [{ replaceAllText: {} }] });
    await expect(
      service.replaceText({ fileId: 'd1', find: 'zz', replace: 'y', matchCase: false }),
    ).resolves.toEqual({ occurrencesChanged: 0, revisionId: null });
    expect(audit.entries[0]?.details).toMatchObject({ guarded: false, matchCase: false });
  });

  it('never retries a 5xx edit', async () => {
    doc();
    docs.batchUpdate.mockRejectedValueOnce(httpError(500));
    await expect(service.replaceText({ fileId: 'd1', find: 'a', replace: 'b' })).rejects.toThrow(
      /re-read the file/,
    );
    expect(docs.batchUpdate).toHaveBeenCalledTimes(1);
  });
});

describe('DocsService.insertText', () => {
  it('inserts at the end under the implicit read guard', async () => {
    doc();
    docs.getDocument.mockResolvedValueOnce(END_DOC);
    docs.batchUpdate.mockResolvedValueOnce({ writeControl: { requiredRevisionId: 'r6' } });
    const res = await service.insertText({ fileId: 'd1', text: '\nMore', position: { at: 'end' } });
    expect(docs.getDocument).toHaveBeenCalledWith('d1', DOC_FIELDS);
    expect(docs.batchUpdate).toHaveBeenCalledWith(
      'd1',
      [{ insertText: { location: { index: 17 }, text: '\nMore' } }],
      'r5',
    );
    expect(res).toEqual({ insertedAt: 17, revisionId: 'r6' });
    expect(audit.entries[0]?.details).toEqual({
      position: 'end',
      insertedAt: 17,
      chars: 5,
      guarded: 'implicit',
    });
  });

  it('prefers the caller revision over the implicit one', async () => {
    doc();
    docs.getDocument.mockResolvedValueOnce(END_DOC);
    docs.batchUpdate.mockResolvedValueOnce({});
    await service.insertText({
      fileId: 'd1',
      text: 'x',
      position: { at: 'end' },
      requiredRevisionId: 'mine',
    });
    expect(docs.batchUpdate.mock.calls[0]?.[2]).toBe('mine');
    expect(audit.entries[0]?.details).toMatchObject({ guarded: 'caller' });
  });

  it('inserts after a heading and normalizes the new paragraph style', async () => {
    doc();
    docs.getDocument.mockResolvedValueOnce(END_DOC);
    docs.batchUpdate.mockResolvedValueOnce({});
    await service.insertText({
      fileId: 'd1',
      text: 'First\n',
      position: { at: 'afterHeading', heading: 'Goals' },
    });
    expect(docs.batchUpdate.mock.calls[0]?.[1]).toEqual([
      { insertText: { location: { index: 7 }, text: 'First\n' } },
      {
        updateParagraphStyle: {
          range: { startIndex: 7, endIndex: 13 },
          paragraphStyle: { namedStyleType: 'NORMAL_TEXT' },
          fields: 'namedStyleType',
        },
      },
    ]);
  });

  it('does not restyle when the text merges into the next paragraph', async () => {
    doc();
    docs.getDocument.mockResolvedValueOnce(END_DOC);
    docs.batchUpdate.mockResolvedValueOnce({});
    await service.insertText({
      fileId: 'd1',
      text: 'Pre: ',
      position: { at: 'afterHeading', heading: 'Goals' },
    });
    expect(docs.batchUpdate.mock.calls[0]?.[1]).toEqual([
      { insertText: { location: { index: 7 }, text: 'Pre: ' } },
    ]);
  });

  it('handles a heading that is the last paragraph', async () => {
    doc();
    docs.getDocument.mockResolvedValueOnce(END_DOC);
    docs.batchUpdate.mockResolvedValueOnce({});
    await service.insertText({
      fileId: 'd1',
      text: 'Soon',
      position: { at: 'afterHeading', heading: 'Later' },
    });
    expect(docs.batchUpdate.mock.calls[0]?.[1]).toEqual([
      { insertText: { location: { index: 17 }, text: '\nSoon' } },
      {
        updateParagraphStyle: {
          range: { startIndex: 18, endIndex: 23 },
          paragraphStyle: { namedStyleType: 'NORMAL_TEXT' },
          fields: 'namedStyleType',
        },
      },
    ]);
  });

  it('lists available headings when the heading is missing', async () => {
    doc();
    docs.getDocument.mockResolvedValueOnce(END_DOC);
    await expect(
      service.insertText({
        fileId: 'd1',
        text: 'x',
        position: { at: 'afterHeading', heading: 'Nope' },
      }),
    ).rejects.toThrow('Heading "Nope" not found in "Plan". Available headings: "Goals", "Later"');
    expect(docs.batchUpdate).not.toHaveBeenCalled();
  });

  it('inserts at an explicit index without reading', async () => {
    doc();
    docs.batchUpdate.mockResolvedValueOnce({});
    await service.insertText({ fileId: 'd1', text: 'x', position: { at: 'index', index: 5 } });
    expect(docs.getDocument).not.toHaveBeenCalled();
    expect(docs.batchUpdate).toHaveBeenCalledWith(
      'd1',
      [{ insertText: { location: { index: 5 }, text: 'x' } }],
      undefined,
    );
    expect(audit.entries[0]?.details).toMatchObject({ guarded: false });
  });
});

describe('DocsService.batchUpdate', () => {
  it('sends raw requests under the required revision and audits request kinds', async () => {
    doc();
    docs.batchUpdate.mockResolvedValueOnce({
      replies: [{}, {}],
      writeControl: { requiredRevisionId: 'r2' },
    });
    const requests = [
      { insertText: { location: { index: 1 }, text: 'A' } },
      {
        updateTextStyle: {
          range: { startIndex: 1, endIndex: 2 },
          textStyle: { bold: true },
          fields: 'bold',
        },
      },
      { insertText: { location: { index: 2 }, text: 'B' } },
    ];
    const res = await service.batchUpdate({ fileId: 'd1', requests, requiredRevisionId: 'r1' });
    expect(docs.batchUpdate).toHaveBeenCalledWith('d1', requests, 'r1');
    expect(res).toEqual({ replies: [{}, {}], revisionId: 'r2' });
    expect(audit.entries[0]?.details).toEqual({
      requestCount: 3,
      requestKinds: ['insertText', 'updateTextStyle'],
      guarded: 'caller',
    });
  });
});
