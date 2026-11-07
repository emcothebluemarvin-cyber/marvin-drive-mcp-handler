import path from 'node:path';
import { FileLockBusyError } from '../core/file-lock.js';
import type { Logger } from '../logger.js';
import { INBOX_FILE, Inbox } from './inbox.js';
import { readUpdate, unreadEvents, updateReadState } from './read-state.js';
import { HOOK_LIMIT, renderEvents } from './render.js';
import { WatchStore } from './watch-store.js';

export const HOOK_LOCK_TIMEOUT_MS = 100;

export interface HookOptions {
  watchDir: string;
  logger?: Logger;
  lockTimeoutMs?: number;
}

/** `changes --hook` (spec §8.3): local files only; the JSON to print, or null. */
export async function runHook(opts: HookOptions): Promise<string | null> {
  const store = new WatchStore({
    dir: opts.watchDir,
    ...(opts.logger ? { logger: opts.logger } : {}),
  });
  if ((await store.loadDelivery()) !== 'hook') return null;
  const all = await new Inbox(path.join(opts.watchDir, INBOX_FILE)).readAll();
  const rs = await store.loadRead();
  const unread = unreadEvents(all, rs);
  if (unread.length === 0) return null;
  const { text, shown } = renderEvents(unread, HOOK_LIMIT);
  try {
    await updateReadState(
      store,
      readUpdate(rs, shown, all, true),
      all,
      opts.lockTimeoutMs ?? HOOK_LOCK_TIMEOUT_MS,
    );
  } catch (err) {
    // Busy lock: print anyway; these events may show once more on the next prompt.
    if (!(err instanceof FileLockBusyError)) throw err;
  }
  return JSON.stringify({
    hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: text },
  });
}
