import { chmod, mkdir, mkdtemp, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { AccountNotFoundError, ConfigError, ValidationError } from '../../errors.js';
import { AccountRegistry, defaultAlias } from '../account-registry.js';
import { expectMode } from '../../__tests__/fs-mode.js';

let file: string;
let registry: AccountRegistry;
const NOW = new Date('2026-11-03T10:00:00.000Z');

beforeEach(async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'marvin-reg-'));
  file = path.join(dir, 'nested', 'accounts.json');
  registry = new AccountRegistry(file);
});

describe('defaultAlias', () => {
  it('derives a valid alias from the email local part', () => {
    expect(defaultAlias('alice@example.com')).toBe('alice');
    expect(defaultAlias('John.Doe+x@ex.com')).toBe('john-doe-x');
    expect(defaultAlias('___@ex.com')).toBe('account');
    expect(defaultAlias(`${'a'.repeat(40)}@ex.com`)).toHaveLength(32);
  });
});

describe('AccountRegistry', () => {
  it('starts empty when the file does not exist', async () => {
    await expect(registry.read()).resolves.toEqual({ default: null, accounts: [] });
  });

  it('adds accounts, makes the first one default, writes 0600', async () => {
    await registry.add({ alias: 'emco', email: 'Emco@Example.com' }, NOW);
    await registry.add({ alias: 'work', email: 'work@example.com' }, NOW);
    const data = await registry.read();
    expect(data.default).toBe('emco');
    expect(data.accounts).toEqual([
      { alias: 'emco', email: 'emco@example.com', addedAt: NOW.toISOString() },
      { alias: 'work', email: 'work@example.com', addedAt: NOW.toISOString() },
    ]);
    await expectMode(file, 0o600);
  });

  it('rejects invalid aliases, duplicate emails and duplicate aliases', async () => {
    await registry.add({ alias: 'emco', email: 'emco@example.com' }, NOW);
    await expect(registry.add({ alias: 'Bad Alias', email: 'x@example.com' })).rejects.toThrow(
      ValidationError,
    );
    await expect(registry.add({ alias: 'other', email: 'EMCO@example.com' })).rejects.toThrow(
      /already registered as "emco"/,
    );
    await expect(registry.add({ alias: 'emco', email: 'new@example.com' })).rejects.toThrow(
      /Alias "emco" is already used/,
    );
  });

  it('rejects emails without a valid shape before writing', async () => {
    await expect(registry.add({ alias: 'a', email: 'nope' })).rejects.toThrow(ValidationError);
    await expect(registry.add({ alias: 'a', email: 'a@b@c' })).rejects.toThrow(ValidationError);
    await expect(registry.read()).resolves.toEqual({ default: null, accounts: [] });
  });

  it('tightens an existing config dir to 0700', async () => {
    const dir = path.dirname(file);
    await mkdir(dir, { mode: 0o755 });
    await chmod(dir, 0o755);
    await registry.add({ alias: 'emco', email: 'emco@example.com' }, NOW);
    await expectMode(dir, 0o700);
  });

  it('resolves by alias, email, default, or single account', async () => {
    await expect(registry.resolve()).rejects.toThrow(/No accounts registered/);
    await registry.add({ alias: 'emco', email: 'emco@example.com' }, NOW);
    await expect(registry.resolve()).resolves.toMatchObject({ alias: 'emco' });
    await registry.add({ alias: 'work', email: 'work@example.com' }, NOW);
    await expect(registry.resolve('work')).resolves.toMatchObject({ alias: 'work' });
    await expect(registry.resolve('WORK@example.com')).resolves.toMatchObject({ alias: 'work' });
    await expect(registry.resolve('nope')).rejects.toThrow(AccountNotFoundError);
    await expect(registry.resolve('nope')).rejects.toThrow(/emco \(emco@example.com\)/);
  });

  it('errors when several accounts exist and no default is set', async () => {
    const twoFile = path.join(path.dirname(path.dirname(file)), 'two.json');
    await writeFile(
      twoFile,
      JSON.stringify({
        default: null,
        accounts: [
          { alias: 'a', email: 'a@x.com', addedAt: NOW.toISOString() },
          { alias: 'b', email: 'b@x.com', addedAt: NOW.toISOString() },
        ],
      }),
    );
    await expect(new AccountRegistry(twoFile).resolve()).rejects.toThrow(/No default account/);
  });

  it('removes accounts and reassigns the default', async () => {
    await registry.add({ alias: 'emco', email: 'emco@example.com' }, NOW);
    await registry.add({ alias: 'work', email: 'work@example.com' }, NOW);
    const removed = await registry.remove('emco');
    expect(removed.alias).toBe('emco');
    expect((await registry.read()).default).toBe('work');
    await registry.remove('work@example.com');
    expect(await registry.read()).toEqual({ default: null, accounts: [] });
  });

  it('sets the default account', async () => {
    await registry.add({ alias: 'emco', email: 'emco@example.com' }, NOW);
    await registry.add({ alias: 'work', email: 'work@example.com' }, NOW);
    await registry.setDefault('work');
    expect((await registry.read()).default).toBe('work');
  });

  it('re-reads the file when another process changes it (mtime)', async () => {
    await registry.add({ alias: 'emco', email: 'emco@example.com' }, NOW);
    await registry.read(); // populate cache
    const data = {
      default: 'work',
      accounts: [
        { alias: 'emco', email: 'emco@example.com', addedAt: NOW.toISOString() },
        { alias: 'work', email: 'work@example.com', addedAt: NOW.toISOString() },
      ],
    };
    await writeFile(file, JSON.stringify(data));
    const later = new Date(Date.now() + 5_000);
    await utimes(file, later, later);
    expect((await registry.read()).default).toBe('work');
  });

  it('reports a corrupted file as ConfigError', async () => {
    await registry.add({ alias: 'emco', email: 'emco@example.com' }, NOW);
    await writeFile(file, '{"default": 5}');
    const later = new Date(Date.now() + 10_000);
    await utimes(file, later, later);
    await expect(registry.read()).rejects.toThrow(ConfigError);
  });
});
