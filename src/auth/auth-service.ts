import { Auth } from 'googleapis';
import {
  ALIAS_PATTERN,
  defaultAlias,
  isMicrosoft,
  providerOf,
  tokenKey,
  type AccountProvider,
  type AccountRecord,
  type AccountRegistry,
} from '../config/account-registry.js';
import type { ClientCredentials } from '../config/client-secret.js';
import { AuthFlowError, ConfigError, ReauthRequiredError, ValidationError } from '../errors.js';
import { logger as defaultLogger, type Logger } from '../logger.js';
import type { LoginResult, TwoStepStart } from './login-flow.js';
import { readRedirectUrl, redirectError } from './loopback.js';
import type { PendingLogin, PendingLoginStore } from './pending-login.js';
import { isInvalidGrant } from './oauth-errors.js';
import type { AccountStatus, ProviderAuth } from './provider-auth.js';
import type { TokenStore } from './token-store.js';

export type { AccountStatus } from './provider-auth.js';

export interface AccountStatusEntry {
  alias: string;
  email: string;
  provider: AccountProvider;
  isDefault: boolean;
  status: AccountStatus;
}

export interface AuthorizedClient {
  account: AccountRecord;
  client: Auth.OAuth2Client;
  refreshToken: string;
}

export interface AuthServiceDeps {
  registry: AccountRegistry;
  tokens: TokenStore;
  loadCredentials: () => Promise<ClientCredentials>;
  /**
   * Runs the browser login. Must call `onVerified` after Google verified the account and before
   * answering the browser, so save errors are shown on the page (see runLoginFlow).
   */
  login: (opts: {
    credentials: ClientCredentials;
    loginHint?: string;
    onVerified: (result: LoginResult) => Promise<void>;
  }) => Promise<LoginResult>;
  /** Two-step no-browser login (--print-url, then --redirect-url); see startTwoStepLogin. */
  twoStep?: {
    pending: PendingLoginStore;
    start: (credentials: ClientCredentials, loginHint?: string) => Promise<TwoStepStart>;
    finish: (
      credentials: ClientCredentials,
      pending: PendingLogin,
      redirectUrl: string,
    ) => Promise<LoginResult>;
  };
  newClient?: (credentials: ClientCredentials) => Auth.OAuth2Client;
  /** The Microsoft sign-in; dispatched to before any Google step (spec §3.4). */
  microsoft?: ProviderAuth;
  logger?: Logger;
}

export class AuthService {
  private readonly reauthNeeded = new Set<string>();
  private readonly log: Logger;
  private readonly newClient: (credentials: ClientCredentials) => Auth.OAuth2Client;

  constructor(private readonly deps: AuthServiceDeps) {
    this.log = deps.logger ?? defaultLogger;
    this.newClient =
      deps.newClient ??
      ((c): Auth.OAuth2Client =>
        new Auth.OAuth2Client({ clientId: c.clientId, clientSecret: c.clientSecret }));
  }

  private microsoft(): ProviderAuth {
    if (!this.deps.microsoft) throw new ConfigError('Microsoft accounts are not available here');
    return this.deps.microsoft;
  }

  async addAccount(alias?: string, provider: AccountProvider = 'google'): Promise<AccountRecord> {
    const normalized = await this.checkNewAlias(alias);
    if (provider === 'microsoft') return this.microsoft().add(normalized ?? undefined);
    const credentials = await this.deps.loadCredentials();
    const outcome: { saved?: AccountRecord } = {};
    await this.deps.login({
      credentials,
      onVerified: async (result) => {
        outcome.saved = await this.saveNewAccount(alias, result);
      },
    });
    const { saved } = outcome;
    if (!saved) throw new AuthFlowError('Login finished without saving the account');
    this.reauthNeeded.delete(tokenKey(saved));
    return saved;
  }

  /** `auth add --print-url`: returns the consent URL; finish with finishAddAccount. */
  async startAddAccount(alias?: string, provider: AccountProvider = 'google'): Promise<string> {
    const normalized = await this.checkNewAlias(alias);
    if (provider === 'microsoft') return this.microsoft().startAdd(normalized ?? undefined);
    return this.startTwoStep({ command: 'add', account: normalized });
  }

  /**
   * `auth add --redirect-url`: completes a login started by startAddAccount. The waiting entry
   * decides the provider; `provider` is only checked against it when given.
   */
  async finishAddAccount(
    alias: string | undefined,
    redirectUrl: string,
    provider?: AccountProvider,
  ): Promise<AccountRecord> {
    const normalized = alias === undefined ? null : alias.trim().toLowerCase();
    const pending = await this.takePending(
      { command: 'add', account: normalized, ...(provider ? { provider } : {}) },
      redirectUrl,
    );
    if (pending.provider === 'microsoft') return this.microsoft().finishAdd(pending, redirectUrl);
    const result = await this.finishGoogle(pending, redirectUrl);
    const saved = await this.saveNewAccount(alias, result);
    this.reauthNeeded.delete(tokenKey(saved));
    return saved;
  }

