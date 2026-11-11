import { createHash } from 'node:crypto';
import { link, lstat, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ChecksumMismatchError,
  CollisionError,
  SizeMismatchError,
  TargetChangedError,
} from '../errors.js';
import { md5Hash } from './fixtures.js';
import {
  downloadReplace,
  moveLocal,
  placeExclusive,
  syncDir,
  type StatExpect,
} from '../transfer.js';

const md5 = (s: string): string => createHash('md5').update(s).digest('hex');
const source = (s: string) => async (): Promise<Readable> => Readable.from([Buffer.from(s)]);
let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'sync-transfer-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function statOf(p: string): Promise<StatExpect> {
  const s = await lstat(p);
  return { size: s.size, mtimeMs: s.mtimeMs, ctimeMs: s.ctimeMs };
}

async function leftovers(): Promise<string[]> {
  return (await readdir(dir)).filter((n) => n.endsWith('.marvin-part'));
}

describe('placeExclusive', () => {
  it('writes a new file and verifies md5', async () => {
    const out = await placeExclusive(dir, () => 'a.pdf', source('hello'), {
      expected: md5Hash(md5('hello')),
    });
    expect(out).toEqual({ path: path.join(dir, 'a.pdf'), md5: md5('hello'), size: 5 });
    expect(await readFile(out.path, 'utf8')).toBe('hello');
    expect(await leftovers()).toEqual([]);
  });

  it('never overwrites: an existing target is a collision', async () => {
    await writeFile(path.join(dir, 'a.pdf'), 'mine');
    await expect(placeExclusive(dir, () => 'a.pdf', source('theirs'))).rejects.toBeInstanceOf(
      CollisionError,
    );
    expect(await readFile(path.join(dir, 'a.pdf'), 'utf8')).toBe('mine');
    expect(await leftovers()).toEqual([]);
  });

  it('tries numbered names when allowed', async () => {
    await writeFile(path.join(dir, 'c.pdf'), 'x');
    const names = (i: number): string => (i === 0 ? 'c.pdf' : `c ${i + 1}.pdf`);
    const out = await placeExclusive(dir, names, source('y'), { maxAttempts: 5 });
    expect(path.basename(out.path)).toBe('c 2.pdf');
  });

  it('removes the temp file on a checksum mismatch', async () => {
    await expect(
      placeExclusive(dir, () => 'a.pdf', source('hello'), { expected: md5Hash('nope') }),
    ).rejects.toBeInstanceOf(ChecksumMismatchError);
    expect(await readdir(dir)).toEqual([]);
  });

  it('removes the temp file on a size mismatch', async () => {
    await expect(
      placeExclusive(dir, () => 'a.pdf', source('hello'), { expectedSize: 4 }),
    ).rejects.toBeInstanceOf(SizeMismatchError);
    expect(await readdir(dir)).toEqual([]);
  });

  it('verifies a non-md5 remote hash with the injected digester, md5 still returned', async () => {
    const digesters = () => ({ update: () => {}, digest: () => 'QX' });
    const out = await placeExclusive(dir, () => 'a.pdf', source('hello'), {
      expected: { kind: 'quickXor', value: 'QX' },
      digesters,
    });
    expect(out.md5).toBe(md5('hello'));
    await expect(
      placeExclusive(dir, () => 'b.pdf', source('hello'), {
        expected: { kind: 'quickXor', value: 'other' },
        digesters,
      }),
    ).rejects.toThrow('expected quickXor other, got QX');
    expect(await leftovers()).toEqual([]);
  });

  it('a digester that cannot be created leaves no temp file behind', async () => {
    const digesters = (): never => {
      throw new Error('no quickXor here');
    };
    await expect(
      placeExclusive(dir, () => 'a.pdf', source('hello'), {
        expected: { kind: 'quickXor', value: 'QX' },
        digesters,
      }),
    ).rejects.toThrow('no quickXor here');
    expect(await readdir(dir)).toEqual([]);
  });

  it('falls back to exists-check + rename where hard links are unsupported', async () => {
    const noLink = async (): Promise<void> => {
      throw Object.assign(new Error('nope'), { code: 'ENOTSUP' });
    };
    const out = await placeExclusive(dir, () => 'a.pdf', source('hi'), { link: noLink });
    expect(await readFile(out.path, 'utf8')).toBe('hi');
    await expect(
      placeExclusive(dir, () => 'a.pdf', source('again'), { link: noLink }),
    ).rejects.toBeInstanceOf(CollisionError);
  });
});

