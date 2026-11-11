import { createHash, randomUUID } from 'node:crypto';
import { link as fsLink, lstat, open, readdir, rename, rm, unlink } from 'node:fs/promises';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { hasErrorCode } from '../errors.js';
import {
  ChecksumMismatchError,
  CollisionError,
  SizeMismatchError,
  TargetChangedError,
} from './errors.js';
import { defaultDigesters, type DigesterFactory } from './local-scanner.js';
import { PART_SUFFIX } from './paths.js';
import type { ContentHash } from './remote/sync-remote.js';
import { renameReplacing } from '../files/rename-replacing.js';

export type LinkFn = (existingPath: string, newPath: string) => Promise<void>;

export interface StatExpect {
  size: number;
  mtimeMs: number;
  ctimeMs: number;
}

export interface Written {
  path: string;
  md5: string;
  size: number;
}

const LINK_UNSUPPORTED = ['EPERM', 'ENOTSUP', 'EXDEV', 'ENOSYS'];

async function exists(p: string): Promise<boolean> {
  try {
    await lstat(p);
    return true;
  } catch (err) {
    if (hasErrorCode(err, 'ENOENT')) return false;
    throw err;
  }
}

/** What a download must match (OneDrive sync spec §3.3); null/undefined: no check. */
export interface DownloadCheck {
  /** The remote's hash: md5 is always computed, another kind through `digesters`. */
  expected?: ContentHash | null;
  /** The remote's size; a different byte count fails the write. */
  expectedSize?: number | null;
  digesters?: DigesterFactory;
}

/**
 * Streams `source` into a fresh `.<uuid>.marvin-part` in `dir`, hashing and fsyncing it,
 * then checks it against `check`. On a mismatch or error the temp file is removed.
 */
async function writeTemp(
  dir: string,
  source: Readable,
  what: string,
  check: DownloadCheck,
): Promise<{ tmp: string; md5: string; size: number }> {
  const tmp = path.join(dir, `.${randomUUID()}${PART_SUFFIX}`);
  const handle = await open(tmp, 'wx', 0o644);
  const hash = createHash('md5');
  const expected = check.expected ?? null;
  const other =
    expected !== null && expected.kind !== 'md5'
      ? (check.digesters ?? defaultDigesters)(expected.kind)
      : null;
  let size = 0;
  try {
    for await (const chunk of source) {
      const buf = typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer);
      hash.update(buf);
      other?.update(buf);
      size += buf.length;
      await handle.write(buf);
    }
    await handle.sync();
  } catch (err) {
    source.destroy();
    await handle.close().catch(() => undefined);
    await rm(tmp, { force: true });
    throw err;
  }
  await handle.close();
  const md5 = hash.digest('hex');
  try {
    if (expected !== null) {
      const actual = other ? other.digest() : md5;
      if (actual !== expected.value) {
        throw new ChecksumMismatchError(what, expected.value, actual, expected.kind);
      }
    }
    const expectedSize = check.expectedSize ?? null;
    if (expectedSize !== null && size !== expectedSize) {
      throw new SizeMismatchError(what, expectedSize, size);
    }
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
  return { tmp, md5, size };
}

/** fsync a directory so a new entry survives a crash (best effort where unsupported). */
export async function syncDir(
  dir: string,
  platform: NodeJS.Platform = process.platform,
): Promise<void> {
  if (platform === 'win32') return; // Windows has no directory fsync; NTFS journals the rename
  const handle = await open(dir, 'r');
  try {
    await handle.sync();
  } catch (err) {
    if (!['EINVAL', 'ENOTSUP', 'EISDIR', 'EBADF'].some((c) => hasErrorCode(err, c))) throw err;
  } finally {
    await handle.close();
  }
}

/** Throws TargetChangedError unless `target` is a regular file with the expected stat. */
export async function assertUnchanged(target: string, expect: StatExpect): Promise<void> {
  let info;
  try {
    info = await lstat(target);
  } catch (err) {
    if (hasErrorCode(err, 'ENOENT')) throw new TargetChangedError(`${target} was removed`);
    throw err;
  }
  if (
    !info.isFile() ||
    info.size !== expect.size ||
    info.mtimeMs !== expect.mtimeMs ||
    info.ctimeMs !== expect.ctimeMs
  ) {
    throw new TargetChangedError(`${target} changed since it was scanned`);
  }
}

