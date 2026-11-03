import { describe, expect, it } from 'vitest';
import { createLogger, redact } from '../logger.js';

describe('redact', () => {
  it('masks secret keys at any depth', () => {
    const out = redact({
      refresh_token: 'rt',
      nested: { access_token: 'at', Authorization: 'Bearer x', keep: 1 },
      list: [{ client_secret: 's' }],
    });
    expect(out).toEqual({
      refresh_token: '[REDACTED]',
      nested: { access_token: '[REDACTED]', Authorization: '[REDACTED]', keep: 1 },
      list: [{ client_secret: '[REDACTED]' }],
    });
  });

  it('reduces errors to name and message', () => {
    expect(redact(new TypeError('bad'))).toEqual({ name: 'TypeError', message: 'bad' });
  });

  it('scrubs tokens embedded in strings and error messages', () => {
    const err = new Error('POST https://oauth2.googleapis.com/revoke?token=1//abc.def failed');
    expect(redact(err)).toEqual({
      name: 'Error',
      message: 'POST https://oauth2.googleapis.com/revoke?token=[REDACTED] failed',
    });
    expect(redact({ note: 'Authorization: Bearer ya29.xyz' })).toEqual({
      note: 'Authorization: Bearer [REDACTED]',
    });
  });
});

describe('scrubText coverage', () => {
  it('redacts bare Google tokens and JSON-style pairs', () => {
    expect(redact('tok ya29.abc-def end')).toBe('tok [REDACTED] end');
    expect(redact('rt 1//0gXyz end')).toBe('rt [REDACTED] end');
    expect(redact('body {"refresh_token": "1//x", "keep": "v"}')).toBe(
      'body {"refresh_token":"[REDACTED]", "keep": "v"}',
    );
  });
});

describe('createLogger', () => {
  it('scrubs secrets from the message', () => {
    const lines: string[] = [];
    createLogger((line) => lines.push(line)).warn('failed ?token=abc');
    const entry = JSON.parse(lines[0] ?? '') as Record<string, unknown>;
    expect(entry.msg).toBe('failed ?token=[REDACTED]');
  });

  it('writes one redacted JSON line per call', () => {
    const lines: string[] = [];
    const log = createLogger((line) => lines.push(line));
    log.warn('hello', { code: 'secret-code', alias: 'emco' });
    expect(lines).toHaveLength(1);
    expect(lines[0]?.endsWith('\n')).toBe(true);
    const entry = JSON.parse(lines[0] ?? '') as Record<string, unknown>;
    expect(entry).toMatchObject({
      level: 'warn',
      msg: 'hello',
      meta: { code: '[REDACTED]', alias: 'emco' },
    });
    expect(typeof entry.ts).toBe('string');
  });
});
