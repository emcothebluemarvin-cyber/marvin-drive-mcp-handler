import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createAudit, createRunner, noSleep, silentLogger } from '../../files/__tests__/fakes.js';
import { PairStore } from '../pair-store.js';
import { SyncService } from '../sync-service.js';
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
  tmp = await mkdtemp(path.join(os.tmpdir(), 'sync-native-'));
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

const setDoc = (id: string, text: string, modifiedTime: string): void => {
  const f = mem.files.get(id)!;
  f.content = Buffer.from(text);
  f.modifiedTime = modifiedTime;
};
describe('Google-native files (spec §6.6)', () => {
  it('exports a Doc added after the first run and re-exports it on change (U6, N4)', async () => {
    await apply();
    mem.addNative('g1', 'Plan', 'ROOT', 'doc v1');
    expect((await apply()).actions).toEqual({ 'export-new': ['Plan.docx'] });
    expect(await readFile(at('Plan.docx'), 'utf8')).toBe('doc v1');
    expect((await sync.run({ name: 'docs' })).actions).toEqual({});
    setDoc('g1', 'doc v2', '2026-11-03T14:00:00.000Z');
    expect((await apply()).actions).toEqual({ 'export-replace': ['Plan.docx'] });
    expect(await readFile(at('Plan.docx'), 'utf8')).toBe('doc v2');
    expect((await store.load('docs')).records).toMatchObject([
      { remoteId: 'g1', path: 'Plan.docx', native: { exportFormat: 'docx' } },
    ]);
  });
  it('warns on a pull-only edit (N2) and keeps it beside the new export (N5)', async () => {
    await apply();
    mem.addNative('g1', 'Plan', 'ROOT', 'doc v1');
    await apply();
    await writeFile(at('Plan.docx'), 'my edit');
    const warned = await sync.run({ name: 'docs' });
    expect(warned.actions).toEqual({});
    expect(warned.warnings).toMatchObject([{ path: 'Plan.docx', code: 'native-readonly-edited' }]);
    setDoc('g1', 'doc v2', '2026-11-03T14:00:00.000Z');
    now = new Date('2026-11-03T15:30:00');
    const report = await apply();
    expect(report.actions).toEqual({ 'export-new': ['Plan.docx'] });
    expect(await readFile(at('Plan (local edit 2026-11-03 15.30).docx'), 'utf8')).toBe('my edit');
    expect(await readFile(at('Plan.docx'), 'utf8')).toBe('doc v2');
    expect(report.warnings).toContainEqual(
      expect.objectContaining({ path: 'Plan.docx', code: 'native-local-edit-kept' }),
    );
  });
  it('a stale export restored after the Doc changed in Drive is re-exported, not adopted (O8)', async () => {
    await apply();
    mem.addNative('g1', 'Plan', 'ROOT', 'doc v1');
    await apply();
    await sync.release({ name: 'docs', paths: ['Plan.docx'], apply: true });
    setDoc('g1', 'doc v2', '2026-11-03T14:00:00.000Z');
    expect((await apply()).actions).toEqual({});
    await writeFile(at('Plan.docx'), 'doc v1');
    expect((await apply()).actions).toEqual({ 'export-replace': ['Plan.docx'] });
    expect(await readFile(at('Plan.docx'), 'utf8')).toBe('doc v2');
    expect((await store.load('docs')).records).toMatchObject([
      {
        remoteId: 'g1',
        remoteOnly: false,
        restorePending: false,
        remoteModifiedTime: '2026-11-03T14:00:00.000Z',
      },
    ]);
    expect((await sync.run({ name: 'docs' })).actions).toEqual({});
  });
  it('upgrade: Phase A natives stay candidates, later ones are adopted, selected ones export', async () => {
    await apply();
    const file = await store.load('docs');
    file.pair.nativeBaselineDone = false;
    await store.save(file);
    mem.addNative('g1', 'Old', 'ROOT', 'old doc');
    mem.addNative('g2', 'Chosen', 'ROOT', 'chosen doc');
    await sync.select({ name: 'docs', add: ['Chosen.docx'] });
    const upgrade = await apply();
    expect(upgrade.actions).toEqual({ 'export-new': ['Chosen.docx'] });
    expect(upgrade.candidates.remote.map((c) => c.path)).toEqual(['Old.docx']);
    mem.addNative('g3', 'Later', 'ROOT', 'later doc');
    const next = await apply();
    expect(next.actions).toEqual({ 'export-new': ['Later.docx'] });
    expect(next.candidates.remote.map((c) => c.path)).toEqual(['Old.docx']);
  });
});
