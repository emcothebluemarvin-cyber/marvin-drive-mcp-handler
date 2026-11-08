import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AccountRegistry } from '../../config/account-registry.js';
import { AuthFlowError } from '../../errors.js';
import { createLogger } from '../../logger.js';
import { MICROSOFT_SCOPES, MicrosoftAuth, type MicrosoftAuthDeps } from '../microsoft-auth.js';
import { PendingLoginStore, type PendingLogin } from '../pending-login.js';
import { InMemoryTokenStore } from '../token-store.js';

const CLIENT = '11111111-2222-4333-8444-555555555555';
const idToken = (claims: Record<string, unknown>): string =>
  `h.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.sig`;
const CLAIMS = { tid: 'tid1', oid: 'oid1', email: 'Me@Example.com', preferred_username: 'x@y.z' };

let registry: AccountRegistry;
let tokens: InMemoryTokenStore;
let pending: PendingLoginStore;
let tokenBody: Record<string, unknown>;
let tokenStatus: number;
let posted: URLSearchParams[];
let printed: string[];
let openUrl: ReturnType<typeof vi.fn<MicrosoftAuthDeps['openUrl']>>;

const fakeFetch: typeof fetch = async (_url, init) => {
  posted.push(new URLSearchParams(String(init?.body)));
  return new Response(JSON.stringify(tokenBody), { status: tokenStatus });
};

function auth(extra: Partial<MicrosoftAuthDeps> = {}): MicrosoftAuth {
  return new MicrosoftAuth({
    registry,
    tokens,
    pending,
    loadClientId: async () => CLIENT,
    openUrl,
    print: (m) => printed.push(m),
    fetch: fakeFetch,
    timeoutMs: 5000,
    logger: createLogger(() => {}),
    ...extra,
  });
}

/** Plays the browser: sends the redirect to the loopback server on 127.0.0.1. */
function browser(query: (state: string) => string = (s) => `state=${s}&code=the-code`): void {
  openUrl.mockImplementation(async (url) => {
    const u = new URL(url);
    const port = new URL(u.searchParams.get('redirect_uri') ?? '').port;
    void fetch(`http://127.0.0.1:${port}/?${query(u.searchParams.get('state') ?? '')}`).catch(
      () => undefined,
    );
  });
}

beforeEach(async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ms-auth-'));
  registry = new AccountRegistry(path.join(dir, 'accounts.json'));
  tokens = new InMemoryTokenStore();
  pending = new PendingLoginStore(path.join(dir, 'pending.json'));
  tokenStatus = 200;
  tokenBody = {
    access_token: 'at',
    refresh_token: 'rt',
    id_token: idToken(CLAIMS),
    scope: 'Files.ReadWrite User.Read profile openid email',
    expires_in: 3600,
  };
  posted = [];
  printed = [];
  openUrl = vi.fn<MicrosoftAuthDeps['openUrl']>();
});

describe('MicrosoftAuth interactive login', () => {
  it('sends the PKCE parameters, scopes and prompt on the common authority', async () => {
    browser();
    await auth().add();
    const url = new URL(openUrl.mock.calls[0]?.[0] ?? '');
    expect(url.origin + url.pathname).toBe(
      'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
    );
    const q = url.searchParams;
    expect(q.get('client_id')).toBe(CLIENT);
    expect(q.get('scope')).toBe(MICROSOFT_SCOPES);
    expect(q.get('prompt')).toBe('select_account');
    expect(q.get('code_challenge_method')).toBe('S256');
    expect(q.get('redirect_uri')).toMatch(/^http:\/\/localhost:\d+$/);
    const form = posted[0];
    expect(form?.get('grant_type')).toBe('authorization_code');
    expect(form?.get('code')).toBe('the-code');
    expect(form?.get('redirect_uri')).toBe(q.get('redirect_uri'));
    const { createHash } = await import('node:crypto');
    expect(q.get('code_challenge')).toBe(
      createHash('sha256')
        .update(form?.get('code_verifier') ?? '')
        .digest('base64url'),
    );
  });

  it('stores the account under its accountId with the email claim as display address', async () => {
    browser();
    const record = await auth().add();
    expect(record).toMatchObject({
      alias: 'me',
      email: 'me@example.com',
      provider: 'microsoft',
      accountId: 'tid1.oid1',
    });
    expect(await tokens.get('microsoft:tid1.oid1')).toBe('rt');
    expect(printed.join()).not.toMatch(/Google/);
  });

  it('falls back to preferred_username when email has no @', async () => {
    tokenBody.id_token = idToken({ ...CLAIMS, email: 'nope' });
    browser();
    await expect(auth().add()).resolves.toMatchObject({ email: 'x@y.z' });
  });

  it.each([
    ['tid missing', { ...CLAIMS, tid: undefined }],
    ['oid missing', { ...CLAIMS, oid: undefined }],
    ['no address', { ...CLAIMS, email: 'a', preferred_username: 'b' }],
  ])('stores nothing when the token lacks identity: %s', async (_name, claims) => {
    tokenBody.id_token = idToken(claims);
    browser();
    await expect(auth().add()).rejects.toThrow(AuthFlowError);
    expect((await registry.read()).accounts).toEqual([]);
  });

  it('fails when the granted scope lacks Files.ReadWrite', async () => {
    tokenBody.scope = 'User.Read openid';
    browser();
    await expect(auth().add()).rejects.toThrow(/OneDrive access was not granted/);
    expect((await registry.read()).accounts).toEqual([]);
  });

  it('asks for --alias when the generated alias is taken', async () => {
    await registry.add({ alias: 'me', email: 'other@example.com' });
    browser();
    await expect(auth().add()).rejects.toThrow(/--alias/);
    expect(await tokens.get('microsoft:tid1.oid1')).toBeNull();
  });

  it('surfaces an access_denied redirect', async () => {
    browser((s) => `state=${s}&error=access_denied`);
    await expect(auth().add()).rejects.toThrow('Access was denied in the browser');
  });

  it('accepts a pasted redirect URL in no-browser mode', async () => {
    const readLine = vi.fn(async () => {
      const url = new URL(/https:\S+/.exec(printed[0] ?? '')?.[0] ?? '');
      return `http://localhost:1/?state=${url.searchParams.get('state') ?? ''}&code=pasted`;
    });
    await auth({ manual: { readLine } }).add('m');
    expect(posted[0]?.get('code')).toBe('pasted');
    expect(openUrl).not.toHaveBeenCalled();
  });
});

