import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { AppError } from '../errors.js';
import type { Logger } from '../logger.js';

export const account = z
  .string()
  .min(1)
  .optional()
  .describe('Account alias or email. Omit to use the default account.');
export const fileId = z.string().min(1).describe('Google Drive file or folder ID');
export const pageSize = z
  .number()
  .int()
  .min(1)
  .max(200)
  .optional()
  .describe('Results per page (default 50)');
export const pageToken = z
  .string()
  .min(1)
  .optional()
  .describe('nextPageToken from a previous call');

export async function respond(log: Logger, run: () => Promise<unknown>): Promise<CallToolResult> {
  try {
    const data = await run();
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
  } catch (err) {
    if (err instanceof AppError) {
      return { content: [{ type: 'text', text: err.message }], isError: true };
    }
    log.error('Unexpected tool failure', { error: err });
    return {
      content: [{ type: 'text', text: 'Unexpected internal error; see the server log (stderr).' }],
      isError: true,
    };
  }
}

export const maxChars = z
  .number()
  .int()
  .min(1000)
  .max(200_000)
  .optional()
  .describe('Max characters returned (default 50000)');
export const offset = z
  .number()
  .int()
  .min(0)
  .optional()
  .describe('Start offset — pass nextOffset from the previous call (default 0)');
export const requiredRevisionId = z
  .string()
  .min(1)
  .describe(
    'revisionId from the last read (or edit); the change is rejected if the file changed since',
  );
export const rawRequests = z
  .array(z.record(z.string(), z.unknown()))
  .min(1)
  .max(200)
  .describe('Google API batchUpdate requests, sent verbatim');
export const contentFileId = z
  .string()
  .min(1)
  .describe('Google Drive file ID (a shortcut to the file also works)');
