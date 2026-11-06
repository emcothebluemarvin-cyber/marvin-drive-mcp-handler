import { symlink } from 'node:fs/promises';
import type { TestContext } from 'vitest';
import { hasErrorCode } from '../errors.js';

/**
 * Directory link for tests. On Windows a junction: it needs no privilege, and Node's lstat
 * reports it as a symbolic link, so the code under test sees the same thing as on POSIX.
 */
export async function linkDir(target: string, at: string): Promise<void> {
  await symlink(target, at, process.platform === 'win32' ? 'junction' : 'dir');
}

/**
 * File symlink for tests. Windows refuses these (EPERM) without Developer Mode or admin
 * rights; the test is skipped there instead of failing.
 */
export async function linkFileOrSkip(ctx: TestContext, target: string, at: string): Promise<void> {
  try {
    await symlink(target, at, 'file');
  } catch (err) {
    if (process.platform === 'win32' && hasErrorCode(err, 'EPERM')) {
      ctx.skip('file symlinks need Developer Mode or admin rights on Windows');
    }
    throw err;
  }
}
