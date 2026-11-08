import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Auth } from 'googleapis';
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { AccountRegistry } from '../../config/account-registry.js';
import { AuthFlowError, ConfigError, ReauthRequiredError, ValidationError } from '../../errors.js';
import { createLogger } from '../../logger.js';
import { AuthService, type AuthServiceDeps } from '../auth-service.js';
import type { LoginResult } from '../login-flow.js';
import { PendingLoginStore, type PendingLogin } from '../pending-login.js';
import type { ProviderAuth } from '../provider-auth.js';
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

/** Fake login that behaves like runLoginFlow: runs onVerified before "answering the browser". */
const answer =
  (result: LoginResult): AuthServiceDeps['login'] =>
  async (opts) => {
    await opts.onVerified(result);
    return result;
  };

describe('AuthService.addAccount', () => {
  it('registers the account, stores the token, first account is default', async () => {
    login.mockImplementationOnce(answer(signIn('emco@example.com', 'rt-1')));
    const record = await service.addAccount();
    expect(record).toMatchObject({ alias: 'emco', email: 'emco@example.com' });
    expect(await tokens.get('emco@example.com')).toBe('rt-1');
    expect((await registry.read()).default).toBe('emco');
    expect(login).toHaveBeenCalledWith(expect.objectContaining({ credentials: CREDS }));
  });

  it('checks an explicit alias before opening the browser', async () => {
    login.mockImplementationOnce(answer(signIn('emco@example.com')));
    await service.addAccount('emco');
    await expect(service.addAccount('emco')).rejects.toThrow(ValidationError);
    await expect(service.addAccount('Not Valid')).rejects.toThrow(ValidationError);
    expect(login).toHaveBeenCalledTimes(1);
  });

  it('keeps the existing token when the email is already registered', async () => {
    login.mockImplementationOnce(answer(signIn('emco@example.com', 'rt-old')));
    await service.addAccount();
    login.mockImplementationOnce(answer(signIn('emco@example.com', 'rt-new')));
    await expect(service.addAccount('second')).rejects.toThrow(/already registered/);
    expect(await tokens.get('emco@example.com')).toBe('rt-old');
  });
});

describe('AuthService saves inside the login flow', () => {
  it('registers the account before the browser is answered', async () => {
    let savedBeforeAnswer = false;
    login.mockImplementationOnce(async (opts) => {
      const result = signIn('emco@example.com', 'rt-1');
      await opts.onVerified(result);
      savedBeforeAnswer = (await tokens.get('emco@example.com')) === 'rt-1';
      return result;
    });
    await service.addAccount();
    expect(savedBeforeAnswer).toBe(true);
  });

  it('fails the flow (and saves nothing) when onVerified is never reached', async () => {
    login.mockResolvedValueOnce(signIn('emco@example.com', 'rt-1'));
    await expect(service.addAccount()).rejects.toThrow(/without saving/);
    expect(await tokens.get('emco@example.com')).toBeNull();
  });
});

describe('AuthService.relogin', () => {
  beforeEach(async () => {
    login.mockImplementationOnce(answer(signIn('emco@example.com', 'rt-old')));
    await service.addAccount();
  });

  it('replaces the token and passes a login hint', async () => {
    login.mockImplementationOnce(answer(signIn('emco@example.com', 'rt-new')));
    await service.relogin('emco');
    expect(login).toHaveBeenLastCalledWith(
      expect.objectContaining({ credentials: CREDS, loginHint: 'emco@example.com' }),
    );
    expect(await tokens.get('emco@example.com')).toBe('rt-new');
  });

  it('refuses a different Google account and saves nothing', async () => {
    login.mockImplementationOnce(answer(signIn('other@example.com', 'rt-other')));
    await expect(service.relogin('emco')).rejects.toThrow(AuthFlowError);
    expect(await tokens.get('emco@example.com')).toBe('rt-old');
    expect(await tokens.get('other@example.com')).toBeNull();
  });
});

