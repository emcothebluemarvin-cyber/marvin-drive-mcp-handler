import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ValidationError } from '../../errors.js';
import { createAudit, createRunner, noSleep, silentLogger } from '../../files/__tests__/fakes.js';
import { PairStore, markerName, probeCaseInsensitive } from '../pair-store.js';
import { SyncService } from '../sync-service.js';
import { refuseTrash } from './fixtures.js';
import { memoryDrive, type MemoryDrive } from './memory-drive.js';

let tmp: string;
let local: string;
let mem: MemoryDrive;
let store: PairStore;
let audit: ReturnType<typeof createAudit>;
let sync: SyncService;

beforeEach(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), 'sync-svc-'));
  local = path.join(tmp, 'Local');
  await mkdir(local);
  mem = memoryDrive('ROOT');
  store = new PairStore({ dir: path.join(tmp, 'config', 'sync'), logger: silentLogger() });
  audit = createAudit();
  sync = new SyncService({
    runner: createRunner(mem.drive),
    audit,
    retry: noSleep,
    logger: silentLogger(),
    store,
    trash: refuseTrash,
    clock: () => new Date('2026-11-03T12:00:00.000Z'),
  });
});
afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

async function createDocs(): Promise<void> {
  await sync.createPair({ name: 'docs', localDir: local, remoteFolderId: 'ROOT' });
}

describe('createPair', () => {
  it('binds an existing Drive folder, writes the marker and probes case sensitivity', async () => {
    const summary = await sync.createPair({
      name: 'docs',
      localDir: local,
      remoteFolderId: 'ROOT',
    });
    const file = await store.load('docs');
    expect(summary).toMatchObject({
      name: 'docs',
      account: 'emco',
      remoteFolderId: 'ROOT',
      lastAppliedRunAt: null,
    });
    expect(summary.localDir).toBe(file.pair.localDir);
    expect((await readFile(path.join(local, markerName('docs')), 'utf8')).trim()).toBe(
      file.pair.id,
    );
    expect(file.pair.caseInsensitive).toBe(await probeCaseInsensitive(local, 'docs'));
    expect(file.pair.googleExport).toEqual({
      document: 'docx',
      spreadsheet: 'xlsx',
      presentation: 'pptx',
      drawing: 'pdf',
    });
    expect(file.pair.nativeBaselineDone).toBe(false);
  });

  it('creates a new Drive folder by name and audits it', async () => {
    mem.addFolder('P', 'Parent', 'my-drive');
    const summary = await sync.createPair({
      name: 'docs',
      localDir: local,
      remoteFolderName: 'Backup',
      remoteParentId: 'P',
    });
    const created = mem.files.get(summary.remoteFolderId);
    expect(created).toMatchObject({ name: 'Backup', parents: ['P'] });
    expect(audit.entries[0]).toMatchObject({ op: 'create_folder', fileId: summary.remoteFolderId });
  });

  it('validates the name, the remote arguments and the local folder', async () => {
    await expect(
      sync.createPair({ name: 'Bad Name', localDir: local, remoteFolderId: 'ROOT' }),
    ).rejects.toThrow('Invalid pair name');
    await expect(sync.createPair({ name: 'docs', localDir: local })).rejects.toThrow('exactly one');
    await expect(
      sync.createPair({
        name: 'docs',
        localDir: local,
        remoteFolderId: 'ROOT',
        remoteFolderName: 'x',
      }),
    ).rejects.toThrow('exactly one');
    await expect(
      sync.createPair({ name: 'docs', localDir: 'rel', remoteFolderId: 'ROOT' }),
    ).rejects.toThrow('absolute');
    await expect(
      sync.createPair({ name: 'docs', localDir: path.join(tmp, 'nope'), remoteFolderId: 'ROOT' }),
    ).rejects.toThrow('does not exist');
  });

  it('rejects a Drive file that is not a usable folder and removes the marker again', async () => {
    mem.addFile('F', 'a.pdf', 'ROOT', 'x');
    await expect(
      sync.createPair({ name: 'docs', localDir: local, remoteFolderId: 'F' }),
    ).rejects.toThrow('is not a folder');
    expect(await readdir(local)).toEqual([]);
    expect(await store.exists('docs')).toBe(false);
  });

  it('rejects overlapping pairs', async () => {
    await createDocs();
    await mkdir(path.join(local, 'sub'));
    mem.addFolder('R2', 'Other', 'my-drive');
    await expect(
      sync.createPair({ name: 'sub', localDir: path.join(local, 'sub'), remoteFolderId: 'R2' }),
    ).rejects.toThrow('overlaps');
    const other = path.join(tmp, 'Other');
    await mkdir(other);
    await expect(
      sync.createPair({ name: 'other', localDir: other, remoteFolderId: 'ROOT' }),
    ).rejects.toThrow('already used');
    await expect(
      sync.createPair({ name: 'docs', localDir: other, remoteFolderId: 'R2' }),
    ).rejects.toThrow('already exists');
  });
});

