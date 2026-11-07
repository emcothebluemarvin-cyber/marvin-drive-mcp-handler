import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAudit, createRunner, noSleep, silentLogger } from '../../files/__tests__/fakes.js';
import { LocalTrashError, PersistenceError } from '../errors.js';
import { PairStore } from '../pair-store.js';
import { SyncService } from '../sync-service.js';
import type { LocalTrash } from '../trash.js';
import { dirTrash } from './fixtures.js';
import { memoryDrive, type MemoryDrive } from './memory-drive.js';

let tmp: string;
let local: string;
let trashDir: string;
let mem: MemoryDrive;
let store: PairStore;
let sync: SyncService;
let now: Date;

beforeEach(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), 'sync-release-'));
  local = path.join(tmp, 'Local');
  trashDir = path.join(tmp, 'Trash');
  await mkdir(local);
  await mkdir(trashDir);
  now = new Date('2026-11-03T12:00:00.000Z');
  mem = memoryDrive('ROOT');
  store = new PairStore({ dir: path.join(tmp, 'config', 'sync'), logger: silentLogger() });
  sync = new SyncService({
    runner: createRunner(mem.drive),
    audit: createAudit(),
    retry: noSleep,
    logger: silentLogger(),
    store,
    clock: () => now,
    trash: dirTrash(trashDir),
  });
  await sync.createPair({ name: 'docs', localDir: local, remoteFolderId: 'ROOT' });
});
afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

const at = (...parts: string[]): string => path.join(local, ...parts);

async function apply() {
  const dry = await sync.run({ name: 'docs' });
  return sync.run({ name: 'docs', apply: true, planId: dry.planId });
}

const idOf = async (p: string): Promise<string> =>
  (await store.load('docs')).records.find((r) => r.path === p)?.remoteId ?? '';

