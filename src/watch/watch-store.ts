import { randomUUID } from 'node:crypto';
import { chmod, mkdir, open, readFile, readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import {
  FileLockBusyError,
  acquireExclusive,
  pidLockIsStale,
  processAlive,
} from '../core/file-lock.js';
import { ValidationError, hasErrorCode } from '../errors.js';
import { renameReplacing } from '../files/rename-replacing.js';
import { logger as defaultLogger, type Logger } from '../logger.js';
import { sweepStaleTemps } from './temp-sweep.js';
import {
  UNKNOWN_READ_SEQ,
  emptyState,
  type AccountState,
  type DeliveryMode,
  type ReadState,
  type StoredSnapshot,
} from './types.js';

const kindSchema = z.enum(['doc', 'sheet', 'slides', 'folder', 'other']);
const modifierSchema = z.object({
  name: z.string().nullable(),
  email: z.string().nullable(),
  me: z.boolean(),
});
const knownSchema = z.object({
  name: z.string(),
  kind: kindSchema,
  parents: z.array(z.string()),
  trashed: z.boolean(),
  modifiedTime: z.string(),
  version: z.string().nullable(),
  md5: z.string().nullable(),
  size: z.number().nullable(),
  via: z.array(z.string()),
});
const flagSchema = z.enum([
  'added',
  'edited',
  'first-seen',
  'renamed',
  'moved',
  'trashed',
  'restored',
  'removed',
  'moved-out',
]);
const pendingSchema = z.object({
  fileId: z.string(),
  firstSeen: z.string(),
  lastSeen: z.string(),
  modifiers: z.array(modifierSchema),
  flags: z.array(flagSchema),
  before: knownSchema.nullable(),
  after: knownSchema.nullable(),
});
const entrySchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  kind: kindSchema,
  folder: z.boolean(),
  addedAt: z.string(),
  inaccessible: z.literal(true).optional(),
});
const stateSchema = z.object({
  version: z.literal(1),
  entries: z.array(entrySchema),
  cursor: z.string().nullable(),
  known: z.record(z.string(), knownSchema),
  pending: z.record(z.string(), pendingSchema),
  lastCommentCheck: z.record(z.string(), z.string()),
  backoff: z
    .object({ failures: z.number().int().min(0), until: z.string(), paused: z.boolean() })
    .nullable(),
  lastPollAt: z.string().nullable(),
});
const snapshotSchema = z.object({
  takenAt: z.string(),
  snapshot: z.discriminatedUnion('type', [
    z.object({ type: z.literal('text'), text: z.string() }),
    z.object({
      type: z.literal('sheet'),
      sheets: z.array(z.object({ title: z.string(), rows: z.array(z.array(z.string())) })),
    }),
  ]),
});
const readIdSchema = z.union([
  z.object({ id: z.string(), seq: z.number().int().min(0) }),
  // Legacy entries: id only; the seq is filled in from the inbox (read-state.ts).
  z.string().transform((id) => ({ id, seq: UNKNOWN_READ_SEQ })),
]);
const readSchema = z.object({
  readSeq: z.number().int().min(0),
  readIds: z.array(readIdSchema),
  pushedSeq: z.number().int().min(0),
});
const configSchema = z.object({ delivery: z.enum(['hook', 'channel']) });

/** No whitespace, path separators or characters unsafe in file names (Windows included). */
const EMAIL = /^[^@\s/\\:*?"<>|]+@[^@\s/\\:*?"<>|]+$/;

function safeEmail(email: string): boolean {
  for (const ch of email) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp < 0x20 || (cp >= 0x7f && cp <= 0x9f)) return false;
  }
  return EMAIL.test(email) && !email.startsWith('.');
}
const FILE_ID = /^[A-Za-z0-9_-]+$/;
/** Default wait for `watch.lock` (critical sections hold it for a few ms). */
export const LOCK_TIMEOUT_MS = 5_000;
const LOCK_RETRY_MS = 15;
const ENTRIES_RECHECK_MS = 5 * 60_000;
const ENTRIES_RACY_MS = 1_000;

export interface WatchStoreOptions {
  dir: string;
  isAlive?: (pid: number) => boolean;
  now?: () => Date;
  logger?: Logger;
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/** Files under `<configDir>/watch` (spec §7): 0700 dir, 0600 files, atomic writes. */
export class WatchStore {
  private readonly isAlive: (pid: number) => boolean;
  private readonly now: () => Date;
  private readonly log: Logger;
  private entriesCache: { mtimeMs: number; checkedAt: number; value: boolean } | null = null;
  private swept = false;