describe('listPairs / removePair / repairMarker', () => {
  it('lists pairs with counts', async () => {
    await createDocs();
    expect(await sync.listPairs()).toEqual([
      expect.objectContaining({
        name: 'docs',
        counts: { selected: 0, tracked: 0, remoteOnly: 0, excluded: 0, baseline: 0 },
      }),
    ]);
  });

  it('removes the pair and its marker but no files', async () => {
    await createDocs();
    await writeFile(path.join(local, 'keep.pdf'), 'x');
    await expect(sync.removePair({ name: 'docs' })).resolves.toMatchObject({
      name: 'docs',
      removed: true,
    });
    expect(await readdir(local)).toEqual(['keep.pdf']);
    expect(await store.exists('docs')).toBe(false);
    expect(mem.files.has('ROOT')).toBe(true);
  });

  it('rewrites the marker only after confirmation', async () => {
    await createDocs();
    await rm(path.join(local, markerName('docs')));
    const declined = await sync.repairMarker('docs', async () => false);
    expect(declined.repaired).toBe(false);
    expect(await readdir(local)).toEqual([]);
    const confirmed = await sync.repairMarker('docs', async (pair) =>
      pair.localDir.endsWith('Local'),
    );
    expect(confirmed.repaired).toBe(true);
    expect((await readFile(path.join(local, markerName('docs')), 'utf8')).trim()).toBe(
      (await store.load('docs')).pair.id,
    );
  });
});

describe('select', () => {
  beforeEach(async () => {
    await createDocs();
    await mkdir(path.join(local, 'sub'));
    await writeFile(path.join(local, 'sub', 'Report.pdf'), 'r');
    await writeFile(path.join(local, '.env'), 'secret');
    mem.addFile('n1', 'remote.pdf', 'ROOT', 'remote');
  });

  it('adds local and remote paths, canonicalised and deduped by foldKey', async () => {
    const res = await sync.select({
      name: 'docs',
      add: ['sub/report.pdf', 'sub/Report.pdf', 'remote.pdf'],
    });
    expect(res).toMatchObject({
      added: ['sub/Report.pdf', 'remote.pdf'],
      rejected: [],
      selected: 2,
    });
    expect((await store.load('docs')).pair.selection).toEqual(['sub/Report.pdf', 'remote.pdf']);
  });

  it('rejects ignored, missing and invalid paths', async () => {
    const res = await sync.select({
      name: 'docs',
      add: ['.env', 'missing.pdf', '../x', 'sub/.hidden'],
    });
    expect(res.added).toEqual([]);
    expect(res.rejected.map((r) => [r.path, r.reason])).toEqual([
      ['.env', 'dot-files and temp files are never synced'],
      ['missing.pdf', 'not found locally or in the Drive folder'],
      ['../x', '"../x" is not a clean relative path'],
      ['sub/.hidden', 'dot-files and temp files are never synced'],
    ]);
  });

  it('remove moves the key to excluded and drops the record; add takes it back', async () => {
    await sync.select({ name: 'docs', add: ['remote.pdf'] });
    const file = await store.load('docs');
    file.records.push({
      remoteId: 'n1',
      path: 'remote.pdf',
      localName: 'remote.pdf',
      remoteName: 'remote.pdf',
      remoteParentId: 'ROOT',
      localMd5: 'x',
      localSize: 1,
      localMtimeMs: 1,
      localCtimeMs: 1,
      remoteMd5: 'x',
      remoteSize: 1,
      remoteModifiedTime: 't',
      native: null,
      remoteOnly: false,
      restorePending: false,
      remoteTrashed: false,
    });
    await store.save(file);
    const removed = await sync.select({ name: 'docs', remove: ['remote.pdf'] });
    expect(removed).toMatchObject({
      removed: ['remote.pdf'],
      selected: 0,
      excluded: 1,
      tracked: 0,
    });
    expect(mem.files.get('n1')?.trashed).toBe(false);
    const again = await sync.select({ name: 'docs', add: ['remote.pdf'] });
    expect(again).toMatchObject({ added: ['remote.pdf'], excluded: 0 });
  });

  it('refuses while another writer holds the lock', async () => {
    const release = await store.lock('docs');
    await expect(sync.select({ name: 'docs', add: ['remote.pdf'] })).rejects.toThrow(
      ValidationError,
    );
    await release();
  });
});

describe('scan', () => {
  beforeEach(async () => {
    await createDocs();
    await mkdir(path.join(local, 'notes'));
    await writeFile(
      path.join(local, 'notes', 'ship.md'),
      '# Seafaring\nCargo manifest for the vessel',
    );
    await writeFile(path.join(local, 'manual.pdf'), Buffer.from([0x25, 0x50, 0x44, 0x46, 0]));
    await writeFile(path.join(local, 'picked.txt'), 'already chosen');
    mem.addFile('n1', 'drive-only.pdf', 'ROOT', 'x');
    await sync.select({ name: 'docs', add: ['picked.txt'] });
  });

  it('returns unselected local files with text previews and remote candidates', async () => {
    const res = await sync.scan({ name: 'docs', previewChars: 10 });
    expect(res.entries.map((e) => [e.path, e.mimeType, e.preview])).toEqual([
      ['manual.pdf', 'application/pdf', undefined],
      ['notes/ship.md', 'text/markdown', '# Seafarin'],
    ]);
    expect(res.remoteCandidates).toEqual([
      {
        path: 'drive-only.pdf',
        size: 1,
        modifiedTime: expect.any(String),
        mimeType: 'application/pdf',
      },
    ]);
    expect(res.truncated).toBe(false);
  });

  it('honours onlyUnselected, subdir and limit', async () => {
    const all = await sync.scan({ name: 'docs', onlyUnselected: false, previewChars: 0 });
    expect(all.entries.map((e) => e.path)).toEqual(['manual.pdf', 'notes/ship.md', 'picked.txt']);
    const sub = await sync.scan({ name: 'docs', subdir: 'notes' });
    expect(sub.entries.map((e) => e.path)).toEqual(['notes/ship.md']);
    expect(sub.remoteCandidates).toEqual([]);
    const limited = await sync.scan({ name: 'docs', limit: 1 });
    expect(limited.entries).toHaveLength(1);
    expect(limited.truncated).toBe(true);
  });
});
