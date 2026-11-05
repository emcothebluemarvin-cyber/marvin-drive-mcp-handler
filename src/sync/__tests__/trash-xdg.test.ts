import type { Stats } from 'node:fs';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ValidationError } from '../../errors.js';
import { LocalTrashError } from '../errors.js';
import { nodeTrashFs, type TrashFs } from '../trash-common.js';
import { XdgTrash, encodeTrashPath, formatDeletionDate, trashNames } from '../trash-xdg.js';

const NOW = new Date(2026, 10, 5, 9, 7, 3);

describe('trash info formatting', () => {
  it('percent-encodes UTF-8 bytes outside the unreserved set, keeps /', () => {
    expect(encodeTrashPath('/home/e/a b%ş.pdf')).toBe('/home/e/a%20b%25%C5%9F.pdf');
    expect(encodeTrashPath('/x/A-z_0.~')).toBe('/x/A-z_0.~');
  });

  it('formats local time without a zone', () => {
    expect(formatDeletionDate(NOW)).toBe('2026-11-05T09:07:03');
  });

  it('numbers collisions before the extension', () => {
    expect([...trashNames('a.pdf')].slice(0, 3)).toEqual(['a.pdf', 'a.2.pdf', 'a.3.pdf']);
    expect([...trashNames('.bashrc')].slice(0, 2)).toEqual(['.bashrc', '.bashrc.2']);
    expect([...trashNames('notes')].slice(0, 2)).toEqual(['notes', 'notes.2']);
  });
});

