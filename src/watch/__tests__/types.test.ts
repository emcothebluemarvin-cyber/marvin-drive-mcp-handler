import { describe, expect, it } from 'vitest';
import { InvalidCursorError } from '../feed.js';
import { emptyState, isNative } from '../types.js';

describe('watch types', () => {
  it('knows the Google-native kinds', () => {
    expect(isNative('doc')).toBe(true);
    expect(isNative('sheet')).toBe(true);
    expect(isNative('slides')).toBe(true);
    expect(isNative('folder')).toBe(false);
    expect(isNative('other')).toBe(false);
  });

  it('starts an account with an empty state (fresh objects)', () => {
    expect(emptyState()).toEqual({
      entries: [],
      cursor: null,
      known: {},
      pending: {},
      lastCommentCheck: {},
      backoff: null,
      lastPollAt: null,
    });
    expect(emptyState().entries).not.toBe(emptyState().entries);
  });

  it('InvalidCursorError keeps its cause', () => {
    const cause = new Error('410');
    const err = new InvalidCursorError({ cause });
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('InvalidCursorError');
    expect(err.cause).toBe(cause);
  });
});
