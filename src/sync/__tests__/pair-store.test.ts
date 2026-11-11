import { writeFileSync } from 'node:fs';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  utimes,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ValidationError } from '../../errors.js';
import { silentLogger } from '../../files/__tests__/fakes.js';
import {
  PairStore,
  checkOverlap,
  markerName,
  probeCaseInsensitive,
  readMarker,
  removeMarker,
  writeMarker,
} from '../pair-store.js';
import { makePair, makePairFile, record } from './fixtures.js';
import { expectMode } from '../../__tests__/fs-mode.js';

let tmp: string;
let dir: string;

beforeEach(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), 'sync-store-'));
  dir = path.join(tmp, 'sync');
});
afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

function store(isAlive: (pid: number) => boolean = () => true): PairStore {
  return new PairStore({ dir, isAlive, logger: silentLogger() });
}

describe('PairStore', () => {
  it('loads a Phase A pair file without nativeBaselineDone as false', async () => {
    const file = makePairFile();
    const oldPair: Record<string, unknown> = { ...file.pair };
    delete oldPair.nativeBaselineDone;
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'docs.json'), JSON.stringify({ ...file, pair: oldPair }));
    expect((await store().load('docs')).pair.nativeBaselineDone).toBe(false);
  });

  it('loads a version-1 file (remoteMd5) as version 2 and saves it as version 2', async () => {
    const file = makePairFile({}, [record('r1', 'a.pdf'), record('r2', 'b.pdf')]);
    const v1 = {
      ...file,
      version: 1,
      records: file.records.map(({ remoteHash, ...r }, i) => ({
        ...r,
        remoteMd5: i === 0 ? (remoteHash?.value ?? null) : null,
      })),
    };
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'docs.json'), JSON.stringify(v1));
    const s = store();
    const loaded = await s.load('docs');
    expect(loaded.version).toBe(2);
    expect(loaded.records.map((r) => r.remoteHash)).toEqual([
      { kind: 'md5', value: 'md5-r1' },
      null,
    ]);
    expect(loaded.records[0]).not.toHaveProperty('remoteMd5');
    await s.save(loaded);
    const saved = JSON.parse(await readFile(path.join(dir, 'docs.json'), 'utf8'));
    expect(saved.version).toBe(2);
    expect(saved.records[0].remoteHash).toEqual({ kind: 'md5', value: 'md5-r1' });
  });

  it('gives a version-1 pair an empty deletion cursor and evidence', async () => {
    const file = makePairFile();
    const pair: Record<string, unknown> = { ...file.pair };
    delete pair.remoteCursor;
    delete pair.remoteDeletedIds;
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'docs.json'), JSON.stringify({ ...file, version: 1, pair }));
    expect((await store().load('docs')).pair).toMatchObject({
      remoteCursor: null,
      remoteDeletedIds: [],
    });
  });

  it('refuses a pair file from a newer version with an update hint', async () => {
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'docs.json'), JSON.stringify({ ...makePairFile(), version: 3 }));
    await expect(store().load('docs')).rejects.toThrow(
      'this pair was saved by a newer marvin-drive; update it',
    );
  });

  it('tightens an existing sync dir to 0700', async () => {
    await mkdir(dir, { recursive: true });
    await chmod(dir, 0o755);
    await store().save(makePairFile({}, []));
    await expectMode(dir, 0o700);
  });

  it('saves atomically with 0600 file and 0700 dir, and loads it back', async () => {
    const s = store();
    const data = makePairFile({}, [record('r1', 'a.pdf')]);
    await s.save(data);
    await expectMode(dir, 0o700);
    await expectMode(path.join(dir, 'docs.json'), 0o600);
    expect(await s.load('docs')).toEqual(data);
    expect(await s.exists('docs')).toBe(true);
    expect((await s.list()).map((p) => p.pair.name)).toEqual(['docs']);
    await s.save({ ...data, records: [] });
    expect((await s.load('docs')).records).toEqual([]);
  });

  it('reports a missing pair, invalid JSON and invalid content', async () => {
    const s = store();
    await expect(s.load('nope')).rejects.toThrow('No sync pair named "nope"');
    await s.save(makePairFile());
    await writeFile(path.join(dir, 'docs.json'), '{');
    await expect(s.load('docs')).rejects.toThrow('not valid JSON');
    await writeFile(path.join(dir, 'docs.json'), JSON.stringify({ version: 2 }));
    await expect(s.load('docs')).rejects.toThrow('is invalid');
  });

  it('rejects invalid pair names', async () => {
    await expect(store().load('../x')).rejects.toThrow(ValidationError);
  });

  it('lists nothing when the dir is missing and removes pairs', async () => {
    const s = store();
    expect(await s.list()).toEqual([]);
    await s.save(makePairFile());
    await s.remove('docs');
    expect(await s.exists('docs')).toBe(false);
  });

  it('locks exclusively and releases', async () => {
    const s = store();
    const release = await s.lock('docs');
    const held = JSON.parse(await readFile(path.join(dir, 'docs.lock'), 'utf8')) as {
      pid: number;
    };
    expect(held.pid).toBe(process.pid);
    await expect(s.lock('docs')).rejects.toThrow('sync is busy for docs');
    await release();
    await expect(s.withLock('docs', async () => 42)).resolves.toBe(42);
    await expect(lstat(path.join(dir, 'docs.lock'))).rejects.toThrow();
  });

  it('breaks a lock held by a dead process with a warning', async () => {
    const logger = silentLogger();
    const s = new PairStore({ dir, isAlive: () => false, logger });
    await s.lock('docs');
    const release = await s.lock('docs');
    expect(logger.warn).toHaveBeenCalledWith('Breaking a stale sync lock', { name: 'docs' });
    await release();
  });

  it('does not steal a fresh lock taken while it was breaking a stale one', async () => {
    const lockFile = path.join(dir, 'docs.lock');
    const fresh = JSON.stringify({ pid: 4242, startedAt: 'now' });
    const racing = new PairStore({
      dir,
      logger: silentLogger(),
      isAlive: () => {
        writeFileSync(lockFile, fresh); // another process broke the stale lock and re-locked
        return false;
      },
    });
    await mkdir(dir, { recursive: true });
    await writeFile(lockFile, JSON.stringify({ pid: 1, startedAt: 'old' }));
    await expect(racing.lock('docs')).rejects.toThrow('sync is busy for docs');
    expect(await readFile(lockFile, 'utf8')).toBe(fresh);
    expect((await readdir(dir)).filter((n) => n.endsWith('.stale'))).toEqual([]);
  });

  it('releases only its own lock (pid + token)', async () => {
    const s = store();
    const lockFile = path.join(dir, 'docs.lock');
    const release = await s.lock('docs');
    expect(JSON.parse(await readFile(lockFile, 'utf8'))).toMatchObject({
      pid: process.pid,
      token: expect.any(String),
    });
    const foreign = JSON.stringify({ pid: 4242, startedAt: 'x', token: 'theirs' });
    await writeFile(lockFile, foreign);
    await release();
    expect(await readFile(lockFile, 'utf8')).toBe(foreign);
  });

  it('treats an unreadable lock as busy until it is a minute old', async () => {
    const s = store();
    await s.save(makePairFile());
    const lockFile = path.join(dir, 'docs.lock');
    await writeFile(lockFile, '');
    await expect(s.lock('docs')).rejects.toThrow('busy');
    const old = new Date(Date.now() - 120_000);
    await utimes(lockFile, old, old);
    const release = await s.lock('docs');
    await release();
  });
});

