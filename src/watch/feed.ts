import type { CommentInfo, Kind, RawChange, RawFile, Snapshot } from './types.js';

/** Provider seam for change detection (spec §3.1). One instance per account. */
export interface ChangeFeed {
  /** A fresh cursor ("now"). */
  start(): Promise<string>;
  /** Changes since `cursor` and the next cursor. Throws InvalidCursorError for a dead cursor. */
  poll(cursor: string): Promise<{ changes: RawChange[]; next: string }>;
  /** Parent ids of a folder or file; null when it is not accessible. */
  parentsOf(id: string): Promise<string[] | null>;
  /** Metadata of one file (the access check of `drive_watch add`). */
  file(id: string): Promise<RawFile>;
}

/** Provider seam for content: text/cell snapshots and comments. One instance per account. */
export interface ContentSnapshotter {
  snapshot(fileId: string, kind: Kind): Promise<Snapshot | { tooLarge: true }>;
  commentsSince(fileId: string, since: string): Promise<CommentInfo[]>;
}

export interface WatchAccount {
  email: string;
  alias: string;
}

/** What the watch pipeline needs from a provider (Google now, OneDrive later). */
export interface WatchProvider {
  resolveAccount(ref: string | undefined): Promise<WatchAccount>;
  feed(email: string): ChangeFeed;
  snapshotter(email: string): ContentSnapshotter;
}

/** The change cursor is no longer valid: restart from `start()` and report a gap (spec §5.2). */
export class InvalidCursorError extends Error {
  constructor(options?: ErrorOptions) {
    super('Change cursor is no longer valid', options);
    this.name = 'InvalidCursorError';
  }
}
