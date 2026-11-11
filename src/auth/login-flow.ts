import { randomBytes, randomInt } from 'node:crypto';
import { createServer } from 'node:http';
import { Auth } from 'googleapis';
import { AppError, AuthFlowError, ValidationError } from '../errors.js';
import {
  listen,
  parseRedirectUrl,
  waitForCallback,
  waitForPaste,
  withDeadline,
  type Callback,
  type ManualLogin,
} from './loopback.js';

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
  manual?: ManualLogin;
}

export interface LoginResult {
  email: string;
  refreshToken: string;
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

/** The Google consent URL: offline access (refresh token), PKCE S256, our scopes. */
function buildAuthUrl(
  client: OAuthFlowClient,
  state: string,
  codeChallenge: string | undefined,
  loginHint: string | undefined,
): string {
  return client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: [...OAUTH_SCOPES],
    state,
    code_challenge: codeChallenge,
    code_challenge_method: Auth.CodeChallengeMethod.S256,
    ...(loginHint ? { login_hint: loginHint } : {}),
  });
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
    const callbackPromise = waitForCallback(server, state, timeoutMs, 'Google');
    callbackPromise.catch(() => undefined); // awaited below; prevents an unhandled rejection if we throw first

    const authUrl = buildAuthUrl(client, state, codeChallenge, opts.loginHint);
    let incoming: Promise<Callback> = callbackPromise;
    if (opts.manual) {
      opts.print(
        `Open this URL in a browser on any device and sign in:\n${authUrl}\n\n` +
          `Google then redirects to ${redirectUri}/?…, which usually fails to load on that device — ` +
          'that is expected. Copy the full URL from the address bar and paste it here.',
      );
      const pasted = waitForPaste(opts.manual, state, opts.print, pasteAbort.signal, 'Google');
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
        'Google',
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

/** Options shared by the two-step (--print-url / --redirect-url) login. */
export interface TwoStepOptions {
  clientId: string;
  clientSecret: string;
  createClient?: (redirectUri: string) => OAuthFlowClient;
  finishTimeoutMs?: number;
}

/** What step 1 hands to step 2 (stored by PendingLoginStore). */
export interface TwoStepStart {
  authUrl: string;
  state: string;
  codeVerifier: string;
  redirectUri: string;
}

function clientFor(opts: TwoStepOptions, redirectUri: string): OAuthFlowClient {
  return (
    opts.createClient?.(redirectUri) ??
    new Auth.OAuth2Client({
      clientId: opts.clientId,
      clientSecret: opts.clientSecret,
      redirectUri,
    })
  );
}

/**
 * Step 1: builds the consent URL without listening anywhere. The loopback redirect URI gets a
 * random high port; nothing answers there, so the browser shows an error page whose address
 * bar holds the code. Google accepts any loopback port for Desktop clients.
 */
export async function startTwoStepLogin(
  opts: TwoStepOptions & { loginHint?: string },
): Promise<TwoStepStart> {
  const state = randomBytes(16).toString('hex');
  const port = 49152 + randomInt(65535 - 49152);
  const redirectUri = `http://127.0.0.1:${port}`;
  const client = clientFor(opts, redirectUri);
  const { codeVerifier, codeChallenge } = await client.generateCodeVerifierAsync();
  return {
    authUrl: buildAuthUrl(client, state, codeChallenge, opts.loginHint),
    state,
    codeVerifier,
    redirectUri,
  };
}

/** Step 2: exchanges the code from the redirect URL with the stored PKCE verifier. */
export async function finishTwoStepLogin(
  opts: TwoStepOptions,
  pending: { state: string; codeVerifier: string; redirectUri: string },
  redirectUrl: string,
): Promise<LoginResult> {
  const { state, code } = parseRedirectUrl(redirectUrl, 'Google');
  if (state !== pending.state) {
    throw new AuthFlowError('That redirect URL belongs to a different login attempt.');
  }
  if (!code) throw new ValidationError('That redirect URL has no authorization code.');
  const client = clientFor(opts, pending.redirectUri);
  return withDeadline(
    exchangeAndVerify(client, code, pending.codeVerifier, opts.clientId),
    opts.finishTimeoutMs ?? DEFAULT_FINISH_TIMEOUT_MS,
    'Google',
  );
}
