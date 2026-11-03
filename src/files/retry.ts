import { isRateLimit, reasonOf, statusOf } from './drive-errors.js';

/** idempotent: safe to repeat; create: repeating could make a duplicate. */
export type RetryClass = 'idempotent' | 'create';

export interface RetryOptions {
  retries?: number;
  baseDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

const NETWORK_CODES = new Set([
  'ECONNRESET',
  'ETIMEDOUT',
  'EAI_AGAIN',
  'ECONNREFUSED',
  'EPIPE',
  'UND_ERR_SOCKET',
]);

function networkCode(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const code = (value as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

export function retryKind(err: unknown): 'rate-limit' | 'server' | null {
  const status = statusOf(err);
  if (isRateLimit(status, reasonOf(err))) return 'rate-limit';
  if (status !== undefined && status >= 500) return 'server';
  if (status === undefined && typeof err === 'object' && err !== null) {
    // undici (global fetch) puts the socket error code on `cause`.
    const codes = [networkCode(err), networkCode((err as { cause?: unknown }).cause)];
    if (codes.some((c) => c !== undefined && NETWORK_CODES.has(c))) return 'server';
    if (err instanceof TypeError && err.message === 'terminated') return 'server';
  }
  return null;
}

/** Spec §9 retry policy: exponential backoff + jitter, max `retries` (default 3) retries. */
export async function withRetry<T>(
  operation: (attempt: number) => Promise<T>,
  retryClass: RetryClass,
  options: RetryOptions = {},
): Promise<T> {
  const retries = options.retries ?? 3;
  const base = options.baseDelayMs ?? 500;
  const sleep = options.sleep ?? defaultSleep;
  const random = options.random ?? Math.random;

  for (let attempt = 0; ; attempt++) {
    try {
      return await operation(attempt);
    } catch (err) {
      const kind = retryKind(err);
      const retryable = kind === 'rate-limit' || (kind === 'server' && retryClass === 'idempotent');
      if (!retryable || attempt >= retries) throw err;
      await sleep(base * 2 ** attempt + random() * base);
    }
  }
}
