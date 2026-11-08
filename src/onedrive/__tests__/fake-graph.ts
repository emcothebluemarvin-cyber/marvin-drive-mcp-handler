import { Readable } from 'node:stream';
import { createLogger } from '../../logger.js';
import { GraphClient, type GraphClientDeps } from '../graph-client.js';

export const GRAPH = 'https://graph.microsoft.com/v1.0';

export interface FakeCall {
  url: string;
  /** URL without the Graph base, for concise assertions. */
  path: string;
  method: string;
  headers: Record<string, string>;
  redirect?: string;
  text?: string;
  bytes?: Buffer;
}

export type Responder = (call: FakeCall) => Response | Promise<Response>;

export interface FakeGraph {
  fetch: typeof fetch;
  calls: FakeCall[];
}

export const json = (body: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers });

export const graphError = (status: number, code: string, message = 'msg'): Response =>
  json({ error: { code, message } }, status);

export const empty = (status = 204, headers: Record<string, string> = {}): Response =>
  new Response(null, { status, headers });

/** Records every request, reading a streamed body fully, and answers with `responder`. */
export function fakeGraph(responder: Responder): FakeGraph {
  const calls: FakeCall[] = [];
  const fake = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const body = init?.body;
    const call: FakeCall = {
      url,
      path: url.startsWith(GRAPH) ? url.slice(GRAPH.length) : url,
      method: init?.method ?? 'GET',
      headers: Object.fromEntries(
        Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [
          k.toLowerCase(),
          v,
        ]),
      ),
      ...(init?.redirect ? { redirect: init.redirect } : {}),
    };
    if (typeof body === 'string') call.text = body;
    else if (body instanceof Readable) {
      const parts: Buffer[] = [];
      for await (const chunk of body) parts.push(chunk as Buffer);
      call.bytes = Buffer.concat(parts);
    }
    calls.push(call);
    return responder(call);
  };
  return { fetch: fake as typeof fetch, calls };
}

/** A client with instant sleeps and a token that records refreshes. */
export function makeClient(
  fake: FakeGraph,
  extra: Partial<GraphClientDeps> = {},
): { client: GraphClient; refreshes: () => number } {
  let refreshes = 0;
  const client = new GraphClient({
    alias: 'work',
    accessToken: async (options) => {
      if (options?.forceRefresh) refreshes++;
      return options?.forceRefresh ? 'fresh-token' : 'token';
    },
    fetch: fake.fetch,
    sleep: async () => undefined,
    random: () => 0,
    logger: createLogger(() => {}),
    ...extra,
  });
  return { client, refreshes: () => refreshes };
}
