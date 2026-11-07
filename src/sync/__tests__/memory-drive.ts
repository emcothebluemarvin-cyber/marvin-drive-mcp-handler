import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import type { DriveFile } from '../../drive/drive-adapter.js';
import { GOOGLE_MIME, isGoogleNative } from '../../files/export-formats.js';
import { createFakeDrive, httpError, type FakeDrive } from '../../files/__tests__/fakes.js';

export interface MemFile {
  id: string;
  name: string;
  mimeType: string;
  parents: string[];
  content: Buffer;
  trashed: boolean;
  createdTime: string;
  modifiedTime: string;
  canEdit: boolean;
  canTrash: boolean;
}

export interface MemoryDrive {
  drive: FakeDrive;
  files: Map<string, MemFile>;
  addFolder(id: string, name: string, parent: string): MemFile;
  addFile(
    id: string,
    name: string,
    parent: string,
    content: string,
    extra?: Partial<MemFile>,
  ): MemFile;
  /** A Google-native file; its export (any format) is `content`. */
  addNative(id: string, name: string, parent: string, content: string, mimeType?: string): MemFile;
  childrenOf(parent: string): MemFile[];
}

function unescape(value: string): string {
  return value.replace(/\\'/g, "'").replace(/\\\\/g, '\\');
}

async function readAll(body: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of body) chunks.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(chunks);
}

/** A tiny in-memory Drive behind the FakeDrive interface (queries used by sync only). */
export function memoryDrive(rootId = 'ROOT'): MemoryDrive {
  const files = new Map<string, MemFile>();
  let tick = 0;
  let seq = 0;
  const stamp = (): string => new Date(Date.UTC(2026, 10, 3, 9, 0, tick++)).toISOString();
  const toDrive = (f: MemFile): DriveFile => {
    const isFolder = f.mimeType === GOOGLE_MIME.folder;
    return {
      id: f.id,
      name: f.name,
      mimeType: f.mimeType,
      parents: f.parents,
      trashed: f.trashed,
      createdTime: f.createdTime,
      modifiedTime: f.modifiedTime,
      ...(isGoogleNative(f.mimeType)
        ? {}
        : {
            md5Checksum: createHash('md5').update(f.content).digest('hex'),
            size: String(f.content.length),
          }),
      capabilities: { canEdit: f.canEdit, canTrash: f.canTrash, canAddChildren: isFolder },
    };
  };
  const add = (
    f: Omit<MemFile, 'createdTime' | 'modifiedTime' | 'trashed' | 'canEdit' | 'canTrash'> &
      Partial<MemFile>,
  ): MemFile => {
    const now = stamp();
    const file: MemFile = {
      trashed: false,
      canEdit: true,
      canTrash: true,
      createdTime: now,
      modifiedTime: now,
      ...f,
    };
    files.set(file.id, file);
    return file;
  };
  const drive = createFakeDrive();
  drive.getFile.mockImplementation(async (id) => {
    const f = files.get(id);
    if (!f) throw httpError(404, 'notFound');
    return toDrive(f);
  });
  drive.listFiles.mockImplementation(async ({ q }) => {
    const parent = /'((?:\\'|[^'])+)' in parents/.exec(q)?.[1];
    const name = /name = '((?:\\'|[^'])*)'/.exec(q)?.[1];
    const mime = /mimeType = '([^']+)'/.exec(q)?.[1];
    const list = [...files.values()].filter(
      (f) =>
        (parent === undefined || f.parents.includes(unescape(parent))) &&
        (!q.includes('trashed = false') || !f.trashed) &&
        (name === undefined || f.name === unescape(name)) &&
        (mime === undefined || f.mimeType === mime),
    );
    return { files: list.map(toDrive) };
  });
  drive.createFile.mockImplementation(async ({ requestBody, media }) => {
    const created = add({
      id: `n${++seq}`,
      name: requestBody.name ?? '',
      mimeType: requestBody.mimeType ?? media?.mimeType ?? 'application/octet-stream',
      parents: requestBody.parents ?? [rootId],
      content: media ? await readAll(media.body) : Buffer.alloc(0),
    });
    return toDrive(created);
  });
  drive.updateFile.mockImplementation(async ({ fileId, requestBody, media }) => {
    const f = files.get(fileId);
    if (!f) throw httpError(404, 'notFound');
    if (requestBody?.trashed !== undefined && requestBody.trashed !== null)
      f.trashed = requestBody.trashed;
    if (requestBody?.name) f.name = requestBody.name;
    if (media) {
      f.content = await readAll(media.body);
      f.modifiedTime = stamp();
    }
    return toDrive(f);
  });
  drive.downloadMedia.mockImplementation(async (id) => {
    const f = files.get(id);
    if (!f) throw httpError(404, 'notFound');
    return Readable.from([f.content]);
  });
  drive.exportMedia.mockImplementation(async (id) => {
    const f = files.get(id);
    if (!f) throw httpError(404, 'notFound');
    return Readable.from([f.content]);
  });
  add({
    id: rootId,
    name: 'Sync root',
    mimeType: GOOGLE_MIME.folder,
    parents: ['my-drive'],
    content: Buffer.alloc(0),
  });
  return {
    drive,
    files,
    addFolder: (id, name, parent) =>
      add({ id, name, mimeType: GOOGLE_MIME.folder, parents: [parent], content: Buffer.alloc(0) }),
    addFile: (id, name, parent, content, extra = {}) =>
      add({
        id,
        name,
        mimeType: 'application/pdf',
        parents: [parent],
        content: Buffer.from(content),
        ...extra,
      }),
    addNative: (id, name, parent, content, mimeType = GOOGLE_MIME.document) =>
      add({ id, name, mimeType, parents: [parent], content: Buffer.from(content) }),
    childrenOf: (parent) =>
      [...files.values()].filter((f) => f.parents.includes(parent) && !f.trashed),
  };
}
