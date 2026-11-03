import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { SheetsService } from '../content/sheets-service.js';
import type { Logger } from '../logger.js';
import { account, contentFileId, rawRequests, respond } from './shared.js';

export const SHEETS_TOOL_NAMES = [
  'sheets_info',
  'sheets_read_range',
  'sheets_write_range',
  'sheets_append_rows',
  'sheets_batch_update',
] as const;

const range = z.string().min(1).describe('A1 notation, e.g. "Sheet1!A1:C10" or a tab name');
const values = z
  .array(z.array(z.union([z.string(), z.number(), z.boolean(), z.null()])).min(1))
  .min(1)
  .describe('Rows of cells (max 10000 cells); null clears a cell');
const input = z
  .enum(['user_entered', 'raw'])
  .optional()
  .describe('user_entered (default): formulas and number parsing apply; raw: stored as-is');

export function registerSheetsTools(server: McpServer, sheets: SheetsService, log: Logger): void {
  server.registerTool(
    'sheets_info',
    {
      description:
        'List the tabs of a Google Sheet (sheetId, title, size, hidden, sheetType) plus locale and time zone.',
      inputSchema: { account, fileId: contentFileId },
    },
    async (args) => respond(log, () => sheets.info(args)),
  );

  server.registerTool(
    'sheets_read_range',
    {
      description:
        'Read cell values from a Google Sheet range. render: formatted (default, as displayed), unformatted, or formula. Truncates whole rows beyond maxCells.',
      inputSchema: {
        account,
        fileId: contentFileId,
        range,
        render: z.enum(['formatted', 'unformatted', 'formula']).optional(),
        maxCells: z.number().int().min(1).max(50_000).optional().describe('Default 5000'),
      },
    },
    async (args) => respond(log, () => sheets.readRange(args)),
  );

  server.registerTool(
    'sheets_write_range',
    {
      description: 'Write values into a Google Sheet range (overwrites existing cells).',
      inputSchema: { account, fileId: contentFileId, range, values, input },
    },
    async (args) => respond(log, () => sheets.writeRange(args)),
  );

  server.registerTool(
    'sheets_append_rows',
    {
      description:
        'Append rows after the last row of the table at `range` (usually a tab name); inserts new rows.',
      inputSchema: { account, fileId: contentFileId, range, values, input },
    },
    async (args) => respond(log, () => sheets.appendRows(args)),
  );

  server.registerTool(
    'sheets_batch_update',
    {
      description:
        'ADVANCED: send raw Google Sheets API batchUpdate requests (add/rename tabs, formatting, sorting…). Prefer the other sheets_* tools. No protection against concurrent edits exists in the Sheets API: target tabs by sheetId from sheets_info, never by position.',
      inputSchema: { account, fileId: contentFileId, requests: rawRequests },
    },
    async (args) => respond(log, () => sheets.batchUpdate(args)),
  );
}
