import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it, vi } from 'vitest';
import { silentLogger } from '../../files/__tests__/fakes.js';
import type { FileProvider, UploadOptions } from '../../files/file-provider.js';
import { registerDriveTools } from '../drive-tools.js';

const FILE = { id: 'i', name: 'a.txt' };

async function connect(withElicitation: boolean) {
  const upload = vi.fn<FileProvider['upload']>(async () => ({
    id: 'new',
    name: 'a',
    mimeType: 'text/plain',
  }));
  const files = { upload } as unknown as FileProvider;
  const server = new McpServer({ name: 's', version: '1' });
  registerDriveTools(server, { files, auth: { status: async () => [] } }, silentLogger());
  const client = new Client(
    { name: 'c', version: '1' },
    { capabilities: withElicitation ? { elicitation: { form: {} } } : {} },
  );
  if (withElicitation) {
    client.setRequestHandler(ElicitRequestSchema, async () => ({
      action: 'accept',
      content: { choice: 'Cancel' },
    }));
  }
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  return { client, upload };
}

const callUpload = (client: Client) =>
  client.callTool({ name: 'drive_upload', arguments: { localPath: '/a' } });

describe('drive_upload and the overwrite dialog', () => {
  it('passes confirmReplace when the client declares form elicitation', async () => {
    const { client, upload } = await connect(true);
    await callUpload(client);
    const options = upload.mock.calls[0]?.[1] as UploadOptions;
    await expect(options.confirmReplace?.(FILE)).resolves.toBe('cancel');
  });

  it('passes no callback otherwise', async () => {
    const { client, upload } = await connect(false);
    await callUpload(client);
    expect(upload.mock.calls[0]?.[1]).toEqual({});
  });

  it('offers no overwrite parameter to the model', async () => {
    const { client } = await connect(false);
    const tool = (await client.listTools()).tools.find((t) => t.name === 'drive_upload');
    expect(Object.keys(tool?.inputSchema.properties ?? {})).toEqual([
      'account',
      'localPath',
      'parentId',
      'name',
      'convertToGoogle',
    ]);
  });

  it('marks the Google-only parameters', async () => {
    const { client } = await connect(false);
    const tools = (await client.listTools()).tools;
    const schema = (name: string, key: string): unknown =>
      (tools.find((t) => t.name === name)?.inputSchema.properties as Record<string, unknown>)[key];
    for (const [name, key] of [
      ['drive_list', 'includeTrashed'],
      ['drive_search', 'rawQuery'],
      ['drive_search', 'mimeType'],
      ['drive_search', 'modifiedAfter'],
      ['drive_download', 'exportFormat'],
      ['drive_upload', 'convertToGoogle'],
      ['drive_delete', 'permanent'],
    ] as const) {
      expect(schema(name, key)).toMatchObject({
        description: expect.stringMatching(/Google accounts only/),
      });
    }
  });
});
