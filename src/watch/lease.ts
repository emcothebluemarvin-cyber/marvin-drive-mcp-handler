import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { FileLockBusyError, acquireExclusive, holdsLock, processAlive } from '../core/file-lock.js';
import { hasErrorCode } from '../errors.js';
import { renameReplacing } from '../files/rename-replacing.js';
import { logger as defaultLogger, type Logger } from '../logger.js';

export const LEASE_FILE = 'poller.lock';
export const HEARTBEAT_FILE = 'poller.heartbeat';

export interface LeaseOptions {
  dir: string;
  intervalMs: number;
  now?: () => Date;
  isAlive?: (pid: number) => boolean;
  host?: string;
  pid?: number;
  logger?: Logger;
}

interface Holder {
  pid?: unknown;
  host?: unknown;
  token?: unknown;
  startedAt?: unknown;
}

/** One poller per machine (spec §7.2). */
export class PollerLease {
  private content: string | null = null;
  private token: string | null = null;
  private releaseLock: (() => Promise<void>) | null = null;
  private readonly now: () => Date;
  private readonly isAlive: (pid: number) => boolean;
  private readonly host: string;
  private readonly pid: number;
  private readonly log: Logger;

  constructor(private readonly opts: LeaseOptions) {
    this.now = opts.now ?? ((): Date => new Date());
    this.isAlive = opts.isAlive ?? processAlive;
    this.host = opts.host ?? os.hostname();
    this.pid = opts.pid ?? process.pid;
    this.log = opts.logger ?? defaultLogger;
  }

  get held(): boolean {
    return this.content !== null;
  }

  private get lockFile(): string {
    return path.join(this.opts.dir, LEASE_FILE);
  }

  private get heartbeatFile(): string {
    return path.join(this.opts.dir, HEARTBEAT_FILE);
  }

  async tryAcquire(): Promise<boolean> {
    if (this.held) return true;
    await mkdir(this.opts.dir, { recursive: true, mode: 0o700 });
    const token = randomUUID();
    const content = JSON.stringify({
      pid: this.pid,
      host: this.host,
      token,
      startedAt: this.now().toISOString(),
    });
    try {
      this.releaseLock = await acquireExclusive(this.lockFile, {
        content: () => content,
        isStale: (raw) => this.isStale(raw),
        busyMessage: 'The Drive watch poller lease is held by another session',
        onBreak: () => this.log.warn('Taking over a stale Drive watch poller lease'),
        onLostRelease: () => this.log.warn('Drive watch lease was taken over; not removing it'),
      });
    } catch (err) {
      if (err instanceof FileLockBusyError) return false;
      throw err;
    }
    this.content = content;
    this.token = token;
    await this.writeHeartbeat();
    return true;
  }

  /** Refreshes the heartbeat; false (and no longer held) when the lease was taken over. */
  async heartbeat(): Promise<boolean> {
    if (this.content === null) return false;
    if (!(await holdsLock(this.lockFile, this.content))) {
      this.forget();
      return false;
    }
    await this.writeHeartbeat();
    return true;
  }

  async release(): Promise<void> {
    const release = this.releaseLock;
    this.forget();
    if (release) await release();
  }

  private forget(): void {
    this.content = null;
    this.token = null;
    this.releaseLock = null;
  }

  private async writeHeartbeat(): Promise<void> {
    const tmp = path.join(this.opts.dir, `.${HEARTBEAT_FILE}.${randomUUID()}.tmp`);
    const handle = await open(tmp, 'wx', 0o600);
    try {
      await handle.writeFile(JSON.stringify({ token: this.token, at: this.now().toISOString() }));
    } finally {
      await handle.close();
    }
    try {
      await renameReplacing(tmp, this.heartbeatFile);
    } catch (err) {
      await rm(tmp, { force: true });
      throw err;
    }
  }

  private async readHeartbeat(): Promise<{ token: unknown; at: number } | null> {
    try {
      const beat = JSON.parse(await readFile(this.heartbeatFile, 'utf8')) as {
        token?: unknown;
        at?: unknown;
      };
      return typeof beat.at === 'string' ? { token: beat.token, at: Date.parse(beat.at) } : null;
    } catch (err) {
      if (hasErrorCode(err, 'ENOENT') || err instanceof SyntaxError) return null;
      throw err;
    }
  }

  private tooOld(ms: number): boolean {
    return Number.isNaN(ms) || this.now().getTime() - ms > 3 * this.opts.intervalMs;
  }

  private async isStale(raw: string): Promise<boolean> {
    let holder: Holder;
    try {
      holder = JSON.parse(raw) as Holder;
    } catch {
      const info = await stat(this.lockFile).catch(() => null);
      return info === null || this.tooOld(info.mtimeMs);
    }
    const beat = await this.readHeartbeat();
    const startedAt = typeof holder.startedAt === 'string' ? Date.parse(holder.startedAt) : NaN;
    const last = beat !== null && beat.token === holder.token ? beat.at : startedAt;
    if (!this.tooOld(last)) return false;
    if (holder.host === this.host && typeof holder.pid === 'number' && this.isAlive(holder.pid)) {
      return false;
    }
    return true;
  }
}
