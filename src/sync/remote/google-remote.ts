import { createReadStream } from 'node:fs';
import type { OperationRunner } from '../../core/operation.js';
import type { DriveFile } from '../../drive/drive-adapter.js';
import { NotFoundError, PermissionDeniedError, ValidationError } from '../../errors.js';
import {
  GOOGLE_MIME,
  isGoogleNative,
  resolveExport,
  type ExportFormat,
  type ExportPlan,
} from '../../files/export-formats.js';
import { openExport } from '../../files/export-stream.js';
import { escapeQueryValue } from '../../files/query.js';
import { uploadMimeType } from '../../files/upload-mime.js';
import { foldKey } from '../paths.js';
import { DEFAULT_GOOGLE_EXPORT, type GoogleExportPrefs } from '../types.js';
import type {
  DeletionFeed,
  NativeSource,
  OpenStream,
  RemoteItem,
  SyncRemote,
} from './sync-remote.js';

/** Drive fields every sync read requests (spec §4). */
export const SYNC_FILE_FIELDS =
  'id, name, mimeType, md5Checksum, size, modifiedTime, createdTime, parents, trashed, capabilities(canEdit, canTrash, canAddChildren)';
export const SYNC_LIST_FIELDS = `nextPageToken, files(${SYNC_FILE_FIELDS})`;
/** The export re-read also needs the 10 MB fallback link and the web link (addendum §4.3). */
export const SYNC_EXPORT_FIELDS = `${SYNC_FILE_FIELDS}, exportLinks, webViewLink`;
export const SYNC_PAGE_SIZE = 1000;
const FOLDER_LIST_FIELDS = 'nextPageToken, files(id, name)';
const NAME_PAGE_SIZE = 100;

/** A folder's non-trashed children. */
export function childrenQuery(folderId: string): string {
  return `'${escapeQueryValue(folderId)}' in parents and trashed = false`;
}

/**
 * The only sync module that knows Drive shapes: Google-native, folder and shortcut MIME
 * types, `resolveExport` (addendum §4.1).
 */
export type RemoteKind =
  | { kind: 'binary' }
  | {
      kind: 'native';
      mimeType: string;
      exportFormat: ExportFormat;
      exportMime: string;
      extension: string;
    }
  | { kind: 'unsupported'; reason: 'native-unsupported' };

const PREF_BY_MIME: Readonly<Record<string, keyof GoogleExportPrefs>> = {
  [GOOGLE_MIME.document]: 'document',
  [GOOGLE_MIME.spreadsheet]: 'spreadsheet',
  [GOOGLE_MIME.presentation]: 'presentation',
  [GOOGLE_MIME.drawing]: 'drawing',
};

/** Binary, exportable native (with the pair's format), or unsupported native. */
export function classifyRemote(file: DriveFile, prefs: GoogleExportPrefs): RemoteKind {
  const mimeType = file.mimeType ?? '';
  if (!isGoogleNative(mimeType)) return { kind: 'binary' };
  const pref = PREF_BY_MIME[mimeType];
  if (pref === undefined) return { kind: 'unsupported', reason: 'native-unsupported' };
  const plan = resolveExport(mimeType, prefs[pref]);
  if (plan === null) return { kind: 'unsupported', reason: 'native-unsupported' };
  return {
    kind: 'native',
    mimeType,
    exportFormat: plan.format,
    exportMime: plan.mimeType,
    extension: plan.extension,
  };
}

/** Pair export settings: defaults for omitted types; each checked with resolveExport. */
export function validateGoogleExport(prefs: Partial<GoogleExportPrefs>): GoogleExportPrefs {
  const merged: GoogleExportPrefs = { ...DEFAULT_GOOGLE_EXPORT };
  for (const key of Object.keys(merged) as Array<keyof GoogleExportPrefs>) {
    const value = prefs[key];
    if (value !== undefined) merged[key] = value;
  }
  for (const [mime, key] of Object.entries(PREF_BY_MIME)) resolveExport(mime, merged[key]);
  return merged;
}

