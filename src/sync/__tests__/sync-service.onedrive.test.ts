import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createAudit,
  createFakeDrive,
  createRunner,
  noSleep,
  silentLogger,
} from '../../files/__tests__/fakes.js';
import { PairStore } from '../pair-store.js';
import { SyncService } from '../sync-service.js';
import type { LocalTrash } from '../trash.js';
import type { PairFile } from '../types.js';
import { dirTrash } from './fixtures.js';
import { memoryOneDrive, type MemoryItem, type MemoryOneDrive } from './memory-onedrive.js';

let tmp: string;
let local: string;
let trashDir: string;
let od: MemoryOneDrive;
let store: PairStore;
let saves: PairFile[];
let docs: MemoryItem;
let trash: LocalTrash;

function service(): SyncService {
  return new SyncService({
    runner: createRunner(createFakeDrive()),
    audit: createAudit(),
    retry: noSleep,
    logger: silentLogger(),
    store,
    clock: () => new Date('2026-11-12T12:00:00.000Z'),
    trash: { trash: (abs) => trash.trash(abs) },
    openOneDrive: async (ref) => (ref === 'ms' ? od.remote() : null),
  });
}

beforeEach(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), 'sync-od-'));
  local = path.join(tmp, 'Local');
  trashDir = path.join(tmp, 'Trash');
  await mkdir(local);
  await mkdir(trashDir);
  trash = dirTrash(trashDir);
  od = memoryOneDrive();
  docs = od.addFolder(od.rootId, 'Docs', 'DOCS');
  store = new PairStore({ dir: path.join(tmp, 'config', 'sync'), logger: silentLogger() });
  saves = [];
  const save = store.save.bind(store);
  store.save = async (file) => {
    saves.push(structuredClone(file));
    await save(file);
  };
  await service().createPair({
    name: 'docs',
    localDir: local,
    remoteFolderId: 'DOCS',
    account: 'ms',
  });
});
afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

const at = (...parts: string[]): string => path.join(local, ...parts);

async function apply(sync = service()) {
  const dry = await sync.run({ name: 'docs' });
  return sync.run({ name: 'docs', apply: true, planId: dry.planId });
}

/** a.txt on OneDrive and locally, tracked (first applied run downloads it). */
async function tracked(parent = docs.id, key = 'a.txt'): Promise<MemoryItem> {
  const item = od.addFile(parent, path.posix.basename(key), 'hello', 'A');
  await service().select({ name: 'docs', add: [key] });
  const report = await apply();
  expect(report.actions['download-new']).toEqual([key]);
  return item;
}

const pair = async () => (await store.load('docs')).pair;

describe('OneDrive pairs: basic two-way sync', () => {
  it('downloads with quickXor verification and uploads a new local file', async () => {
    await tracked();
    expect(await readFile(at('a.txt'), 'utf8')).toBe('hello');
    await writeFile(at('b.txt'), 'new');
    await service().select({ name: 'docs', add: ['b.txt'] });
    const report = await apply();
    expect(report.actions['upload-new']).toEqual(['b.txt']);
    const uploaded = [...od.items.values()].find((i) => i.name === 'b.txt');
    expect(uploaded?.content.toString()).toBe('new');
    const { records } = await store.load('docs');
    expect(records.find((r) => r.path === 'b.txt')?.remoteHash?.kind).toBe('quickXor');
  });

  it('a remote edit is downloaded; a local edit is uploaded with If-Match', async () => {
    await tracked();
    od.edit('A', 'remote edit');
    expect((await apply()).actions['download-replace']).toEqual(['a.txt']);
    expect(await readFile(at('a.txt'), 'utf8')).toBe('remote edit');
    await writeFile(at('a.txt'), 'local edit!');
    expect((await apply()).actions['update-remote']).toEqual(['a.txt']);
    expect(od.items.get('A')?.content.toString()).toBe('local edit!');
    const put = od.calls.filter(
      (c) => c.method === 'PUT' && c.path === '/me/drive/items/A/content',
    );
    expect(put.at(-1)?.headers['if-match']).toMatch(/^"\{A\},\d+"$/);
  });
});

