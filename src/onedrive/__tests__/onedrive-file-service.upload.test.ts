import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuditEntry } from '../../audit/audit-log.js';
import {
  NameConflictError,
  NotFoundError,
  TargetChangedError,
  ValidationError,
} from '../../errors.js';
import { silentLogger } from '../../files/__tests__/fakes.js';
import type { ConfirmReplace } from '../../files/file-provider.js';
import { OneDriveFileService } from '../onedrive-file-service.js';
import {
  empty,
  fakeGraph,
  graphError,
  json,
  makeClient,
  type FakeCall,
  type Responder,
} from './fake-graph.js';

const account = 'work';
const UPLOAD_URL = 'https://upload.example/s';
const CHILD = '/me/drive/items/p1:/a.txt';
const EXISTING = {
  id: 'old',
  name: 'a.txt',
  size: 9,
  eTag: 'etag1',
  file: {},
  lastModifiedDateTime: '2026-01-01T00:00:00Z',
  lastModifiedBy: { user: { displayName: 'Ayse' } },
};
const NEW = { id: 'new', name: 'a.txt', size: 5, file: {}, parentReference: { id: 'p1' } };
const notFound = (): Response => graphError(404, 'itemNotFound');
const session = (): Response => json({ uploadUrl: UPLOAD_URL });

let entries: Array<Omit<AuditEntry, 'ts'>>;
let localPath: string;
let emptyPath: string;

beforeEach(async () => {
  entries = [];
  const dir = await mkdtemp(path.join(os.tmpdir(), 'od-upload-'));
  localPath = path.join(dir, 'a.txt');
  emptyPath = path.join(dir, 'empty.txt');
  await writeFile(localPath, 'hello');
  await writeFile(emptyPath, '');
});

function service(responder: Responder) {
  const fake = fakeGraph((c) =>
    c.path.startsWith('/me/drive/items/p1?')
      ? json({ id: 'p1', name: 'p', folder: {} })
      : responder(c),
  );
  const { client } = makeClient(fake);
  const svc = new OneDriveFileService({
    clients: async () => client,
    audit: { record: async (e) => void entries.push(e) },
    downloadsDir: '/x',
    logger: silentLogger(),
  });
  return { svc, fake };
}

const isRead = (c: FakeCall): boolean => c.method === 'GET' && c.path.startsWith(CHILD);
const writes = (calls: FakeCall[]): FakeCall[] =>
  calls.filter((c) => c.method !== 'GET' && c.method !== 'DELETE');
const input = () => ({ account, localPath, parentId: 'p1' });

/** New file, no conflict: read 404, session, one fragment. */
const clean: Responder = (c) => {
  if (isRead(c)) return notFound();
  if (c.path.endsWith('createUploadSession')) return session();
  return json(NEW, 201);
};

