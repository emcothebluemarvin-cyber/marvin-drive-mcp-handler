import { describe, expect, it } from 'vitest';
import {
  GraphThrottledError,
  NameConflictError,
  ReauthRequiredError,
  ValidationError,
} from '../../errors.js';
import { assertSafeName, childPath, itemPath } from '../graph-client.js';
import { GRAPH, empty, fakeGraph, graphError, json, makeClient } from './fake-graph.js';

/** Answers from a list in order; the last answer repeats. */
function sequence(...answers: Array<() => Response>): () => Response {
  let i = 0;
  return () => (answers[Math.min(i++, answers.length - 1)] as () => Response)();
}

describe('paths', () => {
  it('encodes IDs and names and maps root', () => {
    expect(itemPath('a b#c')).toBe('/me/drive/items/a%20b%23c');
    expect(itemPath('root')).toBe('/me/drive/root');
    expect(childPath('root', 'x y#.txt')).toBe('/me/drive/root:/x%20y%23.txt');
    expect(childPath('p1', 'é.txt')).toBe('/me/drive/items/p1:/%C3%A9.txt');
  });

  it.each(['.', '..', 'a/b', 'a\\b', '/', '\\'])('rejects the ID or name %s', (value) => {
    expect(() => itemPath(value)).toThrow(ValidationError);
    expect(() => childPath('p1', value)).toThrow(ValidationError);
    expect(() => {
      assertSafeName(value);
    }).toThrow(ValidationError);
  });

  it('accepts names that only contain dots', () => {
    expect(childPath('p1', '.hidden')).toBe('/me/drive/items/p1:/.hidden');
    expect(childPath('p1', 'a..b')).toBe('/me/drive/items/p1:/a..b');
  });
});

describe('GraphClient requests', () => {
  it('sends the bearer token and JSON body to Graph', async () => {
    const fake = fakeGraph(() => json({ ok: true }));
    const { client } = makeClient(fake);
    await client.json('POST', '/me/x', { retry: 'create', body: { a: 1 } });
    expect(fake.calls[0]).toMatchObject({
      url: `${GRAPH}/me/x`,
      method: 'POST',
      redirect: 'manual',
      text: '{"a":1}',
    });
    expect(fake.calls[0]?.headers.authorization).toBe('Bearer token');
  });

  it('getOrNull returns null on 404 and throws otherwise', async () => {
    const { client } = makeClient(fakeGraph(() => graphError(404, 'itemNotFound')));
    await expect(client.getOrNull('/x')).resolves.toBeNull();
    const failing = makeClient(fakeGraph(() => graphError(423, 'resourceLocked')));
    await expect(failing.client.getOrNull('/x', 'a')).rejects.toThrow(/locked/);
  });

  it('refreshes once on 401 and repeats the request', async () => {
    const fake = fakeGraph(
      sequence(
        () => empty(401),
        () => json({ ok: 1 }),
      ),
    );
    const { client, refreshes } = makeClient(fake);
    await expect(client.get('/x')).resolves.toEqual({ ok: 1 });
    expect(refreshes()).toBe(1);
    expect(fake.calls[1]?.headers.authorization).toBe('Bearer fresh-token');
  });

  it('raises ReauthRequiredError on a second 401', async () => {
    const fake = fakeGraph(() => empty(401));
    const { client, refreshes } = makeClient(fake);
    await expect(client.get('/x')).rejects.toThrow(ReauthRequiredError);
    expect(refreshes()).toBe(1);
    expect(fake.calls).toHaveLength(2);
  });

  it('honours Retry-After on 429 and stops after three retries', async () => {
    const sleeps: number[] = [];
    const fake = fakeGraph(() => json({}, 429, { 'retry-after': '7' }));
    const { client } = makeClient(fake, { sleep: async (ms) => void sleeps.push(ms) });
    await expect(client.get('/x')).rejects.toThrow(GraphThrottledError);
    expect(fake.calls).toHaveLength(4);
    expect(sleeps).toEqual([7000, 7000, 7000]);
  });

  it('retries a create only on 429', async () => {
    const throttled = fakeGraph(
      sequence(
        () => json({}, 429),
        () => json({ id: '1' }),
      ),
    );
    await expect(
      makeClient(throttled).client.json('POST', '/x', { retry: 'create' }),
    ).resolves.toEqual({ id: '1' });
    const failed = fakeGraph(() => graphError(503, 'serviceNotAvailable'));
    await expect(makeClient(failed).client.json('POST', '/x', { retry: 'create' })).rejects.toThrow(
      GraphThrottledError,
    );
    expect(failed.calls).toHaveLength(1);
    const server = fakeGraph(() => graphError(500, 'x'));
    await makeClient(server)
      .client.json('POST', '/x', { retry: 'create' })
      .catch(() => undefined);
    expect(server.calls).toHaveLength(1);
  });

  it('never retries 507', async () => {
    const fake = fakeGraph(() => graphError(507, 'quotaLimitReached'));
    await expect(makeClient(fake).client.get('/x')).rejects.toThrow(/storage is full/);
    expect(fake.calls).toHaveLength(1);
  });

  it('retries an idempotent request after a network failure, not a create', async () => {
    let first = true;
    const fake = fakeGraph(() => {
      if (first) {
        first = false;
        throw new TypeError('fetch failed');
      }
      return json({ id: '1' });
    });
    await expect(makeClient(fake).client.get('/x')).resolves.toEqual({ id: '1' });
    const create = fakeGraph(() => {
      throw new TypeError('fetch failed');
    });
    await expect(makeClient(create).client.json('POST', '/x', { retry: 'create' })).rejects.toThrow(
      /OneDrive request failed/,
    );
    expect(create.calls).toHaveLength(1);
  });

  it('counts a 404 on a repeat as success when asked', async () => {
    const fake = fakeGraph(
      sequence(
        () => graphError(500, 'x'),
        () => graphError(404, 'itemNotFound'),
      ),
    );
    await expect(
      makeClient(fake).client.json('DELETE', '/x', {
        retry: 'idempotent',
        notFoundOnRepeatIsOk: true,
      }),
    ).resolves.toBeUndefined();
    const first = fakeGraph(() => graphError(404, 'itemNotFound'));
    await expect(
      makeClient(first).client.json('DELETE', '/x', {
        retry: 'idempotent',
        notFoundOnRepeatIsOk: true,
      }),
    ).rejects.toThrow(/not found/);
  });

  it('maps a conflict with the target name', async () => {
    const fake = fakeGraph(() => graphError(409, 'nameAlreadyExists'));
    await expect(
      makeClient(fake).client.json('POST', '/x', { retry: 'create', target: 'a.txt' }),
    ).rejects.toThrow(NameConflictError);
  });
});

