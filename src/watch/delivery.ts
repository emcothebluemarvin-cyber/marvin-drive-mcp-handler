import type { Logger } from '../logger.js';
import type { InboxTailer } from './inbox.js';
import { isUnread, updateReadState } from './read-state.js';
import { renderEvent, renderSummary } from './render.js';
import type { ChangeEvent, DeliveryMode } from './types.js';
import type { WatchStore } from './watch-store.js';

/** Channel meta: keys `[a-z_]` only (spec §8.2). */
export type ChannelMeta = Record<string, string>;
export type PushFn = (content: string, meta: ChannelMeta) => Promise<void>;

export interface DeliveryDeps {
  store: WatchStore;
  tailer: InboxTailer;
  push: PushFn;
  log: Logger;
}

const maxSeq = (events: readonly ChangeEvent[]): number =>
  events.reduce((max, e) => Math.max(max, e.seq), 0);

/** Per-session delivery of inbox events over the channel (spec §8.1, §8.2). */
export class Delivery {
  private lastPushedSeq = 0;
  /** Tailed events not yet handled (kept when a local read fails, retried next drain). */
  private backlog: ChangeEvent[] = [];
  private chain: Promise<void> = Promise.resolve();
  /** The last config.json error warned about (one warning per distinct error). */
  private configError: string | null = null;

  constructor(private readonly deps: DeliveryDeps) {}

  /** The delivery mode; an invalid config.json counts as `hook` (the default). */
  private async mode(): Promise<DeliveryMode> {
    try {
      const mode = await this.deps.store.loadDelivery();
      this.configError = null;
      return mode;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message !== this.configError) {
        this.configError = message;
        this.deps.log.warn('Drive watch config.json is unreadable; using hook delivery', {
          error: err,
        });
      }
      return 'hook';
    }
  }

  /** Consumes the current inbox; in channel mode pushes the "while you were away" summary. */
  async start(): Promise<void> {
    const existing = await this.deps.tailer.poll();
    this.lastPushedSeq = maxSeq(existing);
    if ((await this.mode()) !== 'channel') return;
    const rs = await this.deps.store.loadRead();
    const away = existing.filter((e) => isUnread(e, rs) && e.seq > rs.pushedSeq);
    const last = away[away.length - 1];
    if (last === undefined) return;
    await this.deps.push(renderSummary(away), {
      account: '',
      file_id: '',
      event_id: last.id,
      kind: 'summary',
    });
    await updateReadState(this.deps.store, { pushedSeq: maxSeq(away) }, null);
  }

  /** New inbox events → one push each (channel mode). Serialized; failures are logged. */
  onTick(): Promise<void> {
    this.chain = this.chain
      .then(() => this.drain())
      .catch((err: unknown) => {
        this.deps.log.warn('Drive change delivery failed', { error: err });
      });
    return this.chain;
  }

  private async drain(): Promise<void> {
    // The tailer's offset has moved on: keep what it returned until the reads below succeed.
    this.backlog.push(...(await this.deps.tailer.poll()));
    // A rescan (rotation) after a failed drain may return a kept event again: one per seq.
    const unique = new Map(this.backlog.map((e) => [e.seq, e]));
    this.backlog = [...unique.values()].sort((a, b) => a.seq - b.seq);
    const fresh = this.backlog.filter((e) => e.seq > this.lastPushedSeq);
    if (fresh.length === 0) {
      this.backlog = [];
      return;
    }
    const mode = await this.mode();
    const rs = await this.deps.store.loadRead();
    this.backlog = [];
    this.lastPushedSeq = maxSeq(fresh);
    if (mode !== 'channel') return;
    const unread = fresh.filter((e) => isUnread(e, rs));
    for (const e of unread) {
      await this.deps.push(renderEvent(e), {
        account: e.account,
        file_id: e.fileId ?? '',
        event_id: e.id,
        kind: e.kind,
      });
    }
    if (unread.length > 0) {
      await updateReadState(this.deps.store, { pushedSeq: maxSeq(unread) }, null);
    }
  }
}
