import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { beforeEach, describe, expect, it } from 'vitest';
import type { AccountStatusEntry } from '../../auth/auth-service.js';
import { ReauthRequiredError } from '../../errors.js';
import { DocsService } from '../../content/docs-service.js';
import { SheetsService } from '../../content/sheets-service.js';
import { SlidesService } from '../../content/slides-service.js';
import { PairStore } from '../../sync/pair-store.js';
import { SyncService } from '../../sync/sync-service.js';
import { refuseTrash } from '../../sync/__tests__/fixtures.js';
import { FileService } from '../../files/file-service.js';
import {
  createAudit,
  createFakeDrive,
  createRunner,
  noSleep,
  silentLogger,
  type FakeDrive,
} from '../../files/__tests__/fakes.js';
import { TOOL_NAMES, createMcpServer, type McpDeps } from '../server.js';

let drive: FakeDrive;
let client: Client;
let statuses: AccountStatusEntry[];
let verifyArgs: boolean[];

function contentServices(): Pick<McpDeps, 'docs' | 'sheets' | 'slides' | 'sync'> {
  const deps = {
    runner: createRunner(drive),
    audit: createAudit(),
    retry: noSleep,
    logger: silentLogger(),
  };
  return {
    docs: new DocsService(deps),
    sheets: new SheetsService(deps),
    slides: new SlidesService(deps),
    sync: new SyncService({
      ...deps,
      store: new PairStore({ dir: '/tmp/unused-sync' }),
      trash: refuseTrash,
    }),
  };
}

async function connect(files: FileService): Promise<Client> {
  const server = createMcpServer({
    ...contentServices(),
    files,
    auth: {
      status: async (verify?: boolean) => {
        verifyArgs.push(verify ?? false);
        return statuses;
      },
    },
    version: '0.0.0-test',
    logger: silentLogger(),
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const c = new Client({ name: 'test', version: '0.0.0' });
  await c.connect(clientTransport);
  return c;
}

function textOf(result: unknown): string {
  const content = (result as { content: Array<{ type: string; text?: string }> }).content;
  return content[0]?.text ?? '';
}

beforeEach(async () => {
  drive = createFakeDrive();
  statuses = [{ alias: 'emco', email: 'emco@example.com', isDefault: true, status: 'ok' }];
  verifyArgs = [];
  const files = new FileService({
    runner: createRunner(drive),
    audit: createAudit(),
    downloadsDir: '/tmp/unused',
    retry: noSleep,
    logger: silentLogger(),
  });
  client = await connect(files);
});

describe('MCP server', () => {
  it('exposes the 32 tools from all specs', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...TOOL_NAMES].sort());
    expect(TOOL_NAMES).toHaveLength(32);
    const list = tools.find((t) => t.name === 'drive_list');
    expect(list?.inputSchema.properties).toHaveProperty('account');
    expect(list?.inputSchema.properties).toHaveProperty('folderId');
  });

  it('returns JSON text for successful calls', async () => {
    drive.listFiles.mockResolvedValueOnce({
      files: [{ id: 'a', name: 'A', mimeType: 'text/plain' }],
    });
    const res = await client.callTool({ name: 'drive_list', arguments: { folderId: 'root' } });
    expect(res.isError).toBeFalsy();
    expect(JSON.parse(textOf(res))).toEqual({
      files: [{ id: 'a', name: 'A', mimeType: 'text/plain' }],
    });
  });

  it('lists accounts and forwards verify', async () => {
    const res = await client.callTool({ name: 'drive_list_accounts', arguments: { verify: true } });
    expect(JSON.parse(textOf(res))).toEqual(statuses);
    expect(verifyArgs).toEqual([true]);
  });

  it('returns AppError messages as isError results', async () => {
    const files = new FileService({
      runner: {
        run: async () => {
          throw new ReauthRequiredError('emco');
        },
      },
      audit: createAudit(),
      downloadsDir: '/tmp/unused',
      logger: silentLogger(),
    });
    const c = await connect(files);
    const res = await c.callTool({ name: 'drive_get_metadata', arguments: { fileId: 'f1' } });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toBe('Session for "emco" expired. Run: marvin-drive auth login emco');
  });

  it('never leaks an AppError cause into the tool result', async () => {
    const files = new FileService({
      runner: {
        run: async () => {
          throw new ReauthRequiredError('emco', {
            cause: Object.assign(new Error('x'), {
              config: { headers: { Authorization: 'Bearer SECRET' } },
            }),
          });
        },
      },
      audit: createAudit(),
      downloadsDir: '/tmp/unused',
      logger: silentLogger(),
    });
    const c = await connect(files);
    const res = await c.callTool({ name: 'drive_get_metadata', arguments: { fileId: 'f1' } });
    expect(res.isError).toBe(true);
    expect(textOf(res)).not.toContain('SECRET');
    expect(textOf(res)).not.toContain('Authorization');
  });

  it('hides unexpected error details', async () => {
    const server = createMcpServer({
      ...contentServices(),
      files: new FileService({
        runner: createRunner(drive),
        audit: createAudit(),
        downloadsDir: '/tmp/unused',
        logger: silentLogger(),
      }),
      auth: {
        status: async () => {
          throw new TypeError('secret internal detail');
        },
      },
      version: '0.0.0-test',
      logger: silentLogger(),
    });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    const c = new Client({ name: 'test', version: '0.0.0' });
    await c.connect(ct);
    const res = await c.callTool({ name: 'drive_list_accounts', arguments: {} });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toBe('Unexpected internal error; see the server log (stderr).');
  });

  it('rejects arguments that violate the schema', async () => {
    const outcome = await client
      .callTool({ name: 'drive_list', arguments: { pageSize: 500 } })
      .then((res) => ({ isError: res.isError === true }))
      .catch(() => ({ isError: true }));
    expect(outcome.isError).toBe(true);
    expect(drive.listFiles).not.toHaveBeenCalled();
  });
});
