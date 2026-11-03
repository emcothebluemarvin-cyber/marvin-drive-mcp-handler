import { describe, expect, it } from 'vitest';
import { formatAccounts } from '../format.js';

describe('formatAccounts', () => {
  it('marks the default and shows status', () => {
    expect(
      formatAccounts([
        { alias: 'emco', email: 'emco@example.com', isDefault: true, status: 'ok' },
        { alias: 'work', email: 'work@example.com', isDefault: false, status: 'reauth_required' },
        { alias: 'misc', email: 'misc@example.com', isDefault: false, status: 'unknown' },
      ]),
    ).toBe(
      [
        '* emco                 emco@example.com                     ok',
        '  work                 work@example.com                     reauth_required',
        '  misc                 misc@example.com                     unknown',
      ].join('\n'),
    );
  });

  it('explains how to add the first account', () => {
    expect(formatAccounts([])).toBe('No accounts. Run: marvin-drive auth add');
  });
});
