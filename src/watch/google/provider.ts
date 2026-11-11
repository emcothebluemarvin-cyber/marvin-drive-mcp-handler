import type { AuditSink } from '../../audit/audit-log.js';
import type { AccountRecord } from '../../config/account-registry.js';
import { OperationRunner } from '../../core/operation.js';
import type { DriveRunner } from '../../drive/client-factory.js';
import type { RetryOptions } from '../../files/retry.js';
import type { Logger } from '../../logger.js';
import type { WatchAccount, WatchProvider } from '../feed.js';
import { GoogleChangeFeed } from './feed.js';
import { GoogleSnapshotter } from './snapshotter.js';

export interface GoogleWatchDeps {
  runner: DriveRunner;
  audit: AuditSink;
  resolveAccount: (ref?: string) => Promise<AccountRecord>;
  logger?: Logger;
  retry?: RetryOptions;
}

/** The Google implementation of the watch provider seam (composition root: app.ts). */
export function createGoogleWatchProvider(deps: GoogleWatchDeps): WatchProvider {
  const ops = new OperationRunner({
    runner: deps.runner,
    audit: deps.audit,
    ...(deps.logger ? { logger: deps.logger } : {}),
    ...(deps.retry ? { retry: deps.retry } : {}),
  });
  return {
    resolveAccount: async (ref): Promise<WatchAccount> => {
      const account = await deps.resolveAccount(ref);
      return { email: account.email, alias: account.alias };
    },
    feed: (email) => new GoogleChangeFeed(ops, email),
    snapshotter: (email) => new GoogleSnapshotter(ops, email),
  };
}
