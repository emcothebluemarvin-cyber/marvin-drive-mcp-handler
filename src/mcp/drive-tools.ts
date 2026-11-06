import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { AuthService } from '../auth/auth-service.js';
import { EXPORT_FORMATS } from '../files/export-formats.js';
import type { FileService } from '../files/file-service.js';
import type { Logger } from '../logger.js';
import { account, fileId, pageSize, pageToken, respond } from './shared.js';

export const DRIVE_TOOL_NAMES = [
  'drive_list_accounts',
  'drive_list',
  'drive_search',
  'drive_get_metadata',
  'drive_download',
  'drive_upload',
  'drive_create_folder',
  'drive_move',
  'drive_rename',
  'drive_copy',
  'drive_delete',
  'drive_restore',
] as const;

export function registerDriveTools(
  server: McpServer,
  deps: { files: FileService; auth: Pick<AuthService, 'status'> },
  log: Logger,
): void {
  const { files } = deps;

  server.registerTool(
    'drive_list_accounts',
    {
      description:
        'List registered Google accounts, the default, and token status (ok / reauth_required). verify=true does a live token refresh.',
      inputSchema: { verify: z.boolean().optional() },
    },
    async ({ verify }) => respond(log, () => deps.auth.status(verify ?? false)),
  );

  server.registerTool(
    'drive_list',
    {
      description:
        'List files in a folder (default: My Drive root). Excludes trash unless includeTrashed.',
      inputSchema: {
        account,
        folderId: z.string().min(1).optional().describe('Folder ID (default "root")'),
        pageSize,
        pageToken,
        includeTrashed: z.boolean().optional(),
      },
    },
    async (args) => respond(log, () => files.list(args)),
  );

  server.registerTool(
    'drive_search',
    {
      description:
        'Search files. query matches names and full text; rawQuery is raw Drive query syntax (ANDed). Excludes trash unless rawQuery mentions "trashed". Note: any mention of "trashed" in rawQuery (even inside a quoted value) disables the default trashed = false filter.',
      inputSchema: {
        account,
        query: z.string().optional(),
        mimeType: z.string().optional(),
        modifiedAfter: z.string().optional().describe('ISO 8601 date or datetime'),
        rawQuery: z.string().optional(),
        pageSize,
        pageToken,
      },
    },
    async (args) => respond(log, () => files.search(args)),
  );

  server.registerTool(
    'drive_get_metadata',
    {
      description: 'Get metadata for a file: owners, parents, size, link, trashed.',
      inputSchema: { account, fileId },
    },
    async (args) => respond(log, () => files.getMetadata(args)),
  );

  server.registerTool(
    'drive_download',
    {
      description:
        'Download a file to local disk and return its path. Google Docs/Sheets/Slides/Drawings are exported (defaults docx/xlsx/pptx/png). Never overwrites.',
      inputSchema: {
        account,
        fileId,
        destPath: z
          .string()
          .min(1)
          .optional()
          .describe(
            'Absolute directory (existing, or ending with "/"; "\\" also on Windows) or absolute file path; ~ allowed. Default ~/Downloads/marvin-drive/',
          ),
        exportFormat: z.enum(EXPORT_FORMATS).optional(),
      },
    },
    async (args) => respond(log, () => files.download(args)),
  );

  server.registerTool(
    'drive_upload',
    {
      description:
        'Upload a local file. convertToGoogle turns office/text/csv files into Google Docs/Sheets/Slides.',
      inputSchema: {
        account,
        localPath: z.string().min(1).describe('Absolute local file path (~/ allowed)'),
        parentId: z.string().min(1).optional().describe('Destination folder ID (default root)'),
        name: z.string().min(1).optional(),
        convertToGoogle: z.boolean().optional(),
      },
    },
    async (args) => respond(log, () => files.upload(args)),
  );

  server.registerTool(
    'drive_create_folder',
    {
      description: 'Create a folder (default parent: root).',
      inputSchema: { account, name: z.string().min(1), parentId: z.string().min(1).optional() },
    },
    async (args) => respond(log, () => files.createFolder(args)),
  );

  server.registerTool(
    'drive_move',
    {
      description: 'Move a file or folder into newParentId (removes it from all other parents).',
      inputSchema: { account, fileId, newParentId: z.string().min(1) },
    },
    async (args) => respond(log, () => files.move(args)),
  );

  server.registerTool(
    'drive_rename',
    {
      description: 'Rename a file or folder.',
      inputSchema: { account, fileId, newName: z.string().min(1) },
    },
    async (args) => respond(log, () => files.rename(args)),
  );

  server.registerTool(
    'drive_copy',
    {
      description: 'Copy a file (folders cannot be copied).',
      inputSchema: {
        account,
        fileId,
        parentId: z.string().min(1).optional(),
        name: z.string().min(1).optional(),
      },
    },
    async (args) => respond(log, () => files.copy(args)),
  );

  server.registerTool(
    'drive_delete',
    {
      description:
        'Delete a file or folder. Default moves it to trash (restorable for 30 days); permanent=true deletes forever.',
      inputSchema: { account, fileId, permanent: z.boolean().optional() },
    },
    async (args) => respond(log, () => files.delete(args)),
  );

  server.registerTool(
    'drive_restore',
    {
      description: 'Restore a file or folder from trash.',
      inputSchema: { account, fileId },
    },
    async (args) => respond(log, () => files.restore(args)),
  );
}
