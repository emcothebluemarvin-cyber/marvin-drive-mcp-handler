import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Auth } from 'googleapis';
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { AuthService } from '../../auth/auth-service.js';
import { InMemoryTokenStore } from '../../auth/token-store.js';
import { AccountRegistry } from '../../config/account-registry.js';
import { ReauthRequiredError } from '../../errors.js';
import { createLogger } from '../../logger.js';
import { DriveClientFactory, type DriveContext, type GoogleAdapters } from '../client-factory.js';

const invalidGrant = (): Error =>
  Object.assign(new Error('invalid_grant'), { response: { data: { error: 'invalid_grant' } } });

let tokens: InMemoryTokenStore;
let auth: AuthService;
let makeAdapter: Mock<(client: Auth.OAuth2Client) => GoogleAdapters>;
let factory: DriveClientFactory;

beforeEach(async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'marvin-factory-'));
  const registry = new AccountRegistry(path.join(dir, 'accounts.json'));
  await registry.add({ alias: 'emco', email: 'emco@example.com' });
  tokens = new InMemoryTokenStore();
  await tokens.set('emco@example.com', 'rt-1');
  auth = new AuthService({
    registry,
    tokens,
    loadCredentials: async () => ({
      clientId: 'cid.apps.googleusercontent.com',
      clientSecret: 's',
    }),
    login: async () => {
      throw new Error('not used');
    },
    logger: createLogger(() => {}),
  });
  let n = 0;
  makeAdapter = vi.fn(
    (_client: Auth.OAuth2Client) => ({ drive: { id: ++n } }) as unknown as GoogleAdapters,
  );
  factory = new DriveClientFactory(auth, makeAdapter);
});

const adapterId = (ctx: DriveContext): number => (ctx.drive as unknown as { id: number }).id;

describe('DriveClientFactory', () => {
  it('caches one adapter per account while the token is unchanged', async () => {
    const a = await factory.run(undefined, async (ctx) => adapterId(ctx));
    const b = await factory.run('emco', async (ctx) => adapterId(ctx));
    expect(a).toBe(1);
    expect(b).toBe(1);
    expect(makeAdapter).toHaveBeenCalledTimes(1);
  });

  it('rebuilds when the stored token changes between calls', async () => {
    await factory.run(undefined, async (ctx) => adapterId(ctx));
    await tokens.set('emco@example.com', 'rt-2');
    expect(await factory.run(undefined, async (ctx) => adapterId(ctx))).toBe(2);
  });

  it('throws ReauthRequiredError and flags the account when the token is dead', async () => {
    await expect(
      factory.run(undefined, async () => {
        throw invalidGrant();
      }),
    ).rejects.toThrow(ReauthRequiredError);
    expect((await auth.status())[0]?.status).toBe('reauth_required');
  });

  it('retries once with a token refreshed by another process', async () => {
    const seen: number[] = [];
    const result = await factory.run(undefined, async (ctx) => {
      seen.push(adapterId(ctx));
      if (seen.length === 1) {
        await tokens.set('emco@example.com', 'rt-new'); // simulates `auth login` elsewhere
        throw invalidGrant();
      }
      return 'ok';
    });
    expect(result).toBe('ok');
    expect(seen).toEqual([1, 2]);
  });

  it('marks the account healthy again after a successful call', async () => {
    auth.markReauthRequired('emco@example.com');
    await factory.run(undefined, async () => 'ok');
    expect((await auth.status())[0]?.status).toBe('ok');
  });

  it('passes other errors through unchanged', async () => {
    const boom = new Error('boom');
    await expect(
      factory.run(undefined, async () => {
        throw boom;
      }),
    ).rejects.toBe(boom);
  });

  it('throws ReauthRequiredError when no token is stored', async () => {
    await tokens.delete('emco@example.com');
    await expect(factory.run(undefined, async () => 'x')).rejects.toThrow(ReauthRequiredError);
  });

  it('rejects concurrent invalid_grant calls with ReauthRequiredError', async () => {
    const fail = async (): Promise<never> => {
      throw invalidGrant();
    };
    const results = await Promise.allSettled([
      factory.run(undefined, fail),
      factory.run(undefined, fail),
    ]);
    for (const r of results) {
      expect(r.status).toBe('rejected');
      expect((r as PromiseRejectedResult).reason).toBeInstanceOf(ReauthRequiredError);
    }
  });

  it('logs a warning and raises ReauthRequiredError when the Keychain re-read fails', async () => {
    const warn = vi.fn();
    const logger = { info: vi.fn(), warn, error: vi.fn() };
    const f = new DriveClientFactory(auth, makeAdapter, logger);
    const original = tokens.get.bind(tokens);
    let broken = false;
    vi.spyOn(tokens, 'get').mockImplementation(async (email: string) => {
      if (broken) throw new Error('keychain locked');
      return original(email);
    });
    await expect(
      f.run(undefined, async () => {
        broken = true;
        throw invalidGrant();
      }),
    ).rejects.toThrow(ReauthRequiredError);
    expect(warn).toHaveBeenCalledWith(
      'Keychain re-read failed',
      expect.objectContaining({ alias: 'emco' }),
    );
  });
});
