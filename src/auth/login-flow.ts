import { randomBytes } from 'node:crypto';
import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Auth } from 'googleapis';
import { AppError, AuthFlowError } from '../errors.js';
import { logger } from '../logger.js';
import { CALLBACK_PAGE_HEADERS, renderCallbackPage, type CallbackPage } from './callback-page.js';

const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive';
export const OAUTH_SCOPES = [DRIVE_SCOPE, 'openid', 'email'] as const;
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MANUAL_TIMEOUT_MS = 600_000;
const DEFAULT_FINISH_TIMEOUT_MS = 60_000;

/** The subset of Auth.OAuth2Client used by the login flow (injectable for tests). */
export interface OAuthFlowClient {
  generateCodeVerifierAsync(): Promise<{ codeVerifier: string; codeChallenge?: string }>;
  generateAuthUrl(opts: Auth.GenerateAuthUrlOpts): string;
  getToken(opts: { code: string; codeVerifier?: string }): Promise<{
    tokens: { refresh_token?: string | null; id_token?: string | null; scope?: string | null };
  }>;
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
  /** Deadline for the token exchange + verification after the browser returned (default 60 s). */
  finishTimeoutMs?: number;
  createClient?: (redirectUri: string) => OAuthFlowClient;
  /**
   * Runs after Google verified the account, before the browser is answered — e.g. saving the
   * account. If it throws, the browser shows the failure instead of a success page.
   */
  onVerified?: (result: LoginResult) => Promise<void>;
  /**
   * No-browser mode (servers): the URL is only printed and the user pastes the redirect URL back.
   * The loopback callback keeps working too (SSH tunnel); whichever arrives first wins.
   * `readLine` resolves null when input is closed and must stop when `signal` aborts.
   */
  manual?: { readLine: (prompt: string, signal: AbortSignal) => Promise<string | null> };
}

export interface LoginResult {
  email: string;
  refreshToken: string;
}

/**
 * Writes a callback page. Resolves once it is flushed — or as soon as the browser is gone
 * (closed tab): Node never calls the `end` callback on a destroyed socket, so 'close' also settles.
 * Never throws and never writes twice.
 */
function sendPage(res: ServerResponse, status: number, page: CallbackPage): Promise<void> {
  return new Promise((resolve) => {
    if (res.destroyed || res.headersSent) {
      resolve();
      return;
    }
    res.once('close', () => resolve());
    try {
      res.writeHead(status, CALLBACK_PAGE_HEADERS).end(renderCallbackPage(page), () => resolve());
    } catch (err) {
      logger.warn('Could not send the login result page', { error: err });
      resolve();
    }
  });
}

/** Rejects with AuthFlowError if `work` does not settle within `ms`. */
async function withDeadline<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(
        new AuthFlowError(
          `Login did not finish within ${Math.round(ms / 1000)} s while contacting Google. Check your connection and try again.`,
        ),
      );
    }, ms);
    timer.unref();
  });
  try {
    return await Promise.race([work, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

interface Callback {
  code: string;
  /** Answers the browser request that delivered the code (held open until the login finishes). */
  respond: (status: number, page: CallbackPage) => Promise<void>;
}

function waitForCallback(server: Server, state: string, timeoutMs: number): Promise<Callback> {
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
      if (settled) {
        void sendPage(res, 200, { kind: 'finished' });
        return;
      }
      const params = url.searchParams;
      if (params.get('state') !== state) {
        void sendPage(res, 400, { kind: 'stale' });
        return;
      }
      const fail = (message: string): void => {
        settled = true;
        clearTimeout(timer);
        // Reject only after the page is flushed; the caller closes all connections next.
        void sendPage(res, 400, { kind: 'failure', message }).then(() => {
          reject(new AuthFlowError(message));
        });
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
      clearTimeout(timer);
      resolve({ code, respond: (status, page) => sendPage(res, status, page) });
    });
  });
}

const PASTE_PROMPT = 'Paste the full URL from the address bar: ';

/** Parses a pasted redirect URL (or just its query string). */
function parsePasted(input: string): URLSearchParams | null {
  const text = input.trim();
  if (!text) return null;
  try {
    const url = text.includes('://')
      ? new URL(text)
      : new URL(`http://127.0.0.1/?${text.replace(/^\?/, '')}`);
    return url.searchParams;
  } catch {
    return null;
  }
}

