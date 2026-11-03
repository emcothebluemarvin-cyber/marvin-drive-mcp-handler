import type { Auth } from 'googleapis';
import type { AuthService } from '../auth/auth-service.js';
import { isInvalidGrant } from '../auth/oauth-errors.js';
import type { AccountRecord } from '../config/account-registry.js';
import { ReauthRequiredError } from '../errors.js';
import { createDriveAdapter, type DriveAdapter } from './drive-adapter.js';

export interface DriveContext {
  account: AccountRecord;
  drive: DriveAdapter;
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
    private readonly makeAdapter: (client: Auth.OAuth2Client) => DriveAdapter = createDriveAdapter,
  ) {}

  async run<T>(accountRef: string | undefined, fn: (ctx: DriveContext) => Promise<T>): Promise<T> {
    const ctx = await this.context(accountRef);
    try {
      const result = await fn(ctx);
      this.auth.markHealthy(ctx.account.email);
      return result;
    } catch (err) {
      if (!isInvalidGrant(err)) throw err;
      let lastErr: unknown = err;
      this.evict(ctx);
      const latest = await this.auth.readRefreshToken(ctx.account.email).catch(() => null);
      if (latest && latest !== ctx.refreshToken) {
        const retryCtx = await this.context(ctx.account.alias);
        try {
          const result = await fn(retryCtx);
          this.auth.markHealthy(ctx.account.email);
          return result;
        } catch (retryErr) {
          if (!isInvalidGrant(retryErr)) throw retryErr;
          lastErr = retryErr;
          this.evict(retryCtx);
        }
      }
      this.auth.markReauthRequired(ctx.account.email);
      throw new ReauthRequiredError(ctx.account.alias, { cause: lastErr });
    }
  }

  /** Removes the cache entry only if it is still the one this call used. */
  private evict(ctx: CachedContext): void {
    if (this.cache.get(ctx.account.email) === ctx) this.cache.delete(ctx.account.email);
  }

  private async context(accountRef: string | undefined): Promise<CachedContext> {
    const account = await this.auth.resolveAccount(accountRef);
    const token = await this.auth.readRefreshToken(account.email);
    if (!token) {
      this.cache.delete(account.email);
      this.auth.markReauthRequired(account.email);
      throw new ReauthRequiredError(account.alias);
    }
    const cached = this.cache.get(account.email);
    if (cached && cached.refreshToken === token) return cached;

    const { client, refreshToken } = await this.auth.authorize(account.alias);
    const fresh: CachedContext = { account, drive: this.makeAdapter(client), refreshToken };
    this.cache.set(account.email, fresh);
    return fresh;
  }
}
