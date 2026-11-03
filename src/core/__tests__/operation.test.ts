import { describe, expect, it } from 'vitest';
import { ConflictError, DriveApiError, ReauthRequiredError } from '../../errors.js';
import {
  createAudit,
  createFakeDrive,
  createRunner,
  httpError,
  noSleep,
  silentLogger,
} from '../../files/__tests__/fakes.js';
import { OperationRunner } from '../operation.js';

function setup(): {
  ops: OperationRunner;
  audit: ReturnType<typeof createAudit>;
  logger: ReturnType<typeof silentLogger>;
} {
  const audit = createAudit();
  const logger = silentLogger();
  const ops = new OperationRunner({
    runner: createRunner(createFakeDrive()),
    audit,
    retry: noSleep,
    logger,
  });
  return { ops, audit, logger };
}

describe('OperationRunner', () => {
  it('retries 5xx for idempotent operations', async () => {
    const { ops } = setup();
    let calls = 0;
    const result = await ops.exec(undefined, 'idempotent', 'f1', async () => {
      calls += 1;
      if (calls === 1) throw httpError(503);
      return 'ok';
    });
    expect(result).toBe('ok');
    expect(calls).toBe(2);
  });

  it('never retries 5xx for mutations and adds the re-read hint', async () => {
    const { ops } = setup();
    let calls = 0;
    const err = await ops
      .exec(undefined, 'mutate', 'f1', async () => {
        calls += 1;
        throw httpError(500);
      })
      .catch((e: unknown) => e);
    expect(calls).toBe(1);
    expect(err).toBeInstanceOf(DriveApiError);
    expect((err as Error).message).toMatch(/re-read the file/);
  });

  it('passes api and name into error mapping', async () => {
    const { ops } = setup();
    const err = await ops
      .exec(
        undefined,
        'mutate',
        'd1',
        async () => {
          throw httpError(
            400,
            'badRequest',
            "The required revision ID 'r' does not match the latest revision.",
          );
        },
        { api: 'docs', name: 'Plan' },
      )
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConflictError);
    expect((err as Error).message).toContain('"Plan"');
  });

  it('lets invalid_grant through untouched for the runner to handle', async () => {
    const { ops } = setup();
    const grant = Object.assign(new Error('invalid_grant'), {
      response: { data: { error: 'invalid_grant' } },
    });
    const err = await ops
      .exec(undefined, 'idempotent', 'f1', async () => {
        throw grant;
      })
      .catch((e: unknown) => e);
    expect(err).toBe(grant);
    expect(err).not.toBeInstanceOf(ReauthRequiredError);
  });

  it('records audit entries and swallows audit failures', async () => {
    const { ops, audit, logger } = setup();
    await ops.exec(undefined, 'mutate', 'f1', (ctx) =>
      ops.audit(ctx, 'docs_replace_text', { id: 'f1', name: 'Plan' }, { occurrencesChanged: 2 }),
    );
    expect(audit.entries).toEqual([
      {
        account: 'emco',
        op: 'docs_replace_text',
        fileId: 'f1',
        name: 'Plan',
        details: { occurrencesChanged: 2 },
      },
    ]);
    audit.record = async () => {
      throw new Error('disk full');
    };
    await ops.exec(undefined, 'mutate', 'f1', (ctx) =>
      ops.audit(ctx, 'docs_replace_text', { id: 'f1' }, {}),
    );
    expect(logger.warn).toHaveBeenCalled();
  });
});
