import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { ConfigError } from '../../errors.js';
import { loadMicrosoftClientId } from '../microsoft-client.js';

const GUID = '11111111-2222-4333-8444-555555555555';
let file: string;

beforeEach(async () => {
  file = path.join(await mkdtemp(path.join(os.tmpdir(), 'ms-client-')), 'microsoft-client.json');
});

describe('loadMicrosoftClientId', () => {
  it('returns the client id', async () => {
    await writeFile(file, JSON.stringify({ clientId: GUID }));
    await expect(loadMicrosoftClientId(file)).resolves.toBe(GUID);
  });

  it('explains the registration when the file is missing', async () => {
    await expect(loadMicrosoftClientId(file)).rejects.toThrow(ConfigError);
    await expect(loadMicrosoftClientId(file)).rejects.toThrow(
      /App registrations[\s\S]*Files\.ReadWrite/,
    );
  });

  it('rejects invalid JSON and a value that is not a guid', async () => {
    await writeFile(file, '{');
    await expect(loadMicrosoftClientId(file)).rejects.toThrow(/not valid JSON/);
    await writeFile(file, JSON.stringify({ clientId: 'nope' }));
    await expect(loadMicrosoftClientId(file)).rejects.toThrow(/must contain/);
  });
});
