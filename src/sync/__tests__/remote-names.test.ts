import { describe, expect, it } from 'vitest';
import { providerLabel, remoteNameProblem, remotePathProblem } from '../remote/remote-names.js';

describe('remoteNameProblem', () => {
  it('Google accepts every name', () => {
    for (const name of ['a:b', 'CON', ' x', 'x.', '~$a', '_vti_', 'x'.repeat(400)]) {
      expect(remoteNameProblem('google', name)).toBeNull();
    }
  });

  it.each(['"', '*', ':', '<', '>', '?', '/', '\\', '|'])('OneDrive refuses %s', (c) => {
    expect(remoteNameProblem('microsoft', `a${c}b.txt`)).toContain('character OneDrive');
  });

  it('OneDrive refuses leading and trailing spaces and a trailing dot', () => {
    expect(remoteNameProblem('microsoft', ' a.txt')).toContain('space');
    expect(remoteNameProblem('microsoft', 'a.txt ')).toContain('space');
    expect(remoteNameProblem('microsoft', 'a.')).toContain('dot');
    expect(remoteNameProblem('microsoft', '.hidden')).toBeNull();
  });

  it.each([
    '.lock',
    'desktop.ini',
    'Desktop.INI',
    'CON',
    'prn.txt',
    'AUX',
    'nul.tar.gz',
    'COM0',
    'com9.log',
    'LPT0',
    'lpt9',
  ])('OneDrive refuses the reserved name %s', (name) => {
    expect(remoteNameProblem('microsoft', name)).toContain('reserved');
  });

  it('OneDrive accepts names that only contain a reserved word', () => {
    for (const name of ['CONsole.txt', 'com10', 'lpt', 'my.lock', 'a.CON']) {
      expect(remoteNameProblem('microsoft', name)).toBeNull();
    }
  });

  it('OneDrive refuses ~$ prefixes, _vti_ and names over 255 characters', () => {
    expect(remoteNameProblem('microsoft', '~$report.docx')).toContain('~$');
    expect(remoteNameProblem('microsoft', 'a~$b')).toBeNull();
    expect(remoteNameProblem('microsoft', 'x_VTI_y')).toContain('_vti_');
    expect(remoteNameProblem('microsoft', 'é'.repeat(255))).toBeNull();
    expect(remoteNameProblem('microsoft', 'é'.repeat(256))).toContain('255');
  });

  it('the 255 limit counts UTF-16 units (the stricter count; Microsoft does not say)', () => {
    const emoji = '\u{1F600}'; // one code point, two UTF-16 units
    expect(remoteNameProblem('microsoft', emoji.repeat(127))).toBeNull();
    expect(remoteNameProblem('microsoft', emoji.repeat(128))).toContain('255');
  });

  it('labels the providers', () => {
    expect(providerLabel('google')).toBe('Drive');
    expect(providerLabel('microsoft')).toBe('OneDrive');
  });
});

describe('remotePathProblem', () => {
  it('OneDrive refuses a path of 400 characters or more; Google accepts any', () => {
    const long = `${'d'.repeat(200)}/${'f'.repeat(199)}`; // 400
    expect(remotePathProblem('microsoft', long.slice(1))).toBeNull();
    expect(remotePathProblem('microsoft', long)).toContain('400');
    expect(remotePathProblem('google', long)).toBeNull();
  });
});