describe('GraphClient.checkPageToken', () => {
  const { client } = makeClient(fakeGraph(() => json({})));
  it.each([
    `${GRAPH}/me/drive/items/x/children?$skiptoken=1`,
    `${GRAPH}/drives/DRIVE1/items/x/children?$skiptoken=1`,
    `${GRAPH}/drives/b%211/root/search?$skip=1`,
  ])('accepts %s', (token) => {
    expect(() => {
      client.checkPageToken(token, token.includes('b%211') ? 'b!1' : 'DRIVE1');
    }).not.toThrow();
  });

  it.each([
    'not a url',
    'http://graph.microsoft.com/v1.0/me/drive/items',
    'https://evil.example/v1.0/me/drive/items',
    'https://graph.microsoft.com.evil.example/v1.0/me/drive/x',
    `${GRAPH}/me/messages`,
    `${GRAPH}/me/drive/../messages`,
    `${GRAPH}/drives/OTHER/items/x`,
    'https://graph.microsoft.com/beta/me/drive/x',
    `${GRAPH}/me/drive/items/a%2fb`,
    `${GRAPH}/me/drive/items/a%2Fb`,
    `${GRAPH}/me/drive/items/a%5cb`,
    `${GRAPH}/me/drive/items/a%5Cb`,
    `${GRAPH}/me/drive/items/%2e%2e/x`,
    `${GRAPH}/me/drive/items/%2E%2E/x`,
    `${GRAPH}/me/drive/%2e/x`,
    `${GRAPH}/me/drive/./x`,
    `${GRAPH}/me/drive/x/..`,
    `${GRAPH}/me/drive/x\\y`,
    `${GRAPH}/me/drive/..%2\tF..%2\tFme/messages`,
    `${GRAPH}/me/drive/..%2\nF..%2\nFme/messages`,
    `${GRAPH}/me/drive/..%2\rF..%2\rFme/messages`,
    `${GRAPH}/me/drive/items/a\tb`,
    `${GRAPH}/me/drive/items/a\nb`,
    `${GRAPH}/me/drive/items/a b`,
    `${GRAPH}/me/drive/items/x?$skiptoken=a\tb`,
    `${GRAPH}/me/drive/items/a\u0000b`,
    `${GRAPH}/me/drive/items/a\u007fb`,
  ])('rejects %s', (token) => {
    const { client } = makeClient(fakeGraph(() => json({})));
    expect(() => {
      client.checkPageToken(token, 'DRIVE1');
    }).toThrow(
      new ValidationError(
        'pageToken is not a page link that can be followed safely for this account.',
      ),
    );
  });

  it('allows encoded characters in the query', () => {
    const { client } = makeClient(fakeGraph(() => json({})));
    expect(() => {
      client.checkPageToken(`${GRAPH}/me/drive/items/x/children?$skiptoken=a%2Fb%2E`, 'DRIVE1');
    }).not.toThrow();
  });
});

describe('GraphClient.download', () => {
  const read = async (stream: AsyncIterable<unknown>): Promise<string> => {
    let out = '';
    for await (const chunk of stream) out += Buffer.from(chunk as Uint8Array).toString();
    return out;
  };

  it('follows the redirect without the token', async () => {
    const fake = fakeGraph((call) =>
      call.url.startsWith(GRAPH)
        ? empty(302, { location: 'https://cdn.example/file?sig=secret' })
        : new Response('content'),
    );
    const stream = await makeClient(fake).client.download('/me/drive/items/1/content', 'a');
    expect(await read(stream)).toBe('content');
    expect(fake.calls[0]?.redirect).toBe('manual');
    expect(fake.calls[1]?.headers.authorization).toBeUndefined();
  });

  it('streams a direct response', async () => {
    const fake = fakeGraph(() => new Response('direct'));
    expect(await read(await makeClient(fake).client.download('/x', 'a'))).toBe('direct');
  });

  it('retries the pre-authenticated request', async () => {
    const answers = sequence(
      () => empty(500),
      () => new Response('ok'),
    );
    const fake = fakeGraph((call) =>
      call.url.startsWith(GRAPH) ? empty(302, { location: 'https://cdn.example/f' }) : answers(),
    );
    expect(await read(await makeClient(fake).client.download('/x', 'a'))).toBe('ok');
  });
});
