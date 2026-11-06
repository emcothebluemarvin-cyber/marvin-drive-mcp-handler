import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { beforeEach, describe, expect, it } from 'vitest';
import { linkFileOrSkip } from '../../__tests__/links.js';
import { ValidationError } from '../../errors.js';
import {
  assertInside,
  endsWithSeparator,
  expandHome,
  resolveDestination,
  writeUnique,
} from '../destination.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'marvin-dest-'));
});

describe('path separators', () => {
  it('treats a trailing backslash as a folder only on Windows', () => {
    expect(endsWithSeparator('C:\\out\\', 'win32')).toBe(true);
    expect(endsWithSeparator('C:/out/', 'win32')).toBe(true);
    expect(endsWithSeparator('/tmp/out\\', 'linux')).toBe(false);
    expect(endsWithSeparator('/tmp/out/', 'darwin')).toBe(true);
    expect(endsWithSeparator('/tmp/out', 'win32')).toBe(false);
  });

  it('expands ~\\ only on Windows', () => {
    expect(expandHome('~\\Downloads', 'win32')).toBe(path.join(os.homedir(), 'Downloads'));
    expect(expandHome('~\\Downloads', 'linux')).toBe('~\\Downloads');
    expect(expandHome('~/Downloads', 'linux')).toBe(path.join(os.homedir(), 'Downloads'));
  });

  it.runIf(process.platform === 'win32')(
    'resolves a destPath ending in a backslash to that folder',
    async () => {
      const fresh = path.join(dir, 'verify') + '\\';
      await expect(
        resolveDestination({
          driveName: 'Plan',
          fileId: 'f1',
          defaultDir: '/unused',
          destPath: fresh,
        }),
      ).resolves.toEqual({ dir: path.join(dir, 'verify'), name: 'Plan' });
    },
  );
});

describe('resolveDestination', () => {
  const base = { driveName: 'Plan', fileId: 'f1', extension: 'docx' };

  it('uses the default directory when destPath is omitted', async () => {
    await expect(resolveDestination({ ...base, defaultDir: dir })).resolves.toEqual({
      dir,
      name: 'Plan.docx',
    });
  });

  it('treats an existing directory or a trailing slash as a directory', async () => {
    await expect(
      resolveDestination({ ...base, defaultDir: '/unused', destPath: dir }),
    ).resolves.toEqual({ dir, name: 'Plan.docx' });
    const fresh = path.join(dir, 'new-folder');
    await expect(
      resolveDestination({ ...base, defaultDir: '/unused', destPath: `${fresh}/` }),
    ).resolves.toEqual({ dir: fresh, name: 'Plan.docx' });
  });

  it('treats any other destPath as the full target file path', async () => {
    const target = path.join(dir, 'custom.bin');
    await expect(
      resolveDestination({ ...base, defaultDir: '/unused', destPath: target }),
    ).resolves.toEqual({ dir, name: 'custom.bin' });
  });

  it('rejects relative destPath', async () => {
    await expect(
      resolveDestination({ ...base, defaultDir: '/unused', destPath: 'rel/x.txt' }),
    ).rejects.toThrow('destPath must be an absolute path (got "rel/x.txt")');
  });

  it('expands ~ to the home directory', async () => {
    const res = await resolveDestination({ ...base, defaultDir: '/unused', destPath: '~/x.txt' });
    expect(res).toEqual({ dir: os.homedir(), name: 'x.txt' });
  });

  it('sanitizes hostile Drive names so they stay inside the directory', async () => {
    const res = await resolveDestination({
      driveName: '../../.zshrc',
      fileId: 'f1',
      defaultDir: dir,
    });
    expect(res).toEqual({ dir, name: '_.._.zshrc' });
  });
});

describe('assertInside', () => {
  it('rejects paths that escape the directory', () => {
    expect(() => assertInside(dir, path.join(dir, '..', 'evil'))).toThrow(ValidationError);
    expect(() => assertInside(dir, dir)).toThrow(ValidationError);
    expect(() => assertInside(dir, path.join(dir, 'ok.txt'))).not.toThrow();
    expect(() => assertInside(dir, path.join(dir, '..notes'))).not.toThrow();
  });
});

