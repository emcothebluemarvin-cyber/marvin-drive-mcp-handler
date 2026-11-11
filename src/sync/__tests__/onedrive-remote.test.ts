import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NameConflictError, ValidationError } from '../../errors.js';
import { GRAPH, empty, graphError, json } from '../../onedrive/__tests__/fake-graph.js';
import { TargetChangedError } from '../errors.js';
import {
  ONEDRIVE_SYNC_SELECT,
  SIMPLE_UPLOAD_MAX,
  toRemoteItemFromGraph,
} from '../remote/onedrive-remote.js';
import { NEXT, graphFile, graphFolder, remoteOver } from './fake-onedrive.js';

describe('toRemoteItemFromGraph', () => {
  it('maps a file with its quickXor hash and eTag', () => {
    expect(toRemoteItemFromGraph(graphFile('f1', 'a.pdf'))).toEqual({
      id: 'f1',
      name: 'a.pdf',
      parentId: 'P',
      kind: 'file',
      mimeType: 'application/pdf',
      size: 5,
      modifiedTime: '2026-11-02T00:00:00Z',
      createdTime: '2026-11-01T00:00:00Z',
      hash: { kind: 'quickXor', value: 'qx-f1' },
      version: '"{f1},1"',
      trashed: false,
      canEdit: true,
      canTrash: true,
      canAddChildren: true,
      native: null,
    });
  });

  it('a file without a quickXorHash has no hash; a folder has no size', () => {
    const noHash = toRemoteItemFromGraph(graphFile('f1', 'a.pdf', { file: { hashes: {} } }));
    expect(noHash.hash).toBeNull();
    const folder = toRemoteItemFromGraph({ ...graphFolder('d1', 'docs'), size: 99 });
    expect(folder).toMatchObject({ kind: 'folder', size: null, hash: null });
  });

  it('OneNote, shared and facet-less items are unsupported (spec §4.2)', () => {
    const base = { id: 'x', name: 'x', parentReference: { id: 'P' } };
    expect(toRemoteItemFromGraph({ ...base, package: { type: 'oneNote' } })).toMatchObject({
      kind: 'unsupported',
      unsupported: 'onenote',
    });
    expect(toRemoteItemFromGraph({ ...base, remoteItem: {}, folder: {} })).toMatchObject({
      kind: 'unsupported',
      unsupported: 'shared',
    });
    expect(toRemoteItemFromGraph({ ...base, name: 'Personal Vault' })).toMatchObject({
      kind: 'unsupported',
      unsupported: 'special',
    });
  });

  it('the drive root has no parent', () => {
    expect(toRemoteItemFromGraph({ id: 'R', name: 'root', folder: {} }).parentId).toBeNull();
  });
});

describe('OneDriveSyncRemote reads', () => {
  it('get reads the sync fields; 404 and 403 are null, other errors throw', async () => {
    const { remote, calls } = remoteOver((call) => {
      if (call.path.startsWith('/me/drive/items/f1?')) return json(graphFile('f1', 'a.pdf'));
      if (call.path.startsWith('/me/drive/items/gone')) return graphError(404, 'itemNotFound');
      if (call.path.startsWith('/me/drive/items/hidden')) return graphError(403, 'accessDenied');
      return graphError(423, 'resourceLocked');
    });
    expect((await remote.get('f1'))?.id).toBe('f1');
    expect(calls[0]?.path).toBe(`/me/drive/items/f1?$select=${ONEDRIVE_SYNC_SELECT}`);
    expect(await remote.get('gone')).toBeNull();
    expect(await remote.get('hidden')).toBeNull();
    await expect(remote.get('locked')).rejects.toThrow(/locked/);
    await expect(remote.read('gone')).rejects.toThrow('File not found');
  });

  it('listChildren pages through nextLink after the page-link check', async () => {
    const { remote, calls } = remoteOver((call) => {
      if (call.url === NEXT) return json({ value: [graphFile('f2', 'b.pdf')] });
      return json({ value: [graphFile('f1', 'a.pdf')], '@odata.nextLink': NEXT });
    });
    const first = await remote.listChildren('P', undefined);
    expect(first.items.map((i) => i.id)).toEqual(['f1']);
    expect(first.next).toBe(NEXT);
    expect(calls[0]?.path).toBe(
      `/me/drive/items/P/children?$select=${ONEDRIVE_SYNC_SELECT}&$top=200`,
    );
    const second = await remote.listChildren('P', first.next);
    expect(second).toEqual({ items: [expect.objectContaining({ id: 'f2' })] });
    await expect(remote.listChildren('P', 'https://evil.example/me/drive/x')).rejects.toThrow(
      ValidationError,
    );
  });

  it('findChildren returns every fold match over all pages; folders on request', async () => {
    const { remote } = remoteOver((call) => {
      if (call.url === NEXT)
        return json({ value: [graphFolder('d2', 'DOCS'), graphFolder('o', 'x')] });
      return json({
        value: [graphFolder('d1', 'Docs'), graphFile('f1', 'docs')],
        '@odata.nextLink': NEXT,
      });
    });
    expect((await remote.findChildren('P', 'docs')).map((i) => i.id)).toEqual(['d1', 'f1', 'd2']);
    expect((await remote.findChildren('P', 'docs', 'folder')).map((i) => i.id)).toEqual([
      'd1',
      'd2',
    ]);
  });

  it('readNative and exportNative refuse (no natives on OneDrive)', async () => {
    const { remote } = remoteOver(() => empty(500));
    await expect(remote.readNative()).rejects.toBeInstanceOf(ValidationError);
    await expect(remote.exportNative()).rejects.toBeInstanceOf(ValidationError);
    expect(remote.deletionFeed()).not.toBeNull();
    expect([remote.provider, remote.hashKind, remote.rootId]).toEqual([
      'microsoft',
      'quickXor',
      'root',
    ]);
  });
});

