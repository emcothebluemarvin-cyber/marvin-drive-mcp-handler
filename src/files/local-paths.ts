import { stat } from 'node:fs/promises';
import path from 'node:path';
import { ValidationError } from '../errors.js';
import { expandHome } from './destination.js';

export interface UploadPath {
  localPath: string;
  size: number;
}

/** Checks a local upload source: absolute (`~` allowed) and a regular file. */
export async function resolveUploadPath(input: string): Promise<UploadPath> {
  const expanded = expandHome(input);
  if (!path.isAbsolute(expanded)) {
    throw new ValidationError(`localPath must be an absolute path (got "${input}")`);
  }
  const localPath = path.resolve(expanded);
  try {
    const info = await stat(localPath);
    if (!info.isFile()) throw new ValidationError(`${localPath} is not a regular file`);
    return { localPath, size: info.size };
  } catch (err) {
    if (err instanceof ValidationError) throw err;
    throw new ValidationError(`Cannot read ${localPath}`, { cause: err });
  }
}
