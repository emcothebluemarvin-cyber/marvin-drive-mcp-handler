import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { NotFoundError, UnsupportedTypeError, ValidationError } from '../../errors.js';
import { createAudit, silentLogger } from '../../files/__tests__/fakes.js';
import { OneDriveFileService } from '../onedrive-file-service.js';
import { GRAPH, fakeGraph, graphError, json, makeClient, type Responder } from './fake-graph.js';

const FILE = { id: 'i1', name: 'a.txt', size: 3, file: { mimeType: 'text/plain' } };
let downloads: string;

beforeEach(async () => {
  downloads = await mkdtemp(path.join(os.tmpdir(), 'od-read-'));
});

function service(responder: Responder) {
  const fake = fakeGraph(responder);
  const { client } = makeClient(fake);
  const svc = new OneDriveFileService({
    clients: async () => client,
    audit: createAudit(),
    downloadsDir: downloads,
    logger: silentLogger(),
  });
  return { svc, fake };
}

const REJECTIONS = /not available on OneDrive/;

describe('OneDriveFileService.list', () => {
  it('lists the root and drops remoteItem entries', async () => {
    const { svc, fake } = service(() =>
      json({
        value: [FILE, { id: 'shared', name: 's', remoteItem: {} }],
        '@odata.nextLink': `${GRAPH}/me/drive/items/x/children?$skiptoken=2`,
      }),
    );
    await expect(svc.list({ account: 'work', pageSize: 999 })).resolves.toEqual({
      files: [{ id: 'i1', name: 'a.txt', mimeType: 'text/plain', size: 3 }],
      nextPageToken: `${GRAPH}/me/drive/items/x/children?$skiptoken=2`,
    });
    expect(fake.calls[0]?.path).toMatch(/^\/me\/drive\/root\/children\?\$top=200&/);
  });

  it('encodes the folder ID', async () => {
    const { svc, fake } = service(() => json({ value: [] }));
    await svc.list({ account: 'work', folderId: 'a b' });
    expect(fake.calls.at(-1)?.path).toContain('/me/drive/items/a%20b/children');
  });

  it('treats a remote folder as not found and does not list it', async () => {
    const { svc, fake } = service(() => json({ id: 's', name: 's', remoteItem: {} }));
    await expect(svc.list({ account: 'work', folderId: 's' })).rejects.toThrow(NotFoundError);
    expect(fake.calls).toHaveLength(1);
  });

  it('refuses a separator in a folder ID without a request', async () => {
    const { svc, fake } = service(() => json({ value: [] }));
    await expect(svc.list({ account: 'work', folderId: '../x' })).rejects.toThrow(ValidationError);
    expect(fake.calls).toEqual([]);
  });

  it('rejects includeTrashed but accepts false', async () => {
    const { svc } = service(() => json({ value: [] }));
    await expect(svc.list({ account: 'work', includeTrashed: true })).rejects.toThrow(REJECTIONS);
    await expect(svc.list({ account: 'work', includeTrashed: false })).resolves.toBeDefined();
  });

  it('follows an accepted page token after fetching the drive info', async () => {
    const next = `${GRAPH}/drives/D1/items/x/children?$skiptoken=3`;
    const { svc, fake } = service((c) =>
      c.url === next
        ? json({ value: [FILE] })
        : c.path.startsWith('/me/drive/root')
          ? json({ id: 'R' })
          : json({ id: 'D1', driveType: 'personal' }),
    );
    await expect(svc.list({ account: 'work', pageToken: next })).resolves.toMatchObject({
      files: [{ id: 'i1' }],
    });
    expect(fake.calls.at(-1)?.url).toBe(next);
  });

  it('rejects a foreign page token without following it', async () => {
    const { svc, fake } = service((c) =>
      c.path.startsWith('/me/drive/root') ? json({ id: 'R' }) : json({ id: 'D1', driveType: 'x' }),
    );
    await expect(
      svc.list({ account: 'work', pageToken: 'https://evil.example/x' }),
    ).rejects.toThrow(ValidationError);
    expect(fake.calls.map((c) => c.url)).not.toContain('https://evil.example/x');
  });

  it('caches the drive info per account', async () => {
    const next = `${GRAPH}/me/drive/items/x/children?$skiptoken=3`;
    const { svc, fake } = service((c) =>
      c.url === next
        ? json({ value: [] })
        : c.path.startsWith('/me/drive/root')
          ? json({ id: 'R' })
          : json({ id: 'D1', driveType: 'x' }),
    );
    await svc.list({ account: 'work', pageToken: next });
    await svc.list({ account: 'work', pageToken: next });
    expect(fake.calls.filter((c) => c.path.startsWith('/me/drive?'))).toHaveLength(1);
  });

  it('needs the alias from the router', async () => {
    const { svc } = service(() => json({ value: [] }));
    await expect(svc.list({})).rejects.toThrow(/account alias/);
  });
});

