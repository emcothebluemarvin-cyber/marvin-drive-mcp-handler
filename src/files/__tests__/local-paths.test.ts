import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { ValidationError } from '../../errors.js';
import { clampPageSize } from '../file-provider.js';
import { resolveUploadPath } from '../local-paths.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'local-paths-'));
});

describe('resolveUploadPath', () => {
  it('returns the absolute path and size', async () => {
    const file = path.join(dir, 'a.txt');
    await writeFile(file, 'abc');
    await expect(resolveUploadPath(file)).resolves.toEqual({ localPath: file, size: 3 });
  });

  it.each([
    ['relative paths', () => 'a.txt', /absolute/],
    ['missing files', () => path.join(dir, 'none'), /Cannot read/],
    ['folders', () => dir, /not a regular file/],
  ])('rejects %s', async (_name, input, message) => {
    await expect(resolveUploadPath(input())).rejects.toThrow(ValidationError);
    await expect(resolveUploadPath(input())).rejects.toThrow(message);
  });
});

describe('clampPageSize', () => {
  it('clamps to 1..200 and defaults to 50', () => {
    expect(clampPageSize(undefined)).toBe(50);
    expect(clampPageSize(0)).toBe(1);
    expect(clampPageSize(999)).toBe(200);
  });
});
