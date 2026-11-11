import { describe, expect, it, beforeEach } from 'vitest';
import type { AuditEntry, AuditSink } from '../../audit/audit-log.js';
import {
  CopyStillRunningError,
  GraphApiError,
  NameConflictError,
  NotFoundError,
  ValidationError,
} from '../../errors.js';
import { silentLogger } from '../../files/__tests__/fakes.js';
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

const ITEM = { id: 'i1', name: 'a.txt', file: {}, parentReference: { id: 'p1', driveId: 'D1' } };
let entries: Array<Omit<AuditEntry, 'ts'>>;
const audit: AuditSink = {
  record: async (entry) => void entries.push(entry),
};

beforeEach(() => {
  entries = [];
});

function drive(call: FakeCall): Response | undefined {
  if (call.path.startsWith('/me/drive?')) return json({ id: 'D1', driveType: 'personal' });
  if (call.path === '/me/drive/root?$select=id') return json({ id: 'ROOT' });
  return undefined;
}

function service(responder: Responder, extra: Parameters<typeof makeClient>[1] = {}) {
  const fake = fakeGraph((c) => drive(c) ?? responder(c));
  const { client } = makeClient(fake, extra);
  const svc = new OneDriveFileService({
    clients: async () => client,
    audit,
    downloadsDir: '/tmp/unused',
    logger: silentLogger(),
  });
  return { svc, fake };
}

const notFound = (): Response => graphError(404, 'itemNotFound');
const of = (calls: FakeCall[], method: string): FakeCall[] =>
  calls.filter((c) => c.method === method);
const bodyOf = (call: FakeCall | undefined): unknown => JSON.parse(call?.text ?? 'null');
const account = 'work';

describe('createFolder', () => {
  it('fails on a conflict and audits with the alias', async () => {
    const { svc, fake } = service(() => json({ id: 'f', name: 'd', folder: {} }));
    await expect(svc.createFolder({ account, name: 'd' })).resolves.toMatchObject({
      mimeType: 'inode/directory',
    });
    expect(fake.calls[0]?.path).toMatch(/^\/me\/drive\/root\/children/);
    expect(bodyOf(fake.calls[0])).toEqual({
      name: 'd',
      folder: {},
      '@microsoft.graph.conflictBehavior': 'fail',
    });
    expect(entries[0]).toMatchObject({
      account,
      op: 'create_folder',
      details: { parentId: 'root' },
    });
  });

  it('maps a conflict', async () => {
    const { svc } = service(() => graphError(409, 'nameAlreadyExists'));
    await expect(svc.createFolder({ account, name: 'd' })).rejects.toThrow(NameConflictError);
    expect(entries).toEqual([]);
  });
});

describe('rename', () => {
  const route =
    (preflight: () => Response, renamed = ITEM): Responder =>
    (c) => {
      if (c.method === 'PATCH') return json({ ...renamed, name: 'b.txt' });
      if (c.path.includes('b.txt')) return preflight();
      return json(ITEM);
    };

  it('reads the current parent, checks the name and renames', async () => {
    const { svc, fake } = service(route(notFound));
    await expect(svc.rename({ account, fileId: 'i1', newName: 'b.txt' })).resolves.toMatchObject({
      name: 'b.txt',
    });
    expect(fake.calls[1]?.path).toBe('/me/drive/items/p1:/b.txt?$select=id');
    expect(bodyOf(of(fake.calls, 'PATCH')[0])).toEqual({ name: 'b.txt' });
    expect(entries[0]).toMatchObject({
      op: 'rename',
      details: { oldName: 'a.txt', newName: 'b.txt' },
    });
  });

  it('refuses when another item has the name, sending no PATCH', async () => {
    const { svc, fake } = service(route(() => json({ id: 'other' })));
    await expect(svc.rename({ account, fileId: 'i1', newName: 'b.txt' })).rejects.toThrow(
      NameConflictError,
    );
    expect(of(fake.calls, 'PATCH')).toEqual([]);
  });

  it('allows a case-only rename, which finds itself', async () => {
    const { svc, fake } = service(route(() => json({ id: 'i1' })));
    await svc.rename({ account, fileId: 'i1', newName: 'b.txt' });
    expect(of(fake.calls, 'PATCH')).toHaveLength(1);
  });

  it('aborts on a preflight failure other than 404', async () => {
    const { svc, fake } = service(route(() => graphError(403, 'accessDenied')));
    await expect(svc.rename({ account, fileId: 'i1', newName: 'b.txt' })).rejects.toThrow(
      /permission/,
    );
    expect(of(fake.calls, 'PATCH')).toEqual([]);
  });

  it('maps a 409 from the PATCH', async () => {
    const { svc } = service((c) =>
      c.method === 'PATCH' ? graphError(409, 'nameAlreadyExists') : route(notFound)(c),
    );
    await expect(svc.rename({ account, fileId: 'i1', newName: 'b.txt' })).rejects.toThrow(
      NameConflictError,
    );
  });

  it('refuses the root folder', async () => {
    const { svc } = service(() => json({ id: 'r', name: 'root', folder: {} }));
    await expect(svc.rename({ account, fileId: 'root', newName: 'x' })).rejects.toThrow(
      ValidationError,
    );
  });
});

