import { Readable } from 'node:stream';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import {
  GraphApiError,
  NotFoundError,
  ReauthRequiredError,
  ValidationError,
  type AppError,
} from '../errors.js';
import { logger as defaultLogger, type Logger } from '../logger.js';
import { mapGraphError } from './graph-errors.js';
import { decideRetry, type GraphRetryClass } from './graph-retry.js';

const GRAPH_HOST = 'graph.microsoft.com';
const GRAPH_BASE = `https://${GRAPH_HOST}/v1.0`;

export interface GraphClientDeps {
  alias: string;
  accessToken: (options?: { forceRefresh?: boolean }) => Promise<string>;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  now?: () => number;
  logger?: Logger;
}

export interface GraphRequestOptions {
  retry: GraphRetryClass;
  /** The item's name or ID, for error messages. */
  target?: string;
  body?: unknown;
  headers?: Record<string, string>;
  /** A 404 on a repeat means an earlier attempt already succeeded. */
  notFoundOnRepeatIsOk?: boolean;
}

export function itemPath(id: string): string {
  assertSafeSegment(id, 'ID');
  return id === 'root' ? '/me/drive/root' : `/me/drive/items/${encodeURIComponent(id)}`;
}

/** Path-based address of a child; append `:/<action>` for an action on it. */
export function childPath(parentId: string, name: string): string {
  assertSafeName(name);
  return `${itemPath(parentId)}:/${encodeURIComponent(name)}`;
}

/** `encodeURIComponent` keeps `.` and `..`, and a separator must never reach the path. */
function assertSafeSegment(value: string, label: string): void {
  if (value === '.' || value === '..' || /[/\\]/.test(value)) {
    throw new ValidationError(`${label} "${value}" is not valid on OneDrive`);
  }
}

export function assertSafeName(name: string): void {
  assertSafeSegment(name, 'Name');
}