describe('OneDriveSyncRemote writes', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'od-remote-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const file = async (name: string, bytes: Buffer): Promise<string> => {
    const abs = path.join(dir, name);
    await writeFile(abs, bytes);
    return abs;
  };

  it('createFolder posts with conflictBehavior fail; 409 is NameConflictError', async () => {
    let n = 0;
    const { remote, calls } = remoteOver(() =>
      n++ === 0
        ? json({ id: 'd1', name: 'docs', folder: {} }, 201)
        : graphError(409, 'nameAlreadyExists'),
    );
    expect(await remote.createFolder('P', 'docs')).toMatchObject({
      id: 'd1',
      kind: 'folder',
      parentId: 'P',
    });
    expect(calls[0]).toMatchObject({
      method: 'POST',
      path: `/me/drive/items/P/children?$select=${ONEDRIVE_SYNC_SELECT}`,
    });
    expect(JSON.parse(calls[0]?.text ?? '')).toEqual({
      name: 'docs',
      folder: {},
      '@microsoft.graph.conflictBehavior': 'fail',
    });
    await expect(remote.createFolder('P', 'docs')).rejects.toBeInstanceOf(NameConflictError);
    expect(calls).toHaveLength(2);
  });

  it('uploadNew: a simple PUT with conflictBehavior fail up to 4 MiB; 409 is not retried', async () => {
    const bytes = Buffer.from('hello');
    const abs = await file('a.pdf', bytes);
    let n = 0;
    const { remote, calls } = remoteOver(() =>
      n++ === 0 ? json(graphFile('f1', 'a b.pdf'), 201) : graphError(409, 'nameAlreadyExists'),
    );
    expect((await remote.uploadNew('P', 'a b.pdf', abs)).hash).toEqual({
      kind: 'quickXor',
      value: 'qx-f1',
    });
    expect(calls[0]).toMatchObject({
      method: 'PUT',
      path: '/me/drive/items/P:/a%20b.pdf:/content?@microsoft.graph.conflictBehavior=fail',
    });
    expect(calls[0]?.bytes?.equals(bytes)).toBe(true);
    await expect(remote.uploadNew('P', 'a b.pdf', abs)).rejects.toBeInstanceOf(NameConflictError);
    expect(calls).toHaveLength(2);
    await expect(remote.uploadNew('P', 'x/y', abs)).rejects.toBeInstanceOf(ValidationError);
  });

  it('uploadNew above 4 MiB uses an upload session with conflictBehavior fail', async () => {
    const abs = await file('big.bin', randomBytes(SIMPLE_UPLOAD_MAX + 1));
    const { remote, calls } = remoteOver((call) => {
      if (call.path.endsWith('createUploadSession')) {
        return json({ uploadUrl: 'https://upload.example/s?sig=1' });
      }
      return json(graphFile('f9', 'big.bin'), 201);
    });
    expect((await remote.uploadNew('P', 'big.bin', abs)).id).toBe('f9');
    expect(calls[0]?.path).toBe('/me/drive/items/P:/big.bin:/createUploadSession');
    expect(JSON.parse(calls[0]?.text ?? '')).toEqual({
      item: { '@microsoft.graph.conflictBehavior': 'fail' },
    });
  });

  it('replaceContent sends If-Match; 412 is the engine TargetChangedError', async () => {
    const abs = await file('a.pdf', Buffer.from('new'));
    const item = toRemoteItemFromGraph(graphFile('f1', 'a.pdf'));
    let n = 0;
    const { remote, calls } = remoteOver(() =>
      n++ === 0 ? json(graphFile('f1', 'a.pdf', { eTag: '"{f1},2"' })) : graphError(412, 'x'),
    );
    expect((await remote.replaceContent(item, abs)).version).toBe('"{f1},2"');
    expect(calls[0]).toMatchObject({ method: 'PUT', path: '/me/drive/items/f1/content' });
    expect(calls[0]?.headers['if-match']).toBe('"{f1},1"');
    expect(calls[0]?.bytes?.toString()).toBe('new');
    await expect(remote.replaceContent(item, abs)).rejects.toThrow(
      new TargetChangedError('a.pdf changed on OneDrive since the scan'),
    );
    await expect(remote.replaceContent({ ...item, version: null }, abs)).rejects.toBeInstanceOf(
      TargetChangedError,
    );
  });

  it('replaceContent above 4 MiB opens a session with If-Match', async () => {
    const abs = await file('big.bin', randomBytes(SIMPLE_UPLOAD_MAX + 1));
    const item = toRemoteItemFromGraph(graphFile('f1', 'big.bin'));
    const { remote, calls } = remoteOver((call) =>
      call.path.endsWith('createUploadSession')
        ? json({ uploadUrl: 'https://upload.example/s?sig=1' })
        : json(graphFile('f1', 'big.bin'), 200),
    );
    await remote.replaceContent(item, abs);
    expect(calls[0]?.path).toBe('/me/drive/items/f1/createUploadSession');
    expect(calls[0]?.headers['if-match']).toBe('"{f1},1"');
  });

  it('trash deletes with If-Match; 412 is TargetChangedError', async () => {
    const item = toRemoteItemFromGraph(graphFile('f1', 'a.pdf'));
    let n = 0;
    const { remote, calls } = remoteOver(() => (n++ === 0 ? empty(204) : graphError(412, 'x')));
    await remote.trash(item);
    expect(calls[0]).toMatchObject({ method: 'DELETE', path: '/me/drive/items/f1' });
    expect(calls[0]?.headers['if-match']).toBe('"{f1},1"');
    await expect(remote.trash(item)).rejects.toBeInstanceOf(TargetChangedError);
  });

  it('download streams the content through the consumer', async () => {
    const { remote, calls } = remoteOver(() => new Response('bytes', { status: 200 }));
    const text = await remote.download('f1', async (open) => {
      let out = '';
      for await (const chunk of await open()) out += String(chunk);
      return out;
    });
    expect(text).toBe('bytes');
    expect(calls[0]?.path).toBe('/me/drive/items/f1/content');
  });
});