describe('OneDrive pairs: quickXor content comparison (spec §3)', () => {
  it('U2 adopts an identical local file by quickXor (no transfer)', async () => {
    od.addFile(docs.id, 'same.txt', 'same bytes', 'S');
    await writeFile(at('same.txt'), 'same bytes');
    await service().select({ name: 'docs', add: ['same.txt'] });
    const report = await apply();
    expect(report.actions.adopt).toEqual(['same.txt']);
    const { records } = await store.load('docs');
    expect(records[0]).toMatchObject({ remoteId: 'S', remoteHash: { kind: 'quickXor' } });
    expect(records[0]?.localMd5).toMatch(/^[0-9a-f]{32}$/);
  });

  it('a different local file is a conflict, not an adopt', async () => {
    od.addFile(docs.id, 'diff.txt', 'remote bytes', 'D');
    await writeFile(at('diff.txt'), 'local bytes');
    await service().select({ name: 'docs', add: ['diff.txt'] });
    expect((await apply()).actions.conflict).toEqual(['diff.txt']);
  });

  it('a stat-unchanged tracked file is released with a quickXor digest', async () => {
    await tracked();
    const result = await service().release({ name: 'docs', paths: ['a.txt'], apply: true });
    expect(result.released).toEqual([{ path: 'a.txt', status: 'released' }]);
    expect(await readdir(trashDir)).toEqual(['a.txt']);
  });
});

describe('OneDrive release: the item vanishes between select and apply', () => {
  /** A service whose remote hides or removes A right before release re-reads it. */
  function vanishing(how: 'hide' | 'remove'): SyncService {
    return new SyncService({
      runner: createRunner(createFakeDrive()),
      audit: createAudit(),
      retry: noSleep,
      logger: silentLogger(),
      store,
      clock: () => new Date('2026-11-12T12:00:00.000Z'),
      trash: { trash: (abs) => trash.trash(abs) },
      openOneDrive: async (ref) => {
        if (ref !== 'ms') return null;
        const remote = od.remote();
        const get = remote.get.bind(remote);
        remote.get = async (id, signal) => {
          if (id === 'A' && od.items.has('A')) od[how]('A');
          return get(id, signal);
        };
        return remote;
      },
    });
  }

  it.each(['hide', 'remove'] as const)(
    '%s: failed, local file kept, record unchanged',
    async (how) => {
      await tracked();
      const result = await vanishing(how).release({ name: 'docs', paths: ['a.txt'], apply: true });
      expect(result.released).toEqual([]);
      expect(result.failed).toEqual([{ path: 'a.txt', reason: 'a.txt not found on OneDrive' }]);
      expect(await readFile(at('a.txt'), 'utf8')).toBe('hello');
      expect(await readdir(trashDir)).toEqual([]);
      const { records } = await store.load('docs');
      expect(records.find((r) => r.path === 'a.txt')?.remoteOnly).toBe(false);
    },
  );
});

