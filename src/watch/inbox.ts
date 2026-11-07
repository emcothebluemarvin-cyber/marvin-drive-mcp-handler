import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, open, readFile, rm, type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { hasErrorCode } from '../errors.js';
import { renameReplacing } from '../files/rename-replacing.js';
import { sweepStaleTemps } from './temp-sweep.js';
import type { ChangeEvent, EventDraft } from './types.js';

export const INBOX_FILE = 'inbox.jsonl';
/** Rotation threshold, events kept, dedupe window and unread retention (spec §7.3). */
export const ROTATE_AT_LINES = 1_000;
export const KEEP_NEWEST = 500;
export const DEDUPE_WINDOW = 500;
export const UNREAD_KEEP_MS = 30 * 24 * 60 * 60 * 1000;
/** Rotation rewrites the file only when it drops at least this many events (or repairs lines). */
export const MIN_ROTATE_DROP = 100;

function isEvent(value: unknown): value is ChangeEvent {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as { seq?: unknown; id?: unknown };
  return typeof v.seq === 'number' && typeof v.id === 'string';
}

/** Events of the complete lines of `text` (after the last newline is ignored). */
export function parseEvents(text: string): ChangeEvent[] {
  const end = text.lastIndexOf('\n');
  if (end < 0) return [];
  const events: ChangeEvent[] = [];
  for (const raw of text.slice(0, end).split('\n')) {
    if (raw.trim() === '') continue;
    try {
      const value: unknown = JSON.parse(raw);
      if (isEvent(value)) events.push(value);
    } catch {
      // a torn or foreign line: skipped
    }
  }
  return events;
}

/** The shared JSONL inbox (spec §7.3). Appends and rotation are done by the leader only, one after the other (never concurrently). */
export class Inbox {
  constructor(readonly file: string) {}

  async readAll(): Promise<ChangeEvent[]> {
    try {
      return parseEvents(await readFile(this.file, 'utf8'));
    } catch (err) {
      if (hasErrorCode(err, 'ENOENT')) return [];
      throw err;
    }
  }

  /** A crash mid-append leaves a torn last line: end it so the next append starts clean. */
  async repairTail(): Promise<void> {
    let text: string;
    try {
      text = await readFile(this.file, 'utf8');
    } catch (err) {
      if (hasErrorCode(err, 'ENOENT')) return;
      throw err;
    }
    if (text !== '' && !text.endsWith('\n')) await appendFile(this.file, '\n');
  }

