import { randomBytes } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { GraphApiError, NameConflictError, TargetChangedError } from '../../errors.js';
import { createLogger } from '../../logger.js';
import { FRAGMENT_SIZE } from '../graph-client.js';
import { empty, fakeGraph, graphError, json, makeClient, type FakeCall } from './fake-graph.js';

const UPLOAD_URL = 'https://upload.example/session?sig=secret';
const SIZE = FRAGMENT_SIZE + 1000;
let localPath: string;
let content: Buffer;

beforeEach(async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'graph-upload-'));
  localPath = path.join(dir, 'file.bin');
  content = randomBytes(SIZE);
  await writeFile(localPath, content);
});

const request = () => ({
  createPath: '/me/drive/items/p:/f.bin:/createUploadSession',
  body: { item: { '@microsoft.graph.conflictBehavior': 'fail' } },
  localPath,
  size: SIZE,
  target: 'f.bin',
});

const isCreate = (c: FakeCall): boolean => c.path.endsWith('createUploadSession');
const puts = (calls: FakeCall[]): FakeCall[] => calls.filter((c) => c.method === 'PUT');
const session = (): Response => json({ uploadUrl: UPLOAD_URL });
const progress = (next: number): Response => json({ nextExpectedRanges: [`${next}-`] }, 202);
const done = (): Response => json({ id: 'new' }, 201);

