import { ReauthRequiredError } from '../errors.js';
import type { Logger } from '../logger.js';
import { readyToRelease } from './coalesce.js';
import { enrich } from './enrich.js';
import { InvalidCursorError, type ChangeFeed, type WatchProvider } from './feed.js';
import type { Inbox, InboxWriter } from './inbox.js';
import { Membership } from './membership.js';
import { isUnread } from './read-state.js';
import { applyChange, type Tracking } from './relevance.js';
import type { AccountState, EventDraft, RawChange, WatchEntry } from './types.js';
import type { WatchStore } from './watch-store.js';

/** Spec §5.2: per-account backoff up to 5 min. */
export const BASE_BACKOFF_MS = 15_000;
export const MAX_BACKOFF_MS = 5 * 60_000;

export interface PollerDeps {
  store: WatchStore;
  provider: WatchProvider;
  writer: InboxWriter;
  inbox: Inbox;
  now: () => Date;
  log: Logger;
  quietMs?: number;
  maxWaitMs?: number;
}

interface Fetched {
  changes: RawChange[];
  next: string;
  covering: WatchEntry[][];
}

export function backoffDelay(failures: number): number {
  return Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** Math.max(0, failures - 1));
}

/** `gap` / `watch-paused` events (resolved ambiguity 14: not third-party content). */
export function systemEvent(
  account: string,
  kind: 'gap' | 'watch-paused',
  time: string,
  note: string,
): EventDraft {
  return {
    id: `${account}:${kind}:${time}`,
    account,
    kind,
    flags: [],
    fileId: null,
    name: null,
    previousName: null,
    fileKind: null,
    time,
    firstSeen: time,
    modifiers: [],
    own: false,
    alsoByYou: false,
    diff: null,
    note,
    comments: [],
    untrusted: false,
  };
}

/** The lease holder's work (spec §5.2, §6, §7.3). */
export class Poller {
  private readonly members = new Map<string, Membership>();

  constructor(private readonly deps: PollerDeps) {}

  /** One leader pass: poll and release every account with entries, then rotate the inbox. */
  async runOnce(): Promise<void> {
    for (const email of await this.deps.store.accounts()) {
      let state: AccountState;
      try {
        state = await this.deps.store.load(email);
      } catch (err) {
        this.deps.log.warn('Skipping unreadable watch state', { account: email, error: err });
        continue;
      }
      if (state.entries.length === 0 || state.cursor === null) continue;
      // While backing off (outage, expired session) quiet items wait instead of being
      // released without content. A failing account never stops the others (spec §9).
      if (this.backingOff(state)) continue;
      try {
        await this.pollAccount(email, state.cursor, state.entries);
      } catch (err) {
        this.deps.log.error('Drive watch poll failed', { account: email, error: err });
        continue;
      }
      try {
        await this.releaseAccount(email);
      } catch (err) {
        this.deps.log.error('Releasing Drive changes failed', { account: email, error: err });
      }
    }
    const rs = await this.deps.store.loadRead();
    await this.deps.inbox.rotateIfNeeded((e) => isUnread(e, rs), this.deps.now());
  }

  /** Quiet items: enrich (network) → append → remove under the lock if unchanged (spec §6, §7.3). */
  private async releaseAccount(email: string): Promise<void> {
    const state = await this.deps.store.load(email);
    const ready = readyToRelease(
      state.pending,
      this.deps.now(),
      this.deps.quietMs,
      this.deps.maxWaitMs,
    );
    if (ready.length === 0) return;
    const snapshotter = this.deps.provider.snapshotter(email);
    for (const item of ready) {
      const previous = await this.deps.store.loadSnapshot(email, item.fileId);
      const result = await enrich({
        item,
        account: email,
        snapshotter,
        previous,
        since: state.lastCommentCheck[item.fileId] ?? item.firstSeen,
        now: this.deps.now(),
        log: this.deps.log,
      });
      if (result.event) await this.deps.writer.append(result.event);
      await this.deps.store.withLock(async () => {
        const s = await this.deps.store.load(email);
        const current = s.pending[item.fileId];
        if (current && current.lastSeen === item.lastSeen) delete s.pending[item.fileId];
        const tracked = s.known[item.fileId] !== undefined;
        if (!tracked || result.snapshot === 'drop') {
          await this.deps.store.removeSnapshot(email, item.fileId);
        } else if (result.snapshot !== 'keep') {
          await this.deps.store.saveSnapshot(email, item.fileId, result.snapshot);
        }
        if (!tracked) delete s.lastCommentCheck[item.fileId];
        else if (result.commentCheck) s.lastCommentCheck[item.fileId] = result.commentCheck;
        await this.deps.store.save(email, s);
      });
    }
  }