describe.skipIf(process.platform === 'win32')('XdgTrash', () => {
  let tmp: string;
  let dataHome: string;
  let home: string;
  let docs: string;
  let uid: number;

  beforeEach(async () => {
    tmp = await realpath(await mkdtemp(path.join(os.tmpdir(), 'marvin-xdg-')));
    dataHome = path.join(tmp, 'data');
    home = path.join(dataHome, 'Trash');
    docs = path.join(tmp, 'vol', 'docs');
    await mkdir(docs, { recursive: true });
    uid = process.getuid?.() ?? 0;
  });
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  const make = (extra: { fs?: TrashFs; uid?: number } = {}): XdgTrash =>
    new XdgTrash({ env: { XDG_DATA_HOME: dataHome }, now: () => NOW, uid, ...extra });
  const file = async (name: string, body = 'A'): Promise<string> => {
    const p = path.join(docs, name);
    await writeFile(p, body);
    return p;
  };

  /** Everything outside `<tmp>/vol` looks like another device, so `<tmp>/vol` is the top directory. */
  const otherDevice = (): TrashFs => {
    const vol = path.join(tmp, 'vol');
    const shift = (p: unknown, st: Stats): Stats => {
      const inside = String(p) === vol || String(p).startsWith(vol + path.sep);
      return inside ? st : (Object.create(st, { dev: { value: st.dev + 1 } }) as Stats);
    };
    return {
      ...nodeTrashFs,
      stat: (async (p: string) => shift(p, await nodeTrashFs.stat(p))) as TrashFs['stat'],
      lstat: (async (p: string) => shift(p, await nodeTrashFs.lstat(p))) as TrashFs['lstat'],
    };
  };

  it('moves the file into the home trash with a trashinfo record', async () => {
    const f = await file('a b.pdf');
    await make().trash(f);
    expect(await readFile(path.join(home, 'files', 'a b.pdf'), 'utf8')).toBe('A');
    expect(await readFile(path.join(home, 'info', 'a b.pdf.trashinfo'), 'utf8')).toBe(
      `[Trash Info]\nPath=${encodeTrashPath(f)}\nDeletionDate=2026-11-05T09:07:03\n`,
    );
    await expect(readFile(f)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('numbers a second file with the same name', async () => {
    await make().trash(await file('a.pdf', 'one'));
    await make().trash(await file('a.pdf', 'two'));
    expect((await readdir(path.join(home, 'files'))).sort()).toEqual(['a.2.pdf', 'a.pdf']);
    expect(await readFile(path.join(home, 'files', 'a.2.pdf'), 'utf8')).toBe('two');
  });

  it('records the resolved path when the folder is reached through a symlink', async () => {
    const link = path.join(tmp, 'link');
    await symlink(docs, link);
    await file('a.pdf');
    await make().trash(path.join(link, 'a.pdf'));
    const info = await readFile(path.join(home, 'info', 'a.pdf.trashinfo'), 'utf8');
    expect(info).toContain(`Path=${encodeTrashPath(path.join(docs, 'a.pdf'))}\n`);
  });

  it('refuses an unsafe home trash and leaves the file', async () => {
    await mkdir(path.join(home, 'files'), { recursive: true });
    await mkdir(path.join(home, 'info'), { recursive: true });
    await chmod(path.join(home, 'files'), 0o777);
    const f = await file('a.pdf');
    await expect(make().trash(f)).rejects.toThrow(/home trash is not safe/);
    expect(await readFile(f, 'utf8')).toBe('A');
  });

  it('rejects directories and relative paths', async () => {
    await expect(make().trash(docs)).rejects.toBeInstanceOf(ValidationError);
    await expect(make().trash('a.pdf')).rejects.toBeInstanceOf(ValidationError);
  });

  describe('file on another device than the home trash', () => {
    it('uses $top/.Trash-$uid with a relative Path', async () => {
      const f = await file('a.pdf');
      await make({ fs: otherDevice() }).trash(f);
      const user = path.join(tmp, 'vol', `.Trash-${uid}`);
      expect(await readFile(path.join(user, 'files', 'a.pdf'), 'utf8')).toBe('A');
      expect(await readFile(path.join(user, 'info', 'a.pdf.trashinfo'), 'utf8')).toContain(
        'Path=docs/a.pdf\n',
      );
    });

    it('uses $top/.Trash/$uid when .Trash is a sticky directory', async () => {
      const admin = path.join(tmp, 'vol', '.Trash');
      await mkdir(admin);
      await chmod(admin, 0o1777);
      await make({ fs: otherDevice() }).trash(await file('a.pdf'));
      expect(await readdir(path.join(admin, String(uid), 'files'))).toEqual(['a.pdf']);
    });

    it('ignores .Trash without the sticky bit', async () => {
      const admin = path.join(tmp, 'vol', '.Trash');
      await mkdir(admin);
      await chmod(admin, 0o777);
      await make({ fs: otherDevice() }).trash(await file('a.pdf'));
      expect(await readdir(admin)).toEqual([]);
      expect(await readdir(path.join(tmp, 'vol', `.Trash-${uid}`, 'files'))).toEqual(['a.pdf']);
    });

    it('refuses a .Trash-$uid that is a symlink', async () => {
      const elsewhere = path.join(tmp, 'elsewhere');
      await mkdir(path.join(elsewhere, 'files'), { recursive: true });
      await mkdir(path.join(elsewhere, 'info'), { recursive: true });
      await symlink(elsewhere, path.join(tmp, 'vol', `.Trash-${uid}`));
      const f = await file('a.pdf');
      await expect(make({ fs: otherDevice() }).trash(f)).rejects.toBeInstanceOf(LocalTrashError);
      expect(await readFile(f, 'utf8')).toBe('A');
      expect(await readdir(path.join(elsewhere, 'files'))).toEqual([]);
    });

    it('refuses a group-writable .Trash-$uid', async () => {
      const user = path.join(tmp, 'vol', `.Trash-${uid}`);
      await mkdir(path.join(user, 'files'), { recursive: true });
      await mkdir(path.join(user, 'info'), { recursive: true });
      await chmod(user, 0o770);
      const f = await file('a.pdf');
      await expect(make({ fs: otherDevice() }).trash(f)).rejects.toThrow(/writable by others/);
      expect(await readFile(f, 'utf8')).toBe('A');
    });

    it('refuses a trash owned by another user', async () => {
      const f = await file('a.pdf');
      await expect(make({ fs: otherDevice(), uid: uid + 1 }).trash(f)).rejects.toThrow(
        /belongs to another user/,
      );
      expect(await readFile(f, 'utf8')).toBe('A');
    });
  });
});
