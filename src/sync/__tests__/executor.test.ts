import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OperationRunner } from '../../core/operation.js';
import { QuotaExceededError } from '../../errors.js';
import {
  createAudit,
  createFakeDrive,
  createRunner,
  httpError,
  noSleep,
  silentLogger,
  type FakeDrive,
} from '../../files/__tests__/fakes.js';
import { Executor, conflictName } from '../executor.js';
import { foldKey } from '../paths.js';
import { buildReport } from '../report.js';
import type { DriveFile } from '../../drive/drive-adapter.js';
import { GOOGLE_MIME } from '../../files/export-formats.js';
import { SYNC_EXPORT_FIELDS } from '../exec-export.js';
import type { Action, LocalEntry, PairFile, Plan, RemoteEntry, SyncRecord } from '../types.js';
import type { LocalTrash } from '../trash.js';
import {
  ROOT_ID,
  dirTrash,
  makePairFile,
  nativeEntry,
  nativeRecord,
  record,
  remoteEntry,
} from './fixtures.js';

/** Set to make the next `syncDir` call throw (directory fsync failure). */
const fsyncFault = vi.hoisted(() => ({ error: null as Error | null }));
vi.mock('../transfer.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../transfer.js')>();
  return {
    ...real,
    syncDir: async (...args: Parameters<typeof real.syncDir>): Promise<void> => {
      const err = fsyncFault.error;
      if (err) {
        fsyncFault.error = null;
        throw err;
      }
      return real.syncDir(...args);
    },
  };
});

const NOW = new Date('2026-11-03T10:15:00');
const md5 = (s: string): string => createHash('md5').update(s).digest('hex');

let dir: string;
let trashDir: string;
let drive: FakeDrive;
let audit: ReturnType<typeof createAudit>;
let saves: PairFile[];

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'sync-exec-'));
  trashDir = await mkdtemp(path.join(os.tmpdir(), 'sync-trash-'));
  drive = createFakeDrive();
  audit = createAudit();
  saves = [];
  fsyncFault.error = null;
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
  await rm(trashDir, { recursive: true, force: true });
});

function executor(
  file: PairFile,
  folders = new Map([[ROOT_ID, '']]),
  save: (f: PairFile) => Promise<void> = async (f) => {
    saves.push(structuredClone(f));
  },
  trash: LocalTrash = dirTrash(trashDir),
): Executor {
  const ops = new OperationRunner({
    runner: createRunner(drive),
    audit,
    retry: noSleep,
    logger: silentLogger(),
  });
  return new Executor(
    {
      ops,
      audit,
      logger: silentLogger(),
      clock: () => NOW,
      save,
      trash,
    },
    file,
    folders,
  );
}

function pairFile(
  records: SyncRecord[] = [],
  selection: string[] = records.map((r) => r.path),
): PairFile {
  return makePairFile({ localDir: dir, selection }, records);
}

async function put(name: string, content: string): Promise<LocalEntry> {
  const abs = path.join(dir, ...name.split('/'));
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, content);
  const s = await lstat(abs);
  return {
    key: name,
    foldKey: foldKey(name),
    name,
    size: s.size,
    mtimeMs: s.mtimeMs,
    ctimeMs: s.ctimeMs,
    ino: s.ino,
  };
}

function remote(
  id: string,
  key: string,
  content: string,
  extra: Partial<RemoteEntry> = {},
): RemoteEntry {
  return remoteEntry(id, key, { md5: md5(content), size: content.length, ...extra });
}

function action(kind: Action['kind'], key: string, fields: Partial<Action> = {}): Action {
  return {
    kind,
    rule: 'test',
    key,
    record: null,
    local: null,
    localMd5: null,
    remote: null,
    selection: {},
    ...fields,
  };
}

function serve(content: string): void {
  drive.downloadMedia.mockImplementation(async () => Readable.from([Buffer.from(content)]));
}