describe('move', () => {
  const route =
    (preflight: () => Response = notFound): Responder =>
    (c) => {
      if (c.method === 'PATCH') return json({ ...ITEM, parentReference: { id: 'p2' } });
      if (c.path.includes(':/a.txt')) return preflight();
      return json(ITEM);
    };

  it('uses the target folder for the preflight and audits the old parent', async () => {
    const { svc, fake } = service(route());
    await svc.move({ account, fileId: 'i1', newParentId: 'p2' });
    expect(fake.calls.some((c) => c.path === '/me/drive/items/p2:/a.txt?$select=id')).toBe(true);
    expect(bodyOf(of(fake.calls, 'PATCH')[0])).toEqual({ parentReference: { id: 'p2' } });
    expect(entries[0]).toMatchObject({
      op: 'move',
      details: { oldParents: ['p1'], newParentId: 'p2' },
    });
  });

  it('replaces root by the real ID', async () => {
    const { svc, fake } = service(route());
    await svc.move({ account, fileId: 'i1', newParentId: 'root' });
    expect(bodyOf(of(fake.calls, 'PATCH')[0])).toEqual({ parentReference: { id: 'ROOT' } });
  });

  it('is a no-op without audit when already there, also for root', async () => {
    const { svc, fake } = service(route());
    await svc.move({ account, fileId: 'i1', newParentId: 'p1' });
    expect(of(fake.calls, 'PATCH')).toEqual([]);
    expect(entries).toEqual([]);
    const inRoot = service(() => json({ ...ITEM, parentReference: { id: 'ROOT' } }));
    await inRoot.svc.move({ account, fileId: 'i1', newParentId: 'root' });
    expect(of(inRoot.fake.calls, 'PATCH')).toEqual([]);
  });

  it('refuses a name conflict in the target, sending no PATCH', async () => {
    const { svc, fake } = service(route(() => json({ id: 'other' })));
    await expect(svc.move({ account, fileId: 'i1', newParentId: 'p2' })).rejects.toThrow(
      NameConflictError,
    );
    expect(of(fake.calls, 'PATCH')).toEqual([]);
  });

  it('aborts on a preflight failure other than 404', async () => {
    const { svc, fake } = service(route(() => graphError(500, 'x')));
    await expect(svc.move({ account, fileId: 'i1', newParentId: 'p2' })).rejects.toThrow(
      GraphApiError,
    );
    expect(of(fake.calls, 'PATCH')).toEqual([]);
  });
});

const MONITOR = 'https://monitor.example/op';

