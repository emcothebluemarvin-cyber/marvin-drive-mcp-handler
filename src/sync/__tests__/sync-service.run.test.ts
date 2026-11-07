import { mkdir, mkdtemp, readFile, readdir, rename, rm, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { linkDir } from '../../__tests__/links.js';
import { createAudit, createRunner, noSleep, silentLogger } from '../../files/__tests__/fakes.js';
import { SyncRootError } from '../errors.js';
import { PairStore, markerName } from '../pair-store.js';
import { SyncService } from '../sync-service.js';
import { dirTrash, refuseTrash } from './fixtures.js';
import { memoryDrive, type MemoryDrive } from './memory-drive.js';

let tmp: string;
let local: string;
let trashDir: string;
let mem: MemoryDrive;
let store: PairStore;
let sync: SyncService;
let now: Date;

beforeEach(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), 'sync-run-'));
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

async function apply(extra: { allowMassDelete?: boolean } = {}) {
  const dry = await sync.run({ name: 'docs' });
  return sync.run({ name: 'docs', apply: true, planId: dry.planId, ...extra });
}

describe('root checks', () => {
  it('aborts when the marker is missing, with the repair hint', async () => {
    await rm(at(markerName('docs')));
    await expect(sync.run({ name: 'docs' })).rejects.toThrow(/repair-marker docs/);
    await expect(sync.run({ name: 'docs' })).rejects.toBeInstanceOf(SyncRootError);
  });

  it('aborts when the local folder is gone or the Drive folder is trashed', async () => {
    mem.files.get('ROOT')!.trashed = true;
    await expect(sync.run({ name: 'docs' })).rejects.toThrow('is in the Drive trash');
    await rm(local, { recursive: true });
    await expect(sync.run({ name: 'docs' })).rejects.toThrow('is not available');
  });

  it('aborts when the case sensitivity probe changed', async () => {
    const file = await store.load('docs');
    file.pair.caseInsensitive = !file.pair.caseInsensitive;
    await store.save(file);
    await expect(sync.run({ name: 'docs' })).rejects.toThrow('Case sensitivity');
  });
});