export interface PlaceOptions extends DownloadCheck {
  /** Names tried: nameFor(0), nameFor(1)…; default 1 (plain exclusive create). */
  maxAttempts?: number;
  link?: LinkFn;
}

/**
 * Exclusive local write (spec §7): temp `.marvin-part` + `link` + EEXIST → next name or
 * CollisionError. Never overwrites. `dir` must already exist (see prepareParent).
 */
export async function placeExclusive(
  dir: string,
  nameFor: (attempt: number) => string,
  openSource: () => Promise<Readable>,
  opts: PlaceOptions = {},
): Promise<Written> {
  const link = opts.link ?? fsLink;
  const { tmp, md5, size } = await writeTemp(dir, await openSource(), nameFor(0), opts);
  try {
    const attempts = opts.maxAttempts ?? 1;
    for (let i = 0; i < attempts; i++) {
      const target = path.join(dir, nameFor(i));
      try {
        await link(tmp, target);
      } catch (err) {
        if (hasErrorCode(err, 'EEXIST')) continue;
        if (!LINK_UNSUPPORTED.some((code) => hasErrorCode(err, code))) throw err;
        if (await exists(target)) continue;
        await rename(tmp, target);
      }
      await syncDir(dir);
      return { path: target, md5, size };
    }
    throw new CollisionError(path.join(dir, nameFor(0)));
  } finally {
    await rm(tmp, { force: true });
  }
}

/**
 * Overwrites a tracked file's own path (spec §7): only if its stat still matches the
 * scan, both before the download and right before the rename.
 */
export async function downloadReplace(
  target: string,
  openSource: () => Promise<Readable>,
  opts: DownloadCheck & { expect: StatExpect },
): Promise<{ md5: string; size: number }> {
  await assertUnchanged(target, opts.expect);
  const { tmp, md5, size } = await writeTemp(
    path.dirname(target),
    await openSource(),
    target,
    opts,
  );
  try {
    await assertUnchanged(target, opts.expect);
    await renameReplacing(tmp, target);
  } finally {
    await rm(tmp, { force: true });
  }
  return { md5, size };
}

/** True when `a` and `b` are two different directory entries (not one name folded twice). */
async function distinctEntries(a: string, b: string): Promise<boolean> {
  const [dirA, dirB] = await Promise.all([lstat(path.dirname(a)), lstat(path.dirname(b))]);
  if (dirA.ino !== dirB.ino) return true;
  const names = await readdir(path.dirname(a));
  const nameA = path.basename(a);
  const nameB = path.basename(b);
  return nameA !== nameB && names.includes(nameA) && names.includes(nameB);
}

/**
 * Moves a tracked file to its new key without overwriting (spec §7). A target that is
 * the same inode with two links (crash between link and unlink) only drops the source;
 * the same inode with one link is the same directory entry under a name the volume
 * folds together (e.g. straße/STRASSE on APFS) and is renamed, never unlinked.
 */
export async function moveLocal(
  from: string,
  to: string,
  opts: { inPlace: boolean; expect: StatExpect; link?: LinkFn },
): Promise<void> {
  await assertUnchanged(from, opts.expect);
  const source = await lstat(from);
  if (opts.inPlace) {
    const existing = await lstat(to).catch((err: unknown) => {
      if (hasErrorCode(err, 'ENOENT')) return null;
      throw err;
    });
    if (existing && existing.ino !== source.ino) throw new CollisionError(to);
    await rename(from, to);
    return;
  }
  const link = opts.link ?? fsLink;
  try {
    await link(from, to);
  } catch (err) {
    if (hasErrorCode(err, 'EEXIST')) {
      if ((await lstat(to)).ino !== source.ino) throw new CollisionError(to);
      if (source.nlink < 2 || !(await distinctEntries(from, to))) {
        await rename(from, to);
        return;
      }
    } else if (LINK_UNSUPPORTED.some((code) => hasErrorCode(err, code))) {
      if (await exists(to)) throw new CollisionError(to);
      await rename(from, to);
      return;
    } else {
      throw err;
    }
  }
  await unlink(from);
}
