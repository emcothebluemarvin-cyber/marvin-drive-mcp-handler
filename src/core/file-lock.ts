import { randomUUID } from 'node:crypto';
import { link, open, readFile, rename, rm, stat } from 'node:fs/promises';
import { ValidationError, hasErrorCode } from '../errors.js';

/** An unreadable (partial) pid lock is stale only once it is this old. */
export const STALE_UNREADABLE_LOCK_MS = 60_000;

/** The lock is held by someone else. A ValidationError, so tools show the message. */
export class FileLockBusyError extends ValidationError {}

export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return hasErrorCode(err, 'EPERM');
  }
}

export async function holdsLock(lockFile: string, content: string): Promise<boolean> {
  try {
    return (await readFile(lockFile, 'utf8')) === content;
  } catch (err) {
    if (hasErrorCode(err, 'ENOENT')) return false;
    throw err;
  }
}

/** Staleness of a `{ pid, … }` lock: dead pid, or unreadable content older than a minute. */
export async function pidLockIsStale(
  lockFile: string,
  raw: string,
  isAlive: (pid: number) => boolean,
  now: () => Date,
): Promise<boolean> {
  try {
    const holder = JSON.parse(raw) as { pid?: unknown };
    if (typeof holder.pid === 'number') return !isAlive(holder.pid);
  } catch {
    // partial or corrupt content: decided by age below
  }
  // Unreadable/partial lock: stale only once it is old (a writer may be mid-create).
  try {
    const info = await stat(lockFile);
    return now().getTime() - info.mtimeMs > STALE_UNREADABLE_LOCK_MS;
  } catch (err) {
    if (hasErrorCode(err, 'ENOENT')) return true;
    throw err;
  }
}

/** Moves the stale lock aside; false (and restored) if it was replaced by a fresh one. */
export async function breakStaleLock(lockFile: string, raw: string): Promise<boolean> {
  const aside = `${lockFile}.${randomUUID()}.stale`;
  try {
    await rename(lockFile, aside);
  } catch (err) {
    if (hasErrorCode(err, 'ENOENT')) return true; // someone else broke it; retry O_EXCL
    throw err;
  }
  try {
    if ((await readFile(aside, 'utf8')) === raw) return true;
    // A fresh lock was taken after our staleness check: put it back untouched.
    await link(aside, lockFile).catch((err: unknown) => {
      if (!hasErrorCode(err, 'EEXIST')) throw err;
    });
    return false;
  } finally {
    await rm(aside, { force: true });
  }
}

export interface ExclusiveLockOptions {
  /** Lock content, built per attempt (include a random token so the holder is identifiable). */
  content: () => string;
  isStale: (raw: string) => Promise<boolean>;
  busyMessage: string;
  onBreak?: () => void;
  onLostRelease?: () => void;
}

/**
 * O_EXCL lock file; returns the release function. A stale lock is moved aside under a
 * unique name and re-checked, so two processes breaking the same stale lock cannot both
 * end up holding it. Release removes the file only while it still holds our content.
 */
export async function acquireExclusive(
  lockFile: string,
  opts: ExclusiveLockOptions,
): Promise<() => Promise<void>> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const content = opts.content();
      const handle = await open(lockFile, 'wx', 0o600);
      try {
        await handle.writeFile(content);
      } finally {
        await handle.close();
      }
      if (!(await holdsLock(lockFile, content))) throw new FileLockBusyError(opts.busyMessage);
      return async () => {
        if (await holdsLock(lockFile, content)) await rm(lockFile, { force: true });
        else opts.onLostRelease?.();
      };
    } catch (err) {
      if (!hasErrorCode(err, 'EEXIST')) throw err;
      const raw = await readFile(lockFile, 'utf8').catch((readErr: unknown) => {
        if (hasErrorCode(readErr, 'ENOENT')) return null;
        throw readErr;
      });
      if (raw === null) continue; // released meanwhile
      if (!(await opts.isStale(raw)) || !(await breakStaleLock(lockFile, raw))) {
        throw new FileLockBusyError(opts.busyMessage);
      }
      opts.onBreak?.();
    }
  }
  throw new FileLockBusyError(opts.busyMessage);
}