describe('marker', () => {
  it('writes, reads and removes the marker', async () => {
    expect(await readMarker(tmp, 'docs')).toBeNull();
    await writeMarker(tmp, 'docs', 'pair-id-1');
    expect(await readFile(path.join(tmp, markerName('docs')), 'utf8')).toBe('pair-id-1\n');
    expect(await readMarker(tmp, 'docs')).toBe('pair-id-1');
    await removeMarker(tmp, 'docs');
    expect(await readMarker(tmp, 'docs')).toBeNull();
  });

  it('probes case sensitivity read-only via the flipped marker name', async () => {
    await writeMarker(tmp, 'docs', 'id');
    let expected: boolean;
    try {
      await lstat(path.join(tmp, '.MARVIN-SYNC-DOCS'));
      expected = true;
    } catch {
      expected = false;
    }
    expect(await probeCaseInsensitive(tmp, 'docs')).toBe(expected);
  });
});

describe('checkOverlap', () => {
  const existing = [makePair({ name: 'a', localDir: '/Users/x/Docs', remoteFolderId: 'F1' })];

  it('rejects duplicate names, nested local folders and a reused Drive folder', () => {
    const base = { localDir: '/Users/x/Other', remoteFolderId: 'F2' };
    expect(() => checkOverlap(existing, { ...base, name: 'a' })).toThrow('already exists');
    expect(() => checkOverlap(existing, { ...base, name: 'b', localDir: '/Users/x/Docs' })).toThrow(
      'overlaps',
    );
    expect(() =>
      checkOverlap(existing, { ...base, name: 'b', localDir: '/Users/x/docs/sub' }),
    ).toThrow('overlaps');
    expect(() => checkOverlap(existing, { ...base, name: 'b', localDir: '/Users/x' })).toThrow(
      'overlaps',
    );
    expect(() => checkOverlap(existing, { ...base, name: 'b', remoteFolderId: 'F1' })).toThrow(
      'already used',
    );
    expect(() => checkOverlap(existing, { ...base, name: 'b' })).not.toThrow();
    expect(() =>
      checkOverlap(existing, { ...base, name: 'b', localDir: '/Users/x/Docs2' }),
    ).not.toThrow();
  });
});
