/** idempotent: safe to repeat; create: repeating after an unknown outcome could duplicate. */
export type GraphRetryClass = 'idempotent' | 'create';

export const MAX_RETRY_AFTER_MS = 60_000;
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_BASE_DELAY_MS = 500;

export interface RetryInput {
  /** Undefined means a network failure: no response arrived. */
  status: number | undefined;
  retryAfter?: string | null;
  retryClass: GraphRetryClass;
  /** How many retries have already happened. */
  attempt: number;
  maxRetries?: number;
  baseDelayMs?: number;
  random?: () => number;
  now?: () => number;
}

export interface RetryDecision {
  retry: boolean;
  delayMs: number;
}

/** `Retry-After` in milliseconds (seconds or HTTP date), capped; undefined when absent/invalid. */
export function retryAfterMs(value: string | null | undefined, now: number): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS);
  const date = Date.parse(value);
  if (Number.isNaN(date)) return undefined;
  return Math.min(Math.max(date - now, 0), MAX_RETRY_AFTER_MS);
}

/** The retry table of spec §7.2; 401 is the caller's refresh rule and is not handled here. */
export function decideRetry(input: RetryInput): RetryDecision {
  const { status, retryClass, attempt } = input;
  const maxRetries = input.maxRetries ?? DEFAULT_MAX_RETRIES;
  const base = input.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const random = input.random ?? Math.random;
  const backoff = base * 2 ** attempt + random() * base;
  const honour =
    status === 429 || (status === 503 && retryClass === 'idempotent')
      ? retryAfterMs(input.retryAfter, (input.now ?? Date.now)())
      : undefined;
  const retryable =
    status === 429 ||
    (retryClass === 'idempotent' && (status === undefined || (status >= 500 && status !== 507)));
  return { retry: retryable && attempt < maxRetries, delayMs: honour ?? backoff };
}