/** A Drive file as the engine sees it; `prefs` decide how a native file exports. */
export function toRemoteItem(file: DriveFile, prefs: GoogleExportPrefs): RemoteItem {
  const mimeType = file.mimeType ?? '';
  const base = {
    id: file.id ?? '',
    name: file.name ?? '',
    parentId: file.parents?.[0] ?? null,
    mimeType: file.mimeType ?? 'application/octet-stream',
    size: file.size ? Number(file.size) : null,
    modifiedTime: file.modifiedTime ?? '',
    createdTime: file.createdTime ?? '',
    hash:
      typeof file.md5Checksum === 'string'
        ? { kind: 'md5' as const, value: file.md5Checksum }
        : null,
    version: null,
    trashed: file.trashed === true,
    canEdit: file.capabilities?.canEdit ?? false,
    canTrash: file.capabilities?.canTrash ?? false,
    canAddChildren: file.capabilities?.canAddChildren !== false,
    native: null,
  };
  if (mimeType === GOOGLE_MIME.folder) return { ...base, kind: 'folder' };
  if (mimeType === GOOGLE_MIME.shortcut) {
    return { ...base, kind: 'unsupported', unsupported: 'shortcut' };
  }
  const kind = classifyRemote(file, prefs);
  if (kind.kind === 'unsupported') {
    return { ...base, kind: 'unsupported', unsupported: kind.reason };
  }
  if (kind.kind === 'binary') return { ...base, kind: 'file' };
  return {
    ...base,
    kind: 'file',
    native: {
      mimeType: kind.mimeType,
      exportFormat: kind.exportFormat,
      exportMime: kind.exportMime,
    },
  };
}

/**
 * What `exportNative` needs from a `readNative` (the export links), shared by every
 * GoogleSyncRemote so a source stays usable whichever instance exports it.
 */
const NATIVE_FILES = new WeakMap<NativeSource, { id: string; file: DriveFile }>();

/**
 * SyncRemote over the Drive adapter (OneDrive sync spec §2.2). Every call goes through the
 * OperationRunner with the operation kind and target the engine used before the port.
 */
export class GoogleSyncRemote implements SyncRemote {
  readonly provider = 'google';
  readonly hashKind = 'md5';
  readonly rootId = 'root';

  constructor(
    private readonly ops: OperationRunner,
    readonly account: string,
    private readonly prefs: GoogleExportPrefs,
  ) {}

  /** For an account reference (alias, email or default): resolves the alias, no Drive call. */
  static async open(
    ops: OperationRunner,
    accountRef: string | undefined,
    prefs: GoogleExportPrefs,
  ): Promise<GoogleSyncRemote> {
    const alias = await ops.exec(accountRef, 'idempotent', undefined, async (ctx) => {
      return ctx.account.alias;
    });
    return new GoogleSyncRemote(ops, alias, prefs);
  }

  private item(file: DriveFile): RemoteItem {
    return toRemoteItem(file, this.prefs);
  }

  async read(id: string): Promise<RemoteItem> {
    const file = await this.ops.exec(this.account, 'idempotent', id, (ctx) =>
      ctx.drive.getFile(id, SYNC_FILE_FIELDS),
    );
    return this.item(file);
  }

  async get(id: string): Promise<RemoteItem | null> {
    try {
      return await this.read(id);
    } catch (err) {
      if (err instanceof NotFoundError || err instanceof PermissionDeniedError) return null;
      throw err;
    }
  }

  async listChildren(
    folderId: string,
    pageToken: string | undefined,
  ): Promise<{ items: RemoteItem[]; next?: string }> {
    const page = await this.ops.exec(this.account, 'idempotent', folderId, (ctx) =>
      ctx.drive.listFiles({
        q: childrenQuery(folderId),
        pageSize: SYNC_PAGE_SIZE,
        ...(pageToken ? { pageToken } : {}),
        fields: SYNC_LIST_FIELDS,
      }),
    );
    const items = (page.files ?? []).map((f) => this.item(f));
    return page.nextPageToken ? { items, next: page.nextPageToken } : { items };
  }