describe('GraphClient.upload', () => {
  it('sends ordered fragments with no token and returns the item', async () => {
    let n = 0;
    const fake = fakeGraph((c) => {
      if (isCreate(c)) return session();
      return n++ === 0 ? progress(FRAGMENT_SIZE) : done();
    });
    await expect(makeClient(fake).client.upload(request())).resolves.toEqual({ id: 'new' });
    const [first, second] = puts(fake.calls);
    expect(first?.headers['content-range']).toBe(`bytes 0-${FRAGMENT_SIZE - 1}/${SIZE}`);
    expect(first?.headers['content-length']).toBe(String(FRAGMENT_SIZE));
    expect(second?.headers['content-range']).toBe(`bytes ${FRAGMENT_SIZE}-${SIZE - 1}/${SIZE}`);
    // Buffer.equals: toEqual walks 10 MiB element by element and can hit the test timeout.
    const sent = Buffer.concat([first?.bytes ?? Buffer.alloc(0), second?.bytes ?? Buffer.alloc(0)]);
    expect(sent.equals(content)).toBe(true);
    expect(puts(fake.calls).every((c) => c.headers.authorization === undefined)).toBe(true);
    expect(fake.calls.find(isCreate)?.headers.authorization).toBe('Bearer token');
  });

  it.each([
    ['a failed fragment', 500, 'generalException'],
    ['a 416 on a fragment', 416, 'invalidRange'],
  ])('resumes %s from the offset the session reports', async (_name, status, code) => {
    const reported = 320 * 1024;
    let n = 0;
    const fake = fakeGraph((c) => {
      if (isCreate(c)) return session();
      if (c.method === 'GET') return json({ nextExpectedRanges: [`${reported}-`] });
      return n++ === 0 ? graphError(status, code) : done();
    });
    await makeClient(fake).client.upload(request());
    const [first, second] = puts(fake.calls);
    expect(first?.headers['content-range']).toBe(`bytes 0-${FRAGMENT_SIZE - 1}/${SIZE}`);
    expect(second?.headers['content-range']).toBe(`bytes ${reported}-${SIZE - 1}/${SIZE}`);
    expect(second?.bytes?.equals(content.subarray(reported))).toBe(true);
  });

  it('restarts after a lost final response, resending If-Match and the body', async () => {
    let n = 0;
    const fake = fakeGraph((c) => {
      if (isCreate(c)) return session();
      if (c.method === 'GET') return graphError(404, 'itemNotFound');
      const attempt = n++;
      if (attempt === 0) throw new TypeError('fetch failed');
      return attempt === 1 ? graphError(404, 'itemNotFound') : done();
    });
    const upload = { ...request(), size: 1000, headers: { 'If-Match': 'etag1' } };
    await expect(makeClient(fake).client.upload(upload)).resolves.toEqual({ id: 'new' });
    const creates = fake.calls.filter(isCreate);
    expect(creates.map((c) => c.headers['if-match'])).toEqual(['etag1', 'etag1']);
    expect(puts(fake.calls).at(-1)?.bytes?.equals(content.subarray(0, 1000))).toBe(true);
  });

  it('survives a network failure on a fragment', async () => {
    let n = 0;
    const fake = fakeGraph((c) => {
      if (isCreate(c)) return session();
      if (c.method === 'GET') return json({});
      if (n++ === 0) throw new TypeError('fetch failed');
      return n === 2 ? progress(FRAGMENT_SIZE) : done();
    });
    await expect(makeClient(fake).client.upload(request())).resolves.toEqual({ id: 'new' });
  });

  it('gives up after 5 retries and deletes the session', async () => {
    const fake = fakeGraph((c) => {
      if (isCreate(c)) return session();
      if (c.method === 'GET') return json({});
      if (c.method === 'DELETE') return empty();
      return graphError(500, 'x');
    });
    await expect(makeClient(fake).client.upload(request())).rejects.toThrow(
      /OneDrive request failed/,
    );
    expect(puts(fake.calls)).toHaveLength(6);
    expect(fake.calls.at(-1)).toMatchObject({ method: 'DELETE', url: UPLOAD_URL });
  });

  it('restarts the whole upload once when the session is gone', async () => {
    let creates = 0;
    const fake = fakeGraph((c) => {
      if (isCreate(c)) {
        creates++;
        return session();
      }
      return creates === 1 ? graphError(404, 'itemNotFound') : done();
    });
    await makeClient(fake).client.upload({ ...request(), size: 1000 });
    expect(creates).toBe(2);
  });

  it('fails after a second lost session', async () => {
    const fake = fakeGraph((c) => (isCreate(c) ? session() : graphError(404, 'itemNotFound')));
    await expect(makeClient(fake).client.upload({ ...request(), size: 1000 })).rejects.toThrow(
      /404/,
    );
  });

  it('deletes the session and reports a conflict on the last fragment', async () => {
    let n = 0;
    const fake = fakeGraph((c) => {
      if (isCreate(c)) return session();
      if (c.method === 'DELETE') return empty();
      return n++ === 0 ? progress(FRAGMENT_SIZE) : graphError(409, 'nameAlreadyExists');
    });
    await expect(makeClient(fake).client.upload(request())).rejects.toThrow(NameConflictError);
    expect(fake.calls.at(-1)?.method).toBe('DELETE');
  });

  it('reports 412 at session creation', async () => {
    const fake = fakeGraph(() => graphError(412, 'resourceModified'));
    await expect(makeClient(fake).client.upload(request())).rejects.toThrow(TargetChangedError);
  });

  it('keeps the session URL out of errors and logs', async () => {
    const lines: string[] = [];
    const logger = createLogger((line) => {
      lines.push(line);
    });
    const fake = fakeGraph((c) =>
      isCreate(c) ? session() : graphError(400, 'invalidRequest', `bad ${UPLOAD_URL}`),
    );
    const err = (await makeClient(fake, { logger })
      .client.upload(request())
      .catch((e: unknown) => e)) as Error;
    expect(err).toBeInstanceOf(GraphApiError);
    expect(err.message).not.toContain('upload.example');
    expect(lines.join('')).toContain('Graph request failed');
    expect(lines.join('')).not.toContain('sig=secret');
    expect(lines.join('')).not.toContain('upload.example');
  });

  it('sends a real Content-Length, not chunked, through the platform fetch', async () => {
    const seen: Array<Record<string, string | string[] | undefined>> = [];
    const server = createServer((req, res) => {
      seen.push(req.headers);
      req.resume();
      req.on('end', () => res.writeHead(201).end(JSON.stringify({ id: 'real' })));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    try {
      const local = `http://127.0.0.1:${port}/s`;
      const client = makeClient({
        calls: [],
        fetch: ((input: string, init?: RequestInit) =>
          String(input).includes('graph.microsoft.com')
            ? Promise.resolve(json({ uploadUrl: local }))
            : fetch(input, init)) as typeof fetch,
      }).client;
      await expect(client.upload({ ...request(), size: 1000 })).resolves.toEqual({ id: 'real' });
      expect(seen[0]?.['content-length']).toBe('1000');
      expect(seen[0]?.['transfer-encoding']).toBeUndefined();
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
