import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { ValidationError } from '../errors.js';
import { EXPORT_FORMATS } from '../files/export-formats.js';
import type { Logger } from '../logger.js';
import type { SyncService } from '../sync/sync-service.js';
import { PAIR_NAME } from '../sync/types.js';
import { account, respond } from './shared.js';

export const SYNC_TOOL_NAMES = [
  'sync_create_pair',
  'sync_list_pairs',
  'sync_scan',
  'sync_select',
  'sync_run',
  'sync_release',
  'sync_remove_pair',
] as const;

const name = z.string().regex(PAIR_NAME).describe('Sync pair name (a-z, 0-9 and -, max 40)');
const relPaths = z
  .array(z.string().min(1))
  .min(1)
  .max(1000)
  .describe('Paths relative to the pair folder, with "/" separators');

export function registerSyncTools(server: McpServer, sync: SyncService, log: Logger): void {
  server.registerTool(
    'sync_create_pair',
    {
      description:
        'Create a selective two-way sync pair between a local folder and a Google Drive or OneDrive folder (the account decides; synced on demand, never automatically). Pass remoteFolderId of an existing folder, or remoteFolderName (+ optional remoteParentId) to create a new one. Writes a hidden marker file .marvin-sync-<name> into localDir. Next step: sync_scan.',
      inputSchema: {
        name,
        localDir: z
          .string()
          .min(1)
          .describe('Absolute path of an existing local folder (~ allowed)'),
        remoteFolderId: z.string().min(1).optional(),
        remoteFolderName: z
          .string()
          .min(1)
          .optional()
          .describe('Creates a new Drive / OneDrive folder with this name'),
        remoteParentId: z
          .string()
          .min(1)
          .optional()
          .describe('Parent for remoteFolderName (default: My Drive / the OneDrive root)'),
        googleExport: z
          .object({
            document: z.enum(EXPORT_FORMATS).optional(),
            spreadsheet: z.enum(EXPORT_FORMATS).optional(),
            presentation: z.enum(EXPORT_FORMATS).optional(),
            drawing: z.enum(EXPORT_FORMATS).optional(),
          })
          .optional()
          .describe(
            'Google accounts only (rejected on OneDrive): local export format of Google files (read-only copies). Defaults: docx, xlsx, pptx, pdf. Docs: docx/pdf/md/txt/odt/html; Sheets: xlsx/pdf/csv/ods; Slides: pptx/pdf/txt/odp; Drawings: png/pdf/svg/jpg',
          ),
        account,
      },
    },
    async (args) => respond(log, () => sync.createPair(args)),
  );

  server.registerTool(
    'sync_list_pairs',
    {
      description:
        'List sync pairs with their folders, account, counts (selected, tracked, remote-only, excluded, baseline) and the last applied run.',
      inputSchema: {},
    },
    async () => respond(log, () => sync.listPairs()),
  );

  server.registerTool(
    'sync_scan',
    {
      description:
        'Step 1 of choosing what to sync: lists the local files of a pair (path, size, modifiedTime, mimeType, and a short preview for text files) plus remoteCandidates (Drive / OneDrive files not yet synced). Changes nothing. Open PDFs/Office files with your own file-reading tool when the name and preview are not enough, propose a selection to the user (e.g. "the seafaring files"), confirm it with them, then call sync_select.',
      inputSchema: {
        name,
        onlyUnselected: z
          .boolean()
          .optional()
          .describe('Default true: hide already selected files'),
        previewChars: z
          .number()
          .int()
          .min(0)
          .max(2000)
          .optional()
          .describe('Default 300; 0 disables previews'),
        limit: z.number().int().min(1).max(1000).optional().describe('Default 200 per list'),
        subdir: z.string().min(1).optional().describe('Only this sub-folder (relative path)'),
      },
    },
    async (args) => respond(log, () => sync.scan(args)),
  );

  server.registerTool(
    'sync_select',
    {
      description:
        'Step 2, after the user confirmed: add paths to the pair selection (local files or remoteCandidates; deduped by case/Unicode form) or remove them. remove stops syncing a path and puts it on the excluded list — no file is touched on either side. Rejected paths come back with reasons. Next step: sync_run (dry run).',
      inputSchema: { name, add: relPaths.optional(), remove: relPaths.optional() },
    },
    async (args) => respond(log, () => sync.select(args)),
  );

  server.registerTool(
    'sync_run',
    {
      description:
        'Step 3: plan or apply a sync. DRY RUN BY DEFAULT (apply omitted/false): returns the plan — actions by kind, conflicts, collisions, ambiguous/unknown items, warnings, candidates — and a planId; nothing is written. Show it to the user; after they agree call again with apply: true AND that planId (apply without planId is rejected). If anything changed meanwhile nothing is applied and the new plan is returned. Deletions go to the Drive trash / OneDrive recycle bin or the system Trash / Recycle Bin, never permanent; on OneDrive a file counts as deleted only when the OneDrive change history reports it, otherwise it is only reported; conflicts keep both copies. Set allowMassDelete only after the user explicitly confirmed a large deletion. Files the user deleted locally are listed in pendingConfirmation; their Drive copies are NOT trashed unless you pass confirmRemoteTrash: true. For those, ask the user first: delete them in Drive too (pass confirmRemoteTrash: true together with the planId of the dry run the user saw; after an applied run, do a new dry run first), or keep them in Drive only (sync_release with those paths). Confirmation covers every pending path of the run; to keep some, release them first.',
      inputSchema: {
        name,
        apply: z.boolean().optional().describe('Default false (dry run)'),
        planId: z
          .string()
          .min(1)
          .optional()
          .describe('planId of the dry run the user approved; required with apply: true'),
        allowMassDelete: z.boolean().optional(),
        confirmRemoteTrash: z
          .boolean()
          .optional()
          .describe(
            'Also move the Drive copies of locally deleted files (pendingConfirmation) to the Drive trash; only after the user agreed, with the planId of the dry run they saw',
          ),
      },
    },
    async (args) =>
      respond(log, async () => {
        if (args.apply === true && args.planId === undefined) {
          throw new ValidationError(
            'apply: true needs the planId of the dry run the user approved; run sync_run without apply first.',
          );
        }
        return sync.run(args);
      }),
  );

  server.registerTool(
    'sync_release',
    {
      description:
        'Move to Drive / OneDrive: remove the local copies of synced files and keep them in the cloud only (they stay selected; sync_select add brings a copy back). DRY RUN BY DEFAULT. Pass paths — e.g. from releasable after an applied sync_run, or from pendingConfirmation for files the user already deleted locally and wants to keep in Drive — or all: true for every file that is in sync. Ask the user first ("Yerel kopyaları silmek ister misiniz? Hepsi / bazıları / hayır"), then call again with apply: true. Local copies go to the system Trash / Recycle Bin, never deleted permanently; every file is re-checked right before removal.',
      inputSchema: {
        name,
        paths: relPaths.optional(),
        all: z.boolean().optional().describe('Release every file that is in sync'),
        apply: z.boolean().optional().describe('Default false (dry run)'),
      },
    },
    async (args) => respond(log, () => sync.release(args)),
  );

  server.registerTool(
    'sync_remove_pair',
    {
      description:
        'Remove a sync pair: deletes its saved state and the marker file. No local, Drive or OneDrive files are touched.',
      inputSchema: { name },
    },
    async (args) => respond(log, () => sync.removePair(args)),
  );
}
