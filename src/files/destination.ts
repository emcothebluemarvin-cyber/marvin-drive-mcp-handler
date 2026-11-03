import { link, lstat, mkdir, open, rm, stat, unlink, type FileHandle } from 'node:fs/promises';
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
    await lstat(p); // lstat: a dangling symlink counts as taken
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

interface Reservation {
  handle: FileHandle;
  partPath: string;
  index: number;
}

async function reserve(dest: Destination): Promise<Reservation> {
  for (let i = 0; i < MAX_COLLISIONS; i++) {
    const finalPath = path.join(dest.dir, candidateName(dest.name, i));
    assertInside(dest.dir, finalPath);
    if (await exists(finalPath)) continue;
    const partPath = `${finalPath}.part`;
    try {
      const handle = await open(partPath, 'wx', 0o644);
      return { handle, partPath, index: i };
    } catch (err) {
      if (hasErrorCode(err, 'EEXIST')) continue;
      throw err;
    }
  }
  throw new ValidationError(`Too many files named like "${dest.name}" in ${dest.dir}`);
}

/** Hard-links the part file to the first free final name (never overwrites), then drops the part. */
async function publish(dest: Destination, partPath: string, start: number): Promise<string> {
  for (let i = start; i < MAX_COLLISIONS; i++) {
    const finalPath = path.join(dest.dir, candidateName(dest.name, i));
    assertInside(dest.dir, finalPath);
    try {
      await link(partPath, finalPath);
    } catch (err) {
      if (hasErrorCode(err, 'EEXIST')) continue;
      throw err;
    }
    await unlink(partPath);
    return finalPath;
  }
  throw new ValidationError(`Too many files named like "${dest.name}" in ${dest.dir}`);
}

/**
 * Reserves a non-colliding `<name>.part` (exclusive create), streams `openSource()` into it,
 * then publishes via link+unlink. Never overwrites; removes the partial file on failure.
 */
export async function writeUnique(
  dest: Destination,
  openSource: () => Promise<Readable>,
): Promise<WrittenFile> {
  await mkdir(dest.dir, { recursive: true });
  const { handle, partPath, index } = await reserve(dest);
  let streamCreated = false;
  try {
    const source = await openSource();
    const out = handle.createWriteStream();
    streamCreated = true;
    await pipeline(source, out);
    const finalPath = await publish(dest, partPath, index);
    return { path: finalPath, size: (await stat(finalPath)).size };
  } catch (err) {
    if (!streamCreated) await handle.close().catch(() => undefined);
    await rm(partPath, { force: true });
    throw err;
  }
}
