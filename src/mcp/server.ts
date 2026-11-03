import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AuthService } from '../auth/auth-service.js';
import type { FileService } from '../files/file-service.js';
import { logger as defaultLogger, type Logger } from '../logger.js';
import { DRIVE_TOOL_NAMES, registerDriveTools } from './drive-tools.js';

export const TOOL_NAMES = [...DRIVE_TOOL_NAMES] as const;

export interface McpDeps {
  files: FileService;
  auth: Pick<AuthService, 'status'>;
  version: string;
  logger?: Logger;
}

export function createMcpServer(deps: McpDeps): McpServer {
  const log = deps.logger ?? defaultLogger;
  const server = new McpServer({ name: 'marvin-drive', version: deps.version });
  registerDriveTools(server, deps, log);
  return server;
}