/** Reads pasted redirect URLs until one carries a code for this attempt. Never settles on EOF. */
async function waitForPaste(
  manual: NonNullable<LoginFlowOptions['manual']>,
  state: string,
  print: (message: string) => void,
  signal: AbortSignal,
): Promise<Callback> {
  for (;;) {
    const line = await manual.readLine(PASTE_PROMPT, signal);
    if (line === null) return new Promise<never>(() => {}); // stdin closed: rely on the callback
    const params = parsePasted(line);
    if (!params || (!params.has('code') && !params.has('error'))) {
      print('That does not look like the redirect URL (it contains "code=" and "state=").');
      continue;
    }
    if (params.get('state') !== state) {
      print('That URL belongs to a different login attempt; use the URL printed above.');
      continue;
    }
    const error = params.get('error');
    if (error) {
      throw new AuthFlowError(
        error === 'access_denied'
          ? 'Access was denied in the browser'
          : `Google returned an error: ${error}`,
      );
    }
    const code = params.get('code');
    if (!code) {
      print('That URL has no authorization code; paste the full URL.');
      continue;
    }
    return { code, respond: async (): Promise<void> => {} };
  }
}

async function exchangeAndVerify(
  client: OAuthFlowClient,
  code: string,
  codeVerifier: string,
  clientId: string,
): Promise<LoginResult> {
  const { tokens } = await client.getToken({ code, codeVerifier });
  if (tokens.scope && !tokens.scope.split(' ').includes(DRIVE_SCOPE)) {
    throw new AuthFlowError(
      'Google Drive access was not granted. Run the login again and tick the "See, edit, create, and delete all of your Google Drive files" checkbox on the consent screen.',
    );
  }
  if (!tokens.id_token) throw new AuthFlowError('Google did not return an id_token');

  const ticket = await client.verifyIdToken({ idToken: tokens.id_token, audience: clientId });
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
  const pasteAbort = new AbortController();
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
    const timeoutMs =
      opts.timeoutMs ?? (opts.manual ? DEFAULT_MANUAL_TIMEOUT_MS : DEFAULT_TIMEOUT_MS);
    const callbackPromise = waitForCallback(server, state, timeoutMs);
    callbackPromise.catch(() => undefined); // awaited below; prevents an unhandled rejection if we throw first

    const authUrl = client.generateAuthUrl({
      access_type: 'offline',
      prompt: 'consent',
      scope: [...OAUTH_SCOPES],
      state,
      code_challenge: codeChallenge,
      code_challenge_method: Auth.CodeChallengeMethod.S256,
      ...(opts.loginHint ? { login_hint: opts.loginHint } : {}),
    });
    let incoming: Promise<Callback> = callbackPromise;
    if (opts.manual) {
      opts.print(
        `Open this URL in a browser on any device and sign in:\n${authUrl}\n\n` +
          `Google then redirects to ${redirectUri}/?…, which usually fails to load on that device — ` +
          'that is expected. Copy the full URL from the address bar and paste it here.',
      );
      const pasted = waitForPaste(opts.manual, state, opts.print, pasteAbort.signal);
      pasted.catch(() => undefined); // awaited via the race below
      incoming = Promise.race([callbackPromise, pasted]);
    } else {
      opts.print(`Opening the browser for Google sign-in. If it does not open, visit:\n${authUrl}`);
      opts.openUrl(authUrl).catch(() => {
        opts.print('Could not open a browser automatically; use the URL above.');
      });
    }

    const { code, respond } = await incoming;
    pasteAbort.abort();
    try {
      // Network calls get a deadline; onVerified (local save) is not raced, to avoid half-saves.
      const result = await withDeadline(
        exchangeAndVerify(client, code, codeVerifier, opts.clientId),
        opts.finishTimeoutMs ?? DEFAULT_FINISH_TIMEOUT_MS,
      );
      await opts.onVerified?.(result);
      await respond(200, { kind: 'success', email: result.email });
      return result;
    } catch (err) {
      const message =
        err instanceof AppError ? err.message : 'Unexpected error; see the terminal for details.';
      await respond(400, { kind: 'failure', message });
      throw err;
    }
  } finally {
    pasteAbort.abort();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
