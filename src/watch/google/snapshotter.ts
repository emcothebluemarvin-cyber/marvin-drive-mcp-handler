import type { Readable } from 'node:stream';
import type { OperationRunner } from '../../core/operation.js';
import type { DriveComment } from '../../drive/drive-adapter.js';
import { ExportTooLargeError, ValidationError } from '../../errors.js';
import type { ContentSnapshotter } from '../feed.js';
import { rangeOf } from '../sheet-diff.js';
import type { CommentInfo, Kind, Modifier, Snapshot } from '../types.js';

/** Spec §6 limits. */
export const TEXT_LIMIT_BYTES = 1_000_000;
export const SHEET_CELL_LIMIT = 20_000;
export const SHEET_FIELDS = 'sheets(properties(title,gridProperties(rowCount,columnCount)))';
export const COMMENT_FIELDS =
  'comments(id,author(displayName,emailAddress,me),content,createdTime,modifiedTime,resolved,replies(author,content,createdTime))';
const COMMENT_PAGE_SIZE = 100;

type TooLarge = { tooLarge: true };

async function readCapped(stream: Readable, limit: number): Promise<string | null> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    total += buf.length;
    if (total > limit) {
      stream.destroy();
      return null;
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function normalize(text: string): string {
  return text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
}

function cellText(value: unknown): string {
  if (value === null || value === undefined) return '';
  return typeof value === 'string' ? value : String(value);
}

function modifier(user: DriveComment['author']): Modifier {
  return {
    name: user?.displayName ?? null,
    email: user?.emailAddress ?? null,
    me: user?.me === true,
  };
}

/** Text / cell snapshots and comments of Google files for one account (spec §6). */
export class GoogleSnapshotter implements ContentSnapshotter {
  constructor(
    private readonly ops: OperationRunner,
    private readonly account: string,
  ) {}

  async snapshot(fileId: string, kind: Kind): Promise<Snapshot | TooLarge> {
    if (kind === 'sheet') return this.sheet(fileId);
    if (kind !== 'doc' && kind !== 'slides') {
      throw new ValidationError(`No content snapshot for ${kind} files`);
    }
    try {
      const text = await this.ops.exec(this.account, 'idempotent', fileId, async (ctx) =>
        readCapped(await ctx.drive.exportMedia(fileId, 'text/plain'), TEXT_LIMIT_BYTES),
      );
      return text === null ? { tooLarge: true } : { type: 'text', text: normalize(text) };
    } catch (err) {
      if (err instanceof ExportTooLargeError) return { tooLarge: true };
      throw err;
    }
  }

  private async sheet(fileId: string): Promise<Snapshot | TooLarge> {
    const meta = await this.ops.exec(
      this.account,
      'idempotent',
      fileId,
      (ctx) => ctx.sheets.getSpreadsheet(fileId, SHEET_FIELDS),
      { api: 'sheets' },
    );
    const tabs: Array<{ title: string; cells: number }> = [];
    for (const s of meta.sheets ?? []) {
      const p = s.properties;
      const grid = p?.gridProperties;
      if (!p?.title || !grid) continue;
      tabs.push({ title: p.title, cells: (grid.rowCount ?? 0) * (grid.columnCount ?? 0) });
    }
    if (tabs.reduce((n, t) => n + t.cells, 0) > SHEET_CELL_LIMIT) return { tooLarge: true };
    if (tabs.length === 0) return { type: 'sheet', sheets: [] };
    const res = await this.ops.exec(
      this.account,
      'idempotent',
      fileId,
      (ctx) =>
        ctx.sheets.batchGetValues(
          fileId,
          tabs.map((t) => rangeOf(t.title)),
          'FORMATTED_VALUE',
        ),
      { api: 'sheets' },
    );
    const ranges = res.valueRanges ?? [];
    return {
      type: 'sheet',
      sheets: tabs.map((t, i) => ({
        title: t.title,
        rows: ((ranges[i]?.values ?? []) as unknown[][]).map((row) => row.map(cellText)),
      })),
    };
  }

  async commentsSince(fileId: string, since: string): Promise<CommentInfo[]> {
    const res = await this.ops.exec(this.account, 'idempotent', fileId, (ctx) =>
      ctx.drive.listComments({
        fileId,
        startModifiedTime: since,
        pageSize: COMMENT_PAGE_SIZE,
        fields: COMMENT_FIELDS,
      }),
    );
    return (res.comments ?? []).map((c) => ({
      id: c.id ?? '',
      author: modifier(c.author),
      content: c.content ?? '',
      createdTime: c.createdTime ?? '',
      modifiedTime: c.modifiedTime ?? '',
      resolved: c.resolved === true,
      replies: (c.replies ?? []).map((r) => ({
        author: modifier(r.author),
        content: r.content ?? '',
        createdTime: r.createdTime ?? '',
      })),
    }));
  }
}