  constructor(private readonly opts: WatchStoreOptions) {
    this.isAlive = opts.isAlive ?? processAlive;
    this.now = opts.now ?? ((): Date => new Date());
    this.log = opts.logger ?? defaultLogger;
  }

  get dir(): string {
    return this.opts.dir;
  }

  async ensureDir(): Promise<void> {
    await mkdir(this.opts.dir, { recursive: true, mode: 0o700 });
    await chmod(this.opts.dir, 0o700);
    if (!this.swept) {
      this.swept = true;
      await this.sweepTemps();
    }
  }

  private checkEmail(email: string): void {
    if (!safeEmail(email)) {
      throw new ValidationError(`Invalid account email "${email}"`);
    }
  }

  private stateFile(email: string): string {
    this.checkEmail(email);
    return path.join(this.opts.dir, `${email}.json`);
  }

  private snapshotFile(email: string, fileId: string): string {
    this.checkEmail(email);
    if (!FILE_ID.test(fileId)) throw new ValidationError(`Invalid file id "${fileId}"`);
    return path.join(this.opts.dir, 'snapshots', email, `${fileId}.json`);
  }

  private async readJson(file: string): Promise<unknown> {
    let text: string;
    try {
      text = await readFile(file, 'utf8');
    } catch (err) {
      if (hasErrorCode(err, 'ENOENT')) return null;
      throw err;
    }
    try {
      return JSON.parse(text) as unknown;
    } catch (err) {
      throw new ValidationError(`${path.basename(file)} is not valid JSON`, { cause: err });
    }
  }