describe('MicrosoftAuth relogin', () => {
  it('compares accountId, not the address', async () => {
    const record = await registry.add({
      alias: 'w',
      email: 'old@example.com',
      provider: 'microsoft',
      accountId: 'tid1.oid1',
    });
    browser();
    await auth().relogin(record);
    expect(await tokens.get('microsoft:tid1.oid1')).toBe('rt');

    const other = await registry.add({
      alias: 'w2',
      email: 'me@example.com',
      provider: 'microsoft',
      accountId: 'tid2.oid2',
    });
    await expect(auth().relogin(other)).rejects.toThrow(/different account/);
    expect(await tokens.get('microsoft:tid2.oid2')).toBeNull();
  });
});

describe('MicrosoftAuth two-step login', () => {
  const take = async (url: string): Promise<PendingLogin> => {
    const state = new URL(url).searchParams.get('state') ?? '';
    const entry = await pending.take(state);
    if (!entry) throw new Error('no entry');
    return entry;
  };

  it('saves a pending entry for the provider and finishes with it', async () => {
    const a = auth();
    const url = await a.startAdd('my-alias');
    const entry = await take(url);
    expect(entry).toMatchObject({ command: 'add', account: 'my-alias', provider: 'microsoft' });
    expect(entry.redirectUri).toMatch(/^http:\/\/localhost:\d+$/);
    const record = await a.finishAdd(entry, `${entry.redirectUri}/?state=${entry.state}&code=c2`);
    expect(record.alias).toBe('my-alias');
    expect(posted[0]?.get('code_verifier')).toBe(entry.codeVerifier);
  });

  it('keeps the accountId as the relogin target', async () => {
    const record = await registry.add({
      alias: 'w',
      email: 'a@b.c',
      provider: 'microsoft',
      accountId: 'tid1.oid1',
    });
    const a = auth();
    const entry = await take(await a.startRelogin(record));
    expect(entry).toMatchObject({ command: 'login', account: 'tid1.oid1' });
    await a.finishRelogin(record, entry, `http://localhost/?state=${entry.state}&code=c3`);
    expect(await tokens.get('microsoft:tid1.oid1')).toBe('rt');
  });

  it('reports a refused sign-in without the response body', async () => {
    tokenStatus = 400;
    tokenBody = { error: 'invalid_request', error_description: 'secret detail' };
    const a = auth();
    const entry = await take(await a.startAdd());
    await expect(
      a.finishAdd(entry, `http://localhost/?state=${entry.state}&code=c`),
    ).rejects.toThrow('Microsoft refused the sign-in (invalid_request).');
  });
});

describe('MicrosoftAuth.forget', () => {
  it('deletes only this account token', async () => {
    const record = await registry.add({
      alias: 'w',
      email: 'same@example.com',
      provider: 'microsoft',
      accountId: 't.o',
    });
    await tokens.set('same@example.com', 'google-token');
    await tokens.set('microsoft:t.o', 'ms-token');
    await auth().forget(record);
    expect(await tokens.get('same@example.com')).toBe('google-token');
    expect(await tokens.get('microsoft:t.o')).toBeNull();
  });
});
