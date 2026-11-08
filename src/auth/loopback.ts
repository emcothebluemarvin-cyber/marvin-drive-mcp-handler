import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { AuthFlowError, ValidationError } from '../errors.js';
import { logger } from '../logger.js';
import { CALLBACK_PAGE_HEADERS, renderCallbackPage, type CallbackPage } from './callback-page.js';

/** Which provider a message talks about, e.g. "Google". */
export type ProviderLabel = string;

/**
 * Writes a callback page. Resolves once it is flushed — or as soon as the browser is gone
 * (closed tab): Node never calls the `end` callback on a destroyed socket, so 'close' also settles.
 * Never throws and never writes twice.
 */
export function sendPage(res: ServerResponse, status: number, page: CallbackPage): Promise<void> {
  return new Promise((resolve) => {
    if (res.destroyed || res.headersSent) {
      resolve();
      return;
    }
    res.once('close', () => resolve());
    try {
      res.writeHead(status, CALLBACK_PAGE_HEADERS).end(renderCallbackPage(page), () => resolve());
    } catch (err) {
      logger.warn('Could not send the login result page', { error: err });
      resolve();
    }
  });
}

/** Rejects with AuthFlowError if `work` does not settle within `ms`. */
export async function withDeadline<T>(
  work: Promise<T>,
  ms: number,
  provider: ProviderLabel,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(
        new AuthFlowError(
          `Login did not finish within ${Math.round(ms / 1000)} s while contacting ${provider}. Check your connection and try again.`,
        ),
      );
    }, ms);
    timer.unref();
  });
  try {
    return await Promise.race([work, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

export interface Callback {
  code: string;
  /** Answers the browser request that delivered the code (held open until the login finishes). */
  respond: (status: number, page: CallbackPage) => Promise<void>;
}

/** No-browser mode: `readLine` resolves null when input is closed and stops when `signal` aborts. */
export interface ManualLogin {
  readLine: (prompt: string, signal: AbortSignal) => Promise<string | null>;
}

/** The message for an `error=` parameter on the redirect. */
export function redirectError(error: string, provider: ProviderLabel): AuthFlowError {
  return new AuthFlowError(
    error === 'access_denied'
      ? 'Access was denied in the browser'
      : `${provider} returned an error: ${error}`,
  );
}

export function waitForCallback(
  server: Server,
  state: string,
  timeoutMs: number,
  provider: ProviderLabel,
): Promise<Callback> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new AuthFlowError(`Login timed out after ${Math.round(timeoutMs / 1000)} s`));
    }, timeoutMs);
    timer.unref();

    let settled = false;
    server.on('request', (req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (url.pathname !== '/') {
        res.writeHead(404).end();
        return;
      }
      if (settled) {
        void sendPage(res, 200, { kind: 'finished' });
        return;
      }
      const params = url.searchParams;
      if (params.get('state') !== state) {
        void sendPage(res, 400, { kind: 'stale' });
        return;
      }
      const fail = (err: AuthFlowError): void => {
        settled = true;
        clearTimeout(timer);
        // Reject only after the page is flushed; the caller closes all connections next.
        void sendPage(res, 400, { kind: 'failure', message: err.message }).then(() => {
          reject(err);
        });
      };

      const error = params.get('error');
      if (error) return fail(redirectError(error, provider));
      const code = params.get('code');
      if (!code) return fail(new AuthFlowError('Callback did not include an authorization code'));

      settled = true;
      clearTimeout(timer);
      resolve({ code, respond: (status, page) => sendPage(res, status, page) });
    });
  });
}

const PASTE_PROMPT = 'Paste the full URL from the address bar: ';

/** Parses a pasted redirect URL (or just its query string). */
export function parsePasted(input: string): URLSearchParams | null {
  const text = input.trim();
  if (!text) return null;
  try {
    const url = text.includes('://')
      ? new URL(text)
      : new URL(`http://127.0.0.1/?${text.replace(/^\?/, '')}`);
    return url.searchParams;
  } catch {
    return null;
  }
}

/** Reads pasted redirect URLs until one carries a code for this attempt. Never settles on EOF. */
export async function waitForPaste(
  manual: ManualLogin,
  state: string,
  print: (message: string) => void,
  signal: AbortSignal,
  provider: ProviderLabel,
): Promise<Callback> {
  for (;;) {
    const line = await manual.readLine(PASTE_PROMPT, signal);
    if (line === null) return new Promise<never>(() => {}); // stdin closed: rely on the callback
    const params = parsePasted(line);
    if (!params || (!params.has('code') && !params.has('error'))) {
      print('That does not look like the redirect URL (it contains "code=" and "state=").');
      continue;
    }
    if (params.get('state') !== state) {
      print('That URL belongs to a different login attempt; use the URL printed above.');
      continue;
    }
    const error = params.get('error');
    if (error) throw redirectError(error, provider);
    const code = params.get('code');
    if (!code) {
      print('That URL has no authorization code; paste the full URL.');
      continue;
    }
    return { code, respond: async (): Promise<void> => {} };
  }
}

export async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  return (server.address() as AddressInfo).port;
}

export interface LocalhostListener {
  port: number;
  close: () => Promise<void>;
}

function closeServer(server: Server): Promise<void> {
  server.closeAllConnections();
  return new Promise<void>((resolve) => server.close(() => resolve()));
}

/**
 * For `http://localhost:<port>` redirects: browsers may resolve `localhost` to either address, so
 * the port is bound on 127.0.0.1 and, best effort, on ::1. Requests on ::1 reach `server`'s handlers.
 */
export async function listenLocalhost(
  server: Server,
  createV6: () => Server = createServer,
): Promise<LocalhostListener> {
  const port = await listen(server);
  const v6 = createV6();
  const bound = await new Promise<boolean>((resolve) => {
    v6.once('error', () => resolve(false));
    v6.listen(port, '::1', () => resolve(true));
  });
  if (bound) v6.on('request', (req, res) => server.emit('request', req, res));
  return {
    port,
    close: async (): Promise<void> => {
      await Promise.all([closeServer(server), bound ? closeServer(v6) : Promise.resolve()]);
    },
  };
}

export interface RedirectParams {
  state: string;
  code: string;
  error: string | null;
}

/** The parameters of a redirect URL (or its query string); throws on anything else. */
export function readRedirectUrl(input: string): RedirectParams {
  const params = parsePasted(input);
  if (!params || !params.has('state') || (!params.has('code') && !params.has('error'))) {
    throw new ValidationError(
      'That does not look like the redirect URL; it contains "state=" and "code=". Quote it in the shell.',
    );
  }
  return {
    state: params.get('state') ?? '',
    code: params.get('code') ?? '',
    error: params.get('error'),
  };
}

/** The state and code of a redirect URL; throws when it is not one or it reports an error. */
export function parseRedirectUrl(
  input: string,
  provider: ProviderLabel,
): { state: string; code: string } {
  const { state, code, error } = readRedirectUrl(input);
  if (error) throw redirectError(error, provider);
  return { state, code };
}
