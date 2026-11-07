import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DocsService } from '../../content/docs-service.js';
import { SheetsService } from '../../content/sheets-service.js';
import { SlidesService } from '../../content/slides-service.js';
import { FileService } from '../../files/file-service.js';
import { createAudit, createRunner, noSleep, silentLogger } from '../../files/__tests__/fakes.js';
import { PairStore } from '../../sync/pair-store.js';
import { SyncService } from '../../sync/sync-service.js';
import { refuseTrash } from '../../sync/__tests__/fixtures.js';
import { memoryDrive, type MemoryDrive } from '../../sync/__tests__/memory-drive.js';
import { createMcpServer } from '../server.js';

let tmp: string;
let local: string;
let mem: MemoryDrive;
let client: Client;

function textOf(result: unknown): string {
  return (result as { content: Array<{ text?: string }> }).content[0]?.text ?? '';
}

async function call(
  name: string,
  args: Record<string, unknown>,
): Promise<{ isError: boolean; data: unknown; text: string }> {
  const res = await client.callTool({ name, arguments: args });
  const text = textOf(res);
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    data = null;
  }
  return { isError: res.isError === true, data, text };
}

beforeEach(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), 'sync-mcp-'));
  local = path.join(tmp, 'Local');
  await mkdir(local);
  mem = memoryDrive('ROOT');
  const deps = {
    runner: createRunner(mem.drive),
    audit: createAudit(),
    retry: noSleep,
    logger: silentLogger(),
  };
  const server = createMcpServer({
    files: new FileService({ ...deps, downloadsDir: path.join(tmp, 'dl') }),
    docs: new DocsService(deps),
    sheets: new SheetsService(deps),
    slides: new SlidesService(deps),
    sync: new SyncService({
      ...deps,
      store: new PairStore({ dir: path.join(tmp, 'sync'), logger: silentLogger() }),
      trash: refuseTrash,
    }),
    auth: { status: async () => [] },
    version: '0.0.0-test',
    logger: silentLogger(),
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(clientTransport);
});
afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe('sync MCP tools', () => {
  it('validates googleExport on sync_create_pair', async () => {
    const bad = await call('sync_create_pair', {
      name: 'docs',
      localDir: local,
      remoteFolderId: 'ROOT',
      googleExport: { presentation: 'csv' },
    });
    expect(bad.isError).toBe(true);
    expect(bad.text).toContain('Google Slides cannot be exported as "csv"');
  });
  it('describe the conversational flow and the dry-run default', async () => {
    const { tools } = await client.listTools();
    const byName = new Map(tools.map((t) => [t.name, t.description ?? '']));
    expect(byName.get('sync_scan')).toContain('confirm it with them, then call sync_select');
    expect(byName.get('sync_run')).toContain('DRY RUN BY DEFAULT');
    expect(byName.get('sync_run')).toContain('apply without planId is rejected');
    expect(byName.get('sync_release')).toContain('DRY RUN BY DEFAULT');
    expect(byName.get('sync_release')).toContain('pendingConfirmation');
    expect(byName.get('sync_release')).toContain(
      'Yerel kopyaları silmek ister misiniz? Hepsi / bazıları / hayır',
    );
  });
  it('sync_release dry run lists files and needs paths or all', async () => {
    await writeFile(path.join(local, 'voyage.txt'), 'Seafaring log');
    await call('sync_create_pair', { name: 'docs', localDir: local, remoteFolderId: 'ROOT' });
    await call('sync_select', { name: 'docs', add: ['voyage.txt'] });
    const dry = await call('sync_run', { name: 'docs' });
    await call('sync_run', {
      name: 'docs',
      apply: true,
      planId: (dry.data as { planId: string }).planId,
    });
    const rel = await call('sync_release', { name: 'docs', all: true });
    expect(rel.data).toMatchObject({
      dryRun: true,
      released: [{ path: 'voyage.txt', status: 'would release' }],
    });
    const bad = await call('sync_release', { name: 'docs' });
    expect(bad).toMatchObject({ isError: true });
  });

  it('runs create → scan → select → dry run → apply with planId', async () => {
    await writeFile(path.join(local, 'voyage.txt'), 'Seafaring log');
    const created = await call('sync_create_pair', {
      name: 'docs',
      localDir: local,
      remoteFolderId: 'ROOT',
    });
    expect(created.isError).toBe(false);
    const scan = await call('sync_scan', { name: 'docs' });
    expect(scan.data).toMatchObject({
      entries: [{ path: 'voyage.txt', preview: 'Seafaring log' }],
    });
    const sel = await call('sync_select', { name: 'docs', add: ['voyage.txt'] });
    expect(sel.data).toMatchObject({ added: ['voyage.txt'], selected: 1 });
    const dry = await call('sync_run', { name: 'docs' });
    expect(dry.data).toMatchObject({ dryRun: true, actions: { 'upload-new': ['voyage.txt'] } });
    expect(mem.childrenOf('ROOT')).toEqual([]);
    const planId = (dry.data as { planId: string }).planId;
    const applied = await call('sync_run', { name: 'docs', apply: true, planId });
    expect(applied.data).toMatchObject({ dryRun: false, failures: [] });
    expect(mem.childrenOf('ROOT').map((f) => f.name)).toEqual(['voyage.txt']);
    const pairs = await call('sync_list_pairs', {});
    expect(pairs.data).toMatchObject([{ name: 'docs', counts: { selected: 1, tracked: 1 } }]);
    const removed = await call('sync_remove_pair', { name: 'docs' });
    expect(removed.data).toMatchObject({ removed: true });
  });

  it('refuses apply without the planId of a dry run', async () => {
    await call('sync_create_pair', { name: 'docs', localDir: local, remoteFolderId: 'ROOT' });
    const res = await call('sync_run', { name: 'docs', apply: true });
    expect(res).toMatchObject({ isError: true });
    expect(res.text).toContain('needs the planId');
  });

  it('returns readable tool errors', async () => {
    const bad = await call('sync_run', { name: 'Bad Name' });
    expect(bad.isError).toBe(true);
    const missing = await call('sync_run', { name: 'nope' });
    expect(missing).toMatchObject({
      isError: true,
      text: 'No sync pair named "nope". List pairs with sync_list_pairs.',
    });
  });
});