  private backingOff(state: AccountState): boolean {
    return state.backoff !== null && Date.parse(state.backoff.until) > this.deps.now().getTime();
  }

  private membership(email: string, feed: ChangeFeed): Membership {
    let m = this.members.get(email);
    if (!m) {
      m = new Membership((id) => feed.parentsOf(id));
      this.members.set(email, m);
    }
    return m;
  }

  /** Network part: batch + membership. Null after a handled failure. */
  private async fetch(
    email: string,
    cursor: string,
    entries: readonly WatchEntry[],
    feed: ChangeFeed,
  ): Promise<Fetched | null> {
    try {
      const batch = await feed.poll(cursor);
      const members = this.membership(email, feed);
      for (const c of batch.changes) {
        if (c.file === null) members.noteFolder(c.fileId, null);
        else if (c.file.kind === 'folder') members.noteFolder(c.fileId, c.file.parents);
      }
      const covering: WatchEntry[][] = [];
      for (const c of batch.changes) {
        covering.push(
          c.file === null ? [] : await members.covering(c.fileId, c.file.parents, entries),
        );
      }
      return { changes: batch.changes, next: batch.next, covering };
    } catch (err) {
      await this.failed(email, cursor, feed, err);
      return null;
    }
  }

  private async pollAccount(
    email: string,
    cursor: string,
    entries: readonly WatchEntry[],
  ): Promise<void> {
    const feed = this.deps.provider.feed(email);
    const fetched = await this.fetch(email, cursor, entries, feed);
    if (fetched === null) return;
    const observed = this.deps.now().toISOString();
    await this.deps.store.withLock(async () => {
      const state = await this.deps.store.load(email);
      if (state.cursor !== cursor) {
        this.deps.log.info('Watch list changed during a poll; discarding the batch', {
          account: email,
        });
        return;
      }
      const live = new Map(state.entries.map((e) => [e.id, e]));
      let t: Tracking = { known: state.known, pending: state.pending };
      fetched.changes.forEach((change, i) => {
        const covering = (fetched.covering[i] ?? []).flatMap((e) => {
          const current = live.get(e.id);
          return current ? [current] : [];
        });
        t = applyChange(t, { change, covering, now: observed });
        const entry = live.get(change.fileId);
        if (entry && change.removed) entry.inaccessible = true;
        else if (entry && !change.removed) delete entry.inaccessible;
      });
      state.known = t.known;
      state.pending = t.pending;
      state.cursor = fetched.next;
      state.backoff = null;
      state.lastPollAt = observed;
      await this.deps.store.save(email, state);
    });
  }

  private async failed(
    email: string,
    cursor: string,
    feed: ChangeFeed,
    err: unknown,
  ): Promise<void> {
    const now = this.deps.now();
    const time = now.toISOString();
    if (err instanceof InvalidCursorError) {
      let fresh: string;
      try {
        fresh = await feed.start();
      } catch (startErr) {
        await this.failed(email, cursor, feed, startErr);
        return;
      }
      await this.deps.store.withLock(async () => {
        const state = await this.deps.store.load(email);
        if (state.cursor !== cursor) return;
        const from = state.lastPollAt ?? state.entries.map((e) => e.addedAt).sort()[0] ?? time;
        await this.deps.writer.append(
          systemEvent(email, 'gap', time, `changes between ${from} and ${time} may be missing`),
        );
        state.cursor = fresh;
        state.lastPollAt = time;
        state.backoff = null;
        await this.deps.store.save(email, state);
      });
      return;
    }
    const reauth = err instanceof ReauthRequiredError;
    if (!reauth)
      this.deps.log.warn('Drive watch poll failed; backing off', { account: email, error: err });
    await this.deps.store.withLock(async () => {
      const state = await this.deps.store.load(email);
      if (state.cursor !== cursor) return;
      const failures = (state.backoff?.failures ?? 0) + 1;
      const wasPaused = state.backoff?.paused ?? false;
      if (reauth && !wasPaused) {
        await this.deps.writer.append(
          systemEvent(
            email,
            'watch-paused',
            time,
            `Drive watch paused for ${email}: sign in again with marvin-drive auth login ${email}`,
          ),
        );
      }
      const delay = reauth ? MAX_BACKOFF_MS : backoffDelay(failures);
      state.backoff = {
        failures,
        until: new Date(now.getTime() + delay).toISOString(),
        paused: reauth || wasPaused,
      };
      await this.deps.store.save(email, state);
    });
  }
}
