import { describe, expect, it } from 'vitest';
import { requestKinds } from '../content-service.js';

describe('requestKinds', () => {
  it('dedupes first keys and names empty requests unknown', () => {
    expect(requestKinds([{ a: 1 }, { b: 2 }, { a: 3 }, {}])).toEqual(['a', 'b', 'unknown']);
  });
});
