import { createHash } from 'node:crypto';
import { createReadStream, type Stats } from 'node:fs';
import { lstat, readdir } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { ValidationError, hasErrorCode } from '../errors.js';
import { PART_SUFFIX, absInside, ancestorKeys, foldKey, isIgnoredName, toKey } from './paths.js';
import type { LocalScan, OnDiskProbe } from './types.js';

export interface LocalScanOptions {
  /** On-disk relative directory to restrict the scan to (sync_scan `subdir`). */
  subdir?: string;
}

/**
 * Walks `root` without following symlinks (spec §4 local-scanner). Unreadable or
 * vanishing entries become unknown subtrees; ignored and non-regular entries are
 * recorded as `occupied` so the planner never treats their keys as absent, and
 * symlinks/specials/dot-named folders as `blocking` (nothing below them is absent).
 */
export async function scanLocal(root: string, options: LocalScanOptions = {}): Promise<LocalScan> {
  const out: LocalScan = {
    entries: [],
    occupied: [],
    unknownSubtrees: [],
    blocking: [],
    partFiles: [],
  };
  const start = options.subdir ?? '';
  if (start !== '') {
    const abs = absInside(root, start);
    const info = await lstat(abs).catch(() => null);
    if (!info?.isDirectory()) throw new ValidationError(`${start} is not a folder in the pair`);
  }
  await walk(root, start, out, true);
  out.entries.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return out;
}

async function walk(
  root: string,
  dirName: string,
  out: LocalScan,
  isStart: boolean,
): Promise<void> {
  const dirAbs = dirName === '' ? root : absInside(root, dirName);
  let names: string[];
  try {
    names = (await readdir(dirAbs)).sort();
  } catch (err) {
    if (isStart) throw err;
    out.unknownSubtrees.push(toKey(dirName));
    return;
  }
  for (const base of names) {
    const name = dirName === '' ? base : `${dirName}/${base}`;
    const key = toKey(name);
    const abs = path.join(dirAbs, base);
    let info;
    try {
      info = await lstat(abs);
    } catch {
      out.unknownSubtrees.push(key); // vanished or unreadable during the scan
      continue;
    }
    if (isIgnoredName(base)) {
      out.occupied.push(key);
      if (!info.isFile()) out.blocking.push(key); // dot-named folder, symlink or special
      if (base.endsWith(PART_SUFFIX) && info.isFile()) {
        out.partFiles.push({ name, mtimeMs: info.mtimeMs });
      }
      continue;
    }
    if (info.isDirectory()) {
      out.occupied.push(key);
      await walk(root, name, out, false);
    } else if (info.isFile()) {
      out.entries.push({
        key,
        foldKey: foldKey(key),
        name,
        size: info.size,
        mtimeMs: info.mtimeMs,
        ctimeMs: info.ctimeMs,
        ino: info.ino,
      });
    } else {
      out.occupied.push(key); // symlink, socket, FIFO, device
      out.blocking.push(key);
    }
  }
}

/** lstat of keys without an exact scan match; ENOENT keys are omitted (spec §6.1 step 4). */
export async function probeOnDisk(
  root: string,
  keys: readonly string[],
  lstatFn: (p: string) => Promise<Stats> = lstat,
): Promise<Map<string, OnDiskProbe>> {
  const found = new Map<string, OnDiskProbe>();
  for (const key of keys) {
    try {
      const info = await lstatFn(absInside(root, key));
      const kind = info.isFile()
        ? 'file'
        : info.isDirectory()
          ? 'dir'
          : info.isSymbolicLink()
            ? 'symlink'
            : 'other';
      found.set(key, { kind, ino: info.ino });
    } catch (err) {
      if (!hasErrorCode(err, 'ENOENT') || (await blockedByNonDirectory(root, key, lstatFn))) {
        found.set(key, { kind: 'error', ino: 0 });
      }
    }
  }
  return found;
}

/**
 * True when an existing ancestor of `key` is not a directory. POSIX reports that case as
 * ENOTDIR, but Windows reports ENOENT; both must count as an error, never as absence.
 */
async function blockedByNonDirectory(
  root: string,
  key: string,
  lstatFn: (p: string) => Promise<Stats>,
): Promise<boolean> {
  for (const ancestor of ancestorKeys(key)) {
    try {
      if (!(await lstatFn(absInside(root, ancestor))).isDirectory()) return true;
    } catch (err) {
      if (hasErrorCode(err, 'ENOENT')) return false; // a missing folder: the key is absent
      return true;
    }
  }
  return false;
}

export async function md5File(abs: string): Promise<string> {
  const hash = createHash('md5');
  await pipeline(createReadStream(abs), hash);
  return hash.digest('hex');
}

/** Hashes the given on-disk relative names; failures are returned, not thrown. */
export async function hashLocal(
  root: string,
  names: readonly string[],
): Promise<{ md5s: Map<string, string>; failed: string[] }> {
  const md5s = new Map<string, string>();
  const failed: string[] = [];
  for (const name of names) {
    try {
      md5s.set(name, await md5File(absInside(root, name)));
    } catch {
      failed.push(name);
    }
  }
  return { md5s, failed };
}