describe('OneDrive deletion evidence (spec §4.1)', () => {
  it('404 with feed evidence: B10 moves the unchanged local copy to the trash', async () => {
    await tracked();
    od.remove('A');
    const report = await apply();
    expect(report.actions['trash-local']).toEqual(['a.txt']);
    expect(await readdir(trashDir)).toEqual(['a.txt']);
    expect((await store.load('docs')).records).toEqual([]);
    expect((await pair()).remoteDeletedIds).toEqual([]);
  });

  it('404 without evidence: B14 reports only, nothing is trashed', async () => {
    await tracked();
    od.hide('A');
    const report = await apply();
    expect(report.actions).toEqual({});
    expect(report.warnings).toContainEqual(
      expect.objectContaining({ path: 'a.txt', code: 'remote-unavailable' }),
    );
    expect(await readFile(at('a.txt'), 'utf8')).toBe('hello');
    expect(await readdir(trashDir)).toEqual([]);
  });

  it('a dry run moves the cursor and carries the evidence; its apply still sees it', async () => {
    await tracked();
    const before = await pair();
    od.remove('A');
    const sync = service();
    const dry = await sync.run({ name: 'docs' });
    expect(dry.actions['trash-local']).toEqual(['a.txt']);
    const after = await pair();
    expect(after.remoteCursor).not.toBe(before.remoteCursor);
    expect(after.remoteDeletedIds).toEqual(['A']);
    // The next read starts after the deletion; the stored evidence still plans B10.
    const report = await sync.run({ name: 'docs', apply: true, planId: dry.planId });
    expect(report.actions['trash-local']).toEqual(['a.txt']);
  });

  it('dry runs and early returns save cursor and evidence only, records untouched', async () => {
    await tracked();
    od.remove('A');
    const records = (await store.load('docs')).records;
    saves.length = 0;
    await service().run({ name: 'docs' });
    const changed = await service().run({ name: 'docs', apply: true, planId: 'stale' });
    expect(changed.aborted?.reason).toBe('plan-changed');
    expect(saves).toHaveLength(2);
    for (const saved of saves) {
      expect(saved.records).toEqual(records);
      expect(saved.pair.remoteDeletedIds).toEqual(['A']);
    }
  });

  it('cursor and evidence go in one save, also on an applied run with no actions', async () => {
    await tracked();
    const start = (await pair()).remoteCursor;
    saves.length = 0;
    const report = await service().run({ name: 'docs', apply: true });
    expect(report.actions).toEqual({});
    expect(saves).toHaveLength(1);
    expect(saves[0]?.pair.remoteCursor).toBe(start); // nothing changed on OneDrive
    // With actions: the executor's first save already carries the new cursor and evidence.
    od.remove('A');
    saves.length = 0;
    const cursor = (await pair()).remoteCursor;
    await service().run({ name: 'docs', apply: true });
    expect(saves[0]?.pair.remoteCursor).not.toBe(cursor);
  });

  it('evidence survives an apply that skipped the record', async () => {
    await tracked();
    od.remove('A');
    trash = {
      trash: async () => {
        throw new Error('trash is busy');
      },
    };
    const failed = await apply();
    expect(failed.failures).toEqual([expect.objectContaining({ path: 'a.txt' })]);
    expect((await pair()).remoteDeletedIds).toEqual(['A']);
    trash = dirTrash(trashDir);
    expect((await apply()).actions['trash-local']).toEqual(['a.txt']);
  });

  it('an expired cursor warns and does not apply new deletions; it restarts', async () => {
    await tracked();
    od.remove('A');
    od.expireCursors();
    const report = await service().run({ name: 'docs', apply: true });
    expect(report.warnings).toContainEqual({
      path: '',
      code: 'deletion-history-unavailable',
      message:
        'OneDrive change history unavailable; deletions since the last run are reported, not applied',
    });
    expect(report.actions).toEqual({});
    expect(await readFile(at('a.txt'), 'utf8')).toBe('hello');
    const after = await pair();
    expect(after.remoteCursor).toMatch(/token=g1-/);
    // The next run reads the restarted cursor without a warning.
    const next = await service().run({ name: 'docs' });
    expect(next.warnings.map((w) => w.code)).not.toContain('deletion-history-unavailable');
  });

  it('a stored cursor that is not a Graph link does not block runs; it restarts', async () => {
    await tracked();
    const file = await store.load('docs');
    file.pair.remoteCursor = 'https://evil.example/v1.0/me/drive/root/delta?token=x';
    await store.save(file);
    od.remove('A');
    const report = await service().run({ name: 'docs', apply: true });
    expect(report.warnings.map((w) => w.code)).toContain('deletion-history-unavailable');
    expect(report.actions).toEqual({});
    expect(await readFile(at('a.txt'), 'utf8')).toBe('hello');
    expect((await pair()).remoteCursor).toMatch(/^https:\/\/graph\.microsoft\.com\/.*token=g0-/);
  });

  it('an expired cursor still plans with the stored evidence', async () => {
    await tracked();
    od.remove('A');
    await service().run({ name: 'docs' }); // stores A as evidence
    od.expireCursors();
    const report = await apply();
    expect(report.actions['trash-local']).toEqual(['a.txt']);
  });

  it('moved out of the pair stays moved-out (feed update, not a deletion)', async () => {
    await tracked();
    od.move('A', od.rootId);
    const report = await apply();
    expect(report.actions.untrack).toEqual(['a.txt']);
    expect(await readFile(at('a.txt'), 'utf8')).toBe('hello');
  });

  it('an id seen present again is pruned; old evidence does not act later', async () => {
    const item = await tracked();
    od.remove('A');
    await service().run({ name: 'docs' });
    expect((await pair()).remoteDeletedIds).toEqual(['A']);
    od.restore(item);
    await service().run({ name: 'docs' });
    expect((await pair()).remoteDeletedIds).toEqual([]);
    od.hide('A');
    const report = await apply();
    expect(report.actions).toEqual({});
    expect(report.warnings).toContainEqual(
      expect.objectContaining({ path: 'a.txt', code: 'remote-unavailable' }),
    );
  });

  it('a child of an evidenced folder is evidenced (remoteParentId)', async () => {
    const sub = od.addFolder(docs.id, 'sub', 'SUB');
    await tracked(sub.id, 'sub/a.txt');
    od.remove('SUB', { feedChildren: false });
    const report = await apply();
    expect(report.actions['trash-local']).toEqual(['sub/a.txt']);
    expect((await pair()).remoteDeletedIds).toEqual([]);
  });

  it('sync_release reads the feed but does not persist it', async () => {
    await tracked();
    const before = await pair();
    od.remove('A');
    saves.length = 0;
    const result = await service().release({ name: 'docs', paths: ['a.txt'] });
    expect(result.skipped).toEqual([expect.objectContaining({ path: 'a.txt' })]);
    expect(saves).toEqual([]);
    expect((await pair()).remoteCursor).toBe(before.remoteCursor);
  });
});
