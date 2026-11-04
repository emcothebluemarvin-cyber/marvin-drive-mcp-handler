import { rename as fsRename } from 'node:fs/promises';
import { hasErrorCode } from '../errors.js';

/** Windows reports a target held open by another process (antivirus, indexer, editor) like this. */
const TRANSIENT_WIN32 = ['EPERM', 'EACCES', 'EBUSY'];
const ATTEMPTS = 6;
const BASE_DELAY_MS = 50;

export interface RenameReplacingOptions {
  platform?: NodeJS.Platform;
  rename?: (from: string, to: string) => Promise<void>;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * rename() that replaces an existing target. On Windows a briefly locked target makes the
 * rename fail with EPERM/EACCES/EBUSY, so it is retried a few times (≈1.5 s in total).
 * Other platforms and other errors fail immediately.
 */
export async function renameReplacing(
  from: string,
  to: string,
  opts: RenameReplacingOptions = {},
): Promise<void> {
  const rename = opts.rename ?? fsRename;
  const sleep = opts.sleep ?? defaultSleep;
  const retries = (opts.platform ?? process.platform) === 'win32';
  for (let attempt = 1; ; attempt++) {
    try {
      await rename(from, to);
      return;
    } catch (err) {
      const transient = retries && TRANSIENT_WIN32.some((code) => hasErrorCode(err, code));
      if (!transient || attempt >= ATTEMPTS) throw err;
      await sleep(BASE_DELAY_MS * 2 ** (attempt - 1));
    }
  }
}
