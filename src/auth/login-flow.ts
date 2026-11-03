import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Auth } from 'googleapis';
import { AuthFlowError } from '../errors.js';

export const OAUTH_SCOPES = ['https://www.googleapis.com/auth/drive', 'openid', 'email'] as const;
const DEFAULT_TIMEOUT_MS = 120_000;

/** The subset of Auth.OAuth2Client used by the login flow (injectable for tests). */
export interface OAuthFlowClient {
  generateCodeVerifierAsync(): Promise<{ codeVerifier: string; codeChallenge?: string }>;
  generateAuthUrl(opts: Auth.GenerateAuthUrlOpts): string;
  getToken(opts: {
    code: string;
    codeVerifier?: string;
  }): Promise<{ tokens: { refresh_token?: string | null; id_token?: string | null } }>;
  verifyIdToken(opts: {
    idToken: string;
    audience: string;
  }): Promise<{ getPayload(): { email?: string; email_verified?: boolean } | undefined }>;
}

export interface LoginFlowOptions {
  clientId: string;
  clientSecret: string;
  loginHint?: string;
  openUrl: (url: string) => Promise<void>;
  print: (message: string) => void;
  timeoutMs?: number;
  createClient?: (redirectUri: string) => OAuthFlowClient;
}

export interface LoginResult {
  email: string;
  refreshToken: string;
}

const PAGE = (text: string): string =>
  `<!doctype html><meta charset="utf-8"><title>Marvin Drive</title><p>${text}</p>`;

function waitForCode(server: Server, state: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new AuthFlowError(`Login timed out after ${Math.round(timeoutMs / 1000)} s`));
    }, timeoutMs);
    timer.unref();

    let settled = false;
    server.on('request', (req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (url.pathname !== '/') {
        res.writeHead(404).end();
        return;
      }
      const reply = (status: number, text: string): void => {
        res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' }).end(PAGE(text));
      };
      if (settled) {
        reply(200, 'This login is already finished. You can close this tab.');
        return;
      }
      const params = url.searchParams;
      if (params.get('state') !== state) {
        reply(400, 'Invalid or stale login link. Return to the terminal.');
        return;
      }
      const fail = (message: string): void => {
        settled = true;
        reply(400, 'Login failed. Close this tab and check the terminal.');
        clearTimeout(timer);
        reject(new AuthFlowError(message));
      };

      const error = params.get('error');
      if (error) {
        return fail(
          error === 'access_denied'
            ? 'Access was denied in the browser'
            : `Google returned an error: ${error}`,
        );
      }
      const code = params.get('code');
      if (!code) return fail('Callback did not include an authorization code');

      settled = true;
      reply(200, 'Login complete. You can close this tab.');
      clearTimeout(timer);
      resolve(code);
    });
  });
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  return (server.address() as AddressInfo).port;
}

export async function runLoginFlow(opts: LoginFlowOptions): Promise<LoginResult> {
  const state = randomBytes(16).toString('hex');
  const server = createServer();
  const port = await listen(server);
  try {
    const redirectUri = `http://127.0.0.1:${port}`;
    const client: OAuthFlowClient =
      opts.createClient?.(redirectUri) ??
      new Auth.OAuth2Client({
        clientId: opts.clientId,
        clientSecret: opts.clientSecret,
        redirectUri,
      });

    const { codeVerifier, codeChallenge } = await client.generateCodeVerifierAsync();
    const codePromise = waitForCode(server, state, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    codePromise.catch(() => undefined); // awaited below; prevents an unhandled rejection if we throw first

    const authUrl = client.generateAuthUrl({
      access_type: 'offline',
      prompt: 'consent',
      scope: [...OAUTH_SCOPES],
      state,
      code_challenge: codeChallenge,
      code_challenge_method: Auth.CodeChallengeMethod.S256,
      ...(opts.loginHint ? { login_hint: opts.loginHint } : {}),
    });
    opts.print(`Opening the browser for Google sign-in. If it does not open, visit:\n${authUrl}`);
    opts.openUrl(authUrl).catch(() => {
      opts.print('Could not open a browser automatically; use the URL above.');
    });

    const code = await codePromise;
    const { tokens } = await client.getToken({ code, codeVerifier });
    if (!tokens.id_token) throw new AuthFlowError('Google did not return an id_token');

    const ticket = await client.verifyIdToken({
      idToken: tokens.id_token,
      audience: opts.clientId,
    });
    const payload = ticket.getPayload();
    if (!payload?.email || payload.email_verified !== true) {
      throw new AuthFlowError('Google account email is missing or unverified');
    }
    if (!tokens.refresh_token) {
      throw new AuthFlowError(
        'Google did not return a refresh token. Remove the app at https://myaccount.google.com/permissions and retry.',
      );
    }
    return { email: payload.email.toLowerCase(), refreshToken: tokens.refresh_token };
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
