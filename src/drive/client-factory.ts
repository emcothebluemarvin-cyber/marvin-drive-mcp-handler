import type { Auth } from 'googleapis';
import type { AuthService } from '../auth/auth-service.js';
import { isInvalidGrant } from '../auth/oauth-errors.js';
import { isMicrosoft, tokenKey, type AccountRecord } from '../config/account-registry.js';
import { ProviderNotSupportedError, ReauthRequiredError } from '../errors.js';
import { logger as defaultLogger, type Logger } from '../logger.js';
import { createDocsAdapter, type DocsAdapter } from './docs-adapter.js';
import { createDriveAdapter, type DriveAdapter } from './drive-adapter.js';
import { createSheetsAdapter, type SheetsAdapter } from './sheets-adapter.js';
import { createSlidesAdapter, type SlidesAdapter } from './slides-adapter.js';

export interface GoogleAdapters {
  drive: DriveAdapter;
  docs: DocsAdapter;
  sheets: SheetsAdapter;
  slides: SlidesAdapter;
}

export interface DriveContext extends GoogleAdapters {
  account: AccountRecord;
}

export function createGoogleAdapters(client: Auth.OAuth2Client): GoogleAdapters {
  return {
    drive: createDriveAdapter(client),
    docs: createDocsAdapter(client),
    sheets: createSheetsAdapter(client),
    slides: createSlidesAdapter(client),
  };
}

/**
 * Runs `fn` with an authorized Drive adapter for the given account (alias/email/default).
 * `fn` may run twice (stale-token retry), so it must open streams/resources inside itself.
 */
export interface DriveRunner {
  run<T>(accountRef: string | undefined, fn: (ctx: DriveContext) => Promise<T>): Promise<T>;
}

interface CachedContext extends DriveContext {
  refreshToken: string;
}

export class DriveClientFactory implements DriveRunner {
  private readonly cache = new Map<string, CachedContext>();

  constructor(
    private readonly auth: AuthService,
    private readonly makeAdapters: (
      client: Auth.OAuth2Client,
    ) => GoogleAdapters = createGoogleAdapters,
    private readonly logger: Logger = defaultLogger,
  ) {}

  async run<T>(accountRef: string | undefined, fn: (ctx: DriveContext) => Promise<T>): Promise<T> {
    const ctx = await this.context(accountRef);
    try {
      const result = await fn(ctx);
      this.auth.markHealthy(tokenKey(ctx.account));
      return result;
    } catch (err) {
      if (!isInvalidGrant(err)) throw err;
      let lastErr: unknown = err;
      this.evict(ctx);
      let latest: string | null = null;
      try {
        latest = await this.auth.readRefreshToken(tokenKey(ctx.account));
      } catch (readErr) {
        this.logger.warn('Keychain re-read failed', { alias: ctx.account.alias, error: readErr });
      }
      if (latest && latest !== ctx.refreshToken) {
        const retryCtx = await this.context(ctx.account.alias);
        try {
          const result = await fn(retryCtx);
          this.auth.markHealthy(tokenKey(ctx.account));
          return result;
        } catch (retryErr) {
          if (!isInvalidGrant(retryErr)) throw retryErr;
          lastErr = retryErr;
          this.evict(retryCtx);
        }
      }
      this.auth.markReauthRequired(tokenKey(ctx.account));
      throw new ReauthRequiredError(ctx.account.alias, { cause: lastErr });
    }
  }

  /** Removes the cache entry only if it is still the one this call used. */
  private evict(ctx: CachedContext): void {
    if (this.cache.get(ctx.account.email) === ctx) this.cache.delete(ctx.account.email);
  }

  private async context(accountRef: string | undefined): Promise<CachedContext> {
    const account = await this.auth.resolveAccount(accountRef);
    if (isMicrosoft(account)) throw new ProviderNotSupportedError(account.alias);
    const token = await this.auth.readRefreshToken(tokenKey(account));
    if (!token) {
      this.cache.delete(account.email);
      this.auth.markReauthRequired(tokenKey(account));
      throw new ReauthRequiredError(account.alias);
    }
    const cached = this.cache.get(account.email);
    if (cached && cached.refreshToken === token) return cached;

    const { client, refreshToken } = await this.auth.authorize(account.alias);
    const fresh: CachedContext = { account, ...this.makeAdapters(client), refreshToken };
    this.cache.set(account.email, fresh);
    return fresh;
  }
}
