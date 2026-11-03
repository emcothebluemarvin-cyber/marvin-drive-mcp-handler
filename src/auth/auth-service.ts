import { Auth } from 'googleapis';
import {
  ALIAS_PATTERN,
  defaultAlias,
  type AccountRecord,
  type AccountRegistry,
} from '../config/account-registry.js';
import type { ClientCredentials } from '../config/client-secret.js';
import { AuthFlowError, ReauthRequiredError, ValidationError } from '../errors.js';
import { logger as defaultLogger, type Logger } from '../logger.js';
import type { LoginResult } from './login-flow.js';
import { isInvalidGrant } from './oauth-errors.js';
import type { TokenStore } from './token-store.js';

export type AccountStatus = 'ok' | 'reauth_required' | 'unknown';

export interface AccountStatusEntry {
  alias: string;
  email: string;
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
  newClient?: (credentials: ClientCredentials) => Auth.OAuth2Client;
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

  async addAccount(alias?: string): Promise<AccountRecord> {
    if (alias !== undefined) {
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
    }
    const credentials = await this.deps.loadCredentials();
    const outcome: { saved?: AccountRecord } = {};
    await this.deps.login({
      credentials,
      onVerified: async (result) => {
        const record = await this.deps.registry.add({
          alias: alias ?? defaultAlias(result.email),
          email: result.email,
        });
        try {
          await this.deps.tokens.set(record.email, result.refreshToken);
        } catch (err) {
          await this.deps.registry.remove(record.alias);
          throw err;
        }
        outcome.saved = record;
      },
    });
    const { saved } = outcome;
    if (!saved) throw new AuthFlowError('Login finished without saving the account');
    this.reauthNeeded.delete(saved.email);
    return saved;
  }

  async relogin(ref: string): Promise<AccountRecord> {
    const record = await this.deps.registry.resolve(ref);
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
        await this.deps.tokens.set(record.email, result.refreshToken);
        outcome.saved = true;
      },
    });
    if (!outcome.saved) throw new AuthFlowError('Login finished without saving the account');
    this.reauthNeeded.delete(record.email);
    return record;
  }

  async removeAccount(ref: string): Promise<AccountRecord> {
    const record = await this.deps.registry.resolve(ref);
    const token = await this.deps.tokens.get(record.email);
    try {
      await this.deps.tokens.delete(record.email);
    } catch (err) {
      this.log.warn('Failed to delete stored token; removing the account anyway', {
        alias: record.alias,
        error: err,
      });
    }
    await this.deps.registry.remove(record.alias);
    this.reauthNeeded.delete(record.email);
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

  resolveAccount(ref?: string): Promise<AccountRecord> {
    return this.deps.registry.resolve(ref);
  }

  readRefreshToken(email: string): Promise<string | null> {
    return this.deps.tokens.get(email);
  }

  markReauthRequired(email: string): void {
    this.reauthNeeded.add(email);
  }

  markHealthy(email: string): void {
    this.reauthNeeded.delete(email);
  }

  async authorize(ref?: string): Promise<AuthorizedClient> {
    const account = await this.deps.registry.resolve(ref);
    const refreshToken = await this.deps.tokens.get(account.email);
    if (!refreshToken) {
      this.reauthNeeded.add(account.email);
      throw new ReauthRequiredError(account.alias);
    }
    const client = this.newClient(await this.deps.loadCredentials());
    client.setCredentials({ refresh_token: refreshToken });
    client.on('tokens', (fresh) => {
      if (fresh.refresh_token && fresh.refresh_token !== refreshToken) {
        this.deps.tokens.set(account.email, fresh.refresh_token).catch((err: unknown) => {
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
        isDefault: data.default === a.alias,
        status: await this.checkStatus(a, verify),
      })),
    );
  }

  private async checkStatus(account: AccountRecord, verify: boolean): Promise<AccountStatus> {
    const token = await this.deps.tokens.get(account.email);
    if (!token) return 'reauth_required';
    if (!verify) return this.reauthNeeded.has(account.email) ? 'reauth_required' : 'ok';
    try {
      const { client } = await this.authorize(account.alias);
      await client.getAccessToken();
      this.reauthNeeded.delete(account.email);
      return 'ok';
    } catch (err) {
      if (isInvalidGrant(err) || err instanceof ReauthRequiredError) {
        this.reauthNeeded.add(account.email);
        return 'reauth_required';
      }
      this.log.warn('Token check failed', { alias: account.alias, error: err });
      return 'unknown';
    }
  }
}
