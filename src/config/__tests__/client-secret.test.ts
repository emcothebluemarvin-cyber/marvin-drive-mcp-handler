import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { ConfigError } from '../../errors.js';
import { loadClientSecret } from '../client-secret.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'marvin-secret-'));
});

describe('loadClientSecret', () => {
  it('reads the Google installed-client format', async () => {
    const file = path.join(dir, 'client_secret.json');
    await writeFile(
      file,
      JSON.stringify({
        installed: { client_id: '123-abc.apps.googleusercontent.com', client_secret: 'GOCSPX-x' },
      }),
    );
    await expect(loadClientSecret(file)).resolves.toEqual({
      clientId: '123-abc.apps.googleusercontent.com',
      clientSecret: 'GOCSPX-x',
    });
  });

  it('names the expected path when the file is missing', async () => {
    const file = path.join(dir, 'missing.json');
    await expect(loadClientSecret(file)).rejects.toThrow(ConfigError);
    await expect(loadClientSecret(file)).rejects.toThrow(file);
  });

  it('does not claim "not found" for other read errors', async () => {
    const err = await loadClientSecret(dir).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConfigError);
    expect((err as Error).message).toMatch(/Cannot read .*EISDIR/);
    expect((err as Error).message).not.toMatch(/not found/);
  });

  it('rejects invalid JSON and wrong shapes', async () => {
    const bad = path.join(dir, 'bad.json');
    await writeFile(bad, 'not json');
    await expect(loadClientSecret(bad)).rejects.toThrow(/not valid JSON/);
    await writeFile(bad, JSON.stringify({ web: {} }));
    await expect(loadClientSecret(bad)).rejects.toThrow(/Desktop client format/);
  });
});
