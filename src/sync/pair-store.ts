import { randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, open, readFile, readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { ValidationError, hasErrorCode } from '../errors.js';
import { acquireExclusive, pidLockIsStale, processAlive } from '../core/file-lock.js';
import { EXPORT_FORMATS } from '../files/export-formats.js';
import { logger as defaultLogger, type Logger } from '../logger.js';
import { PAIR_NAME, type Pair, type PairFile } from './types.js';
import { renameReplacing } from '../files/rename-replacing.js';

const exportFormat = z.enum(EXPORT_FORMATS);

const pairSchema = z.object({
  name: z.string().regex(PAIR_NAME),
  id: z.string().min(1),
  account: z.string().min(1),
  localDir: z.string().min(1),
  caseInsensitive: z.boolean(),
  remoteFolderId: z.string().min(1),
  googleExport: z.object({
    document: exportFormat,
    spreadsheet: exportFormat,
    presentation: exportFormat,
    drawing: exportFormat,
  }),
  selection: z.array(z.string()),
  excluded: z.array(z.string()),
  remoteBaseline: z.array(z.string()),
  baselineFolders: z.array(z.string()),
  createdAt: z.string(),
  lastAppliedRunAt: z.string().nullable(),
  firstAppliedRunAt: z.string().nullable(),
  nativeBaselineDone: z.boolean().default(false),
});

const contentHash = z.object({ kind: z.enum(['md5', 'quickXor']), value: z.string() });

const recordFields = {
  remoteId: z.string().min(1),
  path: z.string().min(1),
  localName: z.string().min(1),
  remoteName: z.string(),
  remoteParentId: z.string(),
  localMd5: z.string(),
  localSize: z.number(),
  localMtimeMs: z.number(),
  localCtimeMs: z.number(),
  remoteSize: z.number().nullable(),
  remoteModifiedTime: z.string(),
  native: z.object({ mimeType: z.string(), exportFormat }).nullable(),
  remoteOnly: z.boolean(),
  restorePending: z.boolean(),
  remoteTrashed: z.boolean(),
};

const pairFileSchema = z.object({
  version: z.literal(2),
  pair: pairSchema,
  records: z.array(z.object({ ...recordFields, remoteHash: contentHash.nullable() })),
});

/** Version 1 (before OneDrive sync): `remoteMd5` instead of `remoteHash` (spec §4.5). */
const pairFileV1Schema = z.object({
  version: z.literal(1),
  pair: pairSchema,
  records: z.array(z.object({ ...recordFields, remoteMd5: z.string().nullable() })),
});

/** Reads a stored pair file; version 1 is migrated in memory and saved as version 2. */
function parsePairFile(json: unknown): ReturnType<typeof pairFileSchema.safeParse> {
  const v1 = pairFileV1Schema.safeParse(json);
  if (!v1.success) return pairFileSchema.safeParse(json);
  return pairFileSchema.safeParse({
    ...v1.data,
    version: 2,
    records: v1.data.records.map(({ remoteMd5, ...r }) => ({
      ...r,
      remoteHash: remoteMd5 === null ? null : { kind: 'md5', value: remoteMd5 },
    })),
  });
}

export interface PairStoreOptions {
  dir: string;
  isAlive?: (pid: number) => boolean;
  now?: () => Date;
  logger?: Logger;
}

/** Pair files under `<configDir>/sync` (spec §3, §10): atomic writes, 0600 files, 0700 dir. */
export class PairStore {
  private readonly isAlive: (pid: number) => boolean;
  private readonly now: () => Date;
  private readonly log: Logger;

  constructor(private readonly opts: PairStoreOptions) {
    this.isAlive = opts.isAlive ?? processAlive;
    this.now = opts.now ?? ((): Date => new Date());
    this.log = opts.logger ?? defaultLogger;
  }

  get dir(): string {
    return this.opts.dir;
  }

  private file(name: string): string {
    if (!PAIR_NAME.test(name)) {
      throw new ValidationError(`Invalid pair name "${name}" (use a-z, 0-9 and -, max 40)`);
    }
    return path.join(this.opts.dir, `${name}.json`);
  }

  private async ensureDir(): Promise<void> {
    await mkdir(this.opts.dir, { recursive: true, mode: 0o700 });
    await chmod(this.opts.dir, 0o700);
  }

  async exists(name: string): Promise<boolean> {
    try {
      await stat(this.file(name));
      return true;
    } catch (err) {
      if (hasErrorCode(err, 'ENOENT')) return false;
      throw err;
    }
  }

  async load(name: string): Promise<PairFile> {
    let text: string;
    try {
      text = await readFile(this.file(name), 'utf8');
    } catch (err) {
      if (hasErrorCode(err, 'ENOENT')) {
        throw new ValidationError(`No sync pair named "${name}". List pairs with sync_list_pairs.`);
      }
      throw err;
    }
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch (err) {
      throw new ValidationError(`Sync pair file for "${name}" is not valid JSON`, { cause: err });
    }
    const parsed = parsePairFile(json);
    if (!parsed.success) {
      throw new ValidationError(`Sync pair file for "${name}" is invalid: ${parsed.error.message}`);
    }
    return parsed.data;
  }

  async list(): Promise<PairFile[]> {
    let names: string[];
    try {
      names = await readdir(this.opts.dir);
    } catch (err) {
      if (hasErrorCode(err, 'ENOENT')) return [];
      throw err;
    }
    const pairs = names
      .filter((n) => n.endsWith('.json'))
      .map((n) => n.slice(0, -'.json'.length))
      .filter((n) => PAIR_NAME.test(n))
      .sort();
    return Promise.all(pairs.map((n) => this.load(n)));
  }

  /** Atomic: temp file (0600, fsynced) + rename. */
  async save(data: PairFile): Promise<void> {
    await this.ensureDir();
    const target = this.file(data.pair.name);
    const tmp = path.join(this.opts.dir, `.${data.pair.name}.${randomUUID()}.tmp`);
    const handle = await open(tmp, 'wx', 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(data, null, 2)}\n`);
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await renameReplacing(tmp, target);
    } catch (err) {
      await rm(tmp, { force: true });
      throw err;
    }
  }

  async remove(name: string): Promise<void> {
    await rm(this.file(name), { force: true });
  }

  /**
   * `<name>.lock` via O_EXCL with `{ pid, startedAt, token }`; returns the release function.
   * Stale-lock breaking and own-lock release live in `src/core/file-lock.ts`.
   */
  async lock(name: string): Promise<() => Promise<void>> {
    await this.ensureDir();
    this.file(name); // validates the name
    const lockFile = path.join(this.opts.dir, `${name}.lock`);
    return acquireExclusive(lockFile, {
      content: () =>
        JSON.stringify({
          pid: process.pid,
          startedAt: this.now().toISOString(),
          token: randomUUID(),
        }),
      isStale: (raw) => pidLockIsStale(lockFile, raw, this.isAlive, this.now),
      busyMessage: `sync is busy for ${name}`,
      onBreak: () => this.log.warn('Breaking a stale sync lock', { name }),
      onLostRelease: () => this.log.warn('Sync lock was taken over; not removing it', { name }),
    });
  }

  async withLock<T>(name: string, fn: () => Promise<T>): Promise<T> {
    const release = await this.lock(name);
    try {
      return await fn();
    } finally {
      await release();
    }
  }
}

export function markerName(name: string): string {
  return `.marvin-sync-${name}`;
}

/** Writes `<localDir>/.marvin-sync-<name>` containing the pair id (atomic). */
export async function writeMarker(localDir: string, name: string, id: string): Promise<void> {
  const target = path.join(localDir, markerName(name));
  const tmp = `${target}.${randomUUID()}.marvin-part`;
  const handle = await open(tmp, 'wx', 0o644);
  try {
    await handle.writeFile(`${id}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await renameReplacing(tmp, target);
}

/** The marker's pair id, or null when it is missing. */
export async function readMarker(localDir: string, name: string): Promise<string | null> {
  try {
    return (await readFile(path.join(localDir, markerName(name)), 'utf8')).trim();
  } catch (err) {
    if (hasErrorCode(err, 'ENOENT') || hasErrorCode(err, 'ENOTDIR')) return null;
    throw err;
  }
}

export async function removeMarker(localDir: string, name: string): Promise<void> {
  await rm(path.join(localDir, markerName(name)), { force: true });
}

/** Read-only probe: does the case-flipped marker name resolve to the marker? (spec §3) */
export async function probeCaseInsensitive(localDir: string, name: string): Promise<boolean> {
  try {
    await lstat(path.join(localDir, markerName(name).toUpperCase()));
    return true;
  } catch (err) {
    if (hasErrorCode(err, 'ENOENT')) return false;
    throw err;
  }
}

function contains(parent: string, child: string): boolean {
  const rel = path.relative(parent.toLowerCase(), child.toLowerCase());
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

/** Rejects a new pair whose name exists or whose folders overlap an existing pair (spec §8). */
export function checkOverlap(
  existing: readonly Pair[],
  candidate: Pick<Pair, 'name' | 'localDir' | 'remoteFolderId'>,
): void {
  for (const p of existing) {
    if (p.name === candidate.name) {
      throw new ValidationError(`A sync pair named "${candidate.name}" already exists`);
    }
    if (contains(p.localDir, candidate.localDir) || contains(candidate.localDir, p.localDir)) {
      throw new ValidationError(
        `${candidate.localDir} overlaps the folder of pair "${p.name}" (${p.localDir})`,
      );
    }
    if (p.remoteFolderId === candidate.remoteFolderId) {
      throw new ValidationError(
        `Drive folder ${p.remoteFolderId} is already used by pair "${p.name}"`,
      );
    }
  }
}
