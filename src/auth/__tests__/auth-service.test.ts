import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Auth } from 'googleapis';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AccountRegistry } from '../../config/account-registry.js';
import { AuthFlowError, ReauthRequiredError, ValidationError } from '../../errors.js';
import { createLogger } from '../../logger.js';
import { AuthService, type AuthServiceDeps } from '../auth-service.js';
import type { LoginResult } from '../login-flow.js';
import { InMemoryTokenStore } from '../token-store.js';

const CREDS = { clientId: 'cid.apps.googleusercontent.com', clientSecret: 'secret' };
const invalidGrant = (): Error =>
  Object.assign(new Error('invalid_grant'), { response: { data: { error: 'invalid_grant' } } });

let registry: AccountRegistry;
let tokens: InMemoryTokenStore;
let login: ReturnType<typeof vi.fn<AuthServiceDeps['login']>>;
let service: AuthService;

beforeEach(async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'marvin-auth-'));
  registry = new AccountRegistry(path.join(dir, 'accounts.json'));
  tokens = new InMemoryTokenStore();
  login = vi.fn<AuthServiceDeps['login']>();
  service = new AuthService({
    registry,
    tokens,
    loadCredentials: async () => CREDS,
    login,
    newClient: (creds) =>
      new Auth.OAuth2Client({ clientId: creds.clientId, clientSecret: creds.clientSecret }),
    logger: createLogger(() => {}),
  });
});

const signIn = (email: string, refreshToken = `rt-${email}`): LoginResult => ({
  email,
  refreshToken,
});

describe('AuthService.addAccount', () => {
  it('registers the account, stores the token, first account is default', async () => {
    login.mockResolvedValueOnce(signIn('emco@example.com', 'rt-1'));
    const record = await service.addAccount();
    expect(record).toMatchObject({ alias: 'emco', email: 'emco@example.com' });
    expect(await tokens.get('emco@example.com')).toBe('rt-1');
    expect((await registry.read()).default).toBe('emco');
    expect(login).toHaveBeenCalledWith({ credentials: CREDS });
  });

  it('checks an explicit alias before opening the browser', async () => {
    login.mockResolvedValueOnce(signIn('emco@example.com'));
    await service.addAccount('emco');
    await expect(service.addAccount('emco')).rejects.toThrow(ValidationError);
    await expect(service.addAccount('Not Valid')).rejects.toThrow(ValidationError);
    expect(login).toHaveBeenCalledTimes(1);
  });

  it('keeps the existing token when the email is already registered', async () => {
    login.mockResolvedValueOnce(signIn('emco@example.com', 'rt-old'));
    await service.addAccount();
    login.mockResolvedValueOnce(signIn('emco@example.com', 'rt-new'));
    await expect(service.addAccount('second')).rejects.toThrow(/already registered/);
    expect(await tokens.get('emco@example.com')).toBe('rt-old');
  });
});

describe('AuthService.relogin', () => {
  beforeEach(async () => {
    login.mockResolvedValueOnce(signIn('emco@example.com', 'rt-old'));
    await service.addAccount();
  });

  it('replaces the token and passes a login hint', async () => {
    login.mockResolvedValueOnce(signIn('emco@example.com', 'rt-new'));
    await service.relogin('emco');
    expect(login).toHaveBeenLastCalledWith({ credentials: CREDS, loginHint: 'emco@example.com' });
    expect(await tokens.get('emco@example.com')).toBe('rt-new');
  });

  it('refuses a different Google account and saves nothing', async () => {
    login.mockResolvedValueOnce(signIn('other@example.com', 'rt-other'));
    await expect(service.relogin('emco')).rejects.toThrow(AuthFlowError);
    expect(await tokens.get('emco@example.com')).toBe('rt-old');
    expect(await tokens.get('other@example.com')).toBeNull();
  });
});

