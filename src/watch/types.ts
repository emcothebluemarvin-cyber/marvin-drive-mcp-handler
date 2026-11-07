/** Provider-neutral shapes of the Drive watch pipeline (spec §3.1, §5.3, §7). */

export type Kind = 'doc' | 'sheet' | 'slides' | 'folder' | 'other';

export function isNative(kind: Kind): boolean {
  return kind === 'doc' || kind === 'sheet' || kind === 'slides';
}

export interface Modifier {
  name: string | null;
  email: string | null;
  me: boolean;
}

export interface RawFile {
  name: string;
  kind: Kind;
  parents: string[];
  trashed: boolean;
  modifiedTime: string;
  createdTime: string;
  version: string | null;
  md5: string | null;
  size: number | null;
  modifier: Modifier | null;
}

export interface RawChange {
  fileId: string;
  /** API change time (informational only; windows use local observation time). */
  time: string;
  /** Deleted or access lost: `file` is null. */
  removed: boolean;
  file: RawFile | null;
}

export interface WatchEntry {
  id: string;
  name: string;
  kind: Kind;
  folder: boolean;
  addedAt: string;
  inaccessible?: true;
}

/** Last seen state of a relevant file (spec §5.3, plus kind/size/via). */
export interface KnownFile {
  name: string;
  kind: Kind;
  parents: string[];
  trashed: boolean;
  modifiedTime: string;
  version: string | null;
  md5: string | null;
  size: number | null;
  /** Ids of the watch entries that covered the file when it was last seen. */
  via: string[];
}

export type PendingFlag =
  | 'added'
  | 'edited'
  | 'first-seen'
  | 'renamed'
  | 'moved'
  | 'trashed'
  | 'restored'
  | 'removed'
  | 'moved-out';

export interface PendingItem {
  fileId: string;
  /** Local observation times (ISO) — the coalescing windows use these. */
  firstSeen: string;
  lastSeen: string;
  modifiers: Modifier[];
  flags: PendingFlag[];
  /** Known state before the first pending change; null when the file was not known. */
  before: KnownFile | null;
  /** Latest state; null after `removed`. */
  after: KnownFile | null;
}

export interface Backoff {
  failures: number;
  until: string;
  /** A `watch-paused` event was emitted (reauth); cleared by the next successful poll. */
  paused: boolean;
}

export interface AccountState {
  entries: WatchEntry[];
  cursor: string | null;
  known: Record<string, KnownFile>;
  pending: Record<string, PendingItem>;
  lastCommentCheck: Record<string, string>;
  backoff: Backoff | null;
  lastPollAt: string | null;
}

export function emptyState(): AccountState {
  return {
    entries: [],
    cursor: null,
    known: {},
    pending: {},
    lastCommentCheck: {},
    backoff: null,
    lastPollAt: null,
  };
}

export interface SheetSnapshot {
  title: string;
  rows: string[][];
}

export type Snapshot = { type: 'text'; text: string } | { type: 'sheet'; sheets: SheetSnapshot[] };

export interface StoredSnapshot {
  takenAt: string;
  snapshot: Snapshot;
}

export interface ReplyInfo {
  author: Modifier;
  content: string;
  createdTime: string;
}

export interface CommentInfo {
  id: string;
  author: Modifier;
  content: string;
  createdTime: string;
  modifiedTime: string;
  resolved: boolean;
  replies: ReplyInfo[];
}

/** A new comment or reply by someone else, as stored in an event (sanitized). */
export interface CommentNote {
  type: 'comment' | 'reply';
  commentId: string;
  author: Modifier;
  content: string;
  time: string;
}

export type EventKind =
  | 'edited'
  | 'added'
  | 'renamed'
  | 'moved'
  | 'trashed'
  | 'restored'
  | 'removed'
  | 'moved-out'
  | 'commented'
  | 'gap'
  | 'watch-paused';

export interface ChangeEvent {
  seq: number;
  /** `<email>:<fileId>:<lastSeen>`, or `<email>:<kind>:<time>` for gap / watch-paused. */
  id: string;
  account: string;
  kind: EventKind;
  flags: PendingFlag[];
  fileId: string | null;
  name: string | null;
  previousName: string | null;
  fileKind: Kind | null;
  time: string;
  firstSeen: string;
  modifiers: Modifier[];
  own: boolean;
  alsoByYou: boolean;
  diff: string | null;
  note: string | null;
  comments: CommentNote[];
  untrusted: boolean;
}

export type EventDraft = Omit<ChangeEvent, 'seq'>;

export type DeliveryMode = 'hook' | 'channel';

export interface ReadState {
  readSeq: number;
  readIds: string[];
  pushedSeq: number;
}

export const bySeq = (a: ChangeEvent, b: ChangeEvent): number => a.seq - b.seq;
