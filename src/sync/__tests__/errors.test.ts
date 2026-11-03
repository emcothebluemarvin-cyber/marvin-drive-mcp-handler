import { describe, expect, it } from 'vitest';
import {
  ApiDisabledError,
  NotFoundError,
  QuotaExceededError,
  RateLimitError,
  ReauthRequiredError,
} from '../../errors.js';
import { ChecksumMismatchError, CollisionError, isAbortError } from '../errors.js';

describe('sync errors', () => {
  it('formats collision and checksum messages', () => {
    expect(new CollisionError('/x/a.pdf').message).toBe(
      '/x/a.pdf already exists; nothing was overwritten',
    );
    expect(new ChecksumMismatchError('a.pdf', 'aa', 'bb').message).toBe(
      'a.pdf: expected md5 aa, got bb',
    );
  });

  it('classifies run-aborting errors', () => {
    expect(isAbortError(new ReauthRequiredError('emco'))).toBe(true);
    expect(isAbortError(new QuotaExceededError('emco'))).toBe(true);
    expect(isAbortError(new ApiDisabledError('drive'))).toBe(true);
    expect(isAbortError(new RateLimitError())).toBe(true);
    expect(isAbortError(new NotFoundError('x'))).toBe(false);
    expect(isAbortError(new Error('x'))).toBe(false);
  });
});
