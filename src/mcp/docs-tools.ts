import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { DocsService } from '../content/docs-service.js';
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

export const DOCS_TOOL_NAMES = [
  'docs_read',
  'docs_replace_text',
  'docs_insert_text',
  'docs_batch_update',
] as const;

const position = z
  .discriminatedUnion('at', [
    z.object({ at: z.literal('end') }),
    z.object({ at: z.literal('afterHeading'), heading: z.string().min(1) }),
    z.object({ at: z.literal('index'), index: z.number().int().min(1) }),
  ])
  .describe('Where to insert: end of the doc, under a heading, or at a raw index');

export function registerDocsTools(server: McpServer, docs: DocsService, log: Logger): void {
  server.registerTool(
    'docs_read',
    {
      description:
        'Read a Google Doc. format "markdown" (default) returns the text as Markdown; "structure" returns one line per element with its [start-end) index range — use it to compute indexes for docs_batch_update. Returns revisionId for guarded edits. Long content is paged: pass nextOffset as offset. Structure covers the first tab only.',
      inputSchema: {
        account,
        fileId: contentFileId,
        format: z.enum(['markdown', 'structure']).optional(),
        maxChars,
        offset,
      },
    },
    async (args) => respond(log, () => docs.read(args)),
  );

  server.registerTool(
    'docs_replace_text',
    {
      description:
        'Replace every occurrence of `find` with `replace` in a Google Doc (first tab). Returns occurrencesChanged and the new revisionId.',
      inputSchema: {
        account,
        fileId: contentFileId,
        find: z.string().min(1),
        replace: z.string(),
        matchCase: z.boolean().optional().describe('Default true'),
        requiredRevisionId: requiredRevisionId.optional(),
      },
    },
    async (args) => respond(log, () => docs.replaceText(args)),
  );

  server.registerTool(
    'docs_insert_text',
    {
      description:
        'Insert plain text into a Google Doc (first tab). position: {at:"end"} appends (start text with "\\n" for a new paragraph); {at:"afterHeading",heading} inserts the text as new normal-text paragraph(s) directly under that heading (matched by its plain text); {at:"index",index} inserts at a raw index from docs_read structure. end/afterHeading are guarded by the read they do internally unless requiredRevisionId is given; index mode is guarded only when requiredRevisionId is given. For afterHeading, insertedAt is the index of the inserted line break, so the text starts at insertedAt + 1.',
      inputSchema: {
        account,
        fileId: contentFileId,
        text: z.string().min(1),
        position,
        requiredRevisionId: requiredRevisionId.optional(),
      },
    },
    async (args) => respond(log, () => docs.insertText(args)),
  );

  server.registerTool(
    'docs_batch_update',
    {
      description:
        'ADVANCED: send raw Google Docs API batchUpdate requests (formatting, tables, deletions…). Prefer docs_replace_text / docs_insert_text. Read with docs_read format "structure" first and pass its revisionId; requests apply to the first tab.',
      inputSchema: { account, fileId: contentFileId, requests: rawRequests, requiredRevisionId },
    },
    async (args) => respond(log, () => docs.batchUpdate(args)),
  );
}
