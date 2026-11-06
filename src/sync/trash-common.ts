import { execFile } from 'node:child_process';
import * as fsp from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { hasErrorCode, ValidationError } from '../errors.js';
import { LocalTrashError } from './errors.js';

/** Moves one regular file to the OS trash. Never deletes, never overwrites (local trash spec §3). */
export interface LocalTrash {
  trash(absPath: string): Promise<void>;
}

/** Runs a program without a shell; rejects on a non-zero exit. */
export type ExecFn = (file: string, args: readonly string[]) => Promise<{ stdout: string }>;

const execFileAsync = promisify(execFile);

export const defaultExec: ExecFn = async (file, args) => {
  const { stdout } = await execFileAsync(file, [...args], { encoding: 'utf8', windowsHide: true });
  return { stdout };
};

/** The filesystem calls the trash implementations use; tests inject fakes. */
export interface TrashFs {
  lstat: typeof fsp.lstat;
  stat: typeof fsp.stat;
  mkdir: typeof fsp.mkdir;
  open: typeof fsp.open;
  unlink: typeof fsp.unlink;
  rename: typeof fsp.rename;
  /** fs.promises.realpath resolves through the OS (realpath.native), incl. mapped drives on Windows. */
  realpath: (p: string) => Promise<string>;
}

export const nodeTrashFs: TrashFs = {
  lstat: fsp.lstat,
  stat: fsp.stat,
  mkdir: fsp.mkdir,
  open: fsp.open,
  unlink: fsp.unlink,
  rename: fsp.rename,
  realpath: (p) => fsp.realpath(p),
};

/** Shared checks before any write (spec §3): absolute path, regular file. ENOENT propagates. */
export async function checkTrashable(absPath: string, fs: TrashFs): Promise<void> {
  if (!path.isAbsolute(absPath)) {
    throw new ValidationError(`trash needs an absolute path (got "${absPath}")`);
  }
  const info = await fs.lstat(absPath);
  if (!info.isFile()) {
    throw new ValidationError(
      `${absPath} is not a regular file; only files can be moved to the trash`,
    );
  }
}

/** The chosen trash name is already taken; the caller tries the next name. */
class NameTakenError extends Error {}

async function exists(p: string, fs: TrashFs): Promise<boolean> {
  try {
    await fs.lstat(p);
    return true;
  } catch (err) {
    if (hasErrorCode(err, 'ENOENT')) return false;
    throw err;
  }
}

/** True only when the path is confirmed absent; any other outcome counts as "still there". */
async function confirmedGone(p: string, fs: TrashFs): Promise<boolean> {
  return exists(p, fs).then(
    (present) => !present,
    () => false,
  );
}

/**
 * Runs the part of a trash() after the shared checks (spec §3): every failure becomes a
 * LocalTrashError, except ENOENT when the file itself is confirmed gone, so the executor
 * reports "already gone" only when that is true.
 */
export async function afterChecks(
  absPath: string,
  fs: TrashFs,
  body: () => Promise<void>,
): Promise<void> {
  try {
    await body();
  } catch (err) {
    if (err instanceof LocalTrashError) throw err;
    if (hasErrorCode(err, 'ENOENT') && (await confirmedGone(absPath, fs))) throw err;
    throw trashFailure(absPath, 'the trash could not be prepared', err);
  }
}

/**
 * fsync a directory so a rename or a new entry survives a crash (POSIX only; Windows
 * cannot open directories for fsync). Durability hint only: the operation it follows
 * already happened, so a failing fsync must not turn a done move into a failed action.
 */
async function syncDir(dir: string, fs: TrashFs): Promise<void> {
  if (process.platform === 'win32') return;
  try {
    const handle = await fs.open(dir, 'r');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {
    // Intentionally ignored: see the doc comment.
  }
}

/** Spec §4: target must be free, then one atomic rename. Never unlink, never copy. */
export async function placeInTrash(file: string, target: string, fs: TrashFs): Promise<void> {
  if (await exists(target, fs)) throw new NameTakenError(target);
  await fs.rename(file, target);
  await syncDir(path.dirname(target), fs);
  await syncDir(path.dirname(file), fs);
}

function describeMoveError(err: unknown): string {
  if (hasErrorCode(err, 'EXDEV')) return 'the trash is on a different filesystem';
  if (hasErrorCode(err, 'EPERM') || hasErrorCode(err, 'EBUSY') || hasErrorCode(err, 'EACCES')) {
    return 'file is in use or access was denied';
  }
  return 'the move failed';
}

export function trashFailure(absPath: string, reason: string, cause?: unknown): LocalTrashError {
  return new LocalTrashError(
    `Could not move ${absPath} to the trash: ${reason}. Nothing was deleted.`,
    cause === undefined ? undefined : { cause },
  );
}

export interface ReserveAndMove {
  file: string;
  fs: TrashFs;
  /** Candidate names in order; each gives the metadata path and the target path. */
  names: Iterable<{ meta: string; target: string }>;
  metadata: string | Buffer;
}

/**
 * Reserve a name by creating its metadata file exclusively (O_EXCL), write and fsync it,
 * then move the file (spec §5.2, §6.2). On failure our metadata file is removed;
 * ENOENT of the source is rethrown unchanged so the executor reports "already gone".
 */
export async function reserveAndMove(job: ReserveAndMove): Promise<void> {
  const { file, fs } = job;
  for (const { meta, target } of job.names) {
    let handle: fsp.FileHandle;
    try {
      handle = await fs.open(meta, 'wx', 0o600);
    } catch (err) {
      if (hasErrorCode(err, 'EEXIST')) continue;
      throw trashFailure(file, 'could not write the trash record', err);
    }
    try {
      try {
        await handle.writeFile(job.metadata);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await syncDir(path.dirname(meta), fs);
      await placeInTrash(file, target, fs);
      return;
    } catch (err) {
      await removeOwnRecord(meta, fs);
      if (err instanceof NameTakenError) continue;
      if (hasErrorCode(err, 'ENOENT') && (await confirmedGone(file, fs))) throw err;
      throw trashFailure(file, describeMoveError(err), err);
    }
  }
  throw trashFailure(file, 'no free name in the trash');
}

/** Best effort: a leftover record without its file loses nothing (spec §7). */
async function removeOwnRecord(meta: string, fs: TrashFs): Promise<void> {
  try {
    await fs.unlink(meta);
  } catch {
    // Intentionally ignored: an orphan trash record is harmless.
  }
}
