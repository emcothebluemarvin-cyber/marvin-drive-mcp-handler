import { createHash, randomBytes, randomInt } from 'node:crypto';
import { createServer } from 'node:http';
import {
  defaultAlias,
  tokenKey,
  type AccountRecord,
  type AccountRegistry,
} from '../config/account-registry.js';
import { AppError, AuthFlowError } from '../errors.js';
import { logger as defaultLogger, type Logger } from '../logger.js';
import {
  listenLocalhost,
  parseRedirectUrl,
  waitForCallback,
  waitForPaste,
  withDeadline,
  type Callback,
  type ManualLogin,
} from './loopback.js';
import type { PendingLogin, PendingLoginStore } from './pending-login.js';
import type { AccountStatus, ProviderAuth } from './provider-auth.js';
import type { TokenStore } from './token-store.js';

const AUTHORITY = 'https://login.microsoftonline.com/common/oauth2/v2.0';
export const MICROSOFT_SCOPES = 'Files.ReadWrite offline_access User.Read openid profile email';
const LABEL = 'Microsoft';
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MANUAL_TIMEOUT_MS = 600_000;
const DEFAULT_FINISH_TIMEOUT_MS = 60_000;

export interface MicrosoftAuthDeps {
  registry: AccountRegistry;
  tokens: TokenStore;
  pending: PendingLoginStore;
  loadClientId: () => Promise<string>;
  openUrl: (url: string) => Promise<void>;
  print: (message: string) => void;
  manual?: ManualLogin;
  fetch?: typeof fetch;
  timeoutMs?: number;
  finishTimeoutMs?: number;
  logger?: Logger;
}

interface MicrosoftLogin {
  accountId: string;
  email: string;
  refreshToken: string;
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  id_token?: string;
  scope?: string;
  expires_in?: number;
  error?: string;
}

function pkce(): { codeVerifier: string; codeChallenge: string } {
  const codeVerifier = randomBytes(32).toString('base64url');
  return {
    codeVerifier,
    codeChallenge: createHash('sha256').update(codeVerifier).digest('base64url'),
  };
}

function authorizeUrl(params: {
  clientId: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
}): string {
  const query = new URLSearchParams({
    client_id: params.clientId,
    response_type: 'code',
    redirect_uri: params.redirectUri,
    response_mode: 'query',
    scope: MICROSOFT_SCOPES,
    state: params.state,
    code_challenge: params.codeChallenge,
    code_challenge_method: 'S256',
    prompt: 'select_account',
  });
  return `${AUTHORITY}/authorize?${query.toString()}`;
}

interface IdClaims {
  tid?: unknown;
  oid?: unknown;
  email?: unknown;
  preferred_username?: unknown;
}

/**
 * Reads the ID token's claims without verifying its signature: it comes straight from the token
 * endpoint over TLS, in the exchange that presented the PKCE verifier (OIDC Core §3.1.3.7), and
 * only labels the account.
 */
function readClaims(idToken: string | undefined): IdClaims {
  const payload = idToken?.split('.')[1];
  if (!payload) throw new AuthFlowError('Microsoft did not return an ID token.');
  try {
    return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as IdClaims;
  } catch (err) {
    throw new AuthFlowError('Microsoft returned an unreadable ID token.', { cause: err });
  }
}

function addressOf(claims: IdClaims): string | undefined {
  return [claims.email, claims.preferred_username].find(
    (v): v is string => typeof v === 'string' && v.includes('@'),
  );
}

