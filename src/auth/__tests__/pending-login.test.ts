import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { AuthFlowError, ConfigError } from '../../errors.js';
import { PENDING_LOGIN_TTL_MS, PendingLoginStore } from '../pending-login.js';

let file: string;
let clock: Date;
let store: PendingLoginStore;

const entry = (state: string) =>
  ({
    state,
    codeVerifier: `v-${state}`,
    redirectUri: 'http://127.0.0.1:50000',
    command: 'add',
    account: 'work',
  }) as const;

beforeEach(async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'marvin-pending-'));
  file = path.join(dir, 'nested', 'pending-logins.json');
  clock = new Date('2026-11-06T10:00:00Z');
  store = new PendingLoginStore(file, () => clock);
});

describe('PendingLoginStore', () => {
  it('returns a saved login once, then forgets it', async () => {
    await store.save(entry('s1'));
    await expect(store.take('s1')).resolves.toMatchObject({
      ...entry('s1'),
      createdAt: '2026-11-06T10:00:00.000Z',
    });
    await expect(store.take('s1')).resolves.toBeNull();
  });

  it('keeps other pending logins and removes the file when the last one is taken', async () => {
    await store.save(entry('s1'));
    await store.save(entry('s2'));
    await store.take('s1');
    await expect(store.take('s2')).resolves.toMatchObject({ state: 's2' });
    await expect(stat(file)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects an expired login and removes it', async () => {
    await store.save(entry('s1'));
    clock = new Date(clock.getTime() + PENDING_LOGIN_TTL_MS + 1);
    await expect(store.take('s1')).rejects.toThrow(AuthFlowError);
    await expect(store.take('s1')).resolves.toBeNull();
  });

  it('drops expired logins when saving a new one', async () => {
    await store.save(entry('old'));
    clock = new Date(clock.getTime() + PENDING_LOGIN_TTL_MS + 1);
    await store.save(entry('new'));
    const data = JSON.parse(await readFile(file, 'utf8')) as { logins: { state: string }[] };
    expect(data.logins.map((l) => l.state)).toEqual(['new']);
  });

  it('returns null for an unknown state', async () => {
    await expect(store.take('nope')).resolves.toBeNull();
  });

  it.skipIf(process.platform === 'win32')('writes the file 0600 in a 0700 directory', async () => {
    await store.save(entry('s1'));
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect((await stat(path.dirname(file))).mode & 0o777).toBe(0o700);
  });

  it('reports a damaged file as ConfigError', async () => {
    await store.save(entry('s1'));
    await writeFile(file, '{oops');
    await expect(store.take('s1')).rejects.toThrow(ConfigError);
  });
});

describe('PendingLogin provider', () => {
  const ENTRY = {
    state: 's',
    codeVerifier: 'v',
    redirectUri: 'http://localhost:1',
    command: 'add',
    account: null,
  } as const;

  it('keeps the provider and peeks it without consuming the entry', async () => {
    const store = new PendingLoginStore(
      path.join(await mkdtemp(path.join(os.tmpdir(), 'pend-')), 'p.json'),
    );
    await store.save({ ...ENTRY, provider: 'microsoft' });
    await expect(store.peekProvider('s')).resolves.toBe('microsoft');
    await expect(store.take('s')).resolves.toMatchObject({ provider: 'microsoft' });
    await expect(store.peekProvider('s')).resolves.toBeNull();
  });

  it('treats an absent provider as google', async () => {
    const store = new PendingLoginStore(
      path.join(await mkdtemp(path.join(os.tmpdir(), 'pend-')), 'p.json'),
    );
    await store.save(ENTRY);
    await expect(store.peekProvider('s')).resolves.toBe('google');
  });

  it('rejects a file with an unknown provider', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'pend-'));
    const file = path.join(dir, 'p.json');
    await writeFile(
      file,
      JSON.stringify({ version: 1, logins: [{ ...ENTRY, createdAt: 'x', provider: 'other' }] }),
    );
    await expect(new PendingLoginStore(file).peekProvider('s')).rejects.toThrow(ConfigError);
  });
});
