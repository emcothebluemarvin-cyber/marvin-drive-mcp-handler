import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { AuthFlowError, ValidationError } from '../../errors.js';
import {
  listenLocalhost,
  parseRedirectUrl,
  readRedirectUrl,
  redirectError,
  waitForCallback,
  withDeadline,
  type LocalhostListener,
} from '../loopback.js';

let listener: LocalhostListener | undefined;
afterEach(async () => {
  await listener?.close();
  listener = undefined;
});

describe('provider wording', () => {
  it('names the given provider in errors', async () => {
    expect(redirectError('server_error', 'Microsoft').message).toBe(
      'Microsoft returned an error: server_error',
    );
    expect(redirectError('access_denied', 'Microsoft').message).toBe(
      'Access was denied in the browser',
    );
    const never = new Promise<never>(() => {});
    await expect(withDeadline(never, 1, 'Microsoft')).rejects.toThrow(/contacting Microsoft/);
  });
});

describe('redirect URL parsing', () => {
  it('returns the parameters without judging them', () => {
    expect(readRedirectUrl('?state=s&error=nope')).toEqual({ state: 's', code: '', error: 'nope' });
  });
  it('rejects text that is not a redirect URL', () => {
    expect(() => readRedirectUrl('hello')).toThrow(ValidationError);
  });
  it('turns an error parameter into the provider message', () => {
    expect(() => parseRedirectUrl('?state=s&error=boom', 'Microsoft')).toThrow(AuthFlowError);
    expect(() => parseRedirectUrl('?state=s&error=boom', 'Microsoft')).toThrow(/Microsoft/);
  });
});

describe('listenLocalhost', () => {
  it('serves callbacks on 127.0.0.1', async () => {
    const server = createServer();
    listener = await listenLocalhost(server);
    const waiting = waitForCallback(server, 'st', 5000, 'Microsoft');
    const res = fetch(`http://127.0.0.1:${listener.port}/?state=st&code=c1`);
    const callback = await waiting;
    await callback.respond(200, { kind: 'success', email: 'a@b.c' });
    expect(callback.code).toBe('c1');
    expect((await res).status).toBe(200);
  });

  it('forwards requests that arrive on ::1 when that address exists', async () => {
    const server = createServer();
    listener = await listenLocalhost(server);
    const waiting = waitForCallback(server, 'st', 5000, 'Microsoft');
    let res: Promise<Response>;
    try {
      res = fetch(`http://[::1]:${listener.port}/?state=st&code=c6`);
      const callback = await Promise.race([
        waiting,
        res.then(() => {
          throw new Error('answered too early');
        }),
      ]);
      await callback.respond(200, { kind: 'finished' });
      expect(callback.code).toBe('c6');
    } catch (err) {
      if ((err as Error).message === 'answered too early') throw err;
      return; // no IPv6 loopback on this machine
    }
  });

  it('still works when ::1 cannot be bound', async () => {
    const server = createServer();
    const broken = (): Server => {
      const v6 = createServer();
      v6.listen = (() => {
        queueMicrotask(() => v6.emit('error', new Error('EADDRNOTAVAIL')));
        return v6;
      }) as Server['listen'];
      return v6;
    };
    listener = await listenLocalhost(server, broken);
    expect(listener.port).toBeGreaterThan(0);
  });
});
