import { describe, expect, it } from 'vitest';
import { isInvalidGrant } from '../oauth-errors.js';

describe('isInvalidGrant', () => {
  it('detects gaxios-style token endpoint errors', () => {
    const err = Object.assign(new Error('Request failed'), {
      response: { data: { error: 'invalid_grant', error_description: 'Token has been expired' } },
    });
    expect(isInvalidGrant(err)).toBe(true);
  });

  it('detects the message form', () => {
    expect(isInvalidGrant(new Error('invalid_grant'))).toBe(true);
  });

  it('ignores other errors', () => {
    expect(isInvalidGrant(new Error('ECONNRESET'))).toBe(false);
    expect(isInvalidGrant(Object.assign(new Error('x'), { response: { data: 'oops' } }))).toBe(
      false,
    );
    expect(isInvalidGrant(null)).toBe(false);
    expect(isInvalidGrant('invalid_grant')).toBe(false);
  });
});