  /** `auth login <account> --print-url`. */
  async startRelogin(ref: string): Promise<string> {
    const record = await this.deps.registry.resolve(ref);
    if (isMicrosoft(record)) return this.microsoft().startRelogin(record);
    return this.startTwoStep({ command: 'login', account: record.email }, record.email);
  }

  /** `auth login <account> --redirect-url`. */
  async finishRelogin(ref: string, redirectUrl: string): Promise<AccountRecord> {
    const record = await this.deps.registry.resolve(ref);
    const pending = await this.takePending(
      {
        command: 'login',
        account: isMicrosoft(record) ? (record.accountId ?? '') : record.email,
        provider: providerOf(record),
      },
      redirectUrl,
    );
    if (isMicrosoft(record)) return this.microsoft().finishRelogin(record, pending, redirectUrl);
    const result = await this.finishGoogle(pending, redirectUrl);
    if (result.email !== record.email) {
      throw new AuthFlowError(
        `Signed in as ${result.email}, but "${record.alias}" is ${record.email}. Nothing was saved.`,
      );
    }
    await this.deps.tokens.set(tokenKey(record), result.refreshToken);
    this.reauthNeeded.delete(tokenKey(record));
    return record;
  }

  private twoStep(): NonNullable<AuthServiceDeps['twoStep']> {
    if (!this.deps.twoStep) throw new AuthFlowError('Two-step login is not available here');
    return this.deps.twoStep;
  }

  private async startTwoStep(
    target: Pick<PendingLogin, 'command' | 'account'>,
    loginHint?: string,
  ): Promise<string> {
    const twoStep = this.twoStep();
    const credentials = await this.deps.loadCredentials();
    const started = await twoStep.start(credentials, loginHint);
    await twoStep.pending.save({
      ...target,
      state: started.state,
      codeVerifier: started.codeVerifier,
      redirectUri: started.redirectUri,
    });
    return started.authUrl;
  }

  /** Takes the waiting login for the URL's state (single use) and checks it was for `target`. */
  private async takePending(
    target: Pick<PendingLogin, 'command' | 'account' | 'provider'>,
    redirectUrl: string,
  ): Promise<PendingLogin> {
    const twoStep = this.twoStep();
    const { state, error } = readRedirectUrl(redirectUrl);
    if (error) {
      const provider = await twoStep.pending.peekProvider(state);
      throw redirectError(error, provider === 'microsoft' ? 'Microsoft' : 'Google');
    }
    const pending = await twoStep.pending.take(state);
    if (!pending) {
      throw new AuthFlowError(
        'No login is waiting for this redirect URL. Run the same command with --print-url first; its URL is valid for 10 minutes and works once.',
      );
    }
    const provider = pending.provider ?? 'google';
    if (target.provider !== undefined && target.provider !== provider) {
      throw new AuthFlowError(
        `This redirect URL belongs to a ${provider} login, not ${target.provider}. Nothing was saved; start again with --print-url.`,
      );
    }
    if (pending.command !== target.command || pending.account !== target.account) {
      const started = pending.command === 'add' ? 'auth add' : 'auth login';
      throw new AuthFlowError(
        `This redirect URL belongs to "${started}"${pending.account ? ` for ${pending.account}` : ''}; run --redirect-url with the same command and account as --print-url. Nothing was saved; start again with --print-url.`,
      );
    }
    return pending;
  }

  private async finishGoogle(pending: PendingLogin, redirectUrl: string): Promise<LoginResult> {
    const credentials = await this.deps.loadCredentials();
    return this.twoStep().finish(credentials, pending, redirectUrl);
  }

  /** Validates an alias for a new account; returns it normalized, or null when omitted. */
  private async checkNewAlias(alias: string | undefined): Promise<string | null> {
    if (alias === undefined) return null;
    const normalized = alias.trim().toLowerCase();
    if (!ALIAS_PATTERN.test(normalized)) {
      throw new ValidationError(`Alias must match ${ALIAS_PATTERN.source} (got "${alias}")`);
    }
    const taken = await this.deps.registry.find(normalized);
    if (taken) {
      throw new ValidationError(
        `Alias "${normalized}" is already used by ${taken.email}; pass --alias <name>`,
      );
    }
    return normalized;
  }

  /** Registers the account and stores its token; rolls the registry back if the token fails. */
  private async saveNewAccount(
    alias: string | undefined,
    result: LoginResult,
  ): Promise<AccountRecord> {
    const record = await this.deps.registry.add({
      alias: alias ?? defaultAlias(result.email),
      email: result.email,
    });
    try {
      await this.deps.tokens.set(tokenKey(record), result.refreshToken);
    } catch (err) {
      await this.deps.registry.remove(record.alias);
      throw err;
    }
    return record;
  }

