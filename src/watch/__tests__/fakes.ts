import { AccountNotFoundError, NotFoundError } from '../../errors.js';
import type { WatchApi } from '../watch-service.js';
import type { ChangeFeed, ContentSnapshotter, WatchAccount, WatchProvider } from '../feed.js';
import type {
  ChangeEvent,
  CommentInfo,
  EventDraft,
  KnownFile,
  Modifier,
  PendingItem,
  RawChange,
  RawFile,
  Snapshot,
  WatchEntry,
} from '../types.js';

export const ME: Modifier = { name: 'Emco', email: 'me@example.com', me: true };
export const AYSE: Modifier = { name: 'Ayşe Demir', email: 'ayse@example.com', me: false };
export const BORA: Modifier = { name: 'Bora', email: 'bora@example.com', me: false };

export const ADDED_AT = '2026-11-07T10:00:00.000Z';

export function rawFile(over: Partial<RawFile> = {}): RawFile {
  return {
    name: 'Plan',
    kind: 'doc',
    parents: ['F'],
    trashed: false,
    modifiedTime: '2026-11-07T11:00:00.000Z',
    createdTime: '2026-11-01T00:00:00.000Z',
    version: '5',
    md5: null,
    size: null,
    modifier: AYSE,
    ...over,
  };
}

export function change(fileId: string, file: RawFile | null): RawChange {
  return { fileId, time: '2026-11-07T11:00:01.000Z', removed: file === null, file };
}

export function folderEntry(over: Partial<WatchEntry> = {}): WatchEntry {
  return { id: 'F', name: 'Team', kind: 'folder', folder: true, addedAt: ADDED_AT, ...over };
}

export function fileEntry(over: Partial<WatchEntry> = {}): WatchEntry {
  return { id: 'D', name: 'Plan', kind: 'doc', folder: false, addedAt: ADDED_AT, ...over };
}

export function makeDraft(over: Partial<EventDraft> = {}): EventDraft {
  return {
    id: 'me@example.com:D:2026-11-07T11:00:00.000Z',
    account: 'me@example.com',
    kind: 'edited',
    flags: ['edited'],
    fileId: 'D',
    name: 'Plan',
    previousName: null,
    fileKind: 'doc',
    time: '2026-11-07T11:00:00.000Z',
    firstSeen: '2026-11-07T11:00:00.000Z',
    modifiers: [AYSE],
    own: false,
    alsoByYou: false,
    diff: '- a\n+ b',
    note: null,
    comments: [],
    untrusted: true,
    ...over,
  };
}

/** An inbox event; the id defaults to one derived from `seq`. */
export function makeEvent(over: Partial<ChangeEvent> = {}): ChangeEvent {
  const seq = over.seq ?? 1;
  return { ...makeDraft({ id: `me@example.com:D:${seq}` }), seq, ...over };
}

export const T1 = '2026-11-07T11:00:00.000Z';
export const T2 = '2026-11-07T11:05:00.000Z';

export function knownFile(over: Partial<KnownFile> = {}): KnownFile {
  return {
    name: 'Plan',
    kind: 'doc',
    parents: ['F'],
    trashed: false,
    modifiedTime: T1,
    version: '5',
    md5: null,
    size: null,
    via: ['D'],
    ...over,
  };
}

export function pendingItem(over: Partial<PendingItem> = {}): PendingItem {
  return {
    fileId: 'D',
    firstSeen: T1,
    lastSeen: T1,
    modifiers: [AYSE],
    flags: ['edited'],
    before: knownFile(),
    after: knownFile({ modifiedTime: T2 }),
    ...over,
  };
}

export const textSnap = (text: string): Snapshot => ({ type: 'text', text });

/** Snapshots and comments by file id; an Error value makes snapshot() throw. */
export class MemorySnapshotter implements ContentSnapshotter {
  readonly content = new Map<string, Snapshot | { tooLarge: true } | Error>();
  readonly comments = new Map<string, CommentInfo[]>();
  readonly calls: string[] = [];

