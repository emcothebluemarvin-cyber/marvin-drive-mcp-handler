import { createWriteStream } from 'node:fs';
import { mkdir, open, rename, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { ValidationError, hasErrorCode } from '../errors.js';
import { candidateName, ensureExtension, sanitizeFileName } from './filename.js';

export interface DestinationInput {
  destPath?: string;
  defaultDir: string;
  driveName: string;
  fileId: string;
  extension?: string;
}

export interface Destination {
  dir: string;
  name: string;
}

export interface WrittenFile {
  path: string;
  size: number;
}

const MAX_COLLISIONS = 1000;

function expandHome(p: string): string {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

async function isDirectory(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory();
  } catch (err) {
    if (hasErrorCode(err, 'ENOENT')) return false;
    throw err;
  }
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch (err) {
    if (hasErrorCode(err, 'ENOENT')) return false;
    throw err;
  }
}

/** Spec §6 download rule 6: where a download goes and under which (sanitized) name. */
export async function resolveDestination(input: DestinationInput): Promise<Destination> {
  const generated = ensureExtension(
    sanitizeFileName(input.driveName, input.fileId),
    input.extension,
  );
  if (input.destPath === undefined || input.destPath.trim() === '') {
    return { dir: path.resolve(input.defaultDir), name: generated };
  }
  const resolved = path.resolve(expandHome(input.destPath));
  if (input.destPath.endsWith('/') || (await isDirectory(resolved))) {
    return { dir: resolved, name: generated };
  }
  return { dir: path.dirname(resolved), name: path.basename(resolved) };
}

/** Throws unless `target` is strictly inside `dir`. */
export function assertInside(dir: string, target: string): void {
  const rel = path.relative(path.resolve(dir), path.resolve(target));
  if (rel === '' || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    throw new ValidationError(`Refusing to write outside ${dir}`);
  }
}

async function reserve(dest: Destination): Promise<{ finalPath: string; partPath: string }> {
  for (let i = 0; i < MAX_COLLISIONS; i++) {
    const finalPath = path.join(dest.dir, candidateName(dest.name, i));
    assertInside(dest.dir, finalPath);
    if (await exists(finalPath)) continue;
    const partPath = `${finalPath}.part`;
    try {
      const handle = await open(partPath, 'wx', 0o644);
      await handle.close();
      return { finalPath, partPath };
    } catch (err) {
      if (hasErrorCode(err, 'EEXIST')) continue;
      throw err;
    }
  }
  throw new ValidationError(`Too many files named like "${dest.name}" in ${dest.dir}`);
}

/**
 * Reserves a non-colliding `<name>.part` (exclusive create), streams `openSource()` into it,
 * then renames to the final name. Never overwrites; removes the partial file on failure.
 */
export async function writeUnique(
  dest: Destination,
  openSource: () => Promise<Readable>,
): Promise<WrittenFile> {
  await mkdir(dest.dir, { recursive: true });
  const { finalPath, partPath } = await reserve(dest);
  try {
    const source = await openSource();
    await pipeline(source, createWriteStream(partPath));
    await rename(partPath, finalPath);
    return { path: finalPath, size: (await stat(finalPath)).size };
  } catch (err) {
    await rm(partPath, { force: true });
    throw err;
  }
}