describe('writeUnique', () => {
  it('writes the stream, creating missing directories', async () => {
    const target = { dir: path.join(dir, 'a', 'b'), name: 'hello.txt' };
    const res = await writeUnique(target, async () => Readable.from(['hello']));
    expect(res).toEqual({ path: path.join(dir, 'a', 'b', 'hello.txt'), size: 5 });
    expect(await readFile(res.path, 'utf8')).toBe('hello');
  });

  it('never overwrites: picks the next free suffix', async () => {
    await writeFile(path.join(dir, 'report.pdf'), 'old');
    await writeFile(path.join(dir, 'report (1).pdf.part'), 'in progress elsewhere');
    const res = await writeUnique({ dir, name: 'report.pdf' }, async () => Readable.from(['new']));
    expect(path.basename(res.path)).toBe('report (2).pdf');
    expect(await readFile(path.join(dir, 'report.pdf'), 'utf8')).toBe('old');
  });

  it('removes the partial file when the stream fails', async () => {
    const failing = (): Readable =>
      new Readable({
        read() {
          this.destroy(new Error('network reset'));
        },
      });
    await expect(writeUnique({ dir, name: 'x.bin' }, async () => failing())).rejects.toThrow(
      'network reset',
    );
    expect(await readdir(dir)).toEqual([]);
  });

  it('removes the reservation when opening the source fails', async () => {
    await expect(
      writeUnique({ dir, name: 'x.bin' }, async () => {
        throw new Error('403');
      }),
    ).rejects.toThrow('403');
    expect(await readdir(dir)).toEqual([]);
  });

  it('does not overwrite a final file that appears after reservation', async () => {
    const res = await writeUnique({ dir, name: 'report.pdf' }, async () => {
      await writeFile(path.join(dir, 'report.pdf'), 'raced');
      return Readable.from(['new']);
    });
    expect(path.basename(res.path)).toBe('report (1).pdf');
    expect(await readFile(path.join(dir, 'report.pdf'), 'utf8')).toBe('raced');
    expect(await readFile(res.path, 'utf8')).toBe('new');
    expect((await readdir(dir)).sort()).toEqual(['report (1).pdf', 'report.pdf']);
  });

  it('treats a dangling symlink as a taken name', async (ctx) => {
    await linkFileOrSkip(ctx, path.join(dir, 'nowhere'), path.join(dir, 'link.txt'));
    const res = await writeUnique({ dir, name: 'link.txt' }, async () => Readable.from(['x']));
    expect(path.basename(res.path)).toBe('link (1).txt');
  });

  it.each(['EPERM', 'ENOTSUP', 'EXDEV', 'ENOSYS'])(
    'falls back to rename when link fails with %s',
    async (code) => {
      await writeFile(path.join(dir, 'doc.txt'), 'existing');
      const link = async (): Promise<void> => {
        throw Object.assign(new Error('no links'), { code });
      };
      const res = await writeUnique(
        { dir, name: 'fresh.txt' },
        async () => Readable.from(['abc']),
        {
          link,
        },
      );
      expect(res).toEqual({ path: path.join(dir, 'fresh.txt'), size: 3 });
      expect((await readdir(dir)).sort()).toEqual(['doc.txt', 'fresh.txt']);
    },
  );

  it('rename fallback still skips names taken after reservation', async () => {
    const link = async (): Promise<void> => {
      throw Object.assign(new Error('no links'), { code: 'EPERM' });
    };
    const res = await writeUnique(
      { dir, name: 'report.pdf' },
      async () => {
        await writeFile(path.join(dir, 'report.pdf'), 'raced');
        return Readable.from(['new']);
      },
      { link },
    );
    expect(path.basename(res.path)).toBe('report (1).pdf');
    expect(await readFile(path.join(dir, 'report.pdf'), 'utf8')).toBe('raced');
    expect((await readdir(dir)).sort()).toEqual(['report (1).pdf', 'report.pdf']);
  });
});
