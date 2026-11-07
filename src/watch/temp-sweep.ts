import { readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';

/** Temp files of atomic writes older than this are leftovers of a crash. */
export const STALE_TEMP_MS = 60 * 60 * 1000;

/**
 * Best effort: removes `.*.tmp` files older than an hour directly in `dir`. Real clock on
 * purpose (compared with file mtimes). Never throws.
 */
export async function sweepStaleTemps(dir: string): Promise<void> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return;
  }
  const cutoff = Date.now() - STALE_TEMP_MS;
  for (const name of names) {
    if (!name.startsWith('.') || !name.endsWith('.tmp')) continue;
    const file = path.join(dir, name);
    try {
      if ((await stat(file)).mtimeMs < cutoff) await rm(file, { force: true });
    } catch {
      // vanished or not removable: ignored
    }
  }
}