/** Encoded separators and dot segments that a server could decode into another path. */
function hasPathTrick(token: string): boolean {
  const rawPath = token.split(/[?#]/, 1)[0] ?? '';
  return (
    /%2f|%5c|%2e/i.test(rawPath) ||
    rawPath.includes('\\') ||
    rawPath.split('/').some((segment) => segment === '.' || segment === '..')
  );
}

/** `new URL()` silently strips tabs and newlines, which could hide a path trick from a check. */
function hasControlOrSpace(token: string): boolean {
  return /\s/.test(token) || [...token].some((ch) => ch.charCodeAt(0) < 0x20 || ch === '\x7f');
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * Authenticated Graph requests for one account. `Authorization` is only ever sent to
 * graph.microsoft.com; redirects are never followed with it (spec §7.1).
 */
export class GraphClient {
  private readonly fetch: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;
  private readonly now: () => number;
  private readonly log: Logger;

  constructor(private readonly deps: GraphClientDeps) {
    this.fetch = deps.fetch ?? fetch;
    this.sleep = deps.sleep ?? defaultSleep;
    this.random = deps.random ?? Math.random;
    this.now = deps.now ?? Date.now;
    this.log = deps.logger ?? defaultLogger;
  }

  get<T>(path: string, target?: string): Promise<T> {
    return this.json<T>('GET', path, { retry: 'idempotent', ...(target ? { target } : {}) });
  }

  /** Null on 404; every other failure throws. */
  async getOrNull<T>(path: string, target?: string): Promise<T | null> {
    try {
      return await this.get<T>(path, target);
    } catch (err) {
      if (err instanceof NotFoundError) return null;
      throw err;
    }
  }

  async json<T>(method: string, path: string, options: GraphRequestOptions): Promise<T> {
    const res = await this.send(method, `${GRAPH_BASE}${path}`, options);
    if (res.status === 204 || res.status === 404) return undefined as T;
    return (await res.json()) as T;
  }

  /** A `pageToken` must be a Graph page link of this account (spec §7.1). */
  checkPageToken(token: string, driveId: string): void {
    let url: URL | undefined;
    try {
      url = new URL(token);
    } catch {
      url = undefined;
    }
    const prefixes = ['/v1.0/me/drive/', `/v1.0/drives/${driveId}/`];
    prefixes.push(`/v1.0/drives/${driveId.replaceAll('!', '%21')}/`);
    const valid =
      !hasControlOrSpace(token) &&
      !hasPathTrick(token) &&
      url !== undefined &&
      !hasPathTrick(url.pathname) &&
      url.protocol === 'https:' &&
      url.host === GRAPH_HOST &&
      prefixes.some((p) => url.pathname.startsWith(p));
    if (!valid)
      throw new ValidationError(
        'pageToken is not a page link that can be followed safely for this account.',
      );
  }

  /** Follows a page link already accepted by `checkPageToken`. */
  async page<T>(url: string): Promise<T> {
    return (await (await this.send('GET', url, { retry: 'idempotent' })).json()) as T;
  }

  /** Streams item content. The redirect target is pre-authenticated and gets no token. */
  async download(path: string, target: string): Promise<Readable> {
    const res = await this.send('GET', `${GRAPH_BASE}${path}`, { retry: 'idempotent', target });
    if (res.status < 300) return this.bodyStream(res);
    const location = res.headers.get('location');
    if (!location) throw new GraphApiError(res.status);
    await res.body?.cancel();
    return this.bodyStream(await this.sendPreauthenticated('GET', location, target));
  }

  private bodyStream(res: Response): Readable {
    if (!res.body) throw new GraphApiError(res.status);
    return Readable.fromWeb(res.body as WebReadableStream);
  }

  /** One request with the 401 rule, retries and error mapping of spec §7.2. */
  protected async send(
    method: string,
    url: string,
    options: GraphRequestOptions,
  ): Promise<Response> {
    let refreshed = false;
    let forceRefresh = false;
    for (let attempt = 0; ;) {
      const token = await this.deps.accessToken(forceRefresh ? { forceRefresh } : undefined);
      forceRefresh = false;
      let res: Response | undefined;
      try {
        res = await this.fetch(url, {
          method,
          redirect: 'manual',
          headers: {
            Authorization: `Bearer ${token}`,
            ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
            ...options.headers,
          },
          ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
        });
      } catch (err) {
        this.log.warn('Graph request failed to reach the network', { error: err });
      }
      if (res?.status === 401) {
        await res.body?.cancel();
        if (refreshed) throw new ReauthRequiredError(this.deps.alias);
        refreshed = true;
        forceRefresh = true;
        continue;
      }
      if (res && res.status < 400) return res;
      if (res?.status === 404 && options.notFoundOnRepeatIsOk && attempt > 0) return res;
      const decision = this.decide(res, options.retry, attempt);
      if (!decision.retry) throw await this.failure(res, options.target);
      await res?.body?.cancel();
      await this.sleep(decision.delayMs);
      attempt++;
    }
  }

  /** A pre-authenticated URL: never an Authorization header, never logged. */
  protected async sendPreauthenticated(
    method: string,
    url: string,
    target?: string,
  ): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
      let res: Response | undefined;
      try {
        res = await this.fetch(url, { method });
      } catch {
        res = undefined;
      }
      if (res && res.status < 400) return res;
      const decision = this.decide(res, 'idempotent', attempt);
      if (!decision.retry) throw await this.failure(res, target);
      await res?.body?.cancel();
      await this.sleep(decision.delayMs);
    }
  }

  protected decide(
    res: Response | undefined,
    retryClass: GraphRetryClass,
    attempt: number,
    maxRetries?: number,
  ): { retry: boolean; delayMs: number } {
    return decideRetry({
      status: res?.status,
      retryAfter: res?.headers.get('retry-after'),
      retryClass,
      attempt,
      random: this.random,
      now: this.now,
      ...(maxRetries === undefined ? {} : { maxRetries }),
    });
  }

  protected async failure(res: Response | undefined, target?: string): Promise<AppError> {
    if (!res) return new GraphApiError(undefined);
    const text = await res.text().catch(() => '');
    return mapGraphError(res.status, text, {
      alias: this.deps.alias,
      log: this.log,
      ...(target ? { target } : {}),
    });
  }
}
