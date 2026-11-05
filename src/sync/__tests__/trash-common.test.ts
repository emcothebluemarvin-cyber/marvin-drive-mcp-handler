import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LocalTrashError } from '../errors.js';
import { nodeTrashFs, placeInTrash, reserveAndMove, type TrashFs } from '../trash-common.js';

let tmp: string;
let bin: string;
let file: string;
beforeEach(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), 'marvin-trash-move-'));
  bin = path.join(tmp, 'bin');
  await mkdir(bin);
  file = path.join(tmp, 'a.pdf');
  await writeFile(file, 'A');
});
afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

const failingRename = (code: string): TrashFs => ({
  ...nodeTrashFs,
  rename: async () => {
    throw Object.assign(new Error(code), { code });
  },
});

describe('placeInTrash', () => {
  it('moves the file and keeps its content', async () => {
    await placeInTrash(file, path.join(bin, 'a.pdf'), nodeTrashFs);
    expect(await readFile(path.join(bin, 'a.pdf'), 'utf8')).toBe('A');
    await expect(readFile(file)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('never replaces an existing target', async () => {
    await writeFile(path.join(bin, 'a.pdf'), 'OLD');
    await expect(placeInTrash(file, path.join(bin, 'a.pdf'), nodeTrashFs)).rejects.toThrow();
    expect(await readFile(path.join(bin, 'a.pdf'), 'utf8')).toBe('OLD');
    expect(await readFile(file, 'utf8')).toBe('A');
  });
});

describe('reserveAndMove', () => {
  const names = (...n: string[]): Array<{ meta: string; target: string }> =>
    n.map((x) => ({ meta: path.join(bin, `${x}.meta`), target: path.join(bin, x) }));

  it('writes the metadata, then moves the file', async () => {
    await reserveAndMove({ file, fs: nodeTrashFs, names: names('a.pdf'), metadata: 'META' });
    expect(await readFile(path.join(bin, 'a.pdf.meta'), 'utf8')).toBe('META');
    expect(await readFile(path.join(bin, 'a.pdf'), 'utf8')).toBe('A');
  });

  it('skips names whose metadata or target already exists', async () => {
    await writeFile(path.join(bin, 'one.meta'), 'theirs');
    await writeFile(path.join(bin, 'two'), 'orphan');
    await reserveAndMove({
      file,
      fs: nodeTrashFs,
      names: names('one', 'two', 'three'),
      metadata: 'M',
    });
    expect((await readdir(bin)).sort()).toEqual(['one.meta', 'three', 'three.meta', 'two']);
    expect(await readFile(path.join(bin, 'one.meta'), 'utf8')).toBe('theirs');
    expect(await readFile(path.join(bin, 'two'), 'utf8')).toBe('orphan');
  });

  it.each(['EXDEV', 'EBUSY', 'EPERM'])(
    '%s: fails, removes its metadata, leaves the file',
    async (code) => {
      const err = await reserveAndMove({
        file,
        fs: failingRename(code),
        names: names('a.pdf'),
        metadata: 'M',
      }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(LocalTrashError);
      expect(String((err as Error).message)).toMatch(/Nothing was deleted/);
      expect(await readdir(bin)).toEqual([]);
      expect(await readFile(file, 'utf8')).toBe('A');
    },
  );

  it('rethrows ENOENT when the source vanished', async () => {
    await rm(file);
    await expect(
      reserveAndMove({ file, fs: nodeTrashFs, names: names('a.pdf'), metadata: 'M' }),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readdir(bin)).toEqual([]);
  });

  it('fails when every name is taken', async () => {
    await writeFile(path.join(bin, 'x.meta'), '');
    await expect(
      reserveAndMove({ file, fs: nodeTrashFs, names: names('x'), metadata: 'M' }),
    ).rejects.toThrow(/no free name/);
    expect(await readFile(file, 'utf8')).toBe('A');
  });
});
