import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { hashLocal, md5File, probeOnDisk, scanLocal } from '../local-scanner.js';

const NFD = 'şartname.pdf'.normalize('NFD');
const isRoot = process.getuid?.() === 0;
let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'sync-local-'));
});
afterEach(async () => {
  await chmod(path.join(root, 'locked'), 0o755).catch(() => undefined);
  await rm(root, { recursive: true, force: true });
});

describe('scanLocal', () => {
  it('lists regular files with NFC keys and on-disk names', async () => {
    await mkdir(path.join(root, 'sub'));
    await writeFile(path.join(root, 'sub', NFD), 'pdf');
    await writeFile(path.join(root, 'a.txt'), 'hello');
    const scan = await scanLocal(root);
    expect(scan.entries.map((e) => [e.key, e.name, e.foldKey, e.size])).toEqual([
      ['a.txt', 'a.txt', 'a.txt', 5],
      ['sub/şartname.pdf', `sub/${NFD}`, 'sub/şartname.pdf', 3],
    ]);
    expect(scan.entries[0]?.ino).toBeGreaterThan(0);
    expect(scan.occupied).toEqual(['sub']);
  });

  it('records ignored and non-regular entries as occupied and collects part files', async () => {
    await writeFile(path.join(root, '.marvin-sync-docs'), 'id');
    await writeFile(path.join(root, 'x.pdf.ab12.marvin-part'), 'partial');
    await symlink('/etc/hosts', path.join(root, 'link.pdf'));
    await mkdir(path.join(root, '.git'));
    await writeFile(path.join(root, '.git', 'config'), 'x');
    const scan = await scanLocal(root);
    expect(scan.entries).toEqual([]);
    expect(scan.occupied.sort()).toEqual(
      ['.git', '.marvin-sync-docs', 'link.pdf', 'x.pdf.ab12.marvin-part'].sort(),
    );
    expect(scan.partFiles.map((p) => p.name)).toEqual(['x.pdf.ab12.marvin-part']);
    expect(scan.blocking.sort()).toEqual(['.git', 'link.pdf']);
  });

  it('marks symlinked folders as blocking without following them', async () => {
    const outside = await mkdtemp(path.join(os.tmpdir(), 'sync-ext-'));
    try {
      await writeFile(path.join(outside, 'x.pdf'), 'x');
      await symlink(outside, path.join(root, 'a'));
      const scan = await scanLocal(root);
      expect(scan.entries).toEqual([]);
      expect(scan.blocking).toEqual(['a']);
      const onDisk = await probeOnDisk(root, ['a/x.pdf', 'gone.pdf']);
      expect([...onDisk.keys()]).toEqual(['a/x.pdf']);
      expect(onDisk.get('a/x.pdf')?.kind).toBe('file');
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('probeOnDisk reports errors (a parent that is a file) as kind error', async () => {
    await writeFile(path.join(root, 'f'), 'x');
    const onDisk = await probeOnDisk(root, ['f/x.pdf']);
    expect(onDisk.get('f/x.pdf')).toEqual({ kind: 'error', ino: 0 });
  });

  it.skipIf(isRoot)('reports unreadable directories as unknown subtrees', async () => {
    await mkdir(path.join(root, 'locked'));
    await writeFile(path.join(root, 'locked', 'secret.pdf'), 'x');
    await chmod(path.join(root, 'locked'), 0o000);
    const scan = await scanLocal(root);
    expect(scan.unknownSubtrees).toEqual(['locked']);
    expect(scan.entries).toEqual([]);
  });

  it('restricts the walk to a subdir and rejects a missing one', async () => {
    await mkdir(path.join(root, 'a'));
    await writeFile(path.join(root, 'a', 'in.pdf'), 'x');
    await writeFile(path.join(root, 'out.pdf'), 'x');
    const scan = await scanLocal(root, { subdir: 'a' });
    expect(scan.entries.map((e) => e.key)).toEqual(['a/in.pdf']);
    await expect(scanLocal(root, { subdir: 'nope' })).rejects.toThrow('is not a folder');
  });
});

describe('hashing', () => {
  it('computes md5 and reports failures', async () => {
    await writeFile(path.join(root, 'a.txt'), 'hello');
    const expected = createHash('md5').update('hello').digest('hex');
    expect(await md5File(path.join(root, 'a.txt'))).toBe(expected);
    const { md5s, failed } = await hashLocal(root, ['a.txt', 'gone.txt']);
    expect(md5s.get('a.txt')).toBe(expected);
    expect(failed).toEqual(['gone.txt']);
  });
});
