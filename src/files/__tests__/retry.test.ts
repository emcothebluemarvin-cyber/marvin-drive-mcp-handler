import { describe, expect, it, vi } from 'vitest';
import { retryKind, withRetry } from '../retry.js';

const http = (status: number, reason?: string): Error =>
  Object.assign(new Error(`HTTP ${status}`), {
    status,
    ...(reason ? { errors: [{ reason }] } : {}),
  });

function flaky<T>(failures: Error[], value: T): (attempt: number) => Promise<T> {
  return async (attempt) => {
    const failure = failures[attempt];
    if (failure) throw failure;
    return value;
  };
}

describe('withRetry', () => {
  it('retries rate limits and 5xx for idempotent calls with exponential backoff', async () => {
    const sleep = vi.fn(async (_ms: number) => {});
    const result = await withRetry(
      flaky([http(429), http(503), http(403, 'rateLimitExceeded')], 'ok'),
      'idempotent',
      {
        sleep,
        random: () => 0,
        baseDelayMs: 100,
      },
    );
    expect(result).toBe('ok');
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([100, 200, 400]);
  });

  it('gives up after 3 retries', async () => {
    const err = http(500);
    await expect(
      withRetry(flaky([err, err, err, err], 'never'), 'idempotent', { sleep: async () => {} }),
    ).rejects.toBe(err);
  });

  it('retries creates only on rate limits', async () => {
    await expect(
      withRetry(flaky([http(429)], 'created'), 'create', { sleep: async () => {} }),
    ).resolves.toBe('created');
    const serverError = http(500);
    const fn = vi.fn(flaky([serverError], 'created'));
    await expect(withRetry(fn, 'create', { sleep: async () => {} })).rejects.toBe(serverError);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('does not retry client errors', async () => {
    const fn = vi.fn(flaky([http(404)], 'x'));
    await expect(withRetry(fn, 'idempotent', { sleep: async () => {} })).rejects.toThrow(
      'HTTP 404',
    );
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('passes the attempt number to the operation', async () => {
    const attempts: number[] = [];
    await withRetry(
      async (attempt) => {
        attempts.push(attempt);
        if (attempt === 0) throw http(502);
        return 'ok';
      },
      'idempotent',
      { sleep: async () => {} },
    );
    expect(attempts).toEqual([0, 1]);
  });

  it.each(['ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'ECONNREFUSED', 'EPIPE', 'UND_ERR_SOCKET'])(
    'retries %s network errors for idempotent calls but not creates',
    async (code) => {
      const net = Object.assign(new Error(code), { code });
      await expect(
        withRetry(flaky([net], 'ok'), 'idempotent', { sleep: async () => {} }),
      ).resolves.toBe('ok');
      const fn = vi.fn(flaky([net], 'ok'));
      await expect(withRetry(fn, 'create', { sleep: async () => {} })).rejects.toBe(net);
      expect(fn).toHaveBeenCalledTimes(1);
    },
  );
});

describe('retryKind', () => {
  it('reads the network code from err.cause.code', () => {
    const err = Object.assign(new Error('fetch failed'), { cause: { code: 'UND_ERR_SOCKET' } });
    expect(retryKind(err)).toBe('server');
  });

  it('treats an undici "terminated" TypeError as a server error', () => {
    expect(retryKind(new TypeError('terminated'))).toBe('server');
    expect(retryKind(new TypeError('other'))).toBeNull();
    expect(retryKind(new Error('terminated'))).toBeNull();
  });
});
