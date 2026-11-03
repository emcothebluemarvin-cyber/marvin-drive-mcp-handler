import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { ValidationError } from '../errors.js';
import { LocalTrashError } from './errors.js';

/** Runs a program without a shell; rejects on a non-zero exit. */
export type ExecFn = (file: string, args: readonly string[]) => Promise<unknown>;

export const TRASH_BIN = '/usr/bin/trash';

const execFileAsync = promisify(execFile);

export const defaultExec: ExecFn = (file, args) => execFileAsync(file, [...args]);

/** Moves one path to the macOS Trash via `/usr/bin/trash -s` (spec §7). Never unlinks. */
export async function trashLocal(absPath: string, exec: ExecFn): Promise<void> {
  if (!path.isAbsolute(absPath)) {
    throw new ValidationError(`trash needs an absolute path (got "${absPath}")`);
  }
  try {
    await exec(TRASH_BIN, ['-s', absPath]);
  } catch (err) {
    throw new LocalTrashError(
      `Could not move ${absPath} to the Trash (volumes without a Trash are not supported)`,
      { cause: err },
    );
  }
}
