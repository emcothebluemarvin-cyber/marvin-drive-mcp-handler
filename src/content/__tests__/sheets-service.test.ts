import { beforeEach, describe, expect, it } from 'vitest';
import { ValidationError } from '../../errors.js';
import { GOOGLE_MIME } from '../../files/export-formats.js';
import {
  createAudit,
  createFakeDrive,
  createFakeSheets,
  createRunner,
  httpError,
  noSleep,
  silentLogger,
  stubFile,
  type FakeDrive,
  type FakeSheets,
} from '../../files/__tests__/fakes.js';
import { SheetsService } from '../sheets-service.js';

let drive: FakeDrive;
let sheets: FakeSheets;
let audit: ReturnType<typeof createAudit>;
let service: SheetsService;

beforeEach(() => {
  drive = createFakeDrive();
  sheets = createFakeSheets();
  audit = createAudit();
  service = new SheetsService({
    runner: createRunner(drive, { sheets }),
    audit,
    retry: noSleep,
    logger: silentLogger(),
  });
});

const sheet = (): void => stubFile(drive, 's1', GOOGLE_MIME.spreadsheet, 'Budget');

describe('SheetsService', () => {
  it('info lists tabs', async () => {
    sheet();
    sheets.getSpreadsheet.mockResolvedValueOnce({
      properties: { title: 'Budget', locale: 'tr_TR', timeZone: 'Europe/Istanbul' },
      sheets: [
        {
          properties: {
            sheetId: 0,
            title: 'Modüller',
            index: 0,
            gridProperties: { rowCount: 1000, columnCount: 26 },
          },
        },
        {
          properties: {
            sheetId: 7,
            title: 'Hidden',
            index: 1,
            hidden: true,
            gridProperties: { rowCount: 5, columnCount: 2 },
          },
        },
      ],
    });
    await expect(service.info({ fileId: 's1' })).resolves.toEqual({
      fileId: 's1',
      name: 'Budget',
      locale: 'tr_TR',
      timeZone: 'Europe/Istanbul',
      sheets: [
        { sheetId: 0, title: 'Modüller', index: 0, rowCount: 1000, columnCount: 26, hidden: false },
        { sheetId: 7, title: 'Hidden', index: 1, rowCount: 5, columnCount: 2, hidden: true },
      ],
    });
  });

  it('readRange maps render options and truncates whole rows', async () => {
    sheet();
    sheets.getValues.mockResolvedValueOnce({
      range: 'A!A1:C3',
      values: [['a', 'b', 'c'], ['d', 'e', 'f'], ['g']],
    });
    const res = await service.readRange({
      fileId: 's1',
      range: 'A!A1:C3',
      render: 'formula',
      maxCells: 5,
    });
    expect(sheets.getValues).toHaveBeenCalledWith('s1', 'A!A1:C3', 'FORMULA');
    expect(res).toEqual({
      range: 'A!A1:C3',
      values: [['a', 'b', 'c']],
      rowCount: 1,
      totalRows: 3,
      truncated: true,
    });
  });

  it('readRange returns at least one row and handles empty ranges', async () => {
    sheet();
    sheets.getValues.mockResolvedValueOnce({ range: 'A!A1', values: [['a', 'b', 'c']] });
    await expect(
      service.readRange({ fileId: 's1', range: 'A!A1', maxCells: 1 }),
    ).resolves.toMatchObject({
      rowCount: 1,
      truncated: false,
    });
    sheet();
    sheets.getValues.mockResolvedValueOnce({ range: 'A!Z9' });
    await expect(service.readRange({ fileId: 's1', range: 'A!Z9' })).resolves.toEqual({
      range: 'A!Z9',
      values: [],
      rowCount: 0,
      totalRows: 0,
      truncated: false,
    });
    expect(sheets.getValues.mock.calls[1]?.[2]).toBe('FORMATTED_VALUE');
  });

  it('writeRange clears null cells and audits counts only', async () => {
    sheet();
    sheets.updateValues.mockResolvedValueOnce({
      updatedRange: 'A!A1:B1',
      updatedRows: 1,
      updatedColumns: 2,
      updatedCells: 2,
    });
    const res = await service.writeRange({
      fileId: 's1',
      range: 'A!A1:B1',
      values: [['=1+1', null]],
    });
    expect(sheets.updateValues).toHaveBeenCalledWith(
      's1',
      'A!A1:B1',
      [['=1+1', '']],
      'USER_ENTERED',
    );
    expect(res).toEqual({
      updatedRange: 'A!A1:B1',
      updatedRows: 1,
      updatedColumns: 2,
      updatedCells: 2,
    });
    expect(audit.entries[0]).toMatchObject({
      op: 'sheets_write_range',
      details: { updatedRange: 'A!A1:B1', updatedCells: 2, input: 'user_entered' },
    });
    expect(JSON.stringify(audit.entries)).not.toContain('=1+1');
  });

  it('rejects more than 10 000 cells before calling Sheets', async () => {
    sheet();
    const values = Array.from({ length: 101 }, () => Array.from({ length: 100 }, () => 1));
    await expect(service.writeRange({ fileId: 's1', range: 'A', values })).rejects.toBeInstanceOf(
      ValidationError,
    );
    expect(sheets.updateValues).not.toHaveBeenCalled();
  });

  it('appendRows uses RAW when asked and never retries 5xx', async () => {
    sheet();
    sheets.appendValues.mockResolvedValueOnce({
      updates: { updatedRange: 'A!A4:B4', updatedRows: 1, updatedCells: 2 },
    });
    await expect(
      service.appendRows({ fileId: 's1', range: 'A', values: [['x', 2]], input: 'raw' }),
    ).resolves.toEqual({
      updatedRange: 'A!A4:B4',
      updatedRows: 1,
      updatedCells: 2,
    });
    expect(sheets.appendValues).toHaveBeenCalledWith('s1', 'A', [['x', 2]], 'RAW');
    sheet();
    sheets.appendValues.mockRejectedValueOnce(httpError(502));
    await expect(service.appendRows({ fileId: 's1', range: 'A', values: [['x']] })).rejects.toThrow(
      /re-read/,
    );
    expect(sheets.appendValues).toHaveBeenCalledTimes(2);
  });

  it('batchUpdate passes requests through and audits kinds', async () => {
    sheet();
    sheets.batchUpdate.mockResolvedValueOnce({
      replies: [{ addSheet: { properties: { sheetId: 9 } } }],
    });
    const requests = [{ addSheet: { properties: { title: 'New' } } }];
    await expect(service.batchUpdate({ fileId: 's1', requests })).resolves.toEqual({
      replies: [{ addSheet: { properties: { sheetId: 9 } } }],
    });
    expect(audit.entries[0]?.details).toEqual({
      requestCount: 1,
      requestKinds: ['addSheet'],
      guarded: false,
    });
  });
});
