import type { CellValue, SheetsRequest, ValueInput, ValueRender } from '../drive/sheets-adapter.js';
import { ValidationError } from '../errors.js';
import { ContentService, requestKinds, type ContentFileRef } from './content-service.js';

const INFO_FIELDS =
  'spreadsheetId,properties(title,locale,timeZone),sheets(properties(sheetId,title,index,hidden,gridProperties(rowCount,columnCount)))';

export const DEFAULT_MAX_CELLS = 5_000;
export const MAX_WRITE_CELLS = 10_000;

export type RenderOption = 'formatted' | 'unformatted' | 'formula';
export type InputOption = 'user_entered' | 'raw';
export type WriteCell = CellValue | null;

const RENDER: Record<RenderOption, ValueRender> = {
  formatted: 'FORMATTED_VALUE',
  unformatted: 'UNFORMATTED_VALUE',
  formula: 'FORMULA',
};

const INPUT: Record<InputOption, ValueInput> = { user_entered: 'USER_ENTERED', raw: 'RAW' };

export interface SheetTab {
  sheetId: number;
  title: string;
  index: number;
  rowCount: number;
  columnCount: number;
  hidden: boolean;
}

export interface SheetsInfo {
  fileId: string;
  name: string;
  locale: string | null;
  timeZone: string | null;
  sheets: SheetTab[];
}

export interface ReadRangeInput extends ContentFileRef {
  range: string;
  render?: RenderOption;
  maxCells?: number;
}

export interface ReadRangeResult {
  range: string;
  values: unknown[][];
  rowCount: number;
  totalRows: number;
  truncated: boolean;
}

export interface WriteRangeInput extends ContentFileRef {
  range: string;
  values: WriteCell[][];
  input?: InputOption;
}

export interface SheetsBatchInput extends ContentFileRef {
  requests: Array<Record<string, unknown>>;
}

/** null → "" (the Sheets API skips nulls, leaving the old value); enforces the write cap. */
function toApiValues(values: WriteCell[][]): CellValue[][] {
  const cells = values.reduce((n, row) => n + row.length, 0);
  if (cells === 0) throw new ValidationError('values must contain at least one cell');
  if (cells > MAX_WRITE_CELLS) {
    throw new ValidationError(
      `Too many cells (${cells}); write at most ${MAX_WRITE_CELLS} per call`,
    );
  }
  return values.map((row) => row.map((v) => (v === null ? '' : v)));
}

export class SheetsService extends ContentService {
  protected readonly api = 'sheets' as const;

  async info(input: ContentFileRef): Promise<SheetsInfo> {
    const file = await this.resolve(input.account, input.fileId);
    return this.run(input.account, file, 'idempotent', async (ctx) => {
      const s = await ctx.sheets.getSpreadsheet(file.id, INFO_FIELDS);
      return {
        fileId: file.id,
        name: s.properties?.title ?? file.name,
        locale: s.properties?.locale ?? null,
        timeZone: s.properties?.timeZone ?? null,
        sheets: (s.sheets ?? []).map((sh) => ({
          sheetId: sh.properties?.sheetId ?? 0,
          title: sh.properties?.title ?? '',
          index: sh.properties?.index ?? 0,
          rowCount: sh.properties?.gridProperties?.rowCount ?? 0,
          columnCount: sh.properties?.gridProperties?.columnCount ?? 0,
          hidden: sh.properties?.hidden ?? false,
        })),
      };
    });
  }

  async readRange(input: ReadRangeInput): Promise<ReadRangeResult> {
    const file = await this.resolve(input.account, input.fileId);
    const max = input.maxCells ?? DEFAULT_MAX_CELLS;
    return this.run(input.account, file, 'idempotent', async (ctx) => {
      const res = await ctx.sheets.getValues(
        file.id,
        input.range,
        RENDER[input.render ?? 'formatted'],
      );
      const all = (res.values ?? []) as unknown[][];
      const values: unknown[][] = [];
      let cells = 0;
      for (const row of all) {
        if (values.length > 0 && cells + row.length > max) break;
        values.push(row);
        cells += row.length;
      }
      return {
        range: res.range ?? input.range,
        values,
        rowCount: values.length,
        totalRows: all.length,
        truncated: values.length < all.length,
      };
    });
  }

  async writeRange(input: WriteRangeInput): Promise<{
    updatedRange: string | null;
    updatedRows: number;
    updatedColumns: number;
    updatedCells: number;
  }> {
    const file = await this.resolve(input.account, input.fileId);
    const values = toApiValues(input.values);
    const inputOption = input.input ?? 'user_entered';
    return this.run(input.account, file, 'mutate', async (ctx) => {
      const res = await ctx.sheets.updateValues(file.id, input.range, values, INPUT[inputOption]);
      const result = {
        updatedRange: res.updatedRange ?? null,
        updatedRows: res.updatedRows ?? 0,
        updatedColumns: res.updatedColumns ?? 0,
        updatedCells: res.updatedCells ?? 0,
      };
      await this.ops.audit(ctx, 'sheets_write_range', file, {
        updatedRange: result.updatedRange,
        updatedCells: result.updatedCells,
        input: inputOption,
      });
      return result;
    });
  }

  async appendRows(input: WriteRangeInput): Promise<{
    updatedRange: string | null;
    updatedRows: number;
    updatedCells: number;
  }> {
    const file = await this.resolve(input.account, input.fileId);
    const values = toApiValues(input.values);
    const inputOption = input.input ?? 'user_entered';
    return this.run(input.account, file, 'mutate', async (ctx) => {
      const res = await ctx.sheets.appendValues(file.id, input.range, values, INPUT[inputOption]);
      const result = {
        updatedRange: res.updates?.updatedRange ?? null,
        updatedRows: res.updates?.updatedRows ?? 0,
        updatedCells: res.updates?.updatedCells ?? 0,
      };
      await this.ops.audit(ctx, 'sheets_append_rows', file, {
        updatedRange: result.updatedRange,
        updatedCells: result.updatedCells,
        input: inputOption,
      });
      return result;
    });
  }

  async batchUpdate(input: SheetsBatchInput): Promise<{ replies: unknown[] }> {
    const file = await this.resolve(input.account, input.fileId);
    return this.run(input.account, file, 'mutate', async (ctx) => {
      const res = await ctx.sheets.batchUpdate(file.id, input.requests as SheetsRequest[]);
      await this.ops.audit(ctx, 'sheets_batch_update', file, {
        requestCount: input.requests.length,
        requestKinds: requestKinds(input.requests),
        guarded: false, // the Sheets API has no revision guard
      });
      return { replies: res.replies ?? [] };
    });
  }
}