describe('run', () => {
  it('dry run is the default and writes nothing', async () => {
    await writeFile(at('a.pdf'), 'A');
    await sync.select({ name: 'docs', add: ['a.pdf'] });
    const before = await readFile(path.join(store.dir, 'docs.json'), 'utf8');
    const report = await sync.run({ name: 'docs' });
    expect(report).toMatchObject({
      dryRun: true,
      aborted: null,
      actions: { 'upload-new': ['a.pdf'] },
    });
    expect(await readFile(path.join(store.dir, 'docs.json'), 'utf8')).toBe(before);
    expect(mem.childrenOf('ROOT')).toEqual([]);
  });

  it('applies, records the baseline and keeps pre-existing Drive files as candidates', async () => {
    mem.addFile('old', 'old.pdf', 'ROOT', 'pre-existing');
    await writeFile(at('a.pdf'), 'A');
    await sync.select({ name: 'docs', add: ['a.pdf'] });
    const first = await apply();
    expect(first).toMatchObject({
      dryRun: false,
      actions: { 'upload-new': ['a.pdf'] },
      failures: [],
    });
    expect(first.candidates.remote.map((c) => c.path)).toEqual(['old.pdf']);
    const file = await store.load('docs');
    expect(file.pair).toMatchObject({
      firstAppliedRunAt: now.toISOString(),
      lastAppliedRunAt: now.toISOString(),
      remoteBaseline: ['old'],
    });
    expect(file.records.map((r) => r.path)).toEqual(['a.pdf']);

    now = new Date('2026-11-03T13:00:00.000Z');
    mem.addFile('new', 'new.pdf', 'ROOT', 'added later');
    const second = await apply();
    expect(second.actions).toEqual({ 'download-new': ['new.pdf'] });
    expect(second.candidates.remote.map((c) => c.path)).toEqual(['old.pdf']);
    expect(await readFile(at('new.pdf'), 'utf8')).toBe('added later');
    expect((await store.load('docs')).pair.selection).toEqual(['a.pdf', 'new.pdf']);
  });

  it('returns the new plan without applying when planId no longer matches', async () => {
    await writeFile(at('a.pdf'), 'A');
    await sync.select({ name: 'docs', add: ['a.pdf'] });
    const dry = await sync.run({ name: 'docs' });
    await writeFile(at('a.pdf'), 'A edited');
    const res = await sync.run({ name: 'docs', apply: true, planId: dry.planId });
    expect(res.aborted?.reason).toBe('plan-changed');
    expect(res.planId).not.toBe(dry.planId);
    expect(mem.childrenOf('ROOT')).toEqual([]);
  });

  it('brakes mass deletion unless allowed', async () => {
    for (const n of ['a', 'b', 'c']) await writeFile(at(`${n}.pdf`), n);
    await sync.select({ name: 'docs', add: ['a.pdf', 'b.pdf', 'c.pdf'] });
    await apply();
    for (const n of ['a', 'b', 'c']) await rm(at(`${n}.pdf`));
    const braked = await apply();
    expect(braked.aborted).toMatchObject({ reason: 'mass-delete' });
    expect(mem.childrenOf('ROOT')).toHaveLength(3);
    const allowed = await apply({ allowMassDelete: true });
    expect(allowed.actions['trash-remote']).toEqual(['a.pdf', 'b.pdf', 'c.pdf']);
    expect(mem.childrenOf('ROOT')).toEqual([]);
  });

  it('propagates edits both ways, conflicts, deletions and remote renames', async () => {
    for (const n of ['edit-local', 'edit-remote', 'both', 'del-local', 'del-remote', 'moved']) {
      await writeFile(at(`${n}.txt`), `${n} v1`);
    }
    await sync.select({
      name: 'docs',
      add: [
        'edit-local.txt',
        'edit-remote.txt',
        'both.txt',
        'del-local.txt',
        'del-remote.txt',
        'moved.txt',
      ],
    });
    await apply();
    const idOf = async (p: string): Promise<string> =>
      (await store.load('docs')).records.find((r) => r.path === p)?.remoteId ?? '';
    const setRemote = async (p: string, content: string): Promise<void> => {
      const f = mem.files.get(await idOf(p))!;
      f.content = Buffer.from(content);
      f.modifiedTime = '2026-11-03T14:00:00.000Z';
    };
    await writeFile(at('edit-local.txt'), 'local v2');
    await setRemote('edit-remote.txt', 'remote v2');
    await writeFile(at('both.txt'), 'both local');
    await setRemote('both.txt', 'both remote');
    await rm(at('del-local.txt'));
    mem.files.get(await idOf('del-remote.txt'))!.trashed = true;
    mem.addFolder('SUB', 'sub', 'ROOT');
    const moved = mem.files.get(await idOf('moved.txt'))!;
    moved.parents = ['SUB'];
    moved.name = 'renamed.txt';

    now = new Date('2026-11-03T15:30:00');
    const report = await apply();
    expect(report.failures).toEqual([]);
    expect(report.actions).toEqual({
      'update-remote': ['edit-local.txt'],
      'move-local': ['sub/renamed.txt'],
      'download-replace': ['edit-remote.txt'],
      conflict: ['both.txt'],
      'trash-remote': ['del-local.txt'],
      'trash-local': ['del-remote.txt'],
    });
    expect(report.conflicts).toEqual([
      { path: 'both.txt', conflictCopy: 'both (Drive conflict 2026-11-03 15.30).txt' },
    ]);
    expect(await readFile(at('both (Drive conflict 2026-11-03 15.30).txt'), 'utf8')).toBe(
      'both remote',
    );
    expect(mem.files.get(await idOf('both.txt'))?.content.toString()).toBe('both local');
    expect(await readFile(at('edit-remote.txt'), 'utf8')).toBe('remote v2');
    expect(mem.files.get(await idOf('edit-local.txt'))?.content.toString()).toBe('local v2');
    expect(await readFile(at('sub', 'renamed.txt'), 'utf8')).toBe('moved v1');
    expect(await readdir(trashDir)).toEqual(['del-remote.txt']);
    const after = await sync.run({ name: 'docs' });
    expect(after.actions).toEqual({});
  });

  it('deletes stale temp files on applied runs only', async () => {
    const part = at('.abc.marvin-part');
    await writeFile(part, 'partial');
    const old = new Date(now.getTime() - 2 * 60 * 60 * 1000);
    await utimes(part, old, old);
    await sync.run({ name: 'docs' });
    expect(await readdir(local)).toContain('.abc.marvin-part');
    await apply();
    expect(await readdir(local)).not.toContain('.abc.marvin-part');
  });

  it('a rejected apply (stale planId) leaves stale temp files alone', async () => {
    const part = at('.abc.marvin-part');
    await writeFile(part, 'partial');
    const old = new Date(now.getTime() - 2 * 60 * 60 * 1000);
    await utimes(part, old, old);
    const dry = await sync.run({ name: 'docs' });
    await writeFile(at('new.pdf'), 'N');
    await sync.select({ name: 'docs', add: ['new.pdf'] });
    const res = await sync.run({ name: 'docs', apply: true, planId: dry.planId });
    expect(res.aborted?.reason).toBe('plan-changed');
    expect(await readdir(local)).toContain('.abc.marvin-part');
  });
});