describe('downloadReplace', () => {
  it('replaces the tracked file when unchanged since the scan', async () => {
    const target = path.join(dir, 'a.pdf');
    await writeFile(target, 'old');
    const res = await downloadReplace(target, source('new'), {
      expect: await statOf(target),
      expected: md5Hash(md5('new')),
    });
    expect(res).toEqual({ md5: md5('new'), size: 3 });
    expect(await readFile(target, 'utf8')).toBe('new');
    expect(await leftovers()).toEqual([]);
  });

  it('aborts before downloading when the file changed', async () => {
    const target = path.join(dir, 'a.pdf');
    await writeFile(target, 'old');
    const expect0 = await statOf(target);
    await writeFile(target, 'edited!');
    await expect(
      downloadReplace(target, source('new'), { expect: expect0 }),
    ).rejects.toBeInstanceOf(TargetChangedError);
    expect(await readFile(target, 'utf8')).toBe('edited!');
  });

  it('aborts at rename time when the file changed during the download', async () => {
    const target = path.join(dir, 'a.pdf');
    await writeFile(target, 'old');
    const expect0 = await statOf(target);
    const racing = async (): Promise<Readable> => {
      await writeFile(target, 'edited during download');
      return Readable.from([Buffer.from('new')]);
    };
    await expect(downloadReplace(target, racing, { expect: expect0 })).rejects.toBeInstanceOf(
      TargetChangedError,
    );
    expect(await readFile(target, 'utf8')).toBe('edited during download');
    expect(await leftovers()).toEqual([]);
  });

  it('keeps the old file on a size mismatch', async () => {
    const target = path.join(dir, 'a.pdf');
    await writeFile(target, 'old');
    await expect(
      downloadReplace(target, source('new'), { expect: await statOf(target), expectedSize: 9 }),
    ).rejects.toBeInstanceOf(SizeMismatchError);
    expect(await readFile(target, 'utf8')).toBe('old');
    expect(await leftovers()).toEqual([]);
  });

  it('keeps the old file on a checksum mismatch', async () => {
    const target = path.join(dir, 'a.pdf');
    await writeFile(target, 'old');
    await expect(
      downloadReplace(target, source('new'), {
        expect: await statOf(target),
        expected: md5Hash('x'),
      }),
    ).rejects.toBeInstanceOf(ChecksumMismatchError);
    expect(await readFile(target, 'utf8')).toBe('old');
  });
});

describe('moveLocal', () => {
  it('moves via link + unlink', async () => {
    const from = path.join(dir, 'a.pdf');
    await writeFile(from, 'x');
    await moveLocal(from, path.join(dir, 'b.pdf'), { inPlace: false, expect: await statOf(from) });
    expect(await readdir(dir)).toEqual(['b.pdf']);
  });

  it('renames in place for case-only changes', async () => {
    const from = path.join(dir, 'a.pdf');
    await writeFile(from, 'x');
    await moveLocal(from, path.join(dir, 'A.pdf'), { inPlace: true, expect: await statOf(from) });
    expect(await readdir(dir)).toEqual(['A.pdf']);
  });

  it('resumes after a crash between link and unlink', async () => {
    const from = path.join(dir, 'a.pdf');
    await writeFile(from, 'x');
    await link(from, path.join(dir, 'b.pdf'));
    await moveLocal(from, path.join(dir, 'b.pdf'), { inPlace: false, expect: await statOf(from) });
    expect(await readdir(dir)).toEqual(['b.pdf']);
  });

  it('refuses to overwrite another file and skips a changed source', async () => {
    const from = path.join(dir, 'a.pdf');
    await writeFile(from, 'x');
    await writeFile(path.join(dir, 'b.pdf'), 'other');
    await expect(
      moveLocal(from, path.join(dir, 'b.pdf'), { inPlace: false, expect: await statOf(from) }),
    ).rejects.toBeInstanceOf(CollisionError);
    await expect(
      moveLocal(from, path.join(dir, 'c.pdf'), {
        inPlace: false,
        expect: { size: 99, mtimeMs: 0, ctimeMs: 0 },
      }),
    ).rejects.toBeInstanceOf(TargetChangedError);
    expect((await readdir(dir)).sort()).toEqual(['a.pdf', 'b.pdf']);
  });
});

describe('moveLocal on folding volumes (review regressions)', () => {
  it('never deletes the only copy when the volume folds the two names (ß → SS)', async () => {
    const from = path.join(dir, 'straße.pdf');
    await writeFile(from, 'only copy');
    await moveLocal(from, path.join(dir, 'STRASSE.pdf'), {
      inPlace: false,
      expect: await statOf(from),
    });
    expect(await readdir(dir)).toEqual(['STRASSE.pdf']);
    expect(await readFile(path.join(dir, 'STRASSE.pdf'), 'utf8')).toBe('only copy');
  });

  it('never deletes the only copy on a case-only change either', async () => {
    const from = path.join(dir, 'report.pdf');
    await writeFile(from, 'only copy');
    await moveLocal(from, path.join(dir, 'Report.pdf'), {
      inPlace: false,
      expect: await statOf(from),
    });
    expect(await readdir(dir)).toEqual(['Report.pdf']);
    expect(await readFile(path.join(dir, 'Report.pdf'), 'utf8')).toBe('only copy');
  });

  it('in place: refuses a target that is another file', async () => {
    const from = path.join(dir, 'a.pdf');
    await writeFile(from, 'x');
    await writeFile(path.join(dir, 'b.pdf'), 'other');
    await expect(
      moveLocal(from, path.join(dir, 'b.pdf'), { inPlace: true, expect: await statOf(from) }),
    ).rejects.toBeInstanceOf(CollisionError);
    expect(await readFile(path.join(dir, 'b.pdf'), 'utf8')).toBe('other');
  });
});

describe('syncDir on Windows', () => {
  it('is a no-op on win32 (no directory fsync there)', async () => {
    await expect(
      syncDir(path.join(os.tmpdir(), 'does-not-exist-xyz'), 'win32'),
    ).resolves.toBeUndefined();
  });
});
