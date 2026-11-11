import { describe, expect, it } from 'vitest';
import { MAX_RETRY_AFTER_MS, decideRetry, retryAfterMs } from '../graph-retry.js';

const base = { random: () => 0, baseDelayMs: 100, now: () => 1_000_000 };

describe('retryAfterMs', () => {
  it('reads seconds and HTTP dates, and caps them', () => {
    expect(retryAfterMs('7', 0)).toBe(7000);
    expect(retryAfterMs('600', 0)).toBe(MAX_RETRY_AFTER_MS);
    expect(retryAfterMs(new Date(5000).toUTCString(), 0)).toBe(5000);
  });
  it('is undefined when absent or invalid', () => {
    expect(retryAfterMs(null, 0)).toBeUndefined();
    expect(retryAfterMs('soon', 0)).toBeUndefined();
  });
});

describe('decideRetry', () => {
  it.each([
    [429, 'create', true],
    [429, 'idempotent', true],
    [503, 'idempotent', true],
    [503, 'create', false],
    [500, 'idempotent', true],
    [502, 'create', false],
    [507, 'idempotent', false],
    [404, 'idempotent', false],
    [undefined, 'idempotent', true],
    [undefined, 'create', false],
  ] as const)('status %s, class %s: retry %s', (status, retryClass, retry) => {
    expect(decideRetry({ ...base, status, retryClass, attempt: 0 }).retry).toBe(retry);
  });

  it('stops after three retries', () => {
    expect(decideRetry({ ...base, status: 429, retryClass: 'create', attempt: 2 }).retry).toBe(
      true,
    );
    expect(decideRetry({ ...base, status: 429, retryClass: 'create', attempt: 3 }).retry).toBe(
      false,
    );
  });

  it('honours Retry-After for 429 and idempotent 503', () => {
    const at = (status: number) =>
      decideRetry({ ...base, status, retryClass: 'idempotent', attempt: 0, retryAfter: '9' });
    expect(at(429).delayMs).toBe(9000);
    expect(at(503).delayMs).toBe(9000);
  });

  it('uses exponential backoff otherwise', () => {
    const at = (attempt: number) =>
      decideRetry({ ...base, status: 500, retryClass: 'idempotent', attempt, retryAfter: '9' });
    expect(at(0).delayMs).toBe(100);
    expect(at(2).delayMs).toBe(400);
  });

  it('accepts a custom retry limit', () => {
    const input = { ...base, status: 500, retryClass: 'idempotent', maxRetries: 5 } as const;
    expect(decideRetry({ ...input, attempt: 4 }).retry).toBe(true);
    expect(decideRetry({ ...input, attempt: 5 }).retry).toBe(false);
  });
});