describe('Executor', () => {
  it('applies a refresh patch to the record and its selection change (O4)', async () => {
    const k = record('r1', 'a.pdf', { remoteOnly: true });
    const file = pairFile([k]);
    await executor(file).run([
      action('refresh', 'sub/a.pdf', {
        record: k,
        patch: { path: 'sub/a.pdf', localName: 'sub/a.pdf' },
        selection: { remove: ['a.pdf'], add: ['sub/a.pdf'] },
      }),
    ]);
    expect(saves.at(-1)?.records).toMatchObject([{ path: 'sub/a.pdf', remoteOnly: true }]);
    expect(saves.at(-1)?.pair.selection).toEqual(['sub/a.pdf']);
  });

  it('runs stages in spec order regardless of plan order', async () => {
    const a = await put('a.pdf', 'A');
    const r = remote('r2', 'b.pdf', 'B');
    const k1 = record('r1', 'a.pdf', { localMd5: md5('A') });
    drive.getFile.mockResolvedValueOnce({
      id: 'r2',
      md5Checksum: md5('B'),
      modifiedTime: r.modifiedTime,
      parents: [ROOT_ID],
    });
    drive.updateFile.mockResolvedValueOnce({ id: 'r2', trashed: true });
    const out = await executor(pairFile([k1, record('r2', 'b.pdf')])).run([
      action('trash-local', 'a.pdf', { record: k1, local: a, localMd5: md5('A') }),
      action('trash-remote', 'b.pdf', { record: record('r2', 'b.pdf'), remote: r }),
      action('forget', 'c.pdf', { record: record('r3', 'c.pdf') }),
    ]);
    expect(out.map((o) => [o.kind, o.status])).toEqual([
      ['forget', 'done'],
      ['trash-remote', 'done'],
      ['trash-local', 'done'],
    ]);
    expect(await readdir(trashDir)).toEqual(['a.pdf']);
    expect(audit.entries.map((e) => e.op)).toEqual(['sync_trash_remote', 'sync_trash_local']);
    expect(saves.at(-1)?.records).toEqual([]);
  });

  it('uploads a new file into a created sub-folder and records it (U1)', async () => {
    const l = await put('sub/a.pdf', 'hello');
    drive.listFiles.mockResolvedValueOnce({ files: [] });
    drive.createFile.mockResolvedValueOnce({ id: 'F-sub', name: 'sub' }).mockResolvedValueOnce({
      id: 'n1',
      name: 'a.pdf',
      parents: ['F-sub'],
      md5Checksum: md5('hello'),
      size: '5',
      modifiedTime: 't',
    });
    const file = pairFile([], ['sub/a.pdf']);
    const out = await executor(file).run([
      action('upload-new', 'sub/a.pdf', { local: l, localMd5: md5('hello') }),
    ]);
    expect(out[0]).toEqual({ kind: 'upload-new', path: 'sub/a.pdf', status: 'done' });
    expect(drive.createFile.mock.calls[0]?.[0].requestBody).toEqual({
      name: 'sub',
      mimeType: 'application/vnd.google-apps.folder',
      parents: [ROOT_ID],
    });
    expect(drive.createFile.mock.calls[1]?.[0].requestBody).toEqual({
      name: 'a.pdf',
      parents: ['F-sub'],
    });
    expect(file.records[0]).toMatchObject({
      remoteId: 'n1',
      path: 'sub/a.pdf',
      localMd5: md5('hello'),
      remoteParentId: 'F-sub',
    });
    expect(audit.entries.map((e) => [e.op, e.account, e.details])).toEqual([
      ['create_folder', 'emco', { pair: 'docs', parentId: ROOT_ID }],
      ['sync_upload', 'emco', { pair: 'docs', path: 'sub/a.pdf', remoteId: 'n1' }],
    ]);
  });

  it('warns changed-during-upload when Drive reports a different md5', async () => {
    const l = await put('a.pdf', 'hello');
    drive.createFile.mockResolvedValueOnce({ id: 'n1', name: 'a.pdf', md5Checksum: 'other' });
    const file = pairFile([], ['a.pdf']);
    const out = await executor(file).run([
      action('upload-new', 'a.pdf', { local: l, localMd5: md5('hello') }),
    ]);
    expect(out[0]?.warning).toBe('changed-during-upload');
    expect(file.records[0]).toMatchObject({
      localMd5: 'other',
      remoteMd5: 'other',
      localSize: l.size,
    });
  });

  it('adopts its own upload after an ambiguous upload error (duplicate-safe)', async () => {
    const l = await put('a.pdf', 'hello');
    drive.createFile.mockRejectedValueOnce(httpError(500));
    drive.listFiles.mockResolvedValueOnce({
      files: [
        {
          id: 'n1',
          name: 'a.pdf',
          md5Checksum: md5('hello'),
          createdTime: new Date(NOW.getTime() - 60_000).toISOString(),
          parents: [ROOT_ID],
        },
      ],
    });
    const file = pairFile([], ['a.pdf']);
    const out = await executor(file).run([
      action('upload-new', 'a.pdf', { local: l, localMd5: md5('hello') }),
    ]);
    expect(out[0]?.status).toBe('done');
    expect(file.records[0]?.remoteId).toBe('n1');
  });

  it('skips update-remote when Drive changed since planning (no If-Match in Drive)', async () => {
    const l = await put('a.pdf', 'local edit');
    const r = remote('r1', 'a.pdf', 'R');
    drive.getFile.mockResolvedValueOnce({ id: 'r1', md5Checksum: 'newer', modifiedTime: 'later' });
    const out = await executor(pairFile([record('r1', 'a.pdf')])).run([
      action('update-remote', 'a.pdf', {
        record: record('r1', 'a.pdf'),
        local: l,
        localMd5: md5('local edit'),
        remote: r,
      }),
    ]);
    expect(out[0]?.status).toBe('skipped');
    expect(drive.updateFile).not.toHaveBeenCalled();
  });

  it('updates the Drive file in place (B2)', async () => {
    const l = await put('a.pdf', 'local edit');
    const r = remote('r1', 'a.pdf', 'R');
    drive.getFile.mockResolvedValueOnce({
      id: 'r1',
      md5Checksum: r.md5,
      modifiedTime: r.modifiedTime,
    });
    drive.updateFile.mockResolvedValueOnce({
      id: 'r1',
      name: 'a.pdf',
      md5Checksum: md5('local edit'),
      modifiedTime: 'new',
    });
    const file = pairFile([record('r1', 'a.pdf')]);
    await executor(file).run([
      action('update-remote', 'a.pdf', {
        record: record('r1', 'a.pdf'),
        local: l,
        localMd5: md5('local edit'),
        remote: r,
      }),
    ]);
    expect(drive.updateFile.mock.calls[0]?.[0]).toMatchObject({ fileId: 'r1' });
    expect(file.records[0]).toMatchObject({
      localMd5: md5('local edit'),
      remoteMd5: md5('local edit'),
      remoteModifiedTime: 'new',
    });
  });

  it('downloads new files exclusively and reports collisions', async () => {
    serve('R');
    const file = pairFile();
    const r = remote('n1', 'in/new.pdf', 'R');
    await put('taken.pdf', 'mine');
    const out = await executor(file).run([
      action('download-new', 'in/new.pdf', { remote: r, selection: { add: ['in/new.pdf'] } }),
      action('download-new', 'taken.pdf', {
        remote: remote('n2', 'taken.pdf', 'R'),
        selection: { add: ['taken.pdf'] },
      }),
    ]);
    expect(out.map((o) => o.status)).toEqual(['done', 'collision']);
    expect(await readFile(path.join(dir, 'in', 'new.pdf'), 'utf8')).toBe('R');
    expect(await readFile(path.join(dir, 'taken.pdf'), 'utf8')).toBe('mine');
    expect(file.pair.selection).toEqual(['in/new.pdf']);
    expect(file.records.map((r2) => r2.remoteId)).toEqual(['n1']);
  });

  it('skips download-replace when the local file changed after the scan', async () => {
    const l = await put('a.pdf', 'old');
    await writeFile(path.join(dir, 'a.pdf'), 'edited after scan');
    serve('R');
    const out = await executor(pairFile([record('r1', 'a.pdf')])).run([
      action('download-replace', 'a.pdf', {
        record: record('r1', 'a.pdf'),
        local: l,
        remote: remote('r1', 'a.pdf', 'R'),
      }),
    ]);
    expect(out[0]?.status).toBe('skipped');
    expect(await readFile(path.join(dir, 'a.pdf'), 'utf8')).toBe('edited after scan');
  });

  it('moves a file to its new key, then downloads the newer content (B7)', async () => {
    const l = await put('a.pdf', 'old');
    serve('new');
    const k = record('r1', 'a.pdf', { localMd5: md5('old') });
    const file = pairFile([k]);
    const r = remote('r1', 'sub/b.pdf', 'new', { parentId: 'F', name: 'b.pdf' });
    await executor(file).run([
      action('move-local', 'sub/b.pdf', {
        record: k,
        local: l,
        localMd5: md5('old'),
        remote: r,
        thenDownload: true,
        selection: { remove: ['a.pdf'], add: ['sub/b.pdf'] },
      }),
    ]);
    expect(await readdir(dir)).toEqual(['sub']);
    expect(await readFile(path.join(dir, 'sub', 'b.pdf'), 'utf8')).toBe('new');
    expect(file.pair.selection).toEqual(['sub/b.pdf']);
    expect(file.records[0]).toMatchObject({
      path: 'sub/b.pdf',
      localMd5: md5('new'),
      remoteMd5: md5('new'),
      remoteParentId: 'F',
    });
    expect(saves).toHaveLength(2);
    expect(saves[0]?.records[0]).toMatchObject({ path: 'sub/b.pdf', remoteMd5: k.remoteMd5 });
  });

  it('places the conflict copy before uploading L (spec §6.9)', async () => {
    const l = await put('a.pdf', 'local edit');
    const r = remote('r1', 'a.pdf', 'remote edit');
    serve('remote edit');
    drive.getFile.mockResolvedValueOnce({
      id: 'r1',
      md5Checksum: r.md5,
      modifiedTime: r.modifiedTime,
    });
    drive.updateFile.mockResolvedValueOnce({
      id: 'r1',
      name: 'a.pdf',
      md5Checksum: md5('local edit'),
      modifiedTime: 'new',
    });
    const file = pairFile([record('r1', 'a.pdf')]);
    const out = await executor(file).run([
      action('conflict', 'a.pdf', {
        record: record('r1', 'a.pdf'),
        local: l,
        localMd5: md5('local edit'),
        remote: r,
        updateRemote: true,
      }),
    ]);
    const copy = conflictName('a.pdf', NOW, 0);
    expect(copy).toBe('a (Drive conflict 2026-11-03 10.15).pdf');
    expect(out[0]).toMatchObject({ status: 'done', conflictCopy: copy });
    expect(await readFile(path.join(dir, copy), 'utf8')).toBe('remote edit');
    expect(drive.downloadMedia.mock.invocationCallOrder[0]).toBeLessThan(
      drive.updateFile.mock.invocationCallOrder[0] ?? 0,
    );
    expect(file.records[0]).toMatchObject({
      localMd5: md5('local edit'),
      remoteMd5: md5('local edit'),
    });
    expect(file.pair.selection).toEqual(['a.pdf']);
  });

  it('numbers conflict copies and skips the upload when the copy fails', async () => {
    expect(conflictName('a.pdf', NOW, 1)).toBe('a (Drive conflict 2026-11-03 10.15) 2.pdf');
    expect(conflictName('README', NOW, 0)).toBe('README (Drive conflict 2026-11-03 10.15)');
    const l = await put('a.pdf', 'local edit');
    serve('something else');
    const out = await executor(pairFile([record('r1', 'a.pdf')])).run([
      action('conflict', 'a.pdf', {
        record: record('r1', 'a.pdf'),
        local: l,
        localMd5: md5('local edit'),
        remote: remote('r1', 'a.pdf', 'remote edit'),
        updateRemote: true,
      }),
    ]);
    expect(out[0]?.status).toBe('failed');
    expect(drive.updateFile).not.toHaveBeenCalled();
    expect(await readdir(dir)).toEqual(['a.pdf']);
  });

  it('skips trash-remote when Drive changed and trash-local when L changed', async () => {
    const l = await put('a.pdf', 'edited');
    drive.getFile.mockResolvedValueOnce({ id: 'r2', md5Checksum: 'newer', modifiedTime: 'later' });
    const out = await executor(pairFile([record('r1', 'a.pdf'), record('r2', 'b.pdf')])).run([
      action('trash-local', 'a.pdf', {
        record: record('r1', 'a.pdf'),
        local: l,
        localMd5: md5('original'),
      }),
      action('trash-remote', 'b.pdf', {
        record: record('r2', 'b.pdf'),
        remote: remote('r2', 'b.pdf', 'B'),
      }),
    ]);
    expect(out.map((o) => o.status)).toEqual(['skipped', 'skipped']);
    expect(await readdir(trashDir)).toEqual([]);
    expect(saves).toEqual([]);
  });

  it('reports trash-local as skipped when the file vanished during the move', async () => {
    const l = await put('a.pdf', 'A');
    const vanished: LocalTrash = {
      trash: async () => {
        throw Object.assign(new Error('gone'), { code: 'ENOENT' });
      },
    };
    const out = await executor(
      pairFile([record('r1', 'a.pdf')]),
      undefined,
      undefined,
      vanished,
    ).run([
      action('trash-local', 'a.pdf', {
        record: record('r1', 'a.pdf'),
        local: l,
        localMd5: md5('A'),
      }),
    ]);
    expect(out[0]).toMatchObject({ status: 'skipped', message: 'a.pdf is already gone' });
    expect(saves).toEqual([]);
  });

  it('isolates failures and aborts on run-ending errors', async () => {
    const a = await put('a.pdf', 'A');
    const b = await put('b.pdf', 'B');
    drive.createFile.mockRejectedValueOnce(httpError(400, 'badRequest'));
    drive.listFiles.mockResolvedValueOnce({ files: [] });
    drive.createFile.mockRejectedValueOnce(httpError(403, 'storageQuotaExceeded'));
    const out = await executor(pairFile([], ['a.pdf', 'b.pdf'])).run([
      action('upload-new', 'a.pdf', { local: a, localMd5: md5('A') }),
      action('upload-new', 'b.pdf', { local: b, localMd5: md5('B') }),
      action('download-new', 'c.pdf', { remote: remote('n3', 'c.pdf', 'C') }),
    ]);
    expect(out.map((o) => [o.path, o.status])).toEqual([
      ['a.pdf', 'failed'],
      ['b.pdf', 'failed'],
      ['c.pdf', 'not-run'],
    ]);
    expect(out[1]?.message).toBe(new QuotaExceededError('emco').message);
  });

  it('aborts the run when the pair file cannot be saved', async () => {
    serve('R');
    const failing = async (): Promise<void> => {
      throw new Error('ENOSPC');
    };
    const out = await executor(pairFile(), new Map([[ROOT_ID, '']]), failing).run([
      action('download-new', 'a.pdf', {
        remote: remote('n1', 'a.pdf', 'R'),
        selection: { add: ['a.pdf'] },
      }),
      action('download-new', 'b.pdf', { remote: remote('n2', 'b.pdf', 'R') }),
      action('trash-remote', 'c.pdf', {
        record: record('r3', 'c.pdf'),
        remote: remote('r3', 'c.pdf', 'C'),
      }),
    ]);
    expect(out.map((o) => [o.path, o.status])).toEqual([
      ['a.pdf', 'failed'],
      ['b.pdf', 'not-run'],
      ['c.pdf', 'not-run'],
    ]);
    expect(drive.downloadMedia).toHaveBeenCalledTimes(1);
    expect(drive.updateFile).not.toHaveBeenCalled();
  });

  it('reports all actions as not-run when the folder pre-pass hits a run-ending error', async () => {
    const a = await put('sub/a.pdf', 'A');
    drive.listFiles.mockRejectedValue(httpError(403, 'storageQuotaExceeded'));
    const out = await executor(pairFile([], ['sub/a.pdf'])).run([
      action('upload-new', 'sub/a.pdf', { local: a, localMd5: md5('A') }),
      action('download-new', 'c.pdf', { remote: remote('n3', 'c.pdf', 'C') }),
    ]);
    expect(out.map((o) => [o.path, o.status])).toEqual([
      ['sub/a.pdf', 'not-run'],
      ['c.pdf', 'not-run'],
    ]);
    expect(drive.createFile).not.toHaveBeenCalled();
  });

  it('persists after every success, so a crash keeps completed work', async () => {
    serve('R');
    const file = pairFile();
    await executor(file).run([
      action('download-new', 'a.pdf', {
        remote: remote('n1', 'a.pdf', 'R'),
        selection: { add: ['a.pdf'] },
      }),
      action('download-new', 'b.pdf', {
        remote: remote('n2', 'b.pdf', 'R'),
        selection: { add: ['b.pdf'] },
      }),
    ]);
    expect(saves.map((s) => s.records.map((r) => r.remoteId))).toEqual([['n1'], ['n1', 'n2']]);
    expect(saves[0]?.pair.selection).toEqual(['a.pdf']);
  });

  it('applies untrack selection changes (key → excluded)', async () => {
    const k = record('r1', 'a.pdf');
    const file = pairFile([k]);
    await executor(file).run([
      action('untrack', 'a.pdf', {
        record: k,
        selection: { remove: ['a.pdf'], exclude: ['a.pdf'] },
      }),
    ]);
    expect(file.records).toEqual([]);
    expect(file.pair.selection).toEqual([]);
    expect(file.pair.excluded).toEqual(['a.pdf']);
  });
});