  /**
   * Folders: every page of the parent's folders (id and name only). Files: one page of
   * the exact-name query, as the duplicate-upload check always did.
   */
  async findChildren(parentId: string, name: string, kind?: 'folder'): Promise<RemoteItem[]> {
    const fold = foldKey(name);
    const found: RemoteItem[] = [];
    const parents = `'${escapeQueryValue(parentId)}' in parents and trashed = false`;
    if (kind !== 'folder') {
      const q = `${parents} and name = '${escapeQueryValue(name)}'`;
      const list = await this.ops.exec(this.account, 'idempotent', parentId, (ctx) =>
        ctx.drive.listFiles({ q, pageSize: NAME_PAGE_SIZE, fields: SYNC_LIST_FIELDS }),
      );
      for (const f of list.files ?? []) found.push(this.item(f));
    } else {
      const q = `${parents} and mimeType = '${GOOGLE_MIME.folder}'`;
      let pageToken: string | undefined;
      do {
        const page = await this.ops.exec(this.account, 'idempotent', parentId, (ctx) =>
          ctx.drive.listFiles({
            q,
            pageSize: SYNC_PAGE_SIZE,
            ...(pageToken ? { pageToken } : {}),
            fields: FOLDER_LIST_FIELDS,
          }),
        );
        for (const f of page.files ?? []) {
          found.push(this.item({ mimeType: GOOGLE_MIME.folder, parents: [parentId], ...f }));
        }
        pageToken = page.nextPageToken ?? undefined;
      } while (pageToken);
    }
    return found.filter((f) => foldKey(f.name) === fold);
  }

  async createFolder(parentId: string, name: string): Promise<RemoteItem> {
    const created = await this.ops.exec(this.account, 'create', parentId, (ctx) =>
      ctx.drive.createFile({
        requestBody: { name, mimeType: GOOGLE_MIME.folder, parents: [parentId] },
        fields: 'id, name',
      }),
    );
    return this.item({ mimeType: GOOGLE_MIME.folder, parents: [parentId], ...created });
  }

  async uploadNew(parentId: string, name: string, localPath: string): Promise<RemoteItem> {
    const file = await this.ops.exec(this.account, 'create', parentId, async (ctx) => {
      const body = createReadStream(localPath);
      try {
        return await ctx.drive.createFile({
          requestBody: { name, parents: [parentId] },
          media: { mimeType: uploadMimeType(localPath), body },
          fields: SYNC_FILE_FIELDS,
        });
      } catch (err) {
        body.destroy();
        throw err;
      }
    });
    return this.item(file);
  }

  /** New content for the same fileId (Drive keeps a revision). */
  async replaceContent(item: RemoteItem, localPath: string): Promise<RemoteItem> {
    const file = await this.ops.exec(this.account, 'mutate', item.id, async (ctx) => {
      const body = createReadStream(localPath);
      try {
        return await ctx.drive.updateFile({
          fileId: item.id,
          media: { mimeType: uploadMimeType(localPath), body },
          fields: SYNC_FILE_FIELDS,
        });
      } catch (err) {
        body.destroy();
        throw err;
      }
    });
    return this.item(file);
  }

  download<T>(id: string, consume: (open: OpenStream) => Promise<T>): Promise<T> {
    return this.ops.exec(this.account, 'idempotent', id, (ctx) =>
      consume(() => ctx.drive.downloadMedia(id)),
    );
  }

  /** Re-reads a native file with the 10 MB fallback link and the web link (addendum §4.3). */
  async readNative(id: string): Promise<NativeSource> {
    const file = await this.ops.exec(this.account, 'idempotent', id, (ctx) =>
      ctx.drive.getFile(id, SYNC_EXPORT_FIELDS),
    );
    const source: NativeSource = { item: this.item(file) };
    NATIVE_FILES.set(source, { id, file });
    return source;
  }

  async exportNative<T>(
    source: NativeSource,
    plan: ExportPlan,
    consume: (open: OpenStream) => Promise<T>,
  ): Promise<T> {
    const read = NATIVE_FILES.get(source);
    if (!read) throw new ValidationError('Internal: export source was not read by readNative');
    return this.ops.exec(this.account, 'idempotent', read.id, (ctx) =>
      consume(() => openExport(ctx.drive, read.file, plan, this.ops.log)),
    );
  }

  async trash(item: RemoteItem): Promise<void> {
    await this.ops.exec(this.account, 'idempotent', item.id, (ctx) =>
      ctx.drive.updateFile({
        fileId: item.id,
        requestBody: { trashed: true },
        fields: 'id, trashed',
      }),
    );
  }

  deletionFeed(): DeletionFeed | null {
    return null;
  }
}
