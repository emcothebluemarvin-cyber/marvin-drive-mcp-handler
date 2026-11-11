import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ElicitRequestSchema, type ElicitResult } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it, vi } from 'vitest';
import { silentLogger } from '../../files/__tests__/fakes.js';
import type { ClientCapabilities } from '@modelcontextprotocol/sdk/types.js';
import {
  CONFIRM_TIMEOUT_MS,
  createConfirmReplace,
  supportsConfirmReplace,
} from '../confirm-replace.js';

const FILE = {
  id: 'i',
  name: 'a.txt',
  size: 9,
  modifiedTime: '2026-01-01T00:00:00Z',
  modifiedBy: 'Ayse',
};

async function connect(capabilities: ClientCapabilities, answer?: () => Promise<ElicitResult>) {
  const server = new McpServer({ name: 's', version: '1' });
  const client = new Client({ name: 'c', version: '1' }, { capabilities });
  const received: Array<{ message: string; requestedSchema: unknown }> = [];
  if (answer) {
    client.setRequestHandler(ElicitRequestSchema, async (request) => {
      received.push(request.params as (typeof received)[number]);
      return answer();
    });
  }
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  return { server, received };
}

const FORM = { elicitation: { form: {} } };

describe('createConfirmReplace', () => {
  it('asks with a message naming the file, size, time and modifier', async () => {
    const { server, received } = await connect(FORM, async () => ({
      action: 'accept',
      content: { choice: 'Overwrite' },
    }));
    const confirm = createConfirmReplace(server.server, silentLogger());
    await expect(confirm(FILE)).resolves.toBe('overwrite');
    expect(received[0]?.message).toMatch(/a\.txt.*9 bytes.*2026-01-01.*Ayse/);
    expect(received[0]?.requestedSchema).toMatchObject({
      properties: { choice: { enum: ['Overwrite', 'Cancel'] } },
    });
  });

  it.each([
    ['accept Cancel', { action: 'accept', content: { choice: 'Cancel' } }],
    ['decline', { action: 'decline' }],
    ['dismiss', { action: 'cancel' }],
  ] as const)('%s means cancel', async (_name, result) => {
    const { server } = await connect(FORM, async () => result);
    await expect(createConfirmReplace(server.server, silentLogger())(FILE)).resolves.toBe('cancel');
  });

  it('a failed request is no_answer', async () => {
    const { server } = await connect(FORM, async () => {
      throw new Error('boom');
    });
    await expect(createConfirmReplace(server.server, silentLogger())(FILE)).resolves.toBe(
      'no_answer',
    );
  });

  it('asks with a 10 minute timeout', async () => {
    const elicitInput = vi.fn(async () => ({ action: 'cancel' as const }));
    const server = { elicitInput } as unknown as McpServer['server'];
    await createConfirmReplace(server, silentLogger())(FILE);
    expect(elicitInput).toHaveBeenCalledWith(expect.anything(), { timeout: CONFIRM_TIMEOUT_MS });
    expect(CONFIRM_TIMEOUT_MS).toBe(600_000);
  });

  it('a timeout is no_answer', async () => {
    const server = {
      elicitInput: async () => Promise.reject(new Error('Request timed out')),
    } as unknown as McpServer['server'];
    await expect(createConfirmReplace(server, silentLogger())(FILE)).resolves.toBe('no_answer');
  });
});

describe('supportsConfirmReplace', () => {
  it('needs elicitation.form from the client', async () => {
    const yes = await connect(FORM, async () => ({ action: 'cancel' }));
    expect(supportsConfirmReplace(yes.server.server)).toBe(true);
    const no = await connect({});
    expect(supportsConfirmReplace(no.server.server)).toBe(false);
  });
});
