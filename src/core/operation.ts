import type { AuditOp, AuditSink } from '../audit/audit-log.js';
import { isInvalidGrant } from '../auth/oauth-errors.js';
import type { DriveContext, DriveRunner } from '../drive/client-factory.js';
import type { GoogleApi } from '../errors.js';
import { mapDriveError, type OperationKind } from '../files/drive-errors.js';
import { withRetry, type RetryOptions } from '../files/retry.js';
import { logger as defaultLogger, type Logger } from '../logger.js';

export interface OperationDeps {
  runner: DriveRunner;
  audit: AuditSink;
  retry?: RetryOptions;
  logger?: Logger;
}

/** Extra context for error messages: which API, and the file's human name. */
export interface OperationMeta {
  api?: GoogleApi;
  name?: string;
}

/** Shared plumbing for every service: account resolution, retry, error mapping, audit. */
export class OperationRunner {
  readonly log: Logger;

  constructor(private readonly deps: OperationDeps) {
    this.log = deps.logger ?? defaultLogger;
  }

  /** Runs `operation` for an account with retry + error mapping (invalid_grant passes through). */
  exec<T>(
    account: string | undefined,
    kind: OperationKind,
    target: string | undefined,
    operation: (ctx: DriveContext, attempt: number) => Promise<T>,
    meta: OperationMeta = {},
  ): Promise<T> {
    const retryClass = kind === 'idempotent' ? 'idempotent' : 'create';
    return this.deps.runner.run(account, async (ctx) => {
      try {
        return await withRetry((attempt) => operation(ctx, attempt), retryClass, this.deps.retry);
      } catch (err) {
        if (isInvalidGrant(err)) throw err;
        throw mapDriveError(err, {
          target,
          alias: ctx.account.alias,
          logger: this.log,
          kind,
          ...(meta.api ? { api: meta.api } : {}),
          ...(meta.name ? { name: meta.name } : {}),
        });
      }
    });
  }

  /** Writes an audit entry; failures are logged, never thrown (the change already happened). */
  async audit(
    ctx: DriveContext,
    op: AuditOp,
    file: { id?: string | null; name?: string | null },
    details: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.deps.audit.record({
        account: ctx.account.alias,
        op,
        fileId: file.id ?? '',
        ...(file.name ? { name: file.name } : {}),
        details,
      });
    } catch (err) {
      this.log.warn('Audit log write failed', { op, fileId: file.id, error: err });
    }
  }
}