describe('copy', () => {
  const route =
    (monitor: () => Response = () => json({ status: 'completed', resourceId: 'new' })): Responder =>
    (c) => {
      if (c.method === 'POST') return empty(202, { location: MONITOR });
      if (c.url === MONITOR) return monitor();
      if (c.path.startsWith('/me/drive/items/new'))
        return json({ ...ITEM, id: 'new', name: 'copy' });
      return json(ITEM);
    };

  it('needs a name or a target folder', async () => {
    const { svc, fake } = service(route());
    await expect(svc.copy({ account, fileId: 'i1' })).rejects.toThrow(ValidationError);
    expect(fake.calls).toEqual([]);
  });

  it('sends driveId and the target and sends no conflict parameter', async () => {
    const { svc, fake } = service(route());
    await expect(svc.copy({ account, fileId: 'i1', parentId: 'p2' })).resolves.toMatchObject({
      id: 'new',
    });
    const post = of(fake.calls, 'POST')[0];
    expect(post?.path).toBe('/me/drive/items/i1/copy');
    expect(bodyOf(post)).toEqual({ parentReference: { driveId: 'D1', id: 'p2' } });
    expect(entries[0]).toMatchObject({
      op: 'copy',
      fileId: 'new',
      details: { sourceId: 'i1', parentId: 'p2' },
    });
  });

  it('uses the current parent when only a name is given', async () => {
    const { svc, fake } = service(route());
    await svc.copy({ account, fileId: 'i1', name: 'b.txt' });
    expect(bodyOf(of(fake.calls, 'POST')[0])).toEqual({
      parentReference: { driveId: 'D1', id: 'p1' },
      name: 'b.txt',
    });
  });

  it('replaces root by the real ID', async () => {
    const { svc, fake } = service(route());
    await svc.copy({ account, fileId: 'i1', parentId: 'root' });
    expect(bodyOf(of(fake.calls, 'POST')[0])).toEqual({
      parentReference: { driveId: 'D1', id: 'ROOT' },
    });
  });

  it('marks the audit record pending when the copy keeps running', async () => {
    let clock = 0;
    const { svc } = service(
      route(() => json({ status: 'inProgress' }, 202)),
      {
        now: () => clock,
        sleep: async (ms) => {
          clock += ms;
        },
      },
    );
    await expect(svc.copy({ account, fileId: 'i1', parentId: 'p2' })).rejects.toThrow(
      CopyStillRunningError,
    );
    expect(entries[0]).toMatchObject({ op: 'copy', fileId: 'i1', details: { pending: true } });
  });

  it('copies a folder', async () => {
    const folder = { name: 'dir', folder: {}, parentReference: { id: 'p1', driveId: 'D1' } };
    const { svc, fake } = service((c) => {
      if (c.method === 'POST') return empty(202, { location: MONITOR });
      if (c.url === MONITOR) return json({ status: 'completed', resourceId: 'd2' });
      return json({ ...folder, id: c.path.includes('/items/d2') ? 'd2' : 'd1' });
    });
    await expect(svc.copy({ account, fileId: 'd1', parentId: 'p2' })).resolves.toMatchObject({
      id: 'd2',
      mimeType: 'inode/directory',
    });
    expect(of(fake.calls, 'POST')[0]?.path).toBe('/me/drive/items/d1/copy');
  });

  it('audits a completed copy even when reading the new item fails', async () => {
    const { svc } = service((c) => {
      if (c.method === 'POST') return empty(202, { location: MONITOR });
      if (c.url === MONITOR) return json({ status: 'completed', resourceId: 'new' });
      if (c.path.startsWith('/me/drive/items/new')) return graphError(500, 'x');
      return json(ITEM);
    });
    await expect(
      svc.copy({ account, fileId: 'i1', parentId: 'p2', name: 'c.txt' }),
    ).rejects.toThrow(GraphApiError);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      op: 'copy',
      fileId: 'new',
      name: 'c.txt',
      details: { sourceId: 'i1', parentId: 'p2' },
    });
  });
});

describe('delete', () => {
  it('sends the item to the recycle bin', async () => {
    const { svc, fake } = service((c) => (c.method === 'DELETE' ? empty() : json(ITEM)));
    await expect(svc.delete({ account, fileId: 'i1' })).resolves.toEqual({
      fileId: 'i1',
      name: 'a.txt',
      permanent: false,
    });
    expect(of(fake.calls, 'DELETE')[0]?.path).toBe('/me/drive/items/i1');
    expect(entries[0]).toMatchObject({ op: 'delete', details: { permanent: false } });
  });

  it('refuses the root folder', async () => {
    const { svc, fake } = service(() => json({ id: 'r', name: 'root', folder: {} }));
    await expect(svc.delete({ account, fileId: 'root' })).rejects.toThrow(ValidationError);
    expect(of(fake.calls, 'DELETE')).toEqual([]);
  });

  it('rejects permanent, accepts false', async () => {
    const { svc } = service((c) => (c.method === 'DELETE' ? empty() : json(ITEM)));
    await expect(svc.delete({ account, fileId: 'i1', permanent: true })).rejects.toThrow(
      /not available on OneDrive/,
    );
    await expect(svc.delete({ account, fileId: 'i1', permanent: false })).resolves.toBeDefined();
  });

  it('counts a 404 after a failed attempt as success', async () => {
    let n = 0;
    const { svc } = service((c) => {
      if (c.method !== 'DELETE') return json(ITEM);
      return n++ === 0 ? graphError(500, 'x') : notFound();
    });
    await expect(svc.delete({ account, fileId: 'i1' })).resolves.toMatchObject({ fileId: 'i1' });
    expect(entries).toHaveLength(1);
  });
});