  async relogin(ref: string): Promise<AccountRecord> {
    const record = await this.deps.registry.resolve(ref);
    if (isMicrosoft(record)) return this.microsoft().relogin(record);
    const credentials = await this.deps.loadCredentials();
    const outcome = { saved: false };
    await this.deps.login({
      credentials,
      loginHint: record.email,
      onVerified: async (result) => {
        if (result.email !== record.email) {
          throw new AuthFlowError(
            `Signed in as ${result.email}, but "${record.alias}" is ${record.email}. Nothing was saved.`,
          );
        }
        await this.deps.tokens.set(tokenKey(record), result.refreshToken);
        outcome.saved = true;
      },
    });
    if (!outcome.saved) throw new AuthFlowError('Login finished without saving the account');
    this.reauthNeeded.delete(tokenKey(record));
    return record;
  }

  async removeAccount(ref: string): Promise<AccountRecord> {
    const record = await this.deps.registry.resolve(ref);
    if (isMicrosoft(record)) {
      try {
        await this.microsoft().forget(record);
      } catch (err) {
        this.log.warn('Failed to delete stored token; removing the account anyway', {
          alias: record.alias,
          error: err,
        });
      }
      await this.deps.registry.remove(record.alias);
      return record;
    }
    const token = await this.deps.tokens.get(tokenKey(record));
    try {
      await this.deps.tokens.delete(tokenKey(record));
    } catch (err) {
      this.log.warn('Failed to delete stored token; removing the account anyway', {
        alias: record.alias,
        error: err,
      });
    }
    await this.deps.registry.remove(record.alias);
    this.reauthNeeded.delete(tokenKey(record));
    if (token) {
      try {
        const credentials = await this.deps.loadCredentials();
        await this.newClient(credentials).revokeToken(token);
      } catch (err) {
        this.log.warn('Token revocation failed; account was removed locally', {
          alias: record.alias,
          error: err,
        });
      }
    }
    return record;
  }

  setDefault(ref: string): Promise<AccountRecord> {
    return this.deps.registry.setDefault(ref);
  }

  /** For Google-only surfaces: an email means the Google account of that address. */
  resolveAccount(ref?: string): Promise<AccountRecord> {
    return this.deps.registry.resolveGoogleFirst(ref);
  }

  /** `key` comes from `tokenKey(record)`. */
  readRefreshToken(key: string): Promise<string | null> {
    return this.deps.tokens.get(key);
  }

  markReauthRequired(key: string): void {
    this.reauthNeeded.add(key);
  }

  markHealthy(key: string): void {
    this.reauthNeeded.delete(key);
  }

  async authorize(ref?: string): Promise<AuthorizedClient> {
    const account = await this.deps.registry.resolveGoogleFirst(ref);
    const refreshToken = await this.deps.tokens.get(tokenKey(account));
    if (!refreshToken) {
      this.reauthNeeded.add(tokenKey(account));
      throw new ReauthRequiredError(account.alias);
    }
    const client = this.newClient(await this.deps.loadCredentials());
    client.setCredentials({ refresh_token: refreshToken });
    client.on('tokens', (fresh) => {
      if (fresh.refresh_token && fresh.refresh_token !== refreshToken) {
        this.deps.tokens.set(tokenKey(account), fresh.refresh_token).catch((err: unknown) => {
          this.log.warn('Failed to persist rotated refresh token', {
            alias: account.alias,
            error: err,
          });
        });
      }
    });
    return { account, client, refreshToken };
  }

  async status(verify = false): Promise<AccountStatusEntry[]> {
    const data = await this.deps.registry.read();
    return Promise.all(
      data.accounts.map(async (a) => ({
        alias: a.alias,
        email: a.email,
        provider: providerOf(a),
        isDefault: data.default === a.alias,
        status: isMicrosoft(a)
          ? await this.microsoft().checkStatus(a, verify)
          : await this.checkStatus(a, verify),
      })),
    );
  }

  private async checkStatus(account: AccountRecord, verify: boolean): Promise<AccountStatus> {
    const token = await this.deps.tokens.get(tokenKey(account));
    if (!token) return 'reauth_required';
    if (!verify) return this.reauthNeeded.has(tokenKey(account)) ? 'reauth_required' : 'ok';
    try {
      const { client } = await this.authorize(account.alias);
      await client.getAccessToken();
      this.reauthNeeded.delete(tokenKey(account));
      return 'ok';
    } catch (err) {
      if (isInvalidGrant(err) || err instanceof ReauthRequiredError) {
        this.reauthNeeded.add(tokenKey(account));
        return 'reauth_required';
      }
      this.log.warn('Token check failed', { alias: account.alias, error: err });
      return 'unknown';
    }
  }
}
