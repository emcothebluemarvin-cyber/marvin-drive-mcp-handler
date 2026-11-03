import { lstat, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { ValidationError, hasErrorCode } from '../errors.js';

export const PART_SUFFIX = '.marvin-part';
const MAX_SEGMENT_BYTES = 255;

/** NFC key of a relative path (POSIX separators). */
export function toKey(relPath: string): string {
  return relPath.split(path.sep).join('/').normalize('NFC');
}

/**
 * NFC + case fold matching APFS (spec §3): per-character upper-casing first folds ß/SS,
 * ligatures (ﬀ, ﬅ), long s and final sigma; Turkish dotless ı stays distinct from i
 * (APFS keeps `ılık` ≠ `ilik` while `ilik` ≡ `ILIK`).
 */
export function foldKey(key: string): string {
  return Array.from(key.normalize('NFC'))
    .map((c) => (c === 'ı' ? c : c.toUpperCase()))
    .join('')
    .toLowerCase()
    .normalize('NFC');
}

/** Proper ancestor keys of `key`, shortest first (`a/b/c` → `a`, `a/b`). */
export function ancestorKeys(key: string): string[] {
  const segments = key.split('/');
  return segments.slice(1).map((_, i) => segments.slice(0, i + 1).join('/'));
}

/** Dot-files (incl. the marker) and our own temp files are never synced (spec §6.10). */
export function isIgnoredName(name: string): boolean {
  return name.startsWith('.') || name.endsWith(PART_SUFFIX);
}

/** A Drive name that cannot be a single local path segment (spec §3). */
export function isRepresentable(name: string): boolean {
  return (
    name !== '' &&
    !name.includes('/') &&
    !name.includes('\0') &&
    Buffer.byteLength(name.normalize('NFC')) <= MAX_SEGMENT_BYTES
  );
}

/** Validates a user-supplied relative path and returns its key. */
export function validateRelPath(input: string): string {
  if (input === '' || input.includes('\0')) throw new ValidationError('Path must not be empty');
  if (path.posix.isAbsolute(input) || input.startsWith('~')) {
    throw new ValidationError(`"${input}" must be relative to the pair folder`);
  }
  const segments = input.split('/');
  for (const seg of segments) {
    if (seg === '' || seg === '.' || seg === '..') {
      throw new ValidationError(`"${input}" is not a clean relative path`);
    }
    if (Buffer.byteLength(seg.normalize('NFC')) > MAX_SEGMENT_BYTES) {
      throw new ValidationError(`"${input}" has a name longer than 255 bytes`);
    }
  }
  return input.normalize('NFC');
}

/** True when `key` equals `prefix` or lies below it (compared by foldKey). */
export function isUnder(key: string, prefix: string): boolean {
  if (prefix === '') return true;
  const k = foldKey(key);
  const p = foldKey(prefix);
  return k === p || k.startsWith(`${p}/`);
}

export function parentKey(key: string): string {
  const i = key.lastIndexOf('/');
  return i === -1 ? '' : key.slice(0, i);
}

export function baseName(key: string): string {
  return key.slice(key.lastIndexOf('/') + 1);
}

/** Absolute path of a relative name inside `root`; throws on traversal. */
export function absInside(root: string, rel: string): string {
  const abs = path.resolve(root, ...rel.split('/'));
  const back = path.relative(root, abs);
  if (back === '' || back.startsWith('..') || path.isAbsolute(back)) {
    throw new ValidationError(`Refusing to touch a path outside the pair folder: ${rel}`);
  }
  return abs;
}

/**
 * Creates the parent directories of `rel` inside `root`, refusing symlinked or
 * non-directory components, and returns the absolute path of `rel`.
 */
export async function prepareParent(root: string, rel: string): Promise<string> {
  const abs = absInside(root, rel);
  const segments = rel.split('/').slice(0, -1);
  let current = root;
  for (const seg of segments) {
    current = path.join(current, seg);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink() || !info.isDirectory()) {
        throw new ValidationError(`Refusing to write through ${current} (not a plain directory)`);
      }
    } catch (err) {
      if (!hasErrorCode(err, 'ENOENT')) throw err;
      await mkdir(current);
    }
  }
  return abs;
}
