import { mkdir, mkdtemp, rm, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ValidationError } from '../../errors.js';
import {
  absInside,
  ancestorKeys,
  baseName,
  foldKey,
  isIgnoredName,
  isRepresentable,
  isUnder,
  parentKey,
  prepareParent,
  toKey,
  validateRelPath,
} from '../paths.js';

const NFD = 'şartname.pdf'.normalize('NFD');

describe('keys', () => {
  it('normalizes to NFC and folds case', () => {
    expect(toKey(`a/${NFD}`)).toBe('a/şartname.pdf');
    expect(foldKey('Report.PDF')).toBe('report.pdf');
    expect(foldKey(NFD)).toBe(foldKey('ŞARTNAME.pdf'));
  });

  it('folds like APFS: ß/SS, ligatures, long s and final sigma', () => {
    expect(foldKey('straße.pdf')).toBe(foldKey('STRASSE.pdf'));
    expect(foldKey('ﬀ.pdf')).toBe(foldKey('FF.pdf'));
    expect(foldKey('ﬅ.pdf')).toBe(foldKey('st.pdf'));
    expect(foldKey('ſ.pdf')).toBe(foldKey('s.pdf'));
    expect(foldKey('ΟΔΟΣ.pdf')).toBe(foldKey('οδος.pdf'));
    expect(foldKey('οδοσ.pdf')).toBe(foldKey('οδος.pdf'));
  });

  it('keeps Turkish dotless ı distinct like APFS (ılık ≠ ilik, ilik ≡ ILIK, İ ≡ i̇)', () => {
    expect(foldKey('ılık.pdf')).not.toBe(foldKey('ilik.pdf'));
    expect(foldKey('sıcak.pdf')).not.toBe(foldKey('sicak.pdf'));
    expect(foldKey('ilik.pdf')).toBe(foldKey('ILIK.pdf'));
    expect(foldKey('I')).toBe(foldKey('i'));
    expect(foldKey('İ')).toBe(foldKey('i\u0307'));
  });

  it('lists proper ancestors', () => {
    expect(ancestorKeys('a/b/c.pdf')).toEqual(['a', 'a/b']);
    expect(ancestorKeys('c.pdf')).toEqual([]);
  });

  it('splits parent and base names', () => {
    expect(parentKey('a/b/c.pdf')).toBe('a/b');
    expect(parentKey('c.pdf')).toBe('');
    expect(baseName('a/b/c.pdf')).toBe('c.pdf');
  });

  it('isUnder compares folded path prefixes', () => {
    expect(isUnder('A/b.pdf', 'a')).toBe(true);
    expect(isUnder('a', 'a')).toBe(true);
    expect(isUnder('ab/c', 'a')).toBe(false);
    expect(isUnder('x', '')).toBe(true);
  });
});

describe('names', () => {
  it('ignores dot-files and part files', () => {
    expect(isIgnoredName('.marvin-sync-x')).toBe(true);
    expect(isIgnoredName('a.pdf.1234.marvin-part')).toBe(true);
    expect(isIgnoredName('a.pdf')).toBe(false);
  });

  it('rejects unrepresentable Drive names', () => {
    expect(isRepresentable('a/b')).toBe(false);
    expect(isRepresentable('a\0b')).toBe(false);
    expect(isRepresentable('')).toBe(false);
    expect(isRepresentable('ş'.repeat(128))).toBe(false); // 256 bytes
    expect(isRepresentable('ş'.repeat(127))).toBe(true);
  });
});

describe('validateRelPath', () => {
  it('accepts clean relative paths and returns NFC', () => {
    expect(validateRelPath(`docs/${NFD}`)).toBe('docs/şartname.pdf');
  });

  it.each(['', '/abs', '~/x', '../x', 'a/../b', 'a//b', './a', 'a/'])('rejects %j', (p) => {
    expect(() => validateRelPath(p)).toThrow(ValidationError);
  });
});

describe('filesystem containment', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'sync-paths-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('absInside rejects traversal', () => {
    expect(absInside(root, 'a/b.pdf')).toBe(path.join(root, 'a', 'b.pdf'));
    expect(() => absInside(root, '../x')).toThrow(ValidationError);
  });

  it('prepareParent creates plain directories', async () => {
    const abs = await prepareParent(root, 'a/b/c.pdf');
    expect(abs).toBe(path.join(root, 'a', 'b', 'c.pdf'));
    expect((await stat(path.join(root, 'a', 'b'))).isDirectory()).toBe(true);
  });

  it('prepareParent refuses symlinked and file components', async () => {
    const outside = await mkdtemp(path.join(os.tmpdir(), 'sync-out-'));
    try {
      await symlink(outside, path.join(root, 'link'));
      await expect(prepareParent(root, 'link/x.pdf')).rejects.toThrow(ValidationError);
      await writeFile(path.join(root, 'file'), 'x');
      await expect(prepareParent(root, 'file/x.pdf')).rejects.toThrow(ValidationError);
      await mkdir(path.join(root, 'ok'));
      await expect(prepareParent(root, 'ok/x.pdf')).resolves.toBe(path.join(root, 'ok', 'x.pdf'));
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});
