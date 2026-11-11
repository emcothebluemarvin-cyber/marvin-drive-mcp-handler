import { mkdtemp, rm, writeFile, lstat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  FileLockedError,
  NameConflictError,
  OneDriveFullError,
  ReauthRequiredError,
} from '../../errors.js';
import { createAudit, silentLogger } from '../../files/__tests__/fakes.js';
import { Executor } from '../executor.js';
import { foldKey } from '../paths.js';
import { quickXor } from '../remote/quickxor.js';
import type { SyncRemote } from '../remote/sync-remote.js';
import type { Action, LocalEntry, PairFile } from '../types.js';
import { dirTrash, makePairFile, record, remoteEntry } from './fixtures.js';
import { memoryOneDrive, type MemoryOneDrive } from './memory-onedrive.js';

let dir: string;
let od: MemoryOneDrive;

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'exec-od-'));
  od = memoryOneDrive();
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function executor(
  file: PairFile,
  remote: SyncRemote = od.remote(),
  evidence?: ReadonlySet<string>,
): Executor {
  return new Executor(
    {
      remote,
      audit: createAudit(),
      logger: silentLogger(),
      clock: () => new Date('2026-11-12T10:00:00Z'),
      save: async () => undefined,
      trash: dirTrash(dir),
      ...(evidence ? { evidence } : {}),
    },
    file,
    new Map([[od.rootId, '']]),
  );
}