describe('upload of a new file', () => {
  it('reads first, creates a session with fail and uploads', async () => {
    const { svc, fake } = service(clean);
    await expect(svc.upload(input())).resolves.toMatchObject({ id: 'new' });
    expect(fake.calls.map((c) => c.method)).toEqual(['GET', 'GET', 'POST', 'PUT']);
    expect(fake.calls[2]?.path).toBe(`${CHILD}:/createUploadSession`);
    expect(JSON.parse(fake.calls[2]?.text ?? '')).toEqual({
      item: { '@microsoft.graph.conflictBehavior': 'fail' },
    });
    expect(fake.calls[3]?.bytes?.toString()).toBe('hello');
    expect(entries[0]).toMatchObject({
      account,
      op: 'upload',
      details: { size: 5, replaced: false },
    });
  });

  it('uses the local file name and root by default', async () => {
    const { svc, fake } = service((c) =>
      c.method === 'GET'
        ? notFound()
        : c.path.endsWith('createUploadSession')
          ? session()
          : json(NEW, 201),
    );
    await svc.upload({ account, localPath });
    expect(fake.calls[0]?.path).toContain('/me/drive/root:/a.txt?');
  });

  it('sends an empty file with a PUT and conflictBehavior=fail', async () => {
    const { svc, fake } = service((c) => (isRead(c) ? notFound() : json(NEW, 201)));
    await svc.upload({ ...input(), localPath: emptyPath, name: 'a.txt' });
    expect(fake.calls.map((c) => c.method)).toEqual(['GET', 'GET', 'PUT']);
    expect(fake.calls[2]?.path).toBe(`${CHILD}:/content?@microsoft.graph.conflictBehavior=fail`);
  });

  it('aborts on a read failure other than 404', async () => {
    const { svc, fake } = service(() => graphError(403, 'accessDenied'));
    await expect(svc.upload(input())).rejects.toThrow(/permission/);
    expect(writes(fake.calls)).toEqual([]);
  });

  it('rejects convertToGoogle, accepts false', async () => {
    const { svc } = service(clean);
    await expect(svc.upload({ ...input(), convertToGoogle: true })).rejects.toThrow(
      /not available on OneDrive/,
    );
    await expect(svc.upload({ ...input(), convertToGoogle: false })).resolves.toBeDefined();
  });

  it('treats a remote target folder as not found and writes nothing', async () => {
    const { svc, fake } = service(() => json({ id: 'shared', name: 's', remoteItem: {} }));
    await expect(svc.upload({ account, localPath, parentId: 'shared' })).rejects.toThrow(
      NotFoundError,
    );
    expect(fake.calls).toHaveLength(1);
  });

  it.each(['.', '..', 'a/b', 'a\\b'])('refuses the name %s without a request', async (name) => {
    const { svc, fake } = service(clean);
    await expect(svc.upload({ ...input(), name })).rejects.toThrow(ValidationError);
    expect(fake.calls).toEqual([]);
  });

  it('checks the local path before any request', async () => {
    const { svc, fake } = service(clean);
    await expect(svc.upload({ ...input(), localPath: 'relative.txt' })).rejects.toThrow(
      ValidationError,
    );
    expect(fake.calls).toEqual([]);
  });
});

describe('upload onto an existing name', () => {
  const conflict: Responder = (c) => {
    if (isRead(c)) return json(EXISTING);
    if (c.path.endsWith('createUploadSession')) return session();
    return json({ ...NEW, id: 'old' });
  };

  it('fails without confirmReplace and writes nothing', async () => {
    const { svc, fake } = service(conflict);
    await expect(svc.upload(input())).rejects.toThrow(NameConflictError);
    expect(writes(fake.calls)).toEqual([]);
  });

  it('refuses a folder or package, offering no choice', async () => {
    const confirmReplace = vi.fn<ConfirmReplace>(async () => 'overwrite');
    for (const facet of [{ folder: {} }, { package: {} }, { remoteItem: {} }]) {
      const { svc, fake } = service(() => json({ ...EXISTING, file: undefined, ...facet }));
      await expect(svc.upload(input(), { confirmReplace })).rejects.toThrow(NameConflictError);
      expect(writes(fake.calls)).toEqual([]);
    }
    expect(confirmReplace).not.toHaveBeenCalled();
  });

  it.each([
    ['cancel', 'user'],
    ['no_answer', 'no_answer'],
  ] as const)('%s returns UploadCancelled and writes nothing', async (answer, reason) => {
    const { svc, fake } = service(conflict);
    const confirmReplace = vi.fn<ConfirmReplace>(async () => answer);
    await expect(svc.upload(input(), { confirmReplace })).resolves.toEqual({
      cancelled: true,
      reason,
      existing: {
        id: 'old',
        name: 'a.txt',
        size: 9,
        modifiedTime: '2026-01-01T00:00:00Z',
        modifiedBy: 'Ayse',
      },
    });
    expect(writes(fake.calls)).toEqual([]);
    expect(entries).toEqual([]);
  });

  it('overwrite uses If-Match, replace and starts over', async () => {
    const { svc, fake } = service(conflict);
    await svc.upload(input(), { confirmReplace: async () => 'overwrite' });
    const create = fake.calls.find((c) => c.path.endsWith('createUploadSession'));
    expect(create?.path).toBe('/me/drive/items/old/createUploadSession');
    expect(create?.headers['if-match']).toBe('etag1');
    expect(JSON.parse(create?.text ?? '')).toEqual({
      item: { '@microsoft.graph.conflictBehavior': 'replace' },
    });
    expect(entries[0]).toMatchObject({ op: 'upload', details: { replaced: true } });
  });

  it('overwrite of an empty file is a conditional PUT', async () => {
    const { svc, fake } = service((c) => (isRead(c) ? json(EXISTING) : json(NEW)));
    await svc.upload(
      { ...input(), localPath: emptyPath, name: 'a.txt' },
      { confirmReplace: async () => 'overwrite' },
    );
    const put = fake.calls.find((c) => c.method === 'PUT');
    expect(put?.path).toBe('/me/drive/items/old/content');
    expect(put?.headers['if-match']).toBe('etag1');
  });

  it('a 412 on overwrite raises TargetChangedError asking to check the file', async () => {
    const { svc } = service((c) =>
      isRead(c) ? json(EXISTING) : graphError(412, 'resourceModified'),
    );
    const err = (await svc
      .upload(input(), { confirmReplace: async () => 'overwrite' })
      .catch((e: unknown) => e)) as Error;
    expect(err).toBeInstanceOf(TargetChangedError);
    expect(err.message).toMatch(/Check the file/);
  });
});

