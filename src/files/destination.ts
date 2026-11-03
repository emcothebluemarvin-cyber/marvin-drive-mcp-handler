import {
  link,
  lstat,
  mkdir,
  open,
  rename,
  rm,
  stat,
  unlink,
  type FileHandle,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { ValidationError, hasErrorCode } from '../errors.js';
import { logger } from '../logger.js';
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

export function expandHome(p: string): string {
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
  const expanded = expandHome(input.destPath);
  if (!path.isAbsolute(expanded)) {
    throw new ValidationError(`destPath must be an absolute path (got "${input.destPath}")`);
  }
  const resolved = path.resolve(expanded);
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

export interface FsOps {
  link: (existingPath: string, newPath: string) => Promise<void>;
}

const LINK_UNSUPPORTED = ['EPERM', 'ENOTSUP', 'EXDEV', 'ENOSYS'];

/**
 * Hard-links the part file to the first free final name (never overwrites), then drops the part.
 * Where hard links are unsupported, falls back to an existence check + rename.
 */
async function publish(
  dest: Destination,
  partPath: string,
  start: number,
  ops: FsOps,
): Promise<string> {
  for (let i = start; i < MAX_COLLISIONS; i++) {
    const finalPath = path.join(dest.dir, candidateName(dest.name, i));
    assertInside(dest.dir, finalPath);
    try {
      await ops.link(partPath, finalPath);
    } catch (err) {
      if (hasErrorCode(err, 'EEXIST')) continue;
      if (LINK_UNSUPPORTED.some((code) => hasErrorCode(err, code))) {
        if (await exists(finalPath)) continue;
        await rename(partPath, finalPath);
        return finalPath;
      }
      throw err;
    }
    try {
      await unlink(partPath);
    } catch (unlinkErr) {
      logger.warn('Could not remove temporary download file', { partPath, error: unlinkErr });
    }
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
  ops: FsOps = { link },
): Promise<WrittenFile> {
  await mkdir(dest.dir, { recursive: true });
  const { handle, partPath, index } = await reserve(dest);
  let streamCreated = false;
  let finalPath: string;
  let written = 0;
  try {
    const source = await openSource();
    const out = handle.createWriteStream();
    streamCreated = true;
    source.on('data', (chunk: Buffer | string) => {
      written += Buffer.byteLength(chunk);
    });
    await pipeline(source, out);
    finalPath = await publish(dest, partPath, index, ops);
  } catch (err) {
    if (!streamCreated) await handle.close().catch(() => undefined);
    await rm(partPath, { force: true });
    throw err;
  }
  try {
    return { path: finalPath, size: (await stat(finalPath)).size };
  } catch (statErr) {
    logger.warn('Could not stat downloaded file', { path: finalPath, error: statErr });
    return { path: finalPath, size: written };
  }
}
