import { stat } from 'node:fs/promises';
import { expect } from 'vitest';

/**
 * Asserts POSIX permission bits. Windows has no POSIX modes (Node reports 0o666/0o777),
 * so there it only asserts that the path exists.
 */
export async function expectMode(p: string, mode: number): Promise<void> {
  const info = await stat(p);
  if (process.platform !== 'win32') expect(info.mode & 0o777).toBe(mode);
}