describe('AuthService.removeAccount', () => {
  it('removes registry entry and token, revokes best effort', async () => {
    login.mockResolvedValueOnce(signIn('emco@example.com', 'rt-1'));
    await service.addAccount();
    const revoke = vi
      .spyOn(Auth.OAuth2Client.prototype, 'revokeToken')
      .mockRejectedValueOnce(new Error('network down'));
    await expect(service.removeAccount('emco')).resolves.toMatchObject({ alias: 'emco' });
    expect(revoke).toHaveBeenCalledWith('rt-1');
    expect(await tokens.get('emco@example.com')).toBeNull();
    expect((await registry.read()).accounts).toEqual([]);
    revoke.mockRestore();
  });
});

describe('AuthService.removeAccount token failures', () => {
  it('still removes the registry entry and revokes when token deletion fails', async () => {
    login.mockResolvedValueOnce(signIn('emco@example.com', 'rt-1'));
    await service.addAccount();
    tokens.delete = async () => {
      throw new Error('keychain locked');
    };
    const revoke = vi
      .spyOn(Auth.OAuth2Client.prototype, 'revokeToken')
      .mockRejectedValueOnce(new Error('network down'));
    await expect(service.removeAccount('emco')).resolves.toMatchObject({ alias: 'emco' });
    expect((await registry.read()).accounts).toEqual([]);
    expect(revoke).toHaveBeenCalledWith('rt-1');
    revoke.mockRestore();
  });
});

describe('AuthService.authorize', () => {
  it('throws ReauthRequiredError when no token is stored', async () => {
    await registry.add({ alias: 'emco', email: 'emco@example.com' });
    await expect(service.authorize('emco')).rejects.toThrow(ReauthRequiredError);
  });

  it('returns a client with the refresh token and persists rotated tokens', async () => {
    login.mockResolvedValueOnce(signIn('emco@example.com', 'rt-1'));
    await service.addAccount();
    const { client, refreshToken, account } = await service.authorize();
    expect(refreshToken).toBe('rt-1');
    expect(account.alias).toBe('emco');
    expect(client.credentials.refresh_token).toBe('rt-1');
    client.emit('tokens', { refresh_token: 'rt-2' });
    await vi.waitFor(async () => expect(await tokens.get('emco@example.com')).toBe('rt-2'));
  });
});

describe('AuthService.status', () => {
  beforeEach(async () => {
    login.mockResolvedValueOnce(signIn('emco@example.com', 'rt-1'));
    await service.addAccount();
    await registry.add({ alias: 'notoken', email: 'notoken@example.com' });
  });

  it('reports token presence without network calls by default', async () => {
    await expect(service.status()).resolves.toEqual([
      { alias: 'emco', email: 'emco@example.com', isDefault: true, status: 'ok' },
      {
        alias: 'notoken',
        email: 'notoken@example.com',
        isDefault: false,
        status: 'reauth_required',
      },
    ]);
  });

  it('remembers accounts flagged during this process', async () => {
    service.markReauthRequired('emco@example.com');
    expect((await service.status())[0]?.status).toBe('reauth_required');
    service.markHealthy('emco@example.com');
    expect((await service.status())[0]?.status).toBe('ok');
  });

  it('verify=true reports unknown for non-grant errors instead of rejecting', async () => {
    const spy = vi
      .spyOn(Auth.OAuth2Client.prototype, 'getAccessToken')
      .mockRejectedValueOnce(new Error('ECONNRESET'));
    const result = await service.status(true);
    expect(result[0]?.status).toBe('unknown');
    spy.mockRestore();
  });

  it('verify=true performs a live refresh', async () => {
    const spy = vi
      .spyOn(Auth.OAuth2Client.prototype, 'getAccessToken')
      .mockRejectedValueOnce(invalidGrant());
    expect((await service.status(true))[0]?.status).toBe('reauth_required');
    spy.mockImplementationOnce(async () => ({ token: 'at', res: null }));
    expect((await service.status(true))[0]?.status).toBe('ok');
    spy.mockRestore();
  });
});