describe('OneDriveFileService.search', () => {
  it('doubles single quotes and encodes the query', async () => {
    const { svc, fake } = service(() => json({ value: [FILE] }));
    await svc.search({ account: 'work', query: "it's a b" });
    expect(fake.calls[0]?.path).toContain("/me/drive/root/search(q='it''s%20a%20b')?");
  });

  it('drops remoteItem entries', async () => {
    const { svc } = service(() => json({ value: [{ id: 's', name: 's', remoteItem: {} }] }));
    await expect(svc.search({ account: 'work', query: 'x' })).resolves.toEqual({ files: [] });
  });

  it.each([
    ['rawQuery', { rawQuery: 'x' }],
    ['mimeType', { mimeType: 'x' }],
    ['modifiedAfter', { modifiedAfter: 'x' }],
  ])('rejects %s', async (_name, extra) => {
    const { svc } = service(() => json({ value: [] }));
    await expect(svc.search({ account: 'work', query: 'q', ...extra })).rejects.toThrow(REJECTIONS);
  });

  it('requires a query', async () => {
    const { svc } = service(() => json({ value: [] }));
    await expect(svc.search({ account: 'work' })).rejects.toThrow(/query is required/);
  });
});

describe('OneDriveFileService.getMetadata', () => {
  it('returns OneDriveMetadata', async () => {
    const { svc } = service(() => json({ ...FILE, webUrl: 'https://x' }));
    await expect(svc.getMetadata({ account: 'work', fileId: 'i1' })).resolves.toMatchObject({
      id: 'i1',
      webViewLink: 'https://x',
      trashed: false,
    });
  });

  it('treats a remote item as not found', async () => {
    const { svc } = service(() => json({ id: 's', name: 's', remoteItem: {} }));
    await expect(svc.getMetadata({ account: 'work', fileId: 's' })).rejects.toThrow(NotFoundError);
  });
});

describe('OneDriveFileService.download', () => {
  it('writes the content without overwriting', async () => {
    const { svc } = service((c) =>
      c.path.endsWith('/content') ? new Response('new') : json(FILE),
    );
    await writeFile(path.join(downloads, 'a.txt'), 'keep me');
    const result = await svc.download({ account: 'work', fileId: 'i1' });
    expect(result).toMatchObject({ exportFormat: null, mimeType: 'text/plain', size: 3 });
    expect(path.basename(result.path)).not.toBe('a.txt');
    expect(await readFile(path.join(downloads, 'a.txt'), 'utf8')).toBe('keep me');
    expect(await readFile(result.path, 'utf8')).toBe('new');
    expect((await readdir(downloads)).filter((f) => f.endsWith('.part'))).toEqual([]);
  });

  it('rejects exportFormat, folders and packages', async () => {
    const folder = service(() => json({ id: 'f', name: 'd', folder: {} }));
    await expect(
      folder.svc.download({ account: 'work', fileId: 'f', exportFormat: 'pdf' }),
    ).rejects.toThrow(REJECTIONS);
    await expect(folder.svc.download({ account: 'work', fileId: 'f' })).rejects.toThrow(
      UnsupportedTypeError,
    );
    const pack = service(() => json({ id: 'p', name: 'n', package: {} }));
    await expect(pack.svc.download({ account: 'work', fileId: 'p' })).rejects.toThrow(
      UnsupportedTypeError,
    );
  });

  it('treats a remote item as not found', async () => {
    const { svc } = service(() => json({ id: 's', name: 's', remoteItem: {} }));
    await expect(svc.download({ account: 'work', fileId: 's' })).rejects.toThrow(NotFoundError);
  });

  it('maps a missing item', async () => {
    const { svc } = service(() => graphError(404, 'itemNotFound'));
    await expect(svc.download({ account: 'work', fileId: 'x' })).rejects.toThrow(NotFoundError);
  });
});
