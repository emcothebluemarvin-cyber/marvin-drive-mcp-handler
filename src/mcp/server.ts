import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AuthService } from '../auth/auth-service.js';
import type { DocsService } from '../content/docs-service.js';
import type { SheetsService } from '../content/sheets-service.js';
import type { SlidesService } from '../content/slides-service.js';
import type { FileService } from '../files/file-service.js';
import { logger as defaultLogger, type Logger } from '../logger.js';
import { DOCS_TOOL_NAMES, registerDocsTools } from './docs-tools.js';
import { DRIVE_TOOL_NAMES, registerDriveTools } from './drive-tools.js';
import { SHEETS_TOOL_NAMES, registerSheetsTools } from './sheets-tools.js';
import { SLIDES_TOOL_NAMES, registerSlidesTools } from './slides-tools.js';

export const TOOL_NAMES = [
  ...DRIVE_TOOL_NAMES,
  ...DOCS_TOOL_NAMES,
  ...SHEETS_TOOL_NAMES,
  ...SLIDES_TOOL_NAMES,
] as const;

export interface McpDeps {
  files: FileService;
  docs: DocsService;
  sheets: SheetsService;
  slides: SlidesService;
  auth: Pick<AuthService, 'status'>;
  version: string;
  logger?: Logger;
}

export function createMcpServer(deps: McpDeps): McpServer {
  const log = deps.logger ?? defaultLogger;
  const server = new McpServer({ name: 'marvin-drive', version: deps.version });
  registerDriveTools(server, deps, log);
  registerDocsTools(server, deps.docs, log);
  registerSheetsTools(server, deps.sheets, log);
  registerSlidesTools(server, deps.slides, log);
  return server;
}
