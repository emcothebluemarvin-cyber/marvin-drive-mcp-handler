import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { SlidesService } from '../content/slides-service.js';
import type { Logger } from '../logger.js';
import {
  account,
  contentFileId,
  maxChars,
  offset,
  rawRequests,
  requiredRevisionId,
  respond,
} from './shared.js';

export const SLIDES_TOOL_NAMES = [
  'slides_read',
  'slides_replace_text',
  'slides_set_text',
  'slides_batch_update',
] as const;

export function registerSlidesTools(server: McpServer, slides: SlidesService, log: Logger): void {
  server.registerTool(
    'slides_read',
    {
      description:
        'Read a Google Slides deck: per slide, every element objectId with its text, tables, and speaker notes. Returns revisionId for guarded edits. Long decks are paged via nextOffset.',
      inputSchema: { account, fileId: contentFileId, maxChars, offset },
    },
    async (args) => respond(log, () => slides.read(args)),
  );

  server.registerTool(
    'slides_replace_text',
    {
      description:
        'Replace every occurrence of `find` with `replace` across the deck, or only on slideIds. Returns occurrencesChanged and the new revisionId.',
      inputSchema: {
        account,
        fileId: contentFileId,
        find: z.string().min(1),
        replace: z.string(),
        matchCase: z.boolean().optional().describe('Default true'),
        slideIds: z
          .array(z.string().min(1))
          .min(1)
          .optional()
          .describe('Slide objectIds from slides_read'),
        requiredRevisionId: requiredRevisionId.optional(),
      },
    },
    async (args) => respond(log, () => slides.replaceText(args)),
  );

  server.registerTool(
    'slides_set_text',
    {
      description:
        'Replace the whole text of one shape (objectId from slides_read). Empty text clears it. Tables, images and grouped elements need slides_batch_update. Guarded by the read it does internally unless requiredRevisionId is given.',
      inputSchema: {
        account,
        fileId: contentFileId,
        objectId: z.string().min(1),
        text: z.string(),
        requiredRevisionId: requiredRevisionId.optional(),
      },
    },
    async (args) => respond(log, () => slides.setText(args)),
  );

  server.registerTool(
    'slides_batch_update',
    {
      description:
        'ADVANCED: send raw Google Slides API batchUpdate requests (create slides/shapes, styling, deleting…). Prefer slides_replace_text / slides_set_text. Read with slides_read first and pass its revisionId.',
      inputSchema: { account, fileId: contentFileId, requests: rawRequests, requiredRevisionId },
    },
    async (args) => respond(log, () => slides.batchUpdate(args)),
  );
}
