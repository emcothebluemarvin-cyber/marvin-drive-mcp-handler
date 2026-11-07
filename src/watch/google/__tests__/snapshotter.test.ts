import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { OperationRunner } from '../../../core/operation.js';
import { ValidationError } from '../../../errors.js';
import {
  createAudit,
  createFakeDrive,
  createFakeSheets,
  createRunner,
  httpError,
  noSleep,
  silentLogger,
} from '../../../files/__tests__/fakes.js';
import { createGoogleWatchProvider } from '../provider.js';
import {
  COMMENT_FIELDS,
  GoogleSnapshotter,
  SHEET_CELL_LIMIT,
  SHEET_FIELDS,
  TEXT_LIMIT_BYTES,
} from '../snapshotter.js';

function setup() {
  const drive = createFakeDrive();
  const sheets = createFakeSheets();
  const ops = new OperationRunner({
    runner: createRunner(drive, { sheets }),
    audit: createAudit(),
    retry: noSleep,
    logger: silentLogger(),
  });
  return { drive, sheets, snap: new GoogleSnapshotter(ops, 'emco@example.com') };
}

describe('GoogleSnapshotter.snapshot', () => {
  it('exports Docs and Slides as normalized plain text', async () => {
    const { drive, snap } = setup();
    drive.exportMedia.mockImplementation(async () =>
      Readable.from([Buffer.from('\uFEFFa\r\nb\r\n')]),
    );
    expect(await snap.snapshot('d1', 'doc')).toEqual({ type: 'text', text: 'a\nb\n' });
    expect(await snap.snapshot('p1', 'slides')).toEqual({ type: 'text', text: 'a\nb\n' });
    expect(drive.exportMedia).toHaveBeenCalledWith('d1', 'text/plain');
  });

  it('is tooLarge over 1 MB or over the Drive export cap', async () => {
    const { drive, snap } = setup();
    const half = Buffer.alloc(TEXT_LIMIT_BYTES / 2 + 1, 0x61);
    drive.exportMedia.mockResolvedValueOnce(Readable.from([half, half]));
    expect(await snap.snapshot('d1', 'doc')).toEqual({ tooLarge: true });
    drive.exportMedia.mockRejectedValueOnce(httpError(403, 'exportSizeLimitExceeded'));
    expect(await snap.snapshot('d1', 'doc')).toEqual({ tooLarge: true });
  });

  it('reads every grid sheet with one quoted range each', async () => {
    const { sheets, snap } = setup();
    sheets.getSpreadsheet.mockResolvedValueOnce({
      sheets: [
        { properties: { title: 'S 1', gridProperties: { rowCount: 2, columnCount: 2 } } },
        { properties: { title: 'Chart' } },
      ],
    });
    sheets.batchGetValues.mockResolvedValueOnce({ valueRanges: [{ values: [['a', 1], [true]] }] });
    expect(await snap.snapshot('s1', 'sheet')).toEqual({
      type: 'sheet',
      sheets: [{ title: 'S 1', rows: [['a', '1'], ['true']] }],
    });
    expect(sheets.getSpreadsheet).toHaveBeenCalledWith('s1', SHEET_FIELDS);
    expect(sheets.batchGetValues).toHaveBeenCalledWith('s1', ["'S 1'"], 'FORMATTED_VALUE');
  });

  it(`is tooLarge over ${SHEET_CELL_LIMIT} cells without reading values`, async () => {
    const { sheets, snap } = setup();
    sheets.getSpreadsheet.mockResolvedValueOnce({
      sheets: [
        { properties: { title: 'Big', gridProperties: { rowCount: 1001, columnCount: 20 } } },
      ],
    });
    expect(await snap.snapshot('s1', 'sheet')).toEqual({ tooLarge: true });
    expect(sheets.batchGetValues).not.toHaveBeenCalled();
  });

  it('refuses kinds without content', async () => {
    await expect(setup().snap.snapshot('x', 'other')).rejects.toBeInstanceOf(ValidationError);
  });
});

describe('GoogleSnapshotter.commentsSince', () => {
  it('lists comments modified since a time with the spec §6 fields', async () => {
    const { drive, snap } = setup();
    drive.listComments.mockResolvedValueOnce({
      comments: [
        {
          id: 'c1',
          author: { displayName: 'Ayşe', emailAddress: 'a@x.com', me: false },
          content: 'Why 135?',
          createdTime: 't1',
          modifiedTime: 't2',
          resolved: false,
          replies: [
            { author: { displayName: 'Emco', me: true }, content: 'typo', createdTime: 't3' },
          ],
        },
      ],
    });
    expect(await snap.commentsSince('d1', 'since')).toEqual([
      {
        id: 'c1',
        author: { name: 'Ayşe', email: 'a@x.com', me: false },
        content: 'Why 135?',
        createdTime: 't1',
        modifiedTime: 't2',
        resolved: false,
        replies: [
          { author: { name: 'Emco', email: null, me: true }, content: 'typo', createdTime: 't3' },
        ],
      },
    ]);
    expect(drive.listComments).toHaveBeenCalledWith({
      fileId: 'd1',
      startModifiedTime: 'since',
      pageSize: 100,
      fields: COMMENT_FIELDS,
    });
    expect(COMMENT_FIELDS).toBe(
      'comments(id,author(displayName,emailAddress,me),content,createdTime,modifiedTime,resolved,replies(author,content,createdTime))',
    );
  });
});

describe('createGoogleWatchProvider', () => {
  it('resolves accounts and builds per-account feed and snapshotter', async () => {
    const drive = createFakeDrive();
    const provider = createGoogleWatchProvider({
      runner: createRunner(drive),
      audit: createAudit(),
      resolveAccount: async (ref) => ({
        alias: ref ?? 'emco',
        email: 'emco@example.com',
        addedAt: 'x',
      }),
      logger: silentLogger(),
    });
    expect(await provider.resolveAccount(undefined)).toEqual({
      email: 'emco@example.com',
      alias: 'emco',
    });
    drive.getStartPageToken.mockResolvedValueOnce('7');
    expect(await provider.feed('emco@example.com').start()).toBe('7');
    expect(provider.snapshotter('emco@example.com')).toBeInstanceOf(GoogleSnapshotter);
  });
});
