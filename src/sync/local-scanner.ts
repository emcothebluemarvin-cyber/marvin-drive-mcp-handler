import { createHash } from 'node:crypto';
import { createReadStream, type Stats } from 'node:fs';
import { lstat, readdir } from 'node:fs/promises';
import path from 'node:path';
import { ValidationError, hasErrorCode } from '../errors.js';
import { PART_SUFFIX, absInside, ancestorKeys, foldKey, isIgnoredName, toKey } from './paths.js';
import { QuickXorHash } from './remote/quickxor.js';
import type { HashKind } from './remote/sync-remote.js';
import type { LocalDigests, LocalScan, OnDiskProbe } from './types.js';

/** An incremental digest of one hash kind. */
export interface Digester {
  update(chunk: Buffer): void;
  digest(): string;
}

/** Makes a digester for a remote's hash kind (injectable; quickXor plugs in here). */
export type DigesterFactory = (kind: HashKind) => Digester;

/** md5 (hex) and QuickXorHash (base64, OneDrive). */
export const defaultDigesters: DigesterFactory = (kind) => {
  if (kind === 'quickXor') {
    const qx = new QuickXorHash();
    return {
      update: (chunk): void => {
        qx.update(chunk);
      },
      digest: (): string => qx.digest(),
    };
  }
  const hash = createHash('md5');
  return {
    update: (chunk): void => {
      hash.update(chunk);
    },
    digest: (): string => hash.digest('hex'),
  };
};

/** md5 and, when `kind` is not md5, the digest of `kind`, in one read (spec §3.1). */
export async function hashFileDigests(
  abs: string,
  kind: HashKind,
  digesters: DigesterFactory = defaultDigesters,
): Promise<LocalDigests> {
  const md5 = createHash('md5');
  const other = kind === 'md5' ? null : digesters(kind);
  for await (const chunk of createReadStream(abs)) {
    const buf = chunk as Buffer;
    md5.update(buf);
    other?.update(buf);
  }
  const value = md5.digest('hex');
  return {
    md5: value,
    remote: other ? { kind, value: other.digest() } : { kind: 'md5', value },
  };
}

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

/** Digests of the given on-disk relative names; failures are returned, not thrown. */
export async function hashLocal(
  root: string,
  names: readonly string[],
  kind: HashKind,
  digesters: DigesterFactory = defaultDigesters,
): Promise<{ digests: Map<string, LocalDigests>; failed: string[] }> {
  const digests = new Map<string, LocalDigests>();
  const failed: string[] = [];
  for (const name of names) {
    try {
      digests.set(name, await hashFileDigests(absInside(root, name), kind, digesters));
    } catch {
      failed.push(name);
    }
  }
  return { digests, failed };
}
