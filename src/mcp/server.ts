import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AuthService } from '../auth/auth-service.js';
import type { DocsService } from '../content/docs-service.js';
import type { SheetsService } from '../content/sheets-service.js';
import type { SlidesService } from '../content/slides-service.js';
import type { FileProvider } from '../files/file-provider.js';
import { logger as defaultLogger, type Logger } from '../logger.js';
import type { SyncService } from '../sync/sync-service.js';
import type { WatchApi } from '../watch/watch-service.js';
import { serverOptions } from './channel.js';
import { DOCS_TOOL_NAMES, registerDocsTools } from './docs-tools.js';
import { DRIVE_TOOL_NAMES, registerDriveTools } from './drive-tools.js';
import { SHEETS_TOOL_NAMES, registerSheetsTools } from './sheets-tools.js';
import { SLIDES_TOOL_NAMES, registerSlidesTools } from './slides-tools.js';
import { SYNC_TOOL_NAMES, registerSyncTools } from './sync-tools.js';
import { WATCH_TOOL_NAMES, registerWatchTools } from './watch-tools.js';

export const TOOL_NAMES = [
  ...DRIVE_TOOL_NAMES,
  ...DOCS_TOOL_NAMES,
  ...SHEETS_TOOL_NAMES,
  ...SLIDES_TOOL_NAMES,
  ...SYNC_TOOL_NAMES,
  ...WATCH_TOOL_NAMES,
] as const;

export interface McpDeps {
  files: FileProvider;
  docs: DocsService;
  sheets: SheetsService;
  slides: SlidesService;
  sync: SyncService;
  watch: WatchApi;
  auth: Pick<AuthService, 'status'>;
  version: string;
  logger?: Logger;
}

export function createMcpServer(deps: McpDeps): McpServer {
  const log = deps.logger ?? defaultLogger;
  const server = new McpServer({ name: 'marvin-drive', version: deps.version }, serverOptions());
  registerDriveTools(server, deps, log);
  registerDocsTools(server, deps.docs, log);
  registerSheetsTools(server, deps.sheets, log);
  registerSlidesTools(server, deps.slides, log);
  registerSyncTools(server, deps.sync, log);
  registerWatchTools(server, deps.watch, log);
  return server;
}