async function put(name: string, content: string): Promise<LocalEntry> {
  const abs = path.join(dir, name);
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

const upload = (l: LocalEntry): Action => ({
  kind: 'upload-new',
  rule: 'U1',
  key: l.key,
  record: null,
  local: l,
  localMd5: 'md5',
  localDigests: { md5: 'md5', remote: { kind: 'quickXor', value: 'qx' } },
  remote: null,
  selection: {},
});

/** The OneDrive remote with `uploadNew` failing with `err`. */
function failingUploads(err: Error): SyncRemote {
  const remote = od.remote();
  remote.uploadNew = async () => {
    throw err;
  };
  return remote;
}

describe('Executor outcome mapping (OneDrive sync spec §5)', () => {
  it('NameConflictError and FileLockedError skip with the provider message', async () => {
    const a = await put('a.txt', 'a');
    const file = makePairFile({ localDir: dir, remoteFolderId: od.rootId });
    const conflict = await executor(file, failingUploads(new NameConflictError('a.txt'))).run([
      upload(a),
    ]);
    expect(conflict).toEqual([
      {
        kind: 'upload-new',
        path: 'a.txt',
        status: 'skipped',
        message: 'a file with this name appeared on OneDrive',
      },
    ]);
    const locked = await executor(file, failingUploads(new FileLockedError('a.txt'))).run([
      upload(a),
    ]);
    expect(locked[0]).toMatchObject({
      status: 'skipped',
      message: 'open in an Office app on OneDrive; try again later',
    });
  });

  it('a 409 on upload adopts our own earlier upload when it matches (findDuplicateUpload)', async () => {
    const a = await put('a.txt', 'same');
    const existing = od.addFile(od.rootId, 'a.txt', 'same');
    const file = makePairFile({ localDir: dir, remoteFolderId: od.rootId });
    const action = {
      ...upload(a),
      localDigests: {
        md5: 'md5',
        remote: { kind: 'quickXor' as const, value: quickXor(Buffer.from('same')) },
      },
    };
    // The memory drive stamps createdTime 2026-11-01; the duplicate window is 10 minutes.
    const remote = od.remote();
    const find = remote.findChildren.bind(remote);
    remote.findChildren = async (...args) =>
      (await find(...args)).map((i) => ({ ...i, createdTime: '2026-11-12T09:59:00Z' }));
    const out = await executor(file, remote).run([action]);
    expect(out[0]).toMatchObject({ status: 'done' });
    expect(file.records[0]?.remoteId).toBe(existing.id);
  });

  it.each([
    ['ReauthRequiredError', new ReauthRequiredError('ms')],
    ['OneDriveFullError', new OneDriveFullError('ms')],
  ])('%s fails the action and stops the run', async (_name, err) => {
    const a = await put('a.txt', 'a');
    const b = await put('b.txt', 'b');
    const file = makePairFile({ localDir: dir, remoteFolderId: od.rootId });
    const out = await executor(file, failingUploads(err)).run([upload(a), upload(b)]);
    expect(out.map((o) => o.status)).toEqual(['failed', 'not-run']);
  });
});

describe('Executor re-reads that find nothing (OneDrive sync spec §5)', () => {
  it('update-remote of an item gone from OneDrive is skipped', async () => {
    const a = await put('a.txt', 'local');
    const file = makePairFile({ localDir: dir, remoteFolderId: od.rootId }, [
      record('gone', 'a.txt'),
    ]);
    const out = await executor(file).run([
      {
        kind: 'update-remote',
        rule: 'B2',
        key: 'a.txt',
        record: record('gone', 'a.txt'),
        local: a,
        localMd5: 'md5',
        remote: remoteEntry('gone', 'a.txt'),
        selection: {},
      },
    ]);
    expect(out[0]).toMatchObject({
      status: 'skipped',
      message: 'a.txt is gone from OneDrive since planning',
    });
  });

  const trashRemote = (id: string, parentId = od.rootId): Action => ({
    kind: 'trash-remote',
    rule: 'B5',
    key: 'a.txt',
    record: record(id, 'a.txt', { remoteParentId: parentId }),
    local: null,
    localMd5: null,
    remote: remoteEntry(id, 'a.txt', { parentId }),
    selection: { remove: ['a.txt'] },
  });

  it('trash-remote of an item already gone: evidence drops the record', async () => {
    const file = makePairFile({ localDir: dir, remoteFolderId: od.rootId }, [
      record('gone', 'a.txt'),
    ]);
    const out = await executor(file, od.remote(), new Set(['gone'])).run([trashRemote('gone')]);
    expect(out[0]?.status).toBe('done');
    expect(file.records).toEqual([]);
  });

  it('trash-remote of an item gone without evidence is skipped, the record kept', async () => {
    const file = makePairFile({ localDir: dir, remoteFolderId: od.rootId }, [
      record('gone', 'a.txt'),
    ]);
    const out = await executor(file).run([trashRemote('gone')]);
    expect(out[0]).toMatchObject({
      status: 'skipped',
      message: 'a.txt is gone from OneDrive since planning',
    });
    expect(file.records).toHaveLength(1);
  });

  it('trash-remote deletes with If-Match; a stale eTag skips', async () => {
    const item = od.addFile(od.rootId, 'a.txt', 'x', 'R1');
    const planned = remoteEntry('R1', 'a.txt', {
      parentId: od.rootId,
      hash: { kind: 'quickXor', value: quickXor(Buffer.from('x')) },
      modifiedTime: item.modified,
      size: 1,
    });
    const action = { ...trashRemote('R1'), remote: planned };
    const file = makePairFile({ localDir: dir, remoteFolderId: od.rootId }, [
      record('R1', 'a.txt'),
    ]);
    // A remote whose re-read returns the old eTag: the DELETE gets 412.
    const remote = od.remote();
    const get = remote.get.bind(remote);
    remote.get = async (id) => {
      const current = await get(id);
      od.edit('R1', 'x'); // same content, new version on the server
      return current;
    };
    const out = await executor(file, remote).run([action]);
    expect(out[0]).toMatchObject({
      status: 'skipped',
      message: 'a.txt changed on OneDrive since the scan',
    });
    expect(od.items.has('R1')).toBe(true);
    const ok = await executor(file).run([
      { ...action, remote: { ...planned, modifiedTime: od.items.get('R1')?.modified ?? '' } },
    ]);
    expect(ok[0]?.status).toBe('done');
    expect(od.items.has('R1')).toBe(false);
  });
});