describe('OneDriveSyncRemote deletion feed', () => {
  const LATEST = `${GRAPH}/me/drive/root/delta?token=latest-1`;
  const PAGE2 = `${GRAPH}/me/drive/root/delta?token=page-2`;
  const AFTER = `${GRAPH}/me/drive/root/delta?token=after-3`;

  it('start asks for token=latest and returns the delta link', async () => {
    const { remote, calls } = remoteOver(() => json({ value: [], '@odata.deltaLink': LATEST }));
    expect(await remote.deletionFeed().start()).toBe(LATEST);
    expect(calls[0]?.path).toBe('/me/drive/root/delta?token=latest');
  });

  it('read collects deleted ids over every page and returns the next cursor', async () => {
    const { remote, calls } = remoteOver((call) => {
      if (call.url === LATEST) {
        return json({
          value: [{ id: 'gone', name: 'a', deleted: {} }, graphFile('moved', 'b')],
          '@odata.nextLink': PAGE2,
        });
      }
      return json({
        value: [{ id: 'gone2', deleted: { state: 'deleted' } }],
        '@odata.deltaLink': AFTER,
      });
    });
    expect(await remote.deletionFeed().read(LATEST)).toEqual({
      deletedIds: ['gone', 'gone2'],
      cursor: AFTER,
    });
    expect(calls.map((c) => c.url)).toEqual([`${GRAPH}/me/drive?$select=id`, LATEST, PAGE2]);
  });

  it('a 410 means the cursor expired; a foreign cursor is refused', async () => {
    const { remote } = remoteOver(() => graphError(410, 'resyncRequired'));
    expect(await remote.deletionFeed().read(LATEST)).toEqual({ expired: true });
    await expect(
      remote.deletionFeed().read('https://evil.example/v1.0/me/drive/root/delta'),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});