describe('a conflict that appears after the first read', () => {
  let reads: number;
  beforeEach(() => {
    reads = 0;
  });
  const race =
    (at: Responder): Responder =>
    (c) => {
      if (isRead(c)) return reads++ === 0 ? notFound() : json(EXISTING);
      return at(c);
    };

  it('a 409 at session creation enters the question', async () => {
    const { svc } = service(race(() => graphError(409, 'nameAlreadyExists')));
    const confirmReplace = vi.fn<ConfirmReplace>(async () => 'cancel');
    await expect(svc.upload(input(), { confirmReplace })).resolves.toMatchObject({
      cancelled: true,
    });
    expect(confirmReplace).toHaveBeenCalledOnce();
  });

  it('a 409 on the last fragment deletes the session first', async () => {
    const { svc, fake } = service(
      race((c) => {
        if (c.path.endsWith('createUploadSession')) return session();
        if (c.method === 'DELETE') return empty();
        return graphError(409, 'nameAlreadyExists');
      }),
    );
    const confirmReplace = vi.fn<ConfirmReplace>(async () => 'cancel');
    await svc.upload(input(), { confirmReplace });
    const del = fake.calls.findIndex((c) => c.method === 'DELETE');
    const lastRead = fake.calls.map(isRead).lastIndexOf(true);
    expect(del).toBeGreaterThan(-1);
    expect(del).toBeLessThan(lastRead);
  });

  it('a 409 on an empty file enters the question', async () => {
    const { svc } = service(race(() => graphError(409, 'nameAlreadyExists')));
    const confirmReplace = vi.fn<ConfirmReplace>(async () => 'cancel');
    await svc.upload({ ...input(), localPath: emptyPath, name: 'a.txt' }, { confirmReplace });
    expect(confirmReplace).toHaveBeenCalledOnce();
  });

  it('a lost final response, a restart and a 409 end in the question', async () => {
    let creates = 0;
    let fragments = 0;
    const { svc } = service(
      race((c) => {
        if (c.path.endsWith('createUploadSession')) {
          return creates++ === 0 ? session() : graphError(409, 'nameAlreadyExists');
        }
        if (c.method === 'GET') return notFound();
        if (fragments++ === 0) throw new TypeError('fetch failed');
        return notFound();
      }),
    );
    const confirmReplace = vi.fn<ConfirmReplace>(async () => 'cancel');
    await expect(svc.upload(input(), { confirmReplace })).resolves.toMatchObject({
      cancelled: true,
      existing: { id: 'old' },
    });
    expect(creates).toBe(2);
    expect(confirmReplace).toHaveBeenCalledOnce();
  });

  it('a vanished item raises TargetChangedError', async () => {
    const { svc, fake } = service((c) =>
      isRead(c) ? notFound() : graphError(409, 'nameAlreadyExists'),
    );
    await expect(svc.upload(input(), { confirmReplace: async () => 'overwrite' })).rejects.toThrow(
      TargetChangedError,
    );
    expect(fake.calls.filter((c) => c.method === 'PUT')).toEqual([]);
  });
});
