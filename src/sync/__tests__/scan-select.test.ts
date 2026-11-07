import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAudit, createRunner, noSleep, silentLogger } from '../../files/__tests__/fakes.js';
import { PairStore } from '../pair-store.js';
import { SyncService } from '../sync-service.js';
import { refuseTrash } from './fixtures.js';
import { memoryDrive, type MemoryDrive } from './memory-drive.js';

const counter = vi.hoisted(() => ({ scans: 0 }));
vi.mock('../local-scanner.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../local-scanner.js')>();
  return {
    ...actual,
    scanLocal: (...args: Parameters<typeof actual.scanLocal>) => {
      counter.scans++;
      return actual.scanLocal(...args);
    },
  };
});

let tmp: string;
let local: string;
let mem: MemoryDrive;
let sync: SyncService;

beforeEach(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), 'sync-scan-'));
  local = path.join(tmp, 'Local');
  await mkdir(local);
  mem = memoryDrive('ROOT');
  sync = new SyncService({
    runner: createRunner(mem.drive),
    audit: createAudit(),
    retry: noSleep,
    logger: silentLogger(),
    store: new PairStore({ dir: path.join(tmp, 'sync'), logger: silentLogger() }),
    trash: refuseTrash,
    clock: () => new Date('2026-11-03T12:00:00.000Z'),
  });
  await sync.createPair({ name: 'docs', localDir: local, remoteFolderId: 'ROOT' });
});
afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe('sync_scan', () => {
  it('scans the local tree once and returns the same result', async () => {
    await writeFile(path.join(local, 'a.txt'), 'hello');
    mem.addFile('r1', 'remote.pdf', 'ROOT', 'R');
    counter.scans = 0;
    const result = await sync.scan({ name: 'docs' });
    expect(counter.scans).toBe(1);
    expect(result).toMatchObject({
      entries: [{ path: 'a.txt', preview: 'hello', size: 5 }],
      remoteCandidates: [{ path: 'remote.pdf', size: 1 }],
      truncated: false,
    });
  });
});
