import { describe, expect, it } from 'vitest';
import { ValidationError } from '../../errors.js';
import {
  parseProviderOption,
  providerFlag,
  removedMessage,
  twoStepInstructions,
} from '../auth-text.js';

describe('parseProviderOption', () => {
  it('accepts the two providers and leaves an absent flag undefined', () => {
    expect(parseProviderOption('google')).toBe('google');
    expect(parseProviderOption('microsoft')).toBe('microsoft');
    expect(parseProviderOption(undefined)).toBeUndefined();
  });
  it('rejects anything else', () => {
    expect(() => parseProviderOption('dropbox')).toThrow(ValidationError);
  });
});

describe('twoStepInstructions', () => {
  it('keeps the Google wording on the Google path', () => {
    expect(twoStepInstructions('auth add', 'google')).toContain(
      'Google then redirects to http://127.0.0.1:<port>/',
    );
  });
  it('names Microsoft and localhost on the Microsoft path', () => {
    const text = twoStepInstructions('auth add --provider microsoft', 'microsoft');
    expect(text).toContain('Microsoft then redirects to http://localhost:<port>/');
    expect(text).toContain('marvin-drive auth add --provider microsoft --redirect-url');
    expect(text).not.toContain('Google');
  });
});

describe('providerFlag', () => {
  it('is only printed for Microsoft', () => {
    expect(providerFlag('google')).toBe('');
    expect(providerFlag('microsoft')).toBe(' --provider microsoft');
  });
});

describe('removedMessage', () => {
  const base = { alias: 'a', email: 'a@b.c', addedAt: 'x' };
  it('keeps the Google message', () => {
    expect(removedMessage(base)).toBe('Removed a (a@b.c)');
  });
  it('says a Microsoft token is only deleted locally', () => {
    expect(removedMessage({ ...base, provider: 'microsoft', accountId: 't.o' })).toMatch(
      /deleted on this machine.*no per-token revoke/,
    );
  });
});
