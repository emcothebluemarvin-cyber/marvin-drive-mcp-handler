import type { Inbox } from './inbox.js';
import { isUnread, readUpdate, updateReadState } from './read-state.js';
import { bySeq, type ChangeEvent } from './types.js';
import type { WatchStore } from './watch-store.js';

export interface ChangesInput {
  unreadOnly?: boolean;
  eventId?: string;
  fileId?: string;
  includeOwn?: boolean;
  limit?: number;
  markRead?: boolean;
}

export interface ChangesResult {
  events: ChangeEvent[];
  /** Matching events not returned (raise `limit` or call again). */
  more: number;
  /** Unread events left after this call. */
  unread: number;
}

export const DEFAULT_LIMIT = 20;

/** drive_changes / `marvin-drive changes` (spec §8.3, read marking §7.4). */
export async function readChanges(
  deps: { store: WatchStore; inbox: Inbox },
  input: ChangesInput,
): Promise<ChangesResult> {
  const all = (await deps.inbox.readAll()).sort(bySeq);
  const rs = await deps.store.loadRead();
  let matches: ChangeEvent[];
  if (input.eventId !== undefined) {
    matches = all.filter((e) => e.id === input.eventId);
  } else {
    matches = all;
    if (input.fileId !== undefined) matches = matches.filter((e) => e.fileId === input.fileId);
    if (!(input.includeOwn ?? false)) matches = matches.filter((e) => !e.own);
    if (input.unreadOnly ?? true) matches = matches.filter((e) => isUnread(e, rs));
  }
  const limit = Math.max(1, Math.floor(input.limit ?? DEFAULT_LIMIT));
  const events = matches.slice(0, limit);
  let after = rs;
  if ((input.markRead ?? true) && events.length > 0) {
    const unfiltered = input.eventId === undefined && input.fileId === undefined;
    after = await updateReadState(deps.store, readUpdate(rs, events, all, unfiltered), all);
  }
  return {
    events,
    more: matches.length - events.length,
    unread: all.filter((e) => isUnread(e, after)).length,
  };
}
