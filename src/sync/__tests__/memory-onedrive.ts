import {
  GRAPH,
  empty,
  fakeGraph,
  graphError,
  json,
  makeClient,
  type FakeCall,
} from '../../onedrive/__tests__/fake-graph.js';
import { quickXor } from '../remote/quickxor.js';
import { OneDriveSyncRemote, type SyncGraphItem } from '../remote/onedrive-remote.js';

/** One item of the in-memory OneDrive. */
export interface MemoryItem {
  id: string;
  name: string;
  parentId: string | null;
  folder: boolean;
  content: Buffer;
  version: number;
  modified: string;
  /** Without `file`/`folder` (Personal Vault and similar). */
  special?: boolean;
}

export interface MemoryOneDrive {
  rootId: string;
  items: Map<string, MemoryItem>;
  calls: FakeCall[];
  /** A OneDriveSyncRemote for account `ms` over this drive. */
  remote(): OneDriveSyncRemote;
  addFolder(parentId: string, name: string, id?: string): MemoryItem;
  addFile(parentId: string, name: string, content: string, id?: string): MemoryItem;
  edit(id: string, content: string): void;
  /**
   * Deletes the item and its subtree: 404 from now on, reported by the delta feed (only the
   * item itself with `feedChildren: false`).
   */
  remove(id: string, options?: { feedChildren?: boolean }): void;
  /** Puts a removed or hidden item back with the same id (recycle bin restore). */
  restore(item: MemoryItem): void;
  /** Moves an item to another parent (an update in the feed, never a deletion). */
  move(id: string, parentId: string): void;
  /** The item becomes unreachable (404) without a feed entry (e.g. a locked vault). */
  hide(id: string): void;
  /** The next delta read with an old cursor answers 410. */
  expireCursors(): void;
  /** Number of delta reads. */
  deltaReads(): number;
}

const DRIVE_ID = 'mem-drive';

