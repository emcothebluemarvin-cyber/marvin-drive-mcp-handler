import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { access, open, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { OperationRunner, type OperationDeps } from '../core/operation.js';
import type { DriveFile } from '../drive/drive-adapter.js';
import { AppError, NotFoundError, ValidationError } from '../errors.js';
import { expandHome } from '../files/destination.js';
import { GOOGLE_MIME } from '../files/export-formats.js';
import { uploadMimeType } from '../files/upload-mime.js';
import { logger as defaultLogger, type Logger } from '../logger.js';
import { SyncRootError } from './errors.js';
import { scanLocal } from './local-scanner.js';
import {
  PairStore,
  checkOverlap,
  probeCaseInsensitive,
  readMarker,
  removeMarker,
  writeMarker,
} from './pair-store.js';
import {
  absInside,
  ancestorKeys,
  foldKey,
  isIgnoredName,
  isUnder,
  validateRelPath,
} from './paths.js';
import { SYNC_LIST_FIELDS, SYNC_PAGE_SIZE, childrenQuery, scanRemote } from './remote-scanner.js';
import type { ExecFn } from './trash.js';
import {
  DEFAULT_GOOGLE_EXPORT,
  PAIR_NAME,
  SYNC_FILE_FIELDS,
  type LocalScan,
  type Pair,
  type PairFile,
  type RemoteScan,
} from './types.js';

const TEXT_MIME = /^(text\/|application\/(json|xml|javascript|x-yaml|yaml|x-sh|sql|toml))/;

export interface SyncServiceDeps extends OperationDeps {
  store: PairStore;
  /** Runs /usr/bin/trash (the app passes `defaultExec`; tests pass a fake, never the real Trash). */
  trashExec: ExecFn;
  clock?: () => Date;
}

export interface CreatePairInput {
  name: string;
  localDir: string;
  remoteFolderId?: string;
  remoteFolderName?: string;
  remoteParentId?: string;
  account?: string;
}

export interface PairSummary {
  name: string;
  account: string;
  localDir: string;
  remoteFolderId: string;
  caseInsensitive: boolean;
  counts: {
    selected: number;
    tracked: number;
    remoteOnly: number;
    excluded: number;
    baseline: number;
  };
  createdAt: string;
  lastAppliedRunAt: string | null;
}

export interface ScanInput {
  name: string;
  onlyUnselected?: boolean;
  previewChars?: number;
  limit?: number;
  subdir?: string;
}

export interface ScanEntry {
  path: string;
  size: number;
  modifiedTime: string;
  mimeType: string;
  preview?: string;
}

export interface ScanResult {
  entries: ScanEntry[];
  remoteCandidates: Array<{
    path: string;
    size: number | null;
    modifiedTime: string;
    mimeType: string;
  }>;
  truncated: boolean;
}

export interface SelectInput {
  name: string;
  add?: string[];
  remove?: string[];
}

export interface SelectResult {
  selected: number;
  excluded: number;
  tracked: number;
  added: string[];
  removed: string[];
  rejected: Array<{ path: string; reason: string }>;
}

export function summarize(file: PairFile): PairSummary {
  const { pair, records } = file;
  return {
    name: pair.name,
    account: pair.account,
    localDir: pair.localDir,
    remoteFolderId: pair.remoteFolderId,
    caseInsensitive: pair.caseInsensitive,
    counts: {
      selected: pair.selection.length,
      tracked: records.length,
      remoteOnly: records.filter((r) => r.remoteOnly).length,
      excluded: pair.excluded.length,
      baseline: pair.remoteBaseline.length,
    },
    createdAt: pair.createdAt,
    lastAppliedRunAt: pair.lastAppliedRunAt,
  };
}

/** Why a Drive folder cannot be a pair root, or null (spec §5 step 2). */
export function remoteRootProblem(file: DriveFile): string | null {
  if (file.mimeType !== GOOGLE_MIME.folder) return 'is not a folder';
  if (file.trashed) return 'is in the Drive trash';
  if (file.capabilities?.canAddChildren === false) return 'does not allow adding files';
  return null;
}

async function resolveLocalDir(input: string): Promise<string> {
  const expanded = expandHome(input);
  if (!path.isAbsolute(expanded)) {
    throw new ValidationError(`localDir must be an absolute path (got "${input}")`);
  }
  let real: string;
  try {
    real = await realpath(expanded);
  } catch (err) {
    throw new ValidationError(`${expanded} does not exist`, { cause: err });
  }
  if (!(await stat(real)).isDirectory()) throw new ValidationError(`${real} is not a folder`);
  return real;
}

async function readPreview(abs: string, chars: number): Promise<string | undefined> {
  const handle = await open(abs, 'r');
  try {
    const buf = Buffer.alloc(chars * 4);
    const { bytesRead } = await handle.read(buf, 0, buf.length, 0);
    const bytes = buf.subarray(0, bytesRead);
    if (bytes.includes(0)) return undefined;
    return Array.from(bytes.toString('utf8')).slice(0, chars).join('');
  } finally {
    await handle.close();
  }
}

/** Sub-project 5 Phase A: pairs, AI-assisted selection, dry-run/apply two-way sync. */
export class SyncService {
  private readonly ops: OperationRunner;
  private readonly log: Logger;
  private readonly clock: () => Date;

  constructor(private readonly deps: SyncServiceDeps) {
    this.ops = new OperationRunner(deps);
    this.log = deps.logger ?? defaultLogger;
    this.clock = deps.clock ?? ((): Date => new Date());
  }

  private get store(): PairStore {
    return this.deps.store;
  }

  async createPair(input: CreatePairInput): Promise<PairSummary> {
    if (!PAIR_NAME.test(input.name)) {
      throw new ValidationError(`Invalid pair name "${input.name}" (use a-z, 0-9 and -, max 40)`);
    }
    if (Boolean(input.remoteFolderId) === Boolean(input.remoteFolderName)) {
      throw new ValidationError('Give exactly one of remoteFolderId or remoteFolderName');
    }
    const localDir = await resolveLocalDir(input.localDir);
    return this.store.withLock(input.name, async () => {
      const existing = (await this.store.list()).map((f) => f.pair);
      checkOverlap(existing, {
        name: input.name,
        localDir,
        remoteFolderId: input.remoteFolderId ?? '',
      });
      const id = randomUUID();
      await writeMarker(localDir, input.name, id);
      let remote: { folderId: string; alias: string };
      try {
        remote = await this.resolveRemoteRoot(input);
        checkOverlap(existing, { name: input.name, localDir, remoteFolderId: remote.folderId });
      } catch (err) {
        await removeMarker(localDir, input.name);
        throw err;
      }
      const pair: Pair = {
        name: input.name,
        id,
        account: remote.alias,
        localDir,
        caseInsensitive: await probeCaseInsensitive(localDir, input.name),
        remoteFolderId: remote.folderId,
        googleExport: { ...DEFAULT_GOOGLE_EXPORT },
        selection: [],
        excluded: [],
        remoteBaseline: [],
        baselineFolders: [],
        createdAt: this.clock().toISOString(),
        lastAppliedRunAt: null,
        firstAppliedRunAt: null,
      };
      const file: PairFile = { version: 1, pair, records: [] };
      await this.store.save(file);
      return summarize(file);
    });
  }

  private resolveRemoteRoot(input: CreatePairInput): Promise<{ folderId: string; alias: string }> {
    const folderId = input.remoteFolderId;
    if (folderId) {
      return this.ops.exec(input.account, 'idempotent', folderId, async (ctx) => {
        const root = await ctx.drive.getFile(folderId, SYNC_FILE_FIELDS);
        const problem = remoteRootProblem(root);
        if (problem) throw new ValidationError(`Drive folder ${folderId} ${problem}`);
        return { folderId, alias: ctx.account.alias };
      });
    }
    const parentId = input.remoteParentId ?? 'root';
    return this.ops.exec(input.account, 'create', input.remoteParentId, async (ctx) => {
      const folder = await ctx.drive.createFile({
        requestBody: {
          name: input.remoteFolderName ?? '',
          mimeType: GOOGLE_MIME.folder,
          parents: [parentId],
        },
        fields: 'id, name',
      });
      await this.ops.audit(ctx, 'create_folder', folder, { parentId, pair: input.name });
      return { folderId: folder.id ?? '', alias: ctx.account.alias };
    });
  }

  async listPairs(): Promise<PairSummary[]> {
    return (await this.store.list()).map(summarize);
  }

  async removePair(input: {
    name: string;
  }): Promise<{ name: string; removed: true; note: string }> {
    return this.store.withLock(input.name, async () => {
      const { pair } = await this.store.load(input.name);
      try {
        await removeMarker(pair.localDir, pair.name);
      } catch (err) {
        this.log.warn('Could not remove the sync marker', { name: pair.name, error: err });
      }
      await this.store.remove(pair.name);
      return {
        name: pair.name,
        removed: true,
        note: 'Pair removed; no local or Drive files were touched.',
      };
    });
  }

  /** Rewrites the root marker after `confirm` (spec §9) and re-probes case sensitivity. */
  async repairMarker(
    name: string,
    confirm: (pair: Pair) => Promise<boolean>,
  ): Promise<{ repaired: boolean; localDir: string; caseInsensitive: boolean }> {
    return this.store.withLock(name, async () => {
      const file = await this.store.load(name);
      const { pair } = file;
      const info = await stat(pair.localDir).catch(() => null);
      if (!info?.isDirectory())
        throw new ValidationError(`${pair.localDir} is not an available folder`);
      if (!(await confirm(pair))) {
        return { repaired: false, localDir: pair.localDir, caseInsensitive: pair.caseInsensitive };
      }
      await writeMarker(pair.localDir, pair.name, pair.id);
      pair.caseInsensitive = await probeCaseInsensitive(pair.localDir, pair.name);
      await this.store.save(file);
      return { repaired: true, localDir: pair.localDir, caseInsensitive: pair.caseInsensitive };
    });
  }

  /** Spec §5 step 2: any failure aborts the whole run. */
  private async checkRoots(pair: Pair): Promise<void> {
    const hint = `run: marvin-drive sync repair-marker ${pair.name}`;
    const info = await stat(pair.localDir).catch(() => null);
    if (!info?.isDirectory()) {
      throw new SyncRootError(`${pair.localDir} is not available (unmounted, moved or deleted?)`);
    }
    try {
      await access(pair.localDir, constants.R_OK | constants.X_OK);
    } catch (err) {
      throw new SyncRootError(`${pair.localDir} is not readable`, { cause: err });
    }
    const marker = await readMarker(pair.localDir, pair.name).catch(() => null);
    if (marker !== pair.id) {
      throw new SyncRootError(
        `The marker .marvin-sync-${pair.name} in ${pair.localDir} is missing or belongs to another pair; ${hint}`,
      );
    }
    if ((await probeCaseInsensitive(pair.localDir, pair.name)) !== pair.caseInsensitive) {
      throw new SyncRootError(`Case sensitivity of ${pair.localDir} changed; ${hint}`);
    }
    let root: DriveFile;
    try {
      root = await this.ops.exec(pair.account, 'idempotent', pair.remoteFolderId, (ctx) =>
        ctx.drive.getFile(pair.remoteFolderId, SYNC_FILE_FIELDS),
      );
    } catch (err) {
      if (err instanceof NotFoundError) {
        throw new SyncRootError(`The Drive folder ${pair.remoteFolderId} no longer exists`, {
          cause: err,
        });
      }
      throw err;
    }
    const problem = remoteRootProblem(root);
    if (problem) throw new SyncRootError(`The Drive folder ${pair.remoteFolderId} ${problem}`);
  }

  private async scanBoth(pair: Pair): Promise<{ local: LocalScan; remote: RemoteScan }> {
    const local = await scanLocal(pair.localDir);
    const remote = await scanRemote(pair.remoteFolderId, (folderId, pageToken) =>
      this.ops.exec(pair.account, 'idempotent', folderId, (ctx) =>
        ctx.drive.listFiles({
          q: childrenQuery(folderId),
          pageSize: SYNC_PAGE_SIZE,
          ...(pageToken ? { pageToken } : {}),
          fields: SYNC_LIST_FIELDS,
        }),
      ),
    );
    return { local, remote };
  }

  /** sync_scan: local files (with text previews) and remote candidates for Claude to choose from. */
  async scan(input: ScanInput): Promise<ScanResult> {
    const file = await this.store.load(input.name);
    const { pair } = file;
    await this.checkRoots(pair);
    const subdir = input.subdir ? validateRelPath(input.subdir) : undefined;
    const limit = input.limit ?? 200;
    const previewChars = input.previewChars ?? 300;
    const local = await scanLocal(pair.localDir, subdir ? { subdir } : {});
    const { remote } = await this.scanBoth(pair);
    const selected = new Set(pair.selection.map(foldKey));
    const excluded = new Set(pair.excluded.map(foldKey));
    const tracked = new Set(file.records.map((r) => r.remoteId));
    const onlyUnselected = input.onlyUnselected ?? true;
    const localHits = local.entries.filter(
      (e) => !excluded.has(e.foldKey) && !(onlyUnselected && selected.has(e.foldKey)),
    );
    const remoteHits = remote.entries.filter(
      (r) =>
        !tracked.has(r.id) &&
        !selected.has(r.foldKey) &&
        !excluded.has(r.foldKey) &&
        (subdir === undefined || isUnder(r.key, subdir)),
    );
    const entries: ScanEntry[] = [];
    for (const e of localHits.slice(0, limit)) {
      const mimeType = uploadMimeType(e.name);
      const entry: ScanEntry = {
        path: e.key,
        size: e.size,
        modifiedTime: new Date(e.mtimeMs).toISOString(),
        mimeType,
      };
      if (previewChars > 0 && TEXT_MIME.test(mimeType)) {
        try {
          const preview = await readPreview(absInside(pair.localDir, e.name), previewChars);
          if (preview !== undefined) entry.preview = preview;
        } catch (err) {
          this.log.warn('Preview failed', { path: e.key, error: err });
        }
      }
      entries.push(entry);
    }
    return {
      entries,
      remoteCandidates: remoteHits.slice(0, limit).map((r) => ({
        path: r.key,
        size: r.size,
        modifiedTime: r.modifiedTime,
        mimeType: r.mimeType,
      })),
      truncated: localHits.length > limit || remoteHits.length > limit,
    };
  }

  /** sync_select: add/remove relative paths (spec §8). */
  async select(input: SelectInput): Promise<SelectResult> {
    return this.store.withLock(input.name, async () => {
      const file = await this.store.load(input.name);
      const { pair } = file;
      const result: SelectResult = {
        selected: 0,
        excluded: 0,
        tracked: 0,
        added: [],
        removed: [],
        rejected: [],
      };
      const validated = (raw: string): string | null => {
        try {
          return validateRelPath(raw);
        } catch (err) {
          result.rejected.push({
            path: raw,
            reason: err instanceof AppError ? err.message : 'invalid path',
          });
          return null;
        }
      };
      for (const raw of input.remove ?? []) {
        const key = validated(raw);
        if (key === null) continue;
        const fold = foldKey(key);
        pair.selection = pair.selection.filter((k) => foldKey(k) !== fold);
        file.records = file.records.filter((r) => foldKey(r.path) !== fold);
        if (!pair.excluded.some((k) => foldKey(k) === fold)) pair.excluded.push(key);
        result.removed.push(key);
      }
      if (input.add && input.add.length > 0) {
        await this.checkRoots(pair);
        const { local, remote } = await this.scanBoth(pair);
        const localByFold = new Map(local.entries.map((e) => [e.foldKey, e.key]));
        const remoteByFold = new Map(remote.entries.map((r) => [r.foldKey, r.key]));
        const unknown = [...local.unknownSubtrees, ...remote.unknownSubtrees];
        const blocking = local.blocking.map(foldKey);
        for (const raw of input.add) {
          const key = validated(raw);
          if (key === null) continue;
          const fold = foldKey(key);
          const reject = (reason: string): void => {
            result.rejected.push({ path: raw, reason });
          };
          if (key.split('/').some(isIgnoredName))
            reject('dot-files and temp files are never synced');
          else if (unknown.some((u) => isUnder(key, u)))
            reject('inside a folder that could not be read');
          else if (ancestorKeys(key).some((a) => blocking.includes(foldKey(a))))
            reject('inside a symlinked, special or ignored folder');
          else if (pair.selection.some((k) => foldKey(k) === fold)) continue;
          else {
            const canonical = localByFold.get(fold) ?? remoteByFold.get(fold);
            if (canonical === undefined) reject('not found locally or in the Drive folder');
            else {
              pair.excluded = pair.excluded.filter((k) => foldKey(k) !== fold);
              pair.selection.push(canonical);
              result.added.push(canonical);
            }
          }
        }
      }
      await this.store.save(file);
      return {
        ...result,
        selected: pair.selection.length,
        excluded: pair.excluded.length,
        tracked: file.records.length,
      };
    });
  }
}
