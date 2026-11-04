import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { ConfigError } from '../../errors.js';
import { FileTokenStore } from '../file-token-store.js';

let file: string;
let store: FileTokenStore;

beforeEach(async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'marvin-tokens-'));
  file = path.join(dir, 'nested', 'tokens.json');
  store = new FileTokenStore(file);
});

describe('FileTokenStore', () => {
  it('returns null when the file does not exist', async () => {
    await expect(store.get('a@example.com')).resolves.toBeNull();
  });

  it('stores, replaces and deletes tokens per email, idempotent delete', async () => {
    await store.set('a@example.com', 'rt-a');
    await store.set('b@example.com', 'rt-b');
    await store.set('a@example.com', 'rt-a2');
    await expect(store.get('a@example.com')).resolves.toBe('rt-a2');
    await store.delete('a@example.com');
    await expect(store.get('a@example.com')).resolves.toBeNull();
    await expect(store.get('b@example.com')).resolves.toBe('rt-b');
    await expect(store.delete('a@example.com')).resolves.toBeUndefined();
  });

  it('persists across instances in a versioned JSON file', async () => {
    await store.set('a@example.com', 'rt-a');
    await expect(new FileTokenStore(file).get('a@example.com')).resolves.toBe('rt-a');
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({
      version: 1,
      tokens: { 'a@example.com': 'rt-a' },
    });
  });

  it.skipIf(process.platform === 'win32')('writes the file 0600 in a 0700 directory', async () => {
    await store.set('a@example.com', 'rt-a');
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect((await stat(path.dirname(file))).mode & 0o777).toBe(0o700);
  });

  it('rejects a corrupt file with a ConfigError naming the path', async () => {
    await store.set('a@example.com', 'rt-a');
    await writeFile(file, '{not json');
    await expect(store.get('a@example.com')).rejects.toThrow(ConfigError);
    await expect(store.get('a@example.com')).rejects.toThrow(file);
    await writeFile(file, JSON.stringify({ version: 1, tokens: { x: 5 } }));
    await expect(store.get('x')).rejects.toThrow(ConfigError);
  });
});
