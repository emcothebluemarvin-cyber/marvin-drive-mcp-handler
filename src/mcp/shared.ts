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
