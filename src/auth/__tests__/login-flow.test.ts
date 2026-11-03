import { describe, expect, it, vi } from 'vitest';
import type { Auth } from 'googleapis';
import { AuthFlowError, ValidationError } from '../../errors.js';
import { OAUTH_SCOPES, runLoginFlow, type OAuthFlowClient } from '../login-flow.js';

const DRIVE_SCOPES = 'https://www.googleapis.com/auth/drive openid email';

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
    getToken: vi.fn(async () => ({
      tokens: { refresh_token: 'rt-1', id_token: 'id-token', scope: DRIVE_SCOPES },
    })),
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

interface Seen {
  status: number;
  html: string;
}

/** Like `browser`, but records what the browser was shown. */
function capturingBrowser(
  h: Harness,
  query: (state: string) => string,
  seen: Seen,
): (url: string) => Promise<void> {
  return async (url) => {
    const state = new URL(url).searchParams.get('state') ?? '';
    const res = await fetch(`${h.redirect()}/?${query(state)}`);
    seen.status = res.status;
    seen.html = await res.text();
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

  it('ignores callbacks with a wrong state', async () => {
    const h = harness();
    let strayStatus = 0;
    const result = await runLoginFlow({
      ...base,
      createClient: h.create,
      openUrl: async (url) => {
        const state = new URL(url).searchParams.get('state') ?? '';
        const stray = await fetch(`${h.redirect()}/?code=abc&state=evil`);
        strayStatus = stray.status;
        await stray.text();
        await (await fetch(`${h.redirect()}/?code=abc&state=${state}`)).text();
      },
    });
    expect(strayStatus).toBe(400);
    expect(result).toEqual({ email: 'user@example.com', refreshToken: 'rt-1' });
  });

  it('answers requests after completion with a neutral 200', async () => {
    let tokenRequested = false;
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const h = harness({
      getToken: async () => {
        tokenRequested = true;
        await gate; // keep the flow (and server) alive until the late request is done
        return { tokens: { refresh_token: 'rt-1', id_token: 'id-token' } };
      },
    });
    let late = 0;
    let lateBody = '';
    const result = await runLoginFlow({
      ...base,
      createClient: h.create,
      openUrl: async (url) => {
        const state = new URL(url).searchParams.get('state') ?? '';
        // The first response is held open until the login finishes, so don't await it yet.
        const first = fetch(`${h.redirect()}/?code=abc&state=${state}`);
        await vi.waitFor(() => expect(tokenRequested).toBe(true)); // code reached the server
        const second = await fetch(`${h.redirect()}/?error=access_denied&state=${state}`);
        late = second.status;
        lateBody = await second.text();
        release();
        await (await first).text();
      },
    });
    expect(late).toBe(200);
    expect(lateBody).toContain('Already done.');
    expect(result).toEqual({ email: 'user@example.com', refreshToken: 'rt-1' });
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

  it('fails when the Drive scope was not granted', async () => {
    const h = harness({
      getToken: async () => ({
        tokens: { refresh_token: 'rt-1', id_token: 'id-token', scope: 'openid email' },
      }),
    });
    await expect(
      runLoginFlow({
        ...base,
        createClient: h.create,
        openUrl: browser(h, (s) => `code=abc&state=${s}`),
      }),
    ).rejects.toThrow(/Drive access was not granted/);
  });

  it('does not fail when the token response omits scope', async () => {
    const h = harness({
      getToken: async () => ({ tokens: { refresh_token: 'rt-1', id_token: 'id-token' } }),
    });
    await expect(
      runLoginFlow({
        ...base,
        createClient: h.create,
        openUrl: browser(h, (s) => `code=abc&state=${s}`),
      }),
    ).resolves.toEqual({ email: 'user@example.com', refreshToken: 'rt-1' });
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
  describe('browser page', () => {
    it('shows the connected account only after verification and onVerified succeed', async () => {
      const h = harness();
      const seen: Seen = { status: 0, html: '' };
      const onVerified = vi.fn(async () => {
        expect(seen.html).toBe(''); // browser is still waiting
      });
      await runLoginFlow({
        ...base,
        createClient: h.create,
        onVerified,
        openUrl: capturingBrowser(h, (s) => `code=abc&state=${s}`, seen),
      });
      await vi.waitFor(() => expect(seen.html).not.toBe(''));
      expect(onVerified).toHaveBeenCalledWith({ email: 'user@example.com', refreshToken: 'rt-1' });
      expect(seen.status).toBe(200);
      expect(seen.html).toContain('Drive connected.');
      expect(seen.html).toContain('user@example.com');
    });

    it('explains a missing Drive scope in the browser', async () => {
      const h = harness({
        getToken: async () => ({
          tokens: { refresh_token: 'rt-1', id_token: 'id-token', scope: 'openid email' },
        }),
      });
      const seen: Seen = { status: 0, html: '' };
      await expect(
        runLoginFlow({
          ...base,
          createClient: h.create,
          openUrl: capturingBrowser(h, (s) => `code=abc&state=${s}`, seen),
        }),
      ).rejects.toThrow(AuthFlowError);
      await vi.waitFor(() => expect(seen.html).not.toBe(''));
      expect(seen.status).toBe(400);
      expect(seen.html).toContain('Couldn’t connect.');
      expect(seen.html).toContain('Drive access was not granted');
    });

    it('shows onVerified failures (e.g. account already registered)', async () => {
      const h = harness();
      const seen: Seen = { status: 0, html: '' };
      await expect(
        runLoginFlow({
          ...base,
          createClient: h.create,
          onVerified: async () => {
            throw new ValidationError('user@example.com is already registered as "emco"');
          },
          openUrl: capturingBrowser(h, (s) => `code=abc&state=${s}`, seen),
        }),
      ).rejects.toThrow(ValidationError);
      await vi.waitFor(() => expect(seen.html).not.toBe(''));
      expect(seen.html).toContain('already registered as &quot;emco&quot;');
    });

    it('hides unexpected error details', async () => {
      const h = harness();
      const seen: Seen = { status: 0, html: '' };
      await expect(
        runLoginFlow({
          ...base,
          createClient: h.create,
          onVerified: async () => {
            throw new TypeError('internal detail');
          },
          openUrl: capturingBrowser(h, (s) => `code=abc&state=${s}`, seen),
        }),
      ).rejects.toThrow(TypeError);
      await vi.waitFor(() => expect(seen.html).not.toBe(''));
      expect(seen.html).not.toContain('internal detail');
      expect(seen.html).toContain('see the terminal');
    });

    it('escapes Google error codes and marks stale links', async () => {
      const h = harness();
      const seen: Seen = { status: 0, html: '' };
      await expect(
        runLoginFlow({
          ...base,
          createClient: h.create,
          openUrl: capturingBrowser(
            h,
            (s) => `error=${encodeURIComponent('<img src=x onerror=alert(1)>')}&state=${s}`,
            seen,
          ),
        }),
      ).rejects.toThrow(AuthFlowError);
      await vi.waitFor(() => expect(seen.html).not.toBe(''));
      expect(seen.html).not.toContain('<img');
      expect(seen.html).toContain('&lt;img');

      const h2 = harness();
      const stale: Seen = { status: 0, html: '' };
      await runLoginFlow({
        ...base,
        createClient: h2.create,
        openUrl: async (url) => {
          await capturingBrowser(h2, () => 'code=abc&state=evil', stale)(url);
          await browser(h2, (s) => `code=abc&state=${s}`)(url);
        },
      });
      expect(stale.status).toBe(400);
      expect(stale.html).toContain('This link has expired.');
    });

    it('sends a strict content security policy', async () => {
      const h = harness();
      let csp: string | null = null;
      await runLoginFlow({
        ...base,
        createClient: h.create,
        openUrl: async (url) => {
          const state = new URL(url).searchParams.get('state') ?? '';
          const res = await fetch(`${h.redirect()}/?code=abc&state=${state}`);
          csp = res.headers.get('content-security-policy');
          await res.text();
        },
      });
      await vi.waitFor(() => expect(csp).toContain("default-src 'none'"));
    });
  });
  describe('robustness while the browser waits', () => {
    it('finishes even if the browser tab is closed before the answer', async () => {
      let tokenRequested = false;
      let release: () => void = () => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const h = harness({
        getToken: async () => {
          tokenRequested = true;
          await gate;
          return { tokens: { refresh_token: 'rt-1', id_token: 'id-token' } };
        },
      });
      const result = await runLoginFlow({
        ...base,
        createClient: h.create,
        openUrl: async (url) => {
          const state = new URL(url).searchParams.get('state') ?? '';
          const controller = new AbortController();
          const pending = fetch(`${h.redirect()}/?code=abc&state=${state}`, {
            signal: controller.signal,
          }).catch(() => undefined);
          await vi.waitFor(() => expect(tokenRequested).toBe(true));
          controller.abort(); // user closes the tab while we exchange the code
          await pending;
          release();
        },
      });
      expect(result).toEqual({ email: 'user@example.com', refreshToken: 'rt-1' });
    });

    it('gives up on a hung token exchange and shows the failure page', async () => {
      const h = harness({ getToken: () => new Promise(() => {}) });
      const seen: Seen = { status: 0, html: '' };
      await expect(
        runLoginFlow({
          ...base,
          createClient: h.create,
          finishTimeoutMs: 50,
          openUrl: capturingBrowser(h, (s) => `code=abc&state=${s}`, seen),
        }),
      ).rejects.toThrow(/did not finish/);
      await vi.waitFor(() => expect(seen.html).toContain('did not finish'));
    });
  });
});