  async append(event: ChangeEvent): Promise<void> {
    await mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const handle = await open(this.file, 'a', 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(event)}\n`);
    } finally {
      await handle.close();
    }
  }

  /** Over 1 000 lines: keep the newest 500 and unread events younger than 30 days. */
  async rotateIfNeeded(isUnread: (e: ChangeEvent) => boolean, now: Date): Promise<boolean> {
    let text: string;
    try {
      text = await readFile(this.file, 'utf8');
    } catch (err) {
      if (hasErrorCode(err, 'ENOENT')) return false;
      throw err;
    }
    const lines = text.split('\n').filter((l) => l.trim() !== '').length;
    if (lines <= ROTATE_AT_LINES) return false;
    const events = parseEvents(text);
    const raw = text.split('\n');
    if (raw[raw.length - 1] === '') raw.pop();
    const needsRepair = raw.length !== events.length;
    const newest = new Set(events.slice(-KEEP_NEWEST).map((e) => e.seq));
    const keep = events.filter(
      (e) =>
        newest.has(e.seq) || (isUnread(e) && now.getTime() - Date.parse(e.time) < UNREAD_KEEP_MS),
    );
    // Many retained (unread) events: do not rewrite the whole file on every tick.
    if (!needsRepair && events.length - keep.length < MIN_ROTATE_DROP) return false;
    const tmp = path.join(
      path.dirname(this.file),
      `.${path.basename(this.file)}.${randomUUID()}.tmp`,
    );
    const handle = await open(tmp, 'wx', 0o600);
    try {
      await handle.writeFile(keep.map((e) => `${JSON.stringify(e)}\n`).join(''));
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await renameReplacing(tmp, this.file);
    } catch (err) {
      await rm(tmp, { force: true });
      throw err;
    }
    return true;
  }
}

/** The leader's single writer: seq counter in memory, dedupe over the last 500 ids. */
export class InboxWriter {
  private seq = 0;
  private readonly recent: string[] = [];
  private readonly recentSet = new Set<string>();

  constructor(private readonly inbox: Inbox) {}

  get lastSeq(): number {
    return this.seq;
  }

  /**
   * Called once when the lease is acquired. `floorSeq` (max of read.json `readSeq` and
   * `pushedSeq`) keeps a deleted or truncated inbox from reusing seqs already seen.
   */
  async init(floorSeq = 0): Promise<void> {
    await sweepStaleTemps(path.dirname(this.inbox.file));
    await this.inbox.repairTail();
    const events = await this.inbox.readAll();
    this.seq = events.reduce((max, e) => Math.max(max, e.seq), Math.max(0, floorSeq));
    this.recent.length = 0;
    this.recentSet.clear();
    for (const e of events.slice(-DEDUPE_WINDOW)) this.remember(e.id);
  }

  /** Appends with the next seq unless the id is recent; returns the stored event or null. */
  async append(draft: EventDraft): Promise<ChangeEvent | null> {
    if (this.recentSet.has(draft.id)) return null;
    const event: ChangeEvent = { ...draft, seq: this.seq + 1 };
    await this.inbox.append(event);
    this.seq = event.seq;
    this.remember(event.id);
    return event;
  }

  private remember(id: string): void {
    this.recent.push(id);
    this.recentSet.add(id);
    while (this.recent.length > DEDUPE_WINDOW) {
      const old = this.recent.shift();
      if (old !== undefined && !this.recent.includes(old)) this.recentSet.delete(old);
    }
  }
}

/** File access of the tailer (injectable for race tests). */
export interface TailerFs {
  open: (file: string, flags: string) => Promise<FileHandle>;
}

/** Follows the inbox by byte offset (spec §7.3); used by every process. */
export class InboxTailer {
  private offset = 0;
  private ino: number | null = null;
  private partial: Buffer = Buffer.alloc(0);
  private lastSeq = 0;

  private readonly openFile: TailerFs['open'];

  constructor(
    private readonly file: string,
    fs: Partial<TailerFs> = {},
  ) {
    this.openFile = fs.open ?? ((f: string, flags: string): Promise<FileHandle> => open(f, flags));
  }

  /** Highest seq returned so far. */
  get seenSeq(): number {
    return this.lastSeq;
  }

  async poll(): Promise<ChangeEvent[]> {
    // Open first and stat the handle: inode, size and bytes all come from the same file
    // even when the leader rotates (renames over) the inbox in between.
    let handle: FileHandle;
    try {
      handle = await this.openFile(this.file, 'r');
    } catch (err) {
      if (hasErrorCode(err, 'ENOENT')) {
        this.reset();
        return [];
      }
      throw err;
    }
    let bytesRead: number;
    let buf: Buffer;
    try {
      const info = await handle.stat();
      if (this.ino !== null && (info.ino !== this.ino || info.size < this.offset)) this.reset();
      this.ino = info.ino;
      if (info.size <= this.offset) return [];
      const length = info.size - this.offset;
      buf = Buffer.alloc(length);
      ({ bytesRead } = await handle.read(buf, 0, length, this.offset));
    } finally {
      await handle.close();
    }
    this.offset += bytesRead;
    const data = Buffer.concat([this.partial, buf.subarray(0, bytesRead)]);
    const nl = data.lastIndexOf(0x0a);
    if (nl < 0) {
      this.partial = data;
      return [];
    }
    this.partial = Buffer.from(data.subarray(nl + 1));
    const events = parseEvents(data.subarray(0, nl + 1).toString('utf8')).filter(
      (e) => e.seq > this.lastSeq,
    );
    for (const e of events) this.lastSeq = Math.max(this.lastSeq, e.seq);
    return events;
  }

  private reset(): void {
    this.offset = 0;
    this.ino = null;
    this.partial = Buffer.alloc(0);
  }
}