  /** Atomic: temp file (0600, fsynced) in the target's directory + rename. */
  private async writeJson(file: string, data: unknown): Promise<void> {
    await this.ensureDir();
    const dir = path.dirname(file);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const tmp = path.join(dir, `.${path.basename(file)}.${randomUUID()}.tmp`);
    const handle = await open(tmp, 'wx', 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(data, null, 2)}\n`);
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await renameReplacing(tmp, file);
    } catch (err) {
      await rm(tmp, { force: true });
      throw err;
    }
  }

  /** Best effort, once per instance: crash leftovers of atomic writes (never throws). */
  private async sweepTemps(): Promise<void> {
    await sweepStaleTemps(this.opts.dir);
    const snapshots = path.join(this.opts.dir, 'snapshots');
    let accounts: string[];
    try {
      accounts = await readdir(snapshots);
    } catch {
      return;
    }
    for (const account of accounts) await sweepStaleTemps(path.join(snapshots, account));
  }

  /** Emails that have a state file. */
  async accounts(): Promise<string[]> {
    let names: string[];
    try {
      names = await readdir(this.opts.dir);
    } catch (err) {
      if (hasErrorCode(err, 'ENOENT')) return [];
      throw err;
    }
    return names
      .filter((n) => n.endsWith('.json'))
      .map((n) => n.slice(0, -'.json'.length))
      .filter((n) => safeEmail(n))
      .sort();
  }

  async load(email: string): Promise<AccountState> {
    const json = await this.readJson(this.stateFile(email));
    if (json === null) return emptyState();
    const parsed = stateSchema.safeParse(json);
    if (!parsed.success) {
      throw new ValidationError(`Watch state for ${email} is invalid: ${parsed.error.message}`);
    }
    const d = parsed.data;
    return {
      entries: d.entries,
      cursor: d.cursor,
      known: d.known,
      pending: d.pending,
      lastCommentCheck: d.lastCommentCheck,
      backoff: d.backoff,
      lastPollAt: d.lastPollAt,
    };
  }

  async save(email: string, state: AccountState): Promise<void> {
    await this.writeJson(this.stateFile(email), { version: 1, ...state });
    this.entriesCache = null;
  }

  /** Idle check of the local tick: one stat unless the directory changed. */
  async hasEntries(): Promise<boolean> {
    let mtimeMs: number;
    try {
      mtimeMs = (await stat(this.opts.dir)).mtimeMs;
    } catch (err) {
      if (hasErrorCode(err, 'ENOENT')) return false;
      throw err;
    }
    // Real clock on purpose: compared with file mtimes. A cache entry taken within 1 s of the
    // directory's mtime is not trusted (a write in the same timestamp tick could be missed).
    const t = Date.now();
    const c = this.entriesCache;
    const settled = c !== null && c.checkedAt - c.mtimeMs > ENTRIES_RACY_MS;
    if (c && settled && c.mtimeMs === mtimeMs && t - c.checkedAt < ENTRIES_RECHECK_MS)
      return c.value;
    let value = false;
    for (const email of await this.accounts()) {
      let entries: number;
      try {
        entries = (await this.load(email)).entries.length;
      } catch (err) {
        // A corrupt state file must not stop the idle tick; it is reported on use.
        this.log.warn('Unreadable watch state; skipping it', { account: email, error: err });
        continue;
      }
      if (entries > 0) {
        value = true;
        break;
      }
    }
    this.entriesCache = { mtimeMs, checkedAt: t, value };
    return value;
  }

  async loadSnapshot(email: string, fileId: string): Promise<StoredSnapshot | null> {
    const file = this.snapshotFile(email, fileId);
    let json: unknown;
    try {
      json = await this.readJson(file);
    } catch (err) {
      this.log.warn('Unreadable watch snapshot; ignoring it', { fileId, error: err });
      return null;
    }
    if (json === null) return null;
    const parsed = snapshotSchema.safeParse(json);
    if (!parsed.success) {
      this.log.warn('Invalid watch snapshot; ignoring it', { fileId });
      return null;
    }
    return parsed.data;
  }

  async saveSnapshot(email: string, fileId: string, snapshot: StoredSnapshot): Promise<void> {
    await this.writeJson(this.snapshotFile(email, fileId), snapshot);
  }

  async removeSnapshot(email: string, fileId: string): Promise<void> {
    await rm(this.snapshotFile(email, fileId), { force: true });
  }

  async loadRead(): Promise<ReadState> {
    const json = await this.readJson(path.join(this.opts.dir, 'read.json'));
    if (json === null) return { readSeq: 0, readIds: [], pushedSeq: 0 };
    const parsed = readSchema.safeParse(json);
    if (!parsed.success) throw new ValidationError(`read.json is invalid: ${parsed.error.message}`);
    return parsed.data;
  }

  async saveRead(state: ReadState): Promise<void> {
    await this.writeJson(path.join(this.opts.dir, 'read.json'), state);
  }

  async loadDelivery(): Promise<DeliveryMode> {
    const json = await this.readJson(path.join(this.opts.dir, 'config.json'));
    if (json === null) return 'hook';
    const parsed = configSchema.safeParse(json);
    if (!parsed.success)
      throw new ValidationError(`config.json is invalid: ${parsed.error.message}`);
    return parsed.data.delivery;
  }

  async saveDelivery(mode: DeliveryMode): Promise<void> {
    await this.writeJson(path.join(this.opts.dir, 'config.json'), { delivery: mode });
  }

  /** Runs `fn` under `watch.lock` (spec §7.1); waits up to `timeoutMs` for another holder. */
  async withLock<T>(fn: () => Promise<T>, timeoutMs: number = LOCK_TIMEOUT_MS): Promise<T> {
    const release = await this.acquire(timeoutMs);
    try {
      return await fn();
    } finally {
      await release();
    }
  }

  private async acquire(timeoutMs: number): Promise<() => Promise<void>> {
    await this.ensureDir();
    const lockFile = path.join(this.opts.dir, 'watch.lock');
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      try {
        return await acquireExclusive(lockFile, {
          content: () =>
            JSON.stringify({
              pid: process.pid,
              startedAt: this.now().toISOString(),
              token: randomUUID(),
            }),
          // Real clock on purpose: the age is compared with the lock file's mtime.
          isStale: (raw) => pidLockIsStale(lockFile, raw, this.isAlive, () => new Date()),
          busyMessage: 'Drive watch state is busy; try again',
          onBreak: () => this.log.warn('Breaking a stale watch lock'),
          onLostRelease: () => this.log.warn('Watch lock was taken over; not removing it'),
        });
      } catch (err) {
        if (!(err instanceof FileLockBusyError) || Date.now() >= deadline) throw err;
        await sleep(LOCK_RETRY_MS);
      }
    }
  }
}