describe('sync_release', () => {
  beforeEach(async () => {
    await writeFile(at('a.pdf'), 'A');
    await mkdir(at('sub'));
    await writeFile(at('sub', 'b.pdf'), 'B');
    await sync.select({ name: 'docs', add: ['a.pdf', 'sub/b.pdf'] });
    await apply();
  });
  it('dry run changes nothing; apply trashes local copies and keeps them in Drive', async () => {
    const dry = await sync.release({ name: 'docs', all: true });
    expect(dry).toMatchObject({
      pair: 'docs',
      dryRun: true,
      skipped: [],
      failed: [],
      removedDirs: [],
    });
    expect(dry.released).toEqual([
      { path: 'a.pdf', status: 'would release' },
      { path: 'sub/b.pdf', status: 'would release' },
    ]);
    expect(await readdir(local)).toContain('a.pdf');
    const res = await sync.release({ name: 'docs', all: true, apply: true });
    expect(res.released.map((r) => r.status)).toEqual(['released', 'released']);
    expect(res.removedDirs).toEqual(['sub']);
    expect((await readdir(trashDir)).sort()).toEqual(['a.pdf', 'b.pdf']);
    expect(mem.childrenOf('ROOT').map((f) => f.name)).toContain('a.pdf');
    const file = await store.load('docs');
    expect(file.records.every((r) => r.remoteOnly)).toBe(true);
    expect(file.pair.selection.sort()).toEqual(['a.pdf', 'sub/b.pdf']);
    expect((await sync.run({ name: 'docs' })).actions).toEqual({});
  });
  it('sync_select add brings a released file back (O1)', async () => {
    await sync.release({ name: 'docs', paths: ['a.pdf'], apply: true });
    await sync.select({ name: 'docs', add: ['a.pdf'] });
    expect((await apply()).actions).toEqual({ 'download-new': ['a.pdf'] });
    expect(await readFile(at('a.pdf'), 'utf8')).toBe('A');
  });
  it('a failing trash keeps the file and the record', async () => {
    const failing = new SyncService({
      runner: createRunner(mem.drive),
      audit: createAudit(),
      retry: noSleep,
      logger: silentLogger(),
      store,
      clock: () => now,
      trash: {
        trash: async () => {
          throw new LocalTrashError('no trash on this volume; nothing was deleted');
        },
      },
    });
    const res = await failing.release({ name: 'docs', paths: ['a.pdf'], apply: true });
    expect(res.failed).toEqual([
      { path: 'a.pdf', reason: 'no trash on this volume; nothing was deleted' },
    ]);
    expect(await readFile(at('a.pdf'), 'utf8')).toBe('A');
    expect((await store.load('docs')).records.find((r) => r.path === 'a.pdf')?.remoteOnly).toBe(
      false,
    );
  });
  const withTrash = (trash: LocalTrash): SyncService =>
    new SyncService({
      runner: createRunner(mem.drive),
      audit: createAudit(),
      retry: noSleep,
      logger: silentLogger(),
      store,
      clock: () => now,
      trash,
    });
  const remoteOnlyOf = async (p: string): Promise<boolean | undefined> =>
    (await store.load('docs')).records.find((r) => r.path === p)?.remoteOnly;
  it('write-ahead: remoteOnly is on disk before the trash is called', async () => {
    const seen: Array<boolean | undefined> = [];
    const inner = dirTrash(trashDir);
    const res = await withTrash({
      trash: async (abs) => {
        seen.push(await remoteOnlyOf('a.pdf'));
        await inner.trash(abs);
      },
    }).release({ name: 'docs', paths: ['a.pdf'], apply: true });
    expect(seen).toEqual([true]);
    expect(res.released).toEqual([{ path: 'a.pdf', status: 'released' }]);
  });
  it('a failing save before the trash aborts and never calls the trash', async () => {
    const trash = vi.fn(async () => {});
    vi.spyOn(store, 'save').mockRejectedValueOnce(new Error('disk full'));
    await expect(
      withTrash({ trash }).release({ name: 'docs', paths: ['a.pdf'], apply: true }),
    ).rejects.toThrow(PersistenceError);
    expect(trash).not.toHaveBeenCalled();
    expect(await readFile(at('a.pdf'), 'utf8')).toBe('A');
    expect(await remoteOnlyOf('a.pdf')).toBe(false);
  });
  it('a failing trash reverts remoteOnly and persists the revert', async () => {
    const seen: Array<boolean | undefined> = [];
    const save = vi.spyOn(store, 'save');
    const res = await withTrash({
      trash: async () => {
        seen.push(await remoteOnlyOf('a.pdf'));
        throw new LocalTrashError('no trash on this volume; nothing was deleted');
      },
    }).release({ name: 'docs', paths: ['a.pdf'], apply: true });
    expect(seen).toEqual([true]);
    expect(save).toHaveBeenCalledTimes(2);
    expect(res.failed).toEqual([
      { path: 'a.pdf', reason: 'no trash on this volume; nothing was deleted' },
    ]);
    expect(await remoteOnlyOf('a.pdf')).toBe(false);
    expect(await readFile(at('a.pdf'), 'utf8')).toBe('A');
  });
  it('a failing trash and a failing revert report both errors and delete nothing', async () => {
    const realSave = store.save.bind(store);
    vi.spyOn(store, 'save')
      .mockImplementationOnce(realSave)
      .mockRejectedValueOnce(new Error('disk full'));
    const err = await withTrash({
      trash: async () => {
        throw new LocalTrashError('no trash on this volume');
      },
    })
      .release({ name: 'docs', paths: ['a.pdf'], apply: true })
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(err).toBeInstanceOf(PersistenceError);
    expect((err as Error).message).toMatch(
      /no trash on this volume.*restoring the record also failed.*disk full/,
    );
    expect(await readFile(at('a.pdf'), 'utf8')).toBe('A');
    expect(await readdir(trashDir)).toEqual([]);
  });
  it('a crash after the write-ahead save (remoteOnly, L present = R) is adopted by O8, never trashed', async () => {
    const file = await store.load('docs');
    for (const r of file.records) if (r.path === 'a.pdf') r.remoteOnly = true;
    await store.save(file);
    const id = await idOf('a.pdf');
    const res = await apply();
    expect(res.actions).toEqual({ adopt: ['a.pdf'] });
    expect(await readdir(trashDir)).toEqual([]);
    expect(await readFile(at('a.pdf'), 'utf8')).toBe('A');
    expect(mem.files.get(id)?.trashed).toBe(false);
    expect(await remoteOnlyOf('a.pdf')).toBe(false);
  });
  it('R0 releases a locally deleted file without touching anything', async () => {
    await rm(at('a.pdf'));
    const id = await idOf('a.pdf');
    const res = await sync.release({ name: 'docs', paths: ['a.pdf'], apply: true });
    expect(res.released).toEqual([{ path: 'a.pdf', status: 'released (already deleted locally)' }]);
    expect(await readdir(trashDir)).toEqual([]);
    expect(mem.files.get(id)?.trashed).toBe(false);
    expect((await sync.run({ name: 'docs' })).actions).toEqual({});
  });
  it('R0 refuses when the file reappears before the flag is set', async () => {
    await rm(at('a.pdf'));
    const id = await idOf('a.pdf');
    const original = mem.drive.getFile.getMockImplementation()!;
    mem.drive.getFile.mockImplementation(async (fileId, fields) => {
      if (fileId === id) await writeFile(at('a.pdf'), 'back');
      return original(fileId, fields);
    });
    const res = await sync.release({ name: 'docs', paths: ['a.pdf'], apply: true });
    expect(res.failed[0]?.reason).toMatch(/exists locally again/);
    expect((await store.load('docs')).records.find((r) => r.path === 'a.pdf')?.remoteOnly).toBe(
      false,
    );
  });
  it('a local change between selection and trash fails the path and trashes nothing', async () => {
    const id = await idOf('a.pdf');
    const original = mem.drive.getFile.getMockImplementation()!;
    mem.drive.getFile.mockImplementation(async (fileId, fields) => {
      if (fileId === id) await writeFile(at('a.pdf'), 'edited');
      return original(fileId, fields);
    });
    const res = await sync.release({ name: 'docs', paths: ['a.pdf'], apply: true });
    expect(res.released).toEqual([]);
    expect(res.failed).toEqual([{ path: 'a.pdf', reason: 'a.pdf changed locally since the scan' }]);
    expect(await readdir(trashDir)).toEqual([]);
    expect(await readFile(at('a.pdf'), 'utf8')).toBe('edited');
    expect((await store.load('docs')).records.find((r) => r.path === 'a.pdf')?.remoteOnly).toBe(
      false,
    );
  });
  it('a Drive change or trash between selection and trash fails the path', async () => {
    const a = await idOf('a.pdf');
    const b = await idOf('sub/b.pdf');
    const original = mem.drive.getFile.getMockImplementation()!;
    let armed = true;
    mem.drive.getFile.mockImplementation(async (fileId, fields) => {
      const f = mem.files.get(fileId);
      if (armed && f && fileId === a) {
        f.content = Buffer.from('A2');
        f.modifiedTime = '2026-11-03T11:00:00.000Z';
      }
      if (armed && f && fileId === b) f.trashed = true;
      return original(fileId, fields);
    });
    const res = await sync.release({ name: 'docs', all: true, apply: true });
    armed = false;
    expect(res.released).toEqual([]);
    expect(res.failed.map((f) => f.path)).toEqual(['a.pdf', 'sub/b.pdf']);
    for (const f of res.failed) expect(f.reason).toMatch(/changed, moved or was trashed in Drive/);
    expect(await readdir(trashDir)).toEqual([]);
    expect(await readFile(at('sub', 'b.pdf'), 'utf8')).toBe('B');
    expect(res.removedDirs).toEqual([]);
    expect((await store.load('docs')).records.some((r) => r.remoteOnly)).toBe(false);
  });
  it('a Drive change before the scan skips the path at selection', async () => {
    const f = mem.files.get(await idOf('a.pdf'))!;
    f.content = Buffer.from('A2');
    f.modifiedTime = '2026-11-03T11:00:00.000Z';
    const res = await sync.release({ name: 'docs', paths: ['a.pdf'], apply: true });
    expect(res.released).toEqual([]);
    expect(res.failed).toEqual([]);
    expect(res.skipped).toEqual([
      { path: 'a.pdf', reason: 'not in sync (changed locally or in Drive); run sync_run first' },
    ]);
    expect(await readdir(trashDir)).toEqual([]);
  });
  it('a dry run writes nothing: no trash, no pair-file change, no audit, no folder removal', async () => {
    const audit = createAudit();
    const dryOnly = new SyncService({
      runner: createRunner(mem.drive),
      audit,
      retry: noSleep,
      logger: silentLogger(),
      store,
      clock: () => now,
      trash: dirTrash(trashDir),
    });
    await rm(at('a.pdf'));
    const configDir = path.join(tmp, 'config', 'sync');
    const snapshot = async (): Promise<string[]> => {
      const names = (await readdir(configDir)).sort();
      return Promise.all(
        names.map(async (n) => `${n}:${await readFile(path.join(configDir, n), 'utf8')}`),
      );
    };
    const before = await snapshot();
    const res = await dryOnly.release({ name: 'docs', paths: ['a.pdf', 'sub/b.pdf'] });
    expect(res.dryRun).toBe(true);
    expect(res.released).toEqual([
      { path: 'a.pdf', status: 'would release (already deleted locally)' },
      { path: 'sub/b.pdf', status: 'would release' },
    ]);
    expect(await snapshot()).toEqual(before);
    expect(await readdir(trashDir)).toEqual([]);
    expect(await readFile(at('sub', 'b.pdf'), 'utf8')).toBe('B');
    expect(audit.entries).toEqual([]);
    expect(mem.drive.updateFile).not.toHaveBeenCalled();
  });
  it('audits each release as sync_release', async () => {
    const audit = createAudit();
    const audited = new SyncService({
      runner: createRunner(mem.drive),
      audit,
      retry: noSleep,
      logger: silentLogger(),
      store,
      clock: () => now,
      trash: dirTrash(trashDir),
    });
    const id = await idOf('a.pdf');
    await audited.release({ name: 'docs', paths: ['a.pdf'], apply: true });
    expect(audit.entries).toEqual([
      expect.objectContaining({ op: 'sync_release', fileId: id, name: 'a.pdf' }),
    ]);
  });
  it('needs exactly one of paths or all', async () => {
    await expect(sync.release({ name: 'docs' })).rejects.toThrow('Give paths or all: true');
  });
});