/** An in-memory OneDrive behind a fake Graph fetch (paths as OneDriveSyncRemote sends them). */
export function memoryOneDrive(): MemoryOneDrive {
  const rootId = 'ROOTID';
  const items = new Map<string, MemoryItem>();
  /** Every delete appends its ids; a cursor is an index into this log. */
  const deletions: string[] = [];
  /** Cursors of an older generation are expired (410). */
  let generation = 0;
  let deltaReads = 0;
  let nextId = 1;
  let tick = 0;
  const stamp = (): string => new Date(Date.UTC(2026, 10, 1, 0, 0, tick++)).toISOString();
  items.set(rootId, {
    id: rootId,
    name: 'root',
    parentId: null,
    folder: true,
    content: Buffer.alloc(0),
    version: 1,
    modified: stamp(),
  });

  const add = (item: Omit<MemoryItem, 'version' | 'modified'>): MemoryItem => {
    const full = { ...item, version: 1, modified: stamp() };
    items.set(full.id, full);
    return full;
  };
  const toGraph = (item: MemoryItem): SyncGraphItem => ({
    id: item.id,
    name: item.name,
    eTag: `"{${item.id}},${item.version}"`,
    createdDateTime: '2026-11-01T00:00:00Z',
    lastModifiedDateTime: item.modified,
    ...(item.parentId ? { parentReference: { id: item.parentId, driveId: DRIVE_ID } } : {}),
    ...(item.special
      ? {}
      : item.folder
        ? { folder: {} }
        : {
            size: item.content.length,
            file: {
              mimeType: 'application/octet-stream',
              hashes: { quickXorHash: quickXor(item.content) },
            },
          }),
  });
  const resolve = (ref: string): MemoryItem | undefined =>
    items.get(ref === 'root' ? rootId : decodeURIComponent(ref));
  const childNamed = (parentId: string, name: string): MemoryItem | undefined =>
    [...items.values()].find(
      (i) => i.parentId === parentId && i.name.toLowerCase() === name.toLowerCase(),
    );
  const ifMatch = (call: FakeCall, item: MemoryItem): boolean =>
    call.headers['if-match'] === undefined ||
    call.headers['if-match'] === `"{${item.id}},${item.version}"`;
  const subtree = (id: string): string[] => [
    id,
    ...[...items.values()].filter((i) => i.parentId === id).flatMap((i) => subtree(i.id)),
  ];

  const handle = (call: FakeCall): Response => {
    const url = new URL(call.url);
    const p = decodeURIComponent(url.pathname.replace(/^\/v1\.0/, ''));
    if (p === '/me/drive') return json({ id: DRIVE_ID });
    if (p === '/me/drive/root/delta') {
      const token = url.searchParams.get('token') ?? '';
      const link = (n: number): string => `${GRAPH}/me/drive/root/delta?token=g${generation}-${n}`;
      if (token === 'latest')
        return json({ value: [], '@odata.deltaLink': link(deletions.length) });
      deltaReads++;
      const [gen, n] = token.slice(1).split('-').map(Number);
      if (gen !== generation) return graphError(410, 'resyncRequired');
      const from = n ?? 0;
      const value = deletions.slice(from).map((id) => ({ id, deleted: { state: 'deleted' } }));
      return json({ value, '@odata.deltaLink': link(deletions.length) });
    }
    // /me/drive/items/{id}[...] or /me/drive/root[...], or path addressing `{id}:/{name}:/content`
    const m = /^\/me\/drive\/(?:items\/([^/:]+)|(root))(?::\/(.+?):)?(\/children|\/content)?$/.exec(
      p,
    );
    if (!m) return graphError(400, 'invalidRequest');
    const item = resolve(m[1] ?? m[2] ?? '');
    const childName = m[3];
    const tail = m[4];
    if (!item) return graphError(404, 'itemNotFound');
    if (childName !== undefined && tail === '/content' && call.method === 'PUT') {
      if (childNamed(item.id, childName)) return graphError(409, 'nameAlreadyExists');
      const created = add({
        id: `od-${nextId++}`,
        name: childName,
        parentId: item.id,
        folder: false,
        content: call.bytes ?? Buffer.alloc(0),
      });
      return json(toGraph(created), 201);
    }
    if (tail === '/children' && call.method === 'POST') {
      const body = JSON.parse(call.text ?? '{}') as { name: string };
      if (childNamed(item.id, body.name)) return graphError(409, 'nameAlreadyExists');
      const created = add({
        id: `od-${nextId++}`,
        name: body.name,
        parentId: item.id,
        folder: true,
        content: Buffer.alloc(0),
      });
      return json(toGraph(created), 201);
    }
    if (tail === '/children') {
      const value = [...items.values()].filter((i) => i.parentId === item.id).map(toGraph);
      return json({ value });
    }
    if (tail === '/content' && call.method === 'PUT') {
      if (!ifMatch(call, item)) return graphError(412, 'preconditionFailed');
      item.content = call.bytes ?? Buffer.alloc(0);
      item.version++;
      item.modified = stamp();
      return json(toGraph(item));
    }
    if (tail === '/content') return new Response(new Uint8Array(item.content), { status: 200 });
    if (call.method === 'DELETE') {
      if (!ifMatch(call, item)) return graphError(412, 'preconditionFailed');
      api.remove(item.id);
      return empty(204);
    }
    return json(toGraph(item));
  };

  const fake = fakeGraph(handle);
  const api: MemoryOneDrive = {
    rootId,
    items,
    calls: fake.calls,
    remote: () => new OneDriveSyncRemote(makeClient(fake).client, 'ms'),
    addFolder: (parentId, name, id = `od-${nextId++}`) =>
      add({ id, name, parentId, folder: true, content: Buffer.alloc(0) }),
    addFile: (parentId, name, content, id = `od-${nextId++}`) =>
      add({ id, name, parentId, folder: false, content: Buffer.from(content) }),
    edit: (id, content) => {
      const item = items.get(id);
      if (!item) throw new Error(`no item ${id}`);
      item.content = Buffer.from(content);
      item.version++;
      item.modified = stamp();
    },
    remove: (id, options = {}) => {
      for (const gone of subtree(id)) {
        items.delete(gone);
        if (gone === id || options.feedChildren !== false) deletions.push(gone);
      }
    },
    restore: (item) => {
      items.set(item.id, item);
    },
    move: (id, parentId) => {
      const item = items.get(id);
      if (!item) throw new Error(`no item ${id}`);
      item.parentId = parentId;
      item.modified = stamp();
    },
    hide: (id) => {
      for (const gone of subtree(id)) items.delete(gone);
    },
    expireCursors: () => {
      generation++;
    },
    deltaReads: () => deltaReads,
  };
  return api;
}
