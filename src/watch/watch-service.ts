import { watch as watchDir, type FSWatcher } from 'node:fs';
import path from 'node:path';
import { ValidationError } from '../errors.js';
import { logger as defaultLogger, type Logger } from '../logger.js';
import { readChanges, type ChangesInput, type ChangesResult } from './changes.js';
import { Delivery, type PushFn } from './delivery.js';
import type { WatchProvider } from './feed.js';
import { INBOX_FILE, Inbox, InboxTailer, InboxWriter } from './inbox.js';
import { PollerLease } from './lease.js';
import { LeaseLostError, Poller } from './poller.js';
import type { DeliveryMode } from './types.js';
import {
  addWatch,
  listWatches,
  removeWatch,
  type WatchAddResult,
  type WatchListDeps,
  type WatchListResult,
  type WatchRemoveResult,
} from './watch-list.js';
import type { WatchStore } from './watch-store.js';

export const DEFAULT_INTERVAL_S = 30;
export const MIN_INTERVAL_S = 15;

/** `MARVIN_WATCH_POLL_SECONDS` (default 30, minimum 15) in ms. */
export function pollIntervalMs(env: NodeJS.ProcessEnv): number {
  const raw = env.MARVIN_WATCH_POLL_SECONDS;
  const seconds = raw ? Number(raw) : NaN;
  if (!Number.isFinite(seconds)) return DEFAULT_INTERVAL_S * 1000;
  return Math.max(MIN_INTERVAL_S, seconds) * 1000;
}

export interface WatchInput {
  action: 'add' | 'remove' | 'list';
  fileId?: string;
  account?: string;
}

export type WatchResult = WatchAddResult | WatchRemoveResult | WatchListResult;

/** What the MCP tools need. */
export interface WatchApi {
  watch(input: WatchInput): Promise<WatchResult>;
  changes(input: ChangesInput): Promise<ChangesResult>;
}

export interface WatchServiceDeps {
  store: WatchStore;
  provider: WatchProvider;
  intervalMs: number;
  now?: () => Date;
  logger?: Logger;
  lease?: PollerLease;
  quietMs?: number;
  maxWaitMs?: number;
}

/** Drive watch for one process: tools backend, local tick, lease and delivery (spec §3, §5.2). */
export class WatchService implements WatchApi {
  readonly inbox: Inbox;
  private readonly lease: PollerLease;
  private readonly now: () => Date;
  private readonly log: Logger;
  private poller: Poller | null = null;
  private delivery: Delivery | null = null;
  private timer: NodeJS.Timeout | null = null;
  private watcher: FSWatcher | null = null;
  private ticking: Promise<void> | null = null;

  constructor(private readonly deps: WatchServiceDeps) {
    this.now = deps.now ?? ((): Date => new Date());
    this.log = deps.logger ?? defaultLogger;
    this.inbox = new Inbox(path.join(deps.store.dir, INBOX_FILE));
    this.lease =
      deps.lease ??
      new PollerLease({
        dir: deps.store.dir,
        intervalMs: deps.intervalMs,
        now: this.now,
        logger: this.log,
      });
  }

  get isLeader(): boolean {
    return this.lease.held;
  }

  private listDeps(): WatchListDeps {
    return { store: this.deps.store, provider: this.deps.provider, now: this.now, log: this.log };
  }

  async watch(input: WatchInput): Promise<WatchResult> {
    const account = input.account === undefined ? {} : { account: input.account };
    if (input.action === 'list') return listWatches(this.listDeps(), account);
    if (input.fileId === undefined) {
      throw new ValidationError(`fileId is required for drive_watch ${input.action}`);
    }
    const target = { fileId: input.fileId, ...account };
    return input.action === 'add'
      ? addWatch(this.listDeps(), target)
      : removeWatch(this.listDeps(), target);
  }

  changes(input: ChangesInput): Promise<ChangesResult> {
    return readChanges({ store: this.deps.store, inbox: this.inbox }, input);
  }

  getDelivery(): Promise<DeliveryMode> {
    return this.deps.store.loadDelivery();
  }

  async setDelivery(mode: DeliveryMode): Promise<void> {
    await this.deps.store.saveDelivery(mode);
  }

  /** Starts delivery (push null: none), the local tick and the inbox trigger; runs one tick. */
  async start(push: PushFn | null, opts: { timers?: boolean } = {}): Promise<void> {
    await this.deps.store.ensureDir();
    if (push) {
      this.delivery = new Delivery({
        store: this.deps.store,
        tailer: new InboxTailer(this.inbox.file),
        push,
        log: this.log,
      });
      try {
        await this.delivery.start();
      } catch (err) {
        // e.g. a corrupt read.json: keep ticking and polling anyway. The inbox was consumed
        // first, so its existing events count as seen (no "while you were away" summary);
        // only when the inbox itself was unreadable does the first drain push its unread events.
        this.log.error('Drive watch delivery could not start', { error: err });
      }
    }
    if (opts.timers ?? true) {
      this.timer = setInterval(() => {
        void this.tick();
      }, this.deps.intervalMs);
      this.timer.unref();
      try {
        this.watcher = watchDir(this.deps.store.dir, () => {
          void this.delivery?.onTick();
        });
        this.watcher.on('error', (err) => {
          this.log.warn('Inbox watcher failed; the local tick still delivers', { error: err });
          this.watcher?.close();
          this.watcher = null;
        });
        this.watcher.unref();
      } catch (err) {
        this.log.warn('Cannot watch the inbox directory; using the local tick only', {
          error: err,
        });
      }
    }
    await this.tick();
  }

  /** One local tick (never overlapping). Public for tests. */
  tick(): Promise<void> {
    if (!this.ticking) {
      this.ticking = this.runTick().finally(() => {
        this.ticking = null;
      });
    }
    return this.ticking;
  }

  private async runTick(): Promise<void> {
    try {
      if (this.lease.held && !(await this.lease.heartbeat())) this.poller = null;
      const active = await this.deps.store.hasEntries();
      if (!this.lease.held && active) await this.lease.tryAcquire();
      if (this.lease.held && !active) await this.lease.release();
      if (!this.lease.held) {
        this.poller = null;
      } else if (this.poller === null) {
        const writer = new InboxWriter(this.inbox);
        // Never reuse a seq already read or pushed (a deleted inbox restarts above it).
        // A corrupt read.json must not stop polling: then the floor is the inbox alone.
        const floor = await this.deps.store.loadRead().then(
          (rs) => Math.max(rs.readSeq, rs.pushedSeq),
          (err: unknown) => {
            this.log.warn('read.json is unreadable; numbering from the inbox', { error: err });
            return 0;
          },
        );
        await writer.init(floor);
        this.poller = new Poller({
          store: this.deps.store,
          provider: this.deps.provider,
          writer,
          inbox: this.inbox,
          now: this.now,
          log: this.log,
          quietMs: this.deps.quietMs,
          maxWaitMs: this.deps.maxWaitMs,
          stillLeader: (): Promise<boolean> => this.lease.verify(),
        });
      }
      if (this.poller) await this.poller.runOnce();
    } catch (err) {
      if (err instanceof LeaseLostError) {
        this.log.warn('Drive watch lease was taken over; another session polls now');
        this.poller = null;
      } else {
        this.log.error('Drive watch tick failed', { error: err });
      }
    }
    await this.delivery?.onTick();
  }

  /** Clean exit (stdin close / SIGINT / SIGTERM): stop timers, finish the tick, release the lease. */
  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.watcher?.close();
    this.watcher = null;
    await this.ticking;
    this.poller = null;
    if (this.lease.held) await this.lease.release();
  }
}