function hasFilesScope(scope: string | undefined): boolean {
  return (scope ?? '')
    .split(' ')
    .some((s) => s.toLowerCase().replace(/^.*\//, '') === 'files.readwrite');
}

export class MicrosoftAuth implements ProviderAuth {
  private readonly log: Logger;
  private readonly post: typeof fetch;

  constructor(private readonly deps: MicrosoftAuthDeps) {
    this.log = deps.logger ?? defaultLogger;
    this.post = deps.fetch ?? fetch;
  }

  async add(alias?: string): Promise<AccountRecord> {
    const outcome: { saved?: AccountRecord } = {};
    await this.interactiveLogin(async (login) => {
      outcome.saved = await this.saveNew(alias, login);
    });
    if (!outcome.saved) throw new AuthFlowError('Login finished without saving the account');
    return outcome.saved;
  }

  startAdd(alias?: string): Promise<string> {
    return this.startTwoStep('add', alias ?? null);
  }

  async finishAdd(pending: PendingLogin, redirectUrl: string): Promise<AccountRecord> {
    return this.saveNew(
      pending.account ?? undefined,
      await this.finishTwoStep(pending, redirectUrl),
    );
  }

  async relogin(record: AccountRecord): Promise<AccountRecord> {
    let saved = false;
    await this.interactiveLogin(async (login) => {
      await this.saveRelogin(record, login);
      saved = true;
    });
    if (!saved) throw new AuthFlowError('Login finished without saving the account');
    return record;
  }

  startRelogin(record: AccountRecord): Promise<string> {
    return this.startTwoStep('login', record.accountId ?? '');
  }

  async finishRelogin(
    record: AccountRecord,
    pending: PendingLogin,
    redirectUrl: string,
  ): Promise<AccountRecord> {
    await this.saveRelogin(record, await this.finishTwoStep(pending, redirectUrl));
    return record;
  }

  async checkStatus(record: AccountRecord, _verify: boolean): Promise<AccountStatus> {
    return (await this.deps.tokens.get(tokenKey(record))) ? 'ok' : 'reauth_required';
  }

  async forget(record: AccountRecord): Promise<void> {
    await this.deps.tokens.delete(tokenKey(record));
  }

  private async saveNew(alias: string | undefined, login: MicrosoftLogin): Promise<AccountRecord> {
    const record = await this.deps.registry.add({
      alias: alias ?? defaultAlias(login.email),
      email: login.email,
      provider: 'microsoft',
      accountId: login.accountId,
    });
    try {
      await this.deps.tokens.set(tokenKey(record), login.refreshToken);
    } catch (err) {
      await this.deps.registry.remove(record.alias);
      throw err;
    }
    return record;
  }

  private async saveRelogin(record: AccountRecord, login: MicrosoftLogin): Promise<void> {
    if (login.accountId !== record.accountId) {
      throw new AuthFlowError(
        `Signed in as ${login.email}, a different account from "${record.alias}" (${record.email}). Nothing was saved.`,
      );
    }
    await this.deps.tokens.set(tokenKey(record), login.refreshToken);
  }

  private async startTwoStep(command: 'add' | 'login', account: string | null): Promise<string> {
    const clientId = await this.deps.loadClientId();
    const state = randomBytes(16).toString('hex');
    const { codeVerifier, codeChallenge } = pkce();
    const redirectUri = `http://localhost:${49152 + randomInt(65535 - 49152)}`;
    await this.deps.pending.save({
      state,
      codeVerifier,
      redirectUri,
      command,
      account,
      provider: 'microsoft',
    });
    return authorizeUrl({ clientId, redirectUri, state, codeChallenge });
  }

  private async finishTwoStep(pending: PendingLogin, redirectUrl: string): Promise<MicrosoftLogin> {
    const { code } = parseRedirectUrl(redirectUrl, LABEL);
    if (!code) throw new AuthFlowError('That redirect URL has no authorization code.');
    return withDeadline(
      this.exchange(
        code,
        pending.codeVerifier,
        pending.redirectUri,
        await this.deps.loadClientId(),
      ),
      this.deps.finishTimeoutMs ?? DEFAULT_FINISH_TIMEOUT_MS,
      LABEL,
    );
  }

  /** Browser login on a loopback port; `onVerified` saves before the browser is answered. */
  private async interactiveLogin(
    onVerified: (login: MicrosoftLogin) => Promise<void>,
  ): Promise<void> {
    const clientId = await this.deps.loadClientId();
    const state = randomBytes(16).toString('hex');
    const { codeVerifier, codeChallenge } = pkce();
    const server = createServer();
    const listener = await listenLocalhost(server);
    const pasteAbort = new AbortController();
    try {
      const redirectUri = `http://localhost:${listener.port}`;
      const { manual, print } = this.deps;
      const timeoutMs =
        this.deps.timeoutMs ?? (manual ? DEFAULT_MANUAL_TIMEOUT_MS : DEFAULT_TIMEOUT_MS);
      const callback = waitForCallback(server, state, timeoutMs, LABEL);
      callback.catch(() => undefined); // awaited below; prevents an unhandled rejection
      const authUrl = authorizeUrl({ clientId, redirectUri, state, codeChallenge });
      let incoming: Promise<Callback> = callback;
      if (manual) {
        print(
          `Open this URL in a browser on any device and sign in:\n${authUrl}\n\n` +
            `Microsoft then redirects to ${redirectUri}/?…, which usually fails to load on that device — ` +
            'that is expected. Copy the full URL from the address bar and paste it here.',
        );
        const pasted = waitForPaste(manual, state, print, pasteAbort.signal, LABEL);
        pasted.catch(() => undefined); // awaited via the race below
        incoming = Promise.race([callback, pasted]);
      } else {
        print(`Opening the browser for Microsoft sign-in. If it does not open, visit:\n${authUrl}`);
        this.deps.openUrl(authUrl).catch(() => {
          print('Could not open a browser automatically; use the URL above.');
        });
      }
      const { code, respond } = await incoming;
      pasteAbort.abort();
      try {
        const login = await withDeadline(
          this.exchange(code, codeVerifier, redirectUri, clientId),
          this.deps.finishTimeoutMs ?? DEFAULT_FINISH_TIMEOUT_MS,
          LABEL,
        );
        await onVerified(login);
        await respond(200, { kind: 'success', email: login.email });
      } catch (err) {
        const message =
          err instanceof AppError ? err.message : 'Unexpected error; see the terminal for details.';
        await respond(400, { kind: 'failure', message });
        throw err;
      }
    } finally {
      pasteAbort.abort();
      await listener.close();
    }
  }

  private async tokenRequest(form: Record<string, string>): Promise<{
    status: number;
    body: TokenResponse;
  }> {
    let res: Response;
    try {
      res = await this.post(`${AUTHORITY}/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(form).toString(),
      });
    } catch (err) {
      this.log.warn('Microsoft token endpoint unreachable', { error: err });
      throw new AuthFlowError(
        'Could not reach Microsoft sign-in. Check your connection and try again.',
      );
    }
    let body: TokenResponse = {};
    try {
      body = (await res.json()) as TokenResponse;
    } catch {
      // A non-JSON answer is handled by the status and the missing fields.
    }
    return { status: res.status, body };
  }

  private async exchange(
    code: string,
    codeVerifier: string,
    redirectUri: string,
    clientId: string,
  ): Promise<MicrosoftLogin> {
    const { status, body } = await this.tokenRequest({
      client_id: clientId,
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      code_verifier: codeVerifier,
      scope: MICROSOFT_SCOPES,
    });
    if (status !== 200) {
      throw new AuthFlowError(`Microsoft refused the sign-in (${body.error ?? status}).`);
    }
    if (!hasFilesScope(body.scope)) {
      throw new AuthFlowError(
        'OneDrive access was not granted. Run the login again and accept the "Have full access to your files" permission on the consent screen.',
      );
    }
    const claims = readClaims(body.id_token);
    const email = addressOf(claims);
    if (typeof claims.tid !== 'string' || typeof claims.oid !== 'string' || !email) {
      throw new AuthFlowError(
        'Microsoft did not identify the account (tenant, object ID or address is missing). Nothing was saved.',
      );
    }
    if (!body.refresh_token) {
      throw new AuthFlowError('Microsoft did not return a refresh token. Run the login again.');
    }
    return {
      accountId: `${claims.tid}.${claims.oid}`,
      email: email.toLowerCase(),
      refreshToken: body.refresh_token,
    };
  }
}