describe('AuthService.removeAccount', () => {
  it('removes registry entry and token, revokes best effort', async () => {
    login.mockImplementationOnce(answer(signIn('emco@example.com', 'rt-1')));
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
    login.mockImplementationOnce(answer(signIn('emco@example.com', 'rt-1')));
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
    login.mockImplementationOnce(answer(signIn('emco@example.com', 'rt-1')));
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
    login.mockImplementationOnce(answer(signIn('emco@example.com', 'rt-1')));
    await service.addAccount();
    await registry.add({ alias: 'notoken', email: 'notoken@example.com' });
  });

  it('reports token presence without network calls by default', async () => {
    await expect(service.status()).resolves.toEqual([
      {
        alias: 'emco',
        email: 'emco@example.com',
        provider: 'google',
        isDefault: true,
        status: 'ok',
      },
      {
        alias: 'notoken',
        email: 'notoken@example.com',
        provider: 'google',
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

describe('two-step login', () => {
  let pending: PendingLoginStore;
  let finish: ReturnType<typeof vi.fn<NonNullable<AuthServiceDeps['twoStep']>['finish']>>;
  let starts: Array<string | undefined>;
  let two: AuthService;
  let nextState: number;

  beforeEach(async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'marvin-two-step-'));
    pending = new PendingLoginStore(path.join(dir, 'pending-logins.json'));
    finish = vi.fn<NonNullable<AuthServiceDeps['twoStep']>['finish']>();
    starts = [];
    nextState = 0;
    two = new AuthService({
      registry,
      tokens,
      loadCredentials: async () => CREDS,
      login,
      twoStep: {
        pending,
        start: async (_creds, loginHint) => {
          starts.push(loginHint);
          nextState += 1;
          return {
            authUrl: `https://accounts.example/auth?n=${nextState}`,
            state: `st${nextState}`,
            codeVerifier: `v${nextState}`,
            redirectUri: 'http://127.0.0.1:50001',
          };
        },
        finish,
      },
      logger: createLogger(() => {}),
    });
  });

  const redirect = (state: string): string => `http://127.0.0.1:50001/?state=${state}&code=c`;

  it('adds an account in two runs and forgets the pending login', async () => {
    await expect(two.startAddAccount('Work')).resolves.toBe('https://accounts.example/auth?n=1');
    finish.mockResolvedValueOnce(signIn('w@example.com', 'rt-w'));
    await expect(two.finishAddAccount('work', redirect('st1'))).resolves.toMatchObject({
      alias: 'work',
      email: 'w@example.com',
    });
    expect(finish.mock.calls[0]?.[1]).toMatchObject({ state: 'st1', codeVerifier: 'v1' });
    expect(await tokens.get('w@example.com')).toBe('rt-w');
    await expect(pending.take('st1')).resolves.toBeNull();
  });

  it('checks the alias before printing the URL', async () => {
    await registry.add({ alias: 'work', email: 'w@example.com' });
    await expect(two.startAddAccount('work')).rejects.toThrow(ValidationError);
    expect(starts).toEqual([]);
  });

  it('refuses a redirect URL for another alias or command, and it cannot be retried', async () => {
    await two.startAddAccount('work');
    await expect(two.finishAddAccount('home', redirect('st1'))).rejects.toThrow(
      /belongs to "auth add" for work/,
    );
    await expect(two.finishAddAccount('work', redirect('st1'))).rejects.toThrow(
      /No login is waiting/,
    );
    expect(finish).not.toHaveBeenCalled();
    expect((await registry.read()).accounts).toEqual([]);
  });

  it('refuses a URL nobody started', async () => {
    await expect(two.finishAddAccount(undefined, redirect('ghost'))).rejects.toThrow(AuthFlowError);
  });

  it('re-logs in an account with its email as hint and rejects another Google account', async () => {
    await registry.add({ alias: 'work', email: 'w@example.com' });
    await tokens.set('w@example.com', 'rt-old');
    await two.startRelogin('work');
    expect(starts).toEqual(['w@example.com']);
    finish.mockResolvedValueOnce(signIn('other@example.com', 'rt-x'));
    await expect(two.finishRelogin('work', redirect('st1'))).rejects.toThrow(/Nothing was saved/);
    expect(await tokens.get('w@example.com')).toBe('rt-old');

    await two.startRelogin('work');
    finish.mockResolvedValueOnce(signIn('w@example.com', 'rt-new'));
    await two.finishRelogin('work', redirect('st2'));
    expect(await tokens.get('w@example.com')).toBe('rt-new');
  });
});

describe('AuthService token keys and email references', () => {
  it('looks up a shared address as the Google account on Google-only surfaces', async () => {
    login.mockImplementationOnce(answer(signIn('same@example.com', 'rt-google')));
    await service.addAccount('g');
    await registry.add({
      alias: 'ms',
      email: 'same@example.com',
      provider: 'microsoft',
      accountId: 't.o',
    });
    await expect(service.resolveAccount('same@example.com')).resolves.toMatchObject({ alias: 'g' });
    const { refreshToken } = await service.authorize('same@example.com');
    expect(refreshToken).toBe('rt-google');
  });
});

describe('AuthService dispatch to the Microsoft provider', () => {
  const REF = {
    alias: 'ms',
    email: 'same@example.com',
    provider: 'microsoft',
    accountId: 't.o',
  } as const;
  const LOGIN_URL = 'https://login.example/authorize';
  let pending: PendingLoginStore;
  let dir: string;
  let provider: { [K in keyof ProviderAuth]: Mock<ProviderAuth[K]> };
  let loadCredentials: Mock<AuthServiceDeps['loadCredentials']>;
  let dispatching: AuthService;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'marvin-dispatch-'));
    pending = new PendingLoginStore(path.join(dir, 'pending.json'));
    loadCredentials = vi.fn(async () => CREDS);
    const added = { ...REF, addedAt: 'now' };
    provider = {
      add: vi.fn(async () => added),
      startAdd: vi.fn(async () => LOGIN_URL),
      finishAdd: vi.fn(async () => added),
      relogin: vi.fn(async (r) => r),
      startRelogin: vi.fn(async () => LOGIN_URL),
      finishRelogin: vi.fn(async (r) => r),
      checkStatus: vi.fn(async () => 'ok' as const),
      forget: vi.fn(async () => undefined),
    };
    dispatching = new AuthService({
      registry,
      tokens,
      loadCredentials,
      login,
      twoStep: { pending, start: vi.fn(), finish: vi.fn() },
      microsoft: provider,
      logger: createLogger(() => {}),
    });
  });

  it('adds without touching the Google credentials', async () => {
    await dispatching.addAccount('Ms', 'microsoft');
    expect(provider.add).toHaveBeenCalledWith('ms');
    await expect(dispatching.startAddAccount('ms2', 'microsoft')).resolves.toBe(LOGIN_URL);
    expect(loadCredentials).not.toHaveBeenCalled();
    expect(login).not.toHaveBeenCalled();
  });

  it('checks the alias before dispatching', async () => {
    await registry.add(REF);
    await expect(dispatching.addAccount('ms', 'microsoft')).rejects.toThrow(/already used/);
    expect(provider.add).not.toHaveBeenCalled();
  });

  it('dispatches relogin, status and removal on the record', async () => {
    const record = await registry.add(REF);
    await dispatching.relogin('ms');
    expect(provider.relogin).toHaveBeenCalledWith(record);
    await expect(dispatching.startRelogin('ms')).resolves.toBe(LOGIN_URL);
    await expect(dispatching.status()).resolves.toEqual([
      { alias: 'ms', email: REF.email, provider: 'microsoft', isDefault: true, status: 'ok' },
    ]);
    expect(provider.checkStatus).toHaveBeenCalledWith(record, false);
    await dispatching.removeAccount('ms');
    expect(provider.forget).toHaveBeenCalledWith(record);
    expect((await registry.read()).accounts).toEqual([]);
  });

  it('removes a Microsoft account with a shared address without touching the Google token', async () => {
    login.mockImplementationOnce(answer(signIn('same@example.com', 'rt-google')));
    await dispatching.addAccount('g');
    await registry.add(REF);
    const revoke = vi.spyOn(Auth.OAuth2Client.prototype, 'revokeToken');
    await expect(dispatching.removeAccount('same@example.com')).rejects.toThrow(/use an alias/);
    await dispatching.removeAccount('ms');
    expect(await tokens.get('same@example.com')).toBe('rt-google');
    expect(revoke).not.toHaveBeenCalled();
  });

  it('removes the account even when forgetting the token fails', async () => {
    await registry.add(REF);
    provider.forget.mockRejectedValueOnce(new Error('keychain'));
    await dispatching.removeAccount('ms');
    expect((await registry.read()).accounts).toEqual([]);
  });

  describe('finishing a two-step login', () => {
    const entry = (extra: Partial<PendingLogin>): Omit<PendingLogin, 'createdAt'> => ({
      state: 's1',
      codeVerifier: 'v',
      redirectUri: 'http://localhost:1',
      command: 'add',
      account: null,
      provider: 'microsoft',
      ...extra,
    });
    const URL_OK = 'http://localhost:1/?state=s1&code=c';

    it('lets the entry decide the provider', async () => {
      await pending.save(entry({}));
      await dispatching.finishAddAccount(undefined, URL_OK);
      expect(provider.finishAdd).toHaveBeenCalledWith(
        expect.objectContaining({ state: 's1' }),
        URL_OK,
      );
      expect(loadCredentials).not.toHaveBeenCalled();
    });

    it('rejects a provider flag that contradicts the entry', async () => {
      await pending.save(entry({}));
      await expect(dispatching.finishAddAccount(undefined, URL_OK, 'google')).rejects.toThrow(
        /belongs to a microsoft login/,
      );
      expect(provider.finishAdd).not.toHaveBeenCalled();
    });

    it('requires the provider to match on relogin and compares accountId', async () => {
      const record = await registry.add(REF);
      await pending.save(entry({ command: 'login', account: 't.o' }));
      await dispatching.finishRelogin('ms', URL_OK);
      expect(provider.finishRelogin).toHaveBeenCalledWith(record, expect.anything(), URL_OK);

      await pending.save(entry({ command: 'login', account: 't.other' }));
      await expect(dispatching.finishRelogin('ms', URL_OK)).rejects.toThrow(
        /same command and account/,
      );

      await pending.save(entry({ command: 'login', account: 't.o', provider: 'google' }));
      await expect(dispatching.finishRelogin('ms', URL_OK)).rejects.toThrow(
        /belongs to a google login/,
      );
    });

    it('names the provider of the waiting login in a redirect error', async () => {
      await pending.save(entry({}));
      await expect(
        dispatching.finishAddAccount(undefined, 'http://localhost:1/?state=s1&error=boom'),
      ).rejects.toThrow('Microsoft returned an error: boom');
    });

    it('still names Google for a Google login', async () => {
      await pending.save(entry({ provider: 'google' }));
      await expect(
        dispatching.finishAddAccount(undefined, 'http://localhost:1/?state=s1&error=boom'),
      ).rejects.toThrow('Google returned an error: boom');
    });
  });

  it('reports a clear error when no Microsoft provider is configured', async () => {
    await expect(service.addAccount(undefined, 'microsoft')).rejects.toThrow(ConfigError);
  });
});