  async snapshot(fileId: string): Promise<Snapshot | { tooLarge: true }> {
    this.calls.push(`snapshot:${fileId}`);
    const value = this.content.get(fileId);
    if (value === undefined) throw new Error(`no content for ${fileId}`);
    if (value instanceof Error) throw value;
    return value;
  }

  async commentsSince(fileId: string, since: string): Promise<CommentInfo[]> {
    this.calls.push(`comments:${fileId}`);
    return (this.comments.get(fileId) ?? []).filter((c) => c.modifiedTime >= since);
  }
}

export function comment(over: Partial<CommentInfo> = {}): CommentInfo {
  return {
    id: 'c1',
    author: AYSE,
    content: 'Why 135?',
    createdTime: T2,
    modifiedTime: T2,
    resolved: false,
    replies: [],
    ...over,
  };
}

/** A Drive change log in memory; the cursor is the log index. */
export class MemoryFeed implements ChangeFeed {
  readonly files = new Map<string, RawFile>();
  readonly log: RawChange[] = [];
  readonly calls: string[] = [];
  /** Thrown by the next poll() calls, in order. */
  readonly failures: Error[] = [];

  async start(): Promise<string> {
    this.calls.push('start');
    return String(this.log.length);
  }

  async poll(cursor: string): Promise<{ changes: RawChange[]; next: string }> {
    this.calls.push(`poll:${cursor}`);
    const failure = this.failures.shift();
    if (failure) throw failure;
    return { changes: this.log.slice(Number(cursor)), next: String(this.log.length) };
  }

  async parentsOf(id: string): Promise<string[] | null> {
    this.calls.push(`parents:${id}`);
    return this.files.get(id)?.parents ?? null;
  }

  async file(id: string): Promise<RawFile> {
    const f = this.files.get(id);
    if (!f) throw new NotFoundError(id);
    return f;
  }

  /** A file that already existed (no change recorded). */
  seed(id: string, over: Partial<RawFile> = {}): RawFile {
    const f = { ...rawFile(), ...over };
    this.files.set(id, f);
    return f;
  }

  /** Creates or updates a file and records the change. */
  put(id: string, over: Partial<RawFile> = {}): RawFile {
    const f = { ...(this.files.get(id) ?? rawFile()), ...over };
    this.files.set(id, f);
    this.log.push({ fileId: id, time: f.modifiedTime, removed: false, file: f });
    return f;
  }

  remove(id: string): void {
    this.files.delete(id);
    this.log.push({ fileId: id, time: '', removed: true, file: null });
  }
}

export const ACCOUNT: WatchAccount = { email: 'me@example.com', alias: 'me' };

export function memoryProvider(
  feed: MemoryFeed,
  snapshotter: MemorySnapshotter,
  account: WatchAccount = ACCOUNT,
): WatchProvider {
  return {
    resolveAccount: async (ref) => {
      if (ref !== undefined && ref !== account.alias && ref !== account.email) {
        throw new AccountNotFoundError(`Unknown account "${ref}"`);
      }
      return account;
    },
    feed: () => feed,
    snapshotter: () => snapshotter,
  };
}

export function testClock(start = '2026-11-07T11:00:00.000Z'): {
  now: () => Date;
  advance: (ms: number) => void;
} {
  let t = Date.parse(start);
  return {
    now: () => new Date(t),
    advance: (ms) => {
      t += ms;
    },
  };
}

/** A WatchApi that records its inputs (MCP tests). */
export function stubWatchApi(): WatchApi & { calls: unknown[] } {
  const calls: unknown[] = [];
  return {
    calls,
    watch: async (input) => {
      calls.push(input);
      return { action: 'list', watches: [] };
    },
    changes: async (input) => {
      calls.push(input);
      return { events: [], more: 0, unread: 0 };
    },
  };
}