describe('Executor (review regressions)', () => {
  it('re-verification needs md5 and modifiedTime unchanged (remoteUnchangedSince)', async () => {
    const a = await put('a.pdf', 'L2');
    const r = remote('r1', 'a.pdf', 'R1');
    const k = record('r1', 'a.pdf');
    drive.getFile.mockResolvedValueOnce({
      id: 'r1',
      md5Checksum: r.md5,
      modifiedTime: '2026-11-03T09:00:00.000Z',
      parents: [ROOT_ID],
    });
    const out = await executor(pairFile([k])).run([
      action('update-remote', 'a.pdf', { record: k, local: a, localMd5: md5('L2'), remote: r }),
    ]);
    expect(out[0]).toMatchObject({ status: 'skipped' });
    expect(drive.updateFile).not.toHaveBeenCalled();
  });

  it('skips trash-remote when the local file is back or the Drive file moved', async () => {
    await put('back.pdf', 'restored from Trash');
    const r = remote('r2', 'moved.pdf', 'M');
    drive.getFile.mockResolvedValueOnce({
      id: 'r2',
      md5Checksum: r.md5,
      modifiedTime: r.modifiedTime,
      parents: ['ELSEWHERE'],
    });
    const out = await executor(pairFile([record('r1', 'back.pdf'), record('r2', 'moved.pdf')])).run(
      [
        action('trash-remote', 'back.pdf', {
          record: record('r1', 'back.pdf'),
          remote: remote('r1', 'back.pdf', 'B'),
        }),
        action('trash-remote', 'moved.pdf', { record: record('r2', 'moved.pdf'), remote: r }),
      ],
    );
    expect(out.map((o) => o.status)).toEqual(['skipped', 'skipped']);
    expect(drive.updateFile).not.toHaveBeenCalled();
  });

  it('pages through the parent folder listing when ensuring a folder', async () => {
    const l = await put('sub/a.pdf', 'hello');
    drive.listFiles
      .mockResolvedValueOnce({ files: [{ id: 'X', name: 'other' }], nextPageToken: 'p2' })
      .mockResolvedValueOnce({ files: [{ id: 'F-sub', name: 'sub' }] });
    drive.createFile.mockResolvedValueOnce({
      id: 'n1',
      name: 'a.pdf',
      parents: ['F-sub'],
      md5Checksum: md5('hello'),
    });
    await executor(pairFile([], ['sub/a.pdf'])).run([
      action('upload-new', 'sub/a.pdf', { local: l, localMd5: md5('hello') }),
    ]);
    expect(drive.listFiles.mock.calls[1]?.[0].pageToken).toBe('p2');
    expect(drive.createFile).toHaveBeenCalledTimes(1);
    expect(drive.createFile.mock.calls[0]?.[0].requestBody).toEqual({
      name: 'a.pdf',
      parents: ['F-sub'],
    });
  });

  it('reuses a Drive folder whose name differs only in case (case-insensitive volume)', async () => {
    const l = await put('docs/a.pdf', 'hello');
    drive.listFiles.mockResolvedValueOnce({ files: [{ id: 'F-Docs', name: 'Docs' }] });
    drive.createFile.mockResolvedValueOnce({
      id: 'n1',
      name: 'a.pdf',
      parents: ['F-Docs'],
      md5Checksum: md5('hello'),
    });
    await executor(pairFile([], ['docs/a.pdf'])).run([
      action('upload-new', 'docs/a.pdf', { local: l, localMd5: md5('hello') }),
    ]);
    expect(drive.createFile).toHaveBeenCalledTimes(1);
    expect(drive.createFile.mock.calls[0]?.[0].requestBody).toEqual({
      name: 'a.pdf',
      parents: ['F-Docs'],
    });
  });
});

