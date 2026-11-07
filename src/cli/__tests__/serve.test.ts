import { EventEmitter } from 'node:events';
import { access, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { silentLogger } from '../../files/__tests__/fakes.js';
import { serverOptions } from '../../mcp/channel.js';
import { LEASE_FILE, PollerLease } from '../../watch/lease.js';
import { WatchService } from '../../watch/watch-service.js';
import { WatchStore } from '../../watch/watch-store.js';
import { MemoryFeed, MemorySnapshotter, memoryProvider } from '../../watch/__tests__/fakes.js';
import { serve, type ServeDeps } from '../serve.js';

let dir: string;
let svc: WatchService;
let client: Client | null;

const exists = (file: string): Promise<boolean> =>
  access(file).then(
    () => true,
    () => false,
  );

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'serve-'));
  const feed = new MemoryFeed();
  feed.seed('D', { parents: ['ROOT'] });
  const logger = silentLogger();
  svc = new WatchService({
    store: new WatchStore({ dir, logger }),
    provider: memoryProvider(feed, new MemorySnapshotter()),
    intervalMs: 30_000,
    logger,
    lease: new PollerLease({ dir, intervalMs: 30_000, pid: process.pid, host: 'h', logger }),
  });
  await svc.watch({ action: 'add', fileId: 'D' });
  client = null;
});
afterEach(async () => {
  await client?.close();
  await svc.stop();
  await rm(dir, { recursive: true, force: true });
});

type Exit = (code: number) => void;

async function started(
  over: Partial<ServeDeps> = {},
): Promise<{ deps: ServeDeps; exit: Mock<Exit> }> {
  const exit = vi.fn<Exit>();
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const deps = {
    server: new McpServer({ name: 'test', version: '0.0.0' }, serverOptions()),
    watch: svc,
    transport: st,
    log: silentLogger(),
    stdin: new EventEmitter(),
    signals: new EventEmitter(),
    exit,
    ...over,
  };
  const start = vi.spyOn(deps.watch, 'start');
  await serve(deps);
  expect(start).not.toHaveBeenCalled(); // not before the client is initialized
  client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(ct);
  await vi.waitFor(() => expect(start).toHaveBeenCalledTimes(1));
  return { deps, exit };
}

describe('marvin-drive serve lifecycle', () => {
  it.each([
    ['stdin close', (d: ServeDeps) => d.stdin.emit('close')],
    ['stdin end', (d: ServeDeps) => d.stdin.emit('end')],
    ['SIGTERM', (d: ServeDeps) => d.signals.emit('SIGTERM')],
    ['SIGINT', (d: ServeDeps) => d.signals.emit('SIGINT')],
  ])('starts the watch after initialize; %s → exit 0 with the lease released', async (_n, stop) => {
    const { deps, exit } = await started();
    await vi.waitFor(() => expect(svc.isLeader).toBe(true));
    expect(await exists(path.join(dir, LEASE_FILE))).toBe(true);
    stop(deps);
    stop(deps);
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
    expect(exit).toHaveBeenCalledTimes(1);
    expect(await exists(path.join(dir, LEASE_FILE))).toBe(false);
  });

  it('exits 0 after the stop timeout when the watch hangs', async () => {
    const hanging = {
      start: async (): Promise<void> => {},
      stop: (): Promise<void> => new Promise<void>(() => {}),
    };
    const { deps, exit } = await started({ watch: hanging, stopTimeoutMs: 20 });
    deps.signals.emit('SIGTERM');
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
  });
});
