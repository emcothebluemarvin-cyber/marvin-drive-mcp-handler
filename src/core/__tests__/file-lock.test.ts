import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ValidationError } from '../../errors.js';
import {
  FileLockBusyError,
  acquireExclusive,
  holdsLock,
  pidLockIsStale,
  type ExclusiveLockOptions,
} from '../file-lock.js';

let dir: string;
let lockFile: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'file-lock-'));
  lockFile = path.join(dir, 'x.lock');
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function options(over: Partial<ExclusiveLockOptions> = {}): ExclusiveLockOptions {
  return {
    content: () => JSON.stringify({ pid: process.pid, token: randomUUID() }),
    isStale: async () => false,
    busyMessage: 'busy!',
    ...over,
  };
}

describe('acquireExclusive', () => {
  it('locks exclusively and releases', async () => {
    const release = await acquireExclusive(lockFile, options());
    const second = acquireExclusive(lockFile, options());
    await expect(second).rejects.toBeInstanceOf(FileLockBusyError);
    await expect(acquireExclusive(lockFile, options())).rejects.toBeInstanceOf(ValidationError);
    await expect(acquireExclusive(lockFile, options())).rejects.toThrow('busy!');
    await release();
    await expect(readFile(lockFile)).rejects.toThrow();
  });

  it('breaks a stale lock and reports it', async () => {
    await writeFile(lockFile, 'old');
    const onBreak = vi.fn();
    const release = await acquireExclusive(
      lockFile,
      options({ isStale: async (raw) => raw === 'old', onBreak }),
    );
    expect(onBreak).toHaveBeenCalledTimes(1);
    expect(await readFile(lockFile, 'utf8')).not.toBe('old');
    await release();
  });

  it('does not remove a lock that was taken over', async () => {
    const onLostRelease = vi.fn();
    const release = await acquireExclusive(lockFile, options({ onLostRelease }));
    await writeFile(lockFile, 'foreign');
    await release();
    expect(await readFile(lockFile, 'utf8')).toBe('foreign');
    expect(onLostRelease).toHaveBeenCalledTimes(1);
  });

  it('holdsLock compares the exact content', async () => {
    await writeFile(lockFile, 'abc');
    expect(await holdsLock(lockFile, 'abc')).toBe(true);
    expect(await holdsLock(lockFile, 'abd')).toBe(false);
    expect(await holdsLock(path.join(dir, 'missing'), 'abc')).toBe(false);
  });
});

describe('pidLockIsStale', () => {
  const now = (): Date => new Date();

  it('is stale when the holder pid is dead, not when alive', async () => {
    await writeFile(lockFile, JSON.stringify({ pid: 4242 }));
    const raw = JSON.stringify({ pid: 4242 });
    expect(await pidLockIsStale(lockFile, raw, () => false, now)).toBe(true);
    expect(await pidLockIsStale(lockFile, raw, () => true, now)).toBe(false);
  });

  it('treats unreadable content as stale only after a minute', async () => {
    await writeFile(lockFile, '');
    expect(await pidLockIsStale(lockFile, '', () => true, now)).toBe(false);
    const old = new Date(Date.now() - 120_000);
    await utimes(lockFile, old, old);
    expect(await pidLockIsStale(lockFile, '', () => true, now)).toBe(true);
  });
});