describe('Executor exports (Google-native)', () => {
  const NEWER = '2026-11-04T00:00:00.000Z';
  const DOC = nativeEntry('g1', 'Plan.docx');

  function current(r: RemoteEntry, extra: DriveFile = {}): DriveFile {
    return {
      id: r.id,
      name: r.name,
      mimeType: r.mimeType,
      modifiedTime: r.modifiedTime,
      parents: [r.parentId],
      trashed: false,
      webViewLink: `https://docs/${r.id}`,
      exportLinks: { [r.native?.exportMime ?? '']: `https://export/${r.id}` },
      ...extra,
    };
  }
  function exportServes(content: string): void {
    drive.exportMedia.mockImplementation(async () => Readable.from([Buffer.from(content)]));
  }
  it('export-new re-reads the file, writes the export and records a native record', async () => {
    drive.getFile.mockResolvedValueOnce(current(DOC));
    exportServes('DOCX v1');
    const out = await executor(pairFile([], ['Plan.docx'])).run([
      action('export-new', 'Plan.docx', { remote: DOC }),
    ]);
    expect(out).toEqual([{ kind: 'export-new', path: 'Plan.docx', status: 'done' }]);
    expect(drive.getFile).toHaveBeenCalledWith('g1', SYNC_EXPORT_FIELDS);
    expect(drive.exportMedia).toHaveBeenCalledWith('g1', DOC.native?.exportMime);
    expect(await readFile(path.join(dir, 'Plan.docx'), 'utf8')).toBe('DOCX v1');
    expect(saves.at(-1)?.records).toMatchObject([
      {
        remoteId: 'g1',
        path: 'Plan.docx',
        remoteName: 'Plan',
        localMd5: md5('DOCX v1'),
        remoteMd5: null,
        native: { mimeType: GOOGLE_MIME.document, exportFormat: 'docx' },
      },
    ]);
    expect(audit.entries.map((e) => e.op)).toEqual(['sync_download']);
  });
  it('skips an export when the re-read shows a change or the trash', async () => {
    const other = nativeEntry('g2', 'Other.docx');
    drive.getFile.mockResolvedValueOnce(current(DOC, { modifiedTime: NEWER }));
    drive.getFile.mockResolvedValueOnce(current(other, { trashed: true }));
    const out = await executor(pairFile([], ['Plan.docx', 'Other.docx'])).run([
      action('export-new', 'Plan.docx', { remote: DOC }),
      action('export-new', 'Other.docx', { remote: other }),
    ]);
    expect(out.map((o) => o.status)).toEqual(['skipped', 'skipped']);
    expect(drive.exportMedia).not.toHaveBeenCalled();
    expect(await readdir(dir)).toEqual([]);
  });
  it('export-replace overwrites the tracked export while it is unchanged', async () => {
    const l = await put('Plan.docx', 'DOCX v1');
    const k = nativeRecord('g1', 'Plan.docx', { localMd5: md5('DOCX v1') });
    const r = nativeEntry('g1', 'Plan.docx', { modifiedTime: NEWER });
    drive.getFile.mockResolvedValueOnce(current(r));
    exportServes('DOCX v2');
    const out = await executor(pairFile([k])).run([
      action('export-replace', 'Plan.docx', {
        record: k,
        local: l,
        localMd5: k.localMd5,
        remote: r,
      }),
    ]);
    expect(out[0]?.status).toBe('done');
    expect(await readFile(path.join(dir, 'Plan.docx'), 'utf8')).toBe('DOCX v2');
    expect(saves.at(-1)?.records[0]).toMatchObject({
      localMd5: md5('DOCX v2'),
      remoteModifiedTime: NEWER,
    });
  });
  it('N5 moves the local edit aside after the re-read, then exports', async () => {
    const l = await put('Plan.docx', 'my edit');
    const k = nativeRecord('g1', 'Plan.docx');
    const r = nativeEntry('g1', 'Plan.docx', { modifiedTime: NEWER });
    drive.getFile.mockResolvedValueOnce(current(r));
    exportServes('DOCX v2');
    const out = await executor(pairFile([k])).run([
      action('export-new', 'Plan.docx', {
        record: k,
        local: l,
        localMd5: md5('my edit'),
        remote: r,
        localEdit: true,
      }),
    ]);
    const kept = 'Plan (local edit 2026-11-03 10.15).docx';
    expect(out[0]).toMatchObject({
      status: 'done',
      conflictCopy: kept,
      warning: 'native-local-edit-kept',
    });
    expect(await readFile(path.join(dir, kept), 'utf8')).toBe('my edit');
    expect(await readFile(path.join(dir, 'Plan.docx'), 'utf8')).toBe('DOCX v2');
  });
  it('N5 leaves the local edit where it is when the re-read shows a change', async () => {
    const l = await put('Plan.docx', 'my edit');
    const k = nativeRecord('g1', 'Plan.docx');
    const r = nativeEntry('g1', 'Plan.docx', { modifiedTime: NEWER });
    drive.getFile.mockResolvedValueOnce(current(r, { modifiedTime: '2026-11-05T00:00:00.000Z' }));
    const out = await executor(pairFile([k])).run([
      action('export-new', 'Plan.docx', { record: k, local: l, remote: r, localEdit: true }),
    ]);
    expect(out[0]?.status).toBe('skipped');
    expect(await readdir(dir)).toEqual(['Plan.docx']);
    expect(await readFile(path.join(dir, 'Plan.docx'), 'utf8')).toBe('my edit');
  });
  it('N5 does not move the local edit when the export cannot be opened (too large)', async () => {
    const l = await put('Plan.docx', 'my edit');
    const k = nativeRecord('g1', 'Plan.docx');
    const r = nativeEntry('g1', 'Plan.docx', { modifiedTime: NEWER });
    drive.getFile.mockResolvedValueOnce(current(r));
    drive.exportMedia.mockRejectedValueOnce(httpError(403, 'exportSizeLimitExceeded'));
    drive.fetchExportLink.mockRejectedValueOnce(httpError(403));
    const out = await executor(pairFile([k])).run([
      action('export-new', 'Plan.docx', { record: k, local: l, remote: r, localEdit: true }),
    ]);
    expect(out[0]).toMatchObject({ status: 'skipped', warning: 'native-too-large' });
    expect(out[0]?.conflictCopy).toBeUndefined();
    expect(await readdir(dir)).toEqual(['Plan.docx']);
    expect(await readFile(path.join(dir, 'Plan.docx'), 'utf8')).toBe('my edit');
  });
  it('N5 reports the kept name when the export breaks after the edit was moved', async () => {
    const l = await put('Plan.docx', 'my edit');
    const k = nativeRecord('g1', 'Plan.docx');
    const r = nativeEntry('g1', 'Plan.docx', { modifiedTime: NEWER });
    drive.getFile.mockResolvedValueOnce(current(r));
    const broken = new Readable({
      read() {
        this.destroy(new Error('connection reset'));
      },
    });
    drive.exportMedia.mockResolvedValueOnce(broken);
    const out = await executor(pairFile([k])).run([
      action('export-new', 'Plan.docx', { record: k, local: l, remote: r, localEdit: true }),
    ]);
    const kept = 'Plan (local edit 2026-11-03 10.15).docx';
    expect(out[0]).toMatchObject({ status: 'failed', conflictCopy: kept });
    expect(await readFile(path.join(dir, kept), 'utf8')).toBe('my edit');
    expect(saves).toEqual([]);
  });
  it('N5 reports the kept name when syncing the directory fails after the move', async () => {
    const l = await put('Plan.docx', 'my edit');
    const k = nativeRecord('g1', 'Plan.docx');
    const r = nativeEntry('g1', 'Plan.docx', { modifiedTime: NEWER });
    drive.getFile.mockResolvedValueOnce(current(r));
    exportServes('DOCX v2');
    fsyncFault.error = Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
    const out = await executor(pairFile([k])).run([
      action('export-new', 'Plan.docx', { record: k, local: l, remote: r, localEdit: true }),
    ]);
    const kept = 'Plan (local edit 2026-11-03 10.15).docx';
    expect(out[0]).toMatchObject({ status: 'failed', conflictCopy: kept });
    expect(out[0]?.message).toContain('EACCES');
    const plan: Plan = {
      planId: 'p1',
      actions: [],
      notes: [],
      candidates: { local: [], remote: [], truncated: false },
      brake: { tripped: false, trashRemote: 0, trashLocal: 0, tracked: 1 },
      baseline: { files: [], folders: [] },
      nativeBaseline: [],
      inSync: [],
    };
    expect(buildReport('docs', plan, { dryRun: false, outcomes: out }).warnings).toContainEqual({
      path: 'Plan.docx',
      code: 'native-local-edit-kept',
      message: `your local edit is kept as ${kept}`,
    });
    expect(await readFile(path.join(dir, kept), 'utf8')).toBe('my edit');
    expect(saves).toEqual([]);
  });
  it('reports native-too-large and keeps the record when both export paths fail', async () => {
    drive.getFile.mockResolvedValueOnce(current(DOC));
    drive.exportMedia.mockRejectedValueOnce(httpError(403, 'exportSizeLimitExceeded'));
    drive.fetchExportLink.mockRejectedValueOnce(httpError(403));
    const out = await executor(pairFile([], ['Plan.docx'])).run([
      action('export-new', 'Plan.docx', { remote: DOC }),
    ]);
    expect(out[0]).toMatchObject({ status: 'skipped', warning: 'native-too-large' });
    expect(out[0]?.message).toContain('https://docs/g1');
    expect(saves).toEqual([]);
  });
  it('move-local of a native record exports the newer content after the move (N6)', async () => {
    const l = await put('Plan.docx', 'DOCX v1');
    const k = nativeRecord('g1', 'Plan.docx', { localMd5: md5('DOCX v1') });
    const r = nativeEntry('g1', 'sub/Plan.docx', { modifiedTime: NEWER });
    drive.getFile.mockResolvedValueOnce(current(r));
    exportServes('DOCX v2');
    const out = await executor(pairFile([k])).run([
      action('move-local', 'sub/Plan.docx', {
        record: k,
        local: l,
        localMd5: k.localMd5,
        remote: r,
        thenDownload: true,
        selection: { remove: ['Plan.docx'], add: ['sub/Plan.docx'] },
      }),
    ]);
    expect(out[0]?.status).toBe('done');
    expect(await readFile(path.join(dir, 'sub', 'Plan.docx'), 'utf8')).toBe('DOCX v2');
    expect(drive.downloadMedia).not.toHaveBeenCalled();
    expect(saves.at(-1)?.records[0]).toMatchObject({
      path: 'sub/Plan.docx',
      native: { exportFormat: 'docx' },
    });
  });
});
