import type { OperationRunner } from '../../core/operation.js';
import type { DriveChange, DriveFile } from '../../drive/drive-adapter.js';
import { DriveApiError, NotFoundError, PermissionDeniedError } from '../../errors.js';
import { GOOGLE_MIME } from '../../files/export-formats.js';
import { InvalidCursorError, type ChangeFeed } from '../feed.js';
import type { Kind, RawChange, RawFile } from '../types.js';

export const FILE_FIELDS =
  'id,name,mimeType,parents,trashed,modifiedTime,createdTime,version,md5Checksum,size,lastModifyingUser(displayName,emailAddress,me)';
/** Spec §5.1. */
export const CHANGE_FIELDS = `nextPageToken,newStartPageToken,changes(fileId,removed,time,file(${FILE_FIELDS}))`;
export const PAGE_SIZE = 1000;
/** Pages per poll; the next tick continues from the last page token. */
export const MAX_PAGES = 50;

export function kindOfMime(mime: string | null | undefined): Kind {
  switch (mime) {
    case GOOGLE_MIME.document:
      return 'doc';
    case GOOGLE_MIME.spreadsheet:
      return 'sheet';
    case GOOGLE_MIME.presentation:
      return 'slides';
    case GOOGLE_MIME.folder:
      return 'folder';
    default:
      return 'other';
  }
}

export function toRawFile(f: DriveFile): RawFile {
  const user = f.lastModifyingUser;
  return {
    name: f.name ?? '',
    kind: kindOfMime(f.mimeType),
    parents: f.parents ?? [],
    trashed: f.trashed === true,
    modifiedTime: f.modifiedTime ?? '',
    createdTime: f.createdTime ?? '',
    version: f.version ?? null,
    md5: f.md5Checksum ?? null,
    size: f.size ? Number(f.size) : null,
    modifier: user
      ? { name: user.displayName ?? null, email: user.emailAddress ?? null, me: user.me === true }
      : null,
  };
}

function toRawChange(fileId: string, c: DriveChange): RawChange {
  const file = c.removed === true || !c.file ? null : toRawFile(c.file);
  return { fileId, time: c.time ?? '', removed: file === null, file };
}

/** Google Drive Changes API as a ChangeFeed for one account (spec §5.1). */
export class GoogleChangeFeed implements ChangeFeed {
  constructor(
    private readonly ops: OperationRunner,
    private readonly account: string,
  ) {}

  start(): Promise<string> {
    return this.ops.exec(this.account, 'idempotent', undefined, (ctx) =>
      ctx.drive.getStartPageToken(),
    );
  }

  async poll(cursor: string): Promise<{ changes: RawChange[]; next: string }> {
    const changes: RawChange[] = [];
    let token = cursor;
    for (let page = 0; page < MAX_PAGES; page++) {
      const pageToken = token;
      let res;
      try {
        res = await this.ops.exec(this.account, 'idempotent', undefined, (ctx) =>
          ctx.drive.listChanges({ pageToken, pageSize: PAGE_SIZE, fields: CHANGE_FIELDS }),
        );
      } catch (err) {
        if (err instanceof DriveApiError && (err.status === 400 || err.status === 410)) {
          throw new InvalidCursorError({ cause: err });
        }
        throw err;
      }
      for (const c of res.changes ?? []) {
        if (c.fileId) changes.push(toRawChange(c.fileId, c));
      }
      if (res.newStartPageToken) return { changes, next: res.newStartPageToken };
      if (!res.nextPageToken) {
        throw new DriveApiError(undefined, 'changes.list returned no page token');
      }
      token = res.nextPageToken;
    }
    return { changes, next: token };
  }

  async parentsOf(id: string): Promise<string[] | null> {
    try {
      const f = await this.ops.exec(this.account, 'idempotent', id, (ctx) =>
        ctx.drive.getFile(id, 'parents'),
      );
      return f.parents ?? [];
    } catch (err) {
      if (err instanceof NotFoundError || err instanceof PermissionDeniedError) return null;
      throw err;
    }
  }

  async file(id: string): Promise<RawFile> {
    return toRawFile(
      await this.ops.exec(this.account, 'idempotent', id, (ctx) =>
        ctx.drive.getFile(id, FILE_FIELDS),
      ),
    );
  }
}
