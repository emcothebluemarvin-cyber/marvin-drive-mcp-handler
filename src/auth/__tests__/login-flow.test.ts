import { describe, expect, it, vi } from 'vitest';
import type { Auth } from 'googleapis';
import { AuthFlowError } from '../../errors.js';
import { OAUTH_SCOPES, runLoginFlow, type OAuthFlowClient } from '../login-flow.js';

interface Harness {
  client: OAuthFlowClient;
  create: (redirectUri: string) => OAuthFlowClient;
  urlOpts: () => Auth.GenerateAuthUrlOpts | undefined;
  redirect: () => string;
}

function harness(overrides: Partial<OAuthFlowClient> = {}): Harness {
  let urlOpts: Auth.GenerateAuthUrlOpts | undefined;
  let redirect = '';
  const client: OAuthFlowClient = {
    generateCodeVerifierAsync: async () => ({
      codeVerifier: 'verifier',
      codeChallenge: 'challenge',
    }),
    generateAuthUrl: (opts) => {
      urlOpts = opts;
      return `https://accounts.example/auth?state=${String(opts.state)}`;
    },
    getToken: vi.fn(async () => ({ tokens: { refresh_token: 'rt-1', id_token: 'id-token' } })),
    verifyIdToken: vi.fn(async () => ({
      getPayload: () => ({ email: 'User@Example.com', email_verified: true }),
    })),
    ...overrides,
  };
  return {
    client,
    create: (redirectUri) => {
      redirect = redirectUri;
      return client;
    },
    urlOpts: () => urlOpts,
    redirect: () => redirect,
  };
}

/** Simulates the browser hitting our loopback server after Google consent. */
function browser(h: Harness, query: (state: string) => string): (url: string) => Promise<void> {
  return async (url) => {
    const state = new URL(url).searchParams.get('state') ?? '';
    await (await fetch(`${h.redirect()}/?${query(state)}`)).text();
  };
}

const base = {
  clientId: 'cid.apps.googleusercontent.com',
  clientSecret: 'secret',
  print: () => {},
};

describe('runLoginFlow', () => {
  it('completes the PKCE flow and returns the verified email and refresh token', async () => {
    const h = harness();
    const result = await runLoginFlow({
      ...base,
      loginHint: 'user@example.com',
      createClient: h.create,
      openUrl: browser(h, (state) => `code=abc&state=${state}`),
    });
    expect(result).toEqual({ email: 'user@example.com', refreshToken: 'rt-1' });
    expect(h.redirect()).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(h.urlOpts()).toMatchObject({
      access_type: 'offline',
      prompt: 'consent',
      scope: [...OAUTH_SCOPES],
      code_challenge: 'challenge',
      code_challenge_method: 'S256',
      login_hint: 'user@example.com',
    });
    expect(h.client.getToken).toHaveBeenCalledWith({ code: 'abc', codeVerifier: 'verifier' });
    expect(h.client.verifyIdToken).toHaveBeenCalledWith({
      idToken: 'id-token',
      audience: base.clientId,
    });
  });

  it('rejects a state mismatch', async () => {
    const h = harness();
    await expect(
      runLoginFlow({
        ...base,
        createClient: h.create,
        openUrl: browser(h, () => 'code=abc&state=evil'),
      }),
    ).rejects.toThrow(/state mismatch/);
  });

  it('reports access_denied', async () => {
    const h = harness();
    await expect(
      runLoginFlow({
        ...base,
        createClient: h.create,
        openUrl: browser(h, (state) => `error=access_denied&state=${state}`),
      }),
    ).rejects.toThrow(/Access was denied/);
  });

  it('times out when no callback arrives', async () => {
    const h = harness();
    await expect(
      runLoginFlow({ ...base, createClient: h.create, openUrl: async () => {}, timeoutMs: 50 }),
    ).rejects.toThrow(AuthFlowError);
  });

  it('rejects unverified emails and missing refresh tokens', async () => {
    const unverified = harness({
      verifyIdToken: async () => ({
        getPayload: () => ({ email: 'a@b.c', email_verified: false }),
      }),
    });
    await expect(
      runLoginFlow({
        ...base,
        createClient: unverified.create,
        openUrl: browser(unverified, (s) => `code=abc&state=${s}`),
      }),
    ).rejects.toThrow(/unverified/);

    const noRefresh = harness({ getToken: async () => ({ tokens: { id_token: 'id-token' } }) });
    await expect(
      runLoginFlow({
        ...base,
        createClient: noRefresh.create,
        openUrl: browser(noRefresh, (s) => `code=abc&state=${s}`),
      }),
    ).rejects.toThrow(/refresh token/);
  });

  it('prints the auth URL so the user can open it manually', async () => {
    const h = harness();
    const print = vi.fn();
    await runLoginFlow({
      ...base,
      print,
      createClient: h.create,
      openUrl: browser(h, (s) => `code=abc&state=${s}`),
    });
    expect(print).toHaveBeenCalledWith(expect.stringContaining('https://accounts.example/auth'));
  });
});