describe('restore', () => {
  it('restores on a personal drive', async () => {
    const { svc, fake } = service(() => json(ITEM));
    await expect(svc.restore({ account, fileId: 'i1' })).resolves.toMatchObject({ id: 'i1' });
    expect(of(fake.calls, 'POST')[0]?.path).toBe('/me/drive/items/i1/restore');
    expect(entries[0]).toMatchObject({ op: 'restore' });
  });

  it('points a business drive to the web recycle bin', async () => {
    const fake = fakeGraph((c) =>
      c.path.startsWith('/me/drive?')
        ? json({ id: 'D', driveType: 'business' })
        : json({ id: 'R' }),
    );
    const { client } = makeClient(fake);
    const svc = new OneDriveFileService({
      clients: async () => client,
      audit,
      downloadsDir: '/x',
      logger: silentLogger(),
    });
    await expect(svc.restore({ account, fileId: 'i1' })).rejects.toThrow(/OneDrive website/);
    expect(of(fake.calls, 'POST')).toEqual([]);
  });
});

describe('audit failures', () => {
  it('never fail the operation', async () => {
    const svc = new OneDriveFileService({
      clients: async () =>
        makeClient(fakeGraph(() => json({ id: 'f', name: 'd', folder: {} }))).client,
      audit: { record: () => Promise.reject(new Error('disk')) },
      downloadsDir: '/x',
      logger: silentLogger(),
    });
    await expect(svc.createFolder({ account, name: 'd' })).resolves.toBeDefined();
  });
});

describe('a remoteItem counts as not found', () => {
  const remoteOr: Responder = (c) =>
    c.path.startsWith('/me/drive/items/shared')
      ? json({ id: 'shared', name: 's', remoteItem: {} })
      : json(ITEM);

  it.each<[string, (svc: OneDriveFileService) => Promise<unknown>]>([
    ['createFolder parent', (s) => s.createFolder({ account, name: 'd', parentId: 'shared' })],
    ['rename', (s) => s.rename({ account, fileId: 'shared', newName: 'b.txt' })],
    ['move source', (s) => s.move({ account, fileId: 'shared', newParentId: 'p2' })],
    ['move target', (s) => s.move({ account, fileId: 'i1', newParentId: 'shared' })],
    ['delete', (s) => s.delete({ account, fileId: 'shared' })],
    ['copy source with a name only', (s) => s.copy({ account, fileId: 'shared', name: 'c' })],
    ['copy source with a target', (s) => s.copy({ account, fileId: 'shared', parentId: 'p2' })],
    ['copy target', (s) => s.copy({ account, fileId: 'i1', parentId: 'shared' })],
  ])('%s', async (_name, run) => {
    const { svc, fake } = service(remoteOr);
    await expect(run(svc)).rejects.toThrow(NotFoundError);
    expect(fake.calls.filter((c) => c.method !== 'GET')).toEqual([]);
  });

  it('reads root as the own drive without a check', async () => {
    const { svc, fake } = service(() => json({ id: 'f', name: 'd', folder: {} }));
    await svc.createFolder({ account, name: 'd', parentId: 'root' });
    expect(fake.calls.filter((c) => c.method === 'GET')).toEqual([]);
  });
});

describe('unsafe path values', () => {
  it.each(['.', '..', 'a/b', 'a\\b'])(
    'rename refuses the name %s without a request',
    async (newName) => {
      const { svc, fake } = service(() => json(ITEM));
      await expect(svc.rename({ account, fileId: 'i1', newName })).rejects.toThrow(ValidationError);
      expect(fake.calls).toEqual([]);
    },
  );

  it.each(['.', '..', 'a/b', 'a\\b'])(
    'delete refuses the ID %s without a request',
    async (fileId) => {
      const { svc, fake } = service(() => json(ITEM));
      await expect(svc.delete({ account, fileId })).rejects.toThrow(ValidationError);
      expect(fake.calls).toEqual([]);
    },
  );
});