describe('run (review regressions)', () => {
  it('a folder moved to another disk and replaced by a symlink never trashes Drive files', async () => {
    await mkdir(at('a'));
    await writeFile(at('a', 'x.pdf'), 'X');
    await sync.select({ name: 'docs', add: ['a/x.pdf'] });
    await apply();
    const external = path.join(tmp, 'External');
    await rename(at('a'), external);
    await linkDir(external, at('a'));
    const reachable = await apply();
    expect(reachable.actions).toEqual({});
    expect(reachable.unknown.map((u) => u.path)).toEqual(['a/x.pdf']);
    await rm(external, { recursive: true }); // disk unmounted: dangling symlink
    const dangling = await apply();
    expect(dangling.actions).toEqual({});
    expect(dangling.unknown.map((u) => u.path)).toEqual(['a/x.pdf']);
    expect(mem.childrenOf('ROOT').map((f) => f.name)).toEqual(['a']);
    expect(mem.childrenOf(mem.childrenOf('ROOT')[0]?.id ?? '').map((f) => f.name)).toEqual([
      'x.pdf',
    ]);
  });

  it('uploads into the existing Drive folder whose name differs only in case', async () => {
    const ci = (await store.load('docs')).pair.caseInsensitive;
    mem.addFolder('F-Docs', 'Docs', 'ROOT');
    await mkdir(at('docs'));
    await writeFile(at('docs', 'a.pdf'), 'A');
    await sync.select({ name: 'docs', add: ['docs/a.pdf'] });
    const first = await apply();
    if (!ci) {
      expect(first.ambiguous).toEqual(['docs/a.pdf']);
      return;
    }
    expect(first.actions).toEqual({ 'upload-new': ['Docs/a.pdf'] });
    expect(mem.childrenOf('ROOT').map((f) => f.name)).toEqual(['Docs']);
    expect(mem.childrenOf('F-Docs').map((f) => f.name)).toEqual(['a.pdf']);
    const second = await apply();
    expect(second).toMatchObject({ actions: {}, unknown: [], ambiguous: [] });
  });

  it('stamps lastAppliedRunAt with the scan start time', async () => {
    const stamps: Date[] = [];
    const ticking = new SyncService({
      runner: createRunner(mem.drive),
      audit: createAudit(),
      retry: noSleep,
      logger: silentLogger(),
      store,
      trash: refuseTrash,
      clock: () => {
        const t = new Date(Date.UTC(2026, 10, 3, 12, 0, stamps.length));
        stamps.push(t);
        return t;
      },
    });
    await writeFile(at('a.pdf'), 'A');
    await ticking.select({ name: 'docs', add: ['a.pdf'] });
    const before = stamps.length;
    await ticking.run({ name: 'docs', apply: true });
    const pair = (await store.load('docs')).pair;
    expect(pair.lastAppliedRunAt).toBe(stamps[before]?.toISOString());
  });
});

describe('upgrade from Phase A (nativeBaselineDone)', () => {
  async function phaseAPair(): Promise<void> {
    await apply();
    const file = await store.load('docs');
    file.pair.nativeBaselineDone = false;
    await store.save(file);
  }
  const done = async (): Promise<boolean> => (await store.load('docs')).pair.nativeBaselineDone;

  it('dry runs and plan-changed aborts change nothing; an applied run baselines natives', async () => {
    await phaseAPair();
    mem.addNative('g1', 'Plan', 'ROOT', 'doc v1');
    const dry = await sync.run({ name: 'docs' });
    expect(await done()).toBe(false);
    await writeFile(at('new.pdf'), 'N');
    await sync.select({ name: 'docs', add: ['new.pdf'] });
    const changed = await sync.run({ name: 'docs', apply: true, planId: dry.planId });
    expect(changed.aborted?.reason).toBe('plan-changed');
    expect(await done()).toBe(false);
    await apply();
    const after = await store.load('docs');
    expect(after.pair.nativeBaselineDone).toBe(true);
    expect(after.pair.remoteBaseline).toContain('g1');
  });

  it('a mass-delete abort leaves it false', async () => {
    for (const n of ['a', 'b', 'c']) await writeFile(at(`${n}.pdf`), n);
    await sync.select({ name: 'docs', add: ['a.pdf', 'b.pdf', 'c.pdf'] });
    await phaseAPair();
    for (const f of mem.childrenOf('ROOT')) f.trashed = true;
    const braked = await apply();
    expect(braked.aborted?.reason).toBe('mass-delete');
    expect(await done()).toBe(false);
  });
});
