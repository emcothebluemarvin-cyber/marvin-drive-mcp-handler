import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { access, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import type { OperationRunner } from '../core/operation.js';
import type { DriveFile } from '../drive/drive-adapter.js';
import { NotFoundError, ValidationError } from '../errors.js';
import { expandHome } from '../files/destination.js';
import { GOOGLE_MIME } from '../files/export-formats.js';
import type { Logger } from '../logger.js';
import { SyncRootError } from './errors.js';
import {
  checkOverlap,
  probeCaseInsensitive,
  readMarker,
  removeMarker,
  writeMarker,
  type PairStore,
} from './pair-store.js';
import {
  DEFAULT_GOOGLE_EXPORT,
  PAIR_NAME,
  SYNC_FILE_FIELDS,
  type Pair,
  type PairFile,
} from './types.js';

/** What the split service modules share (one per SyncService). */
export interface SyncEnv {
  ops: OperationRunner;
  log: Logger;
  clock: () => Date;
  store: PairStore;
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

export async function createPair(env: SyncEnv, input: CreatePairInput): Promise<PairSummary> {
  if (!PAIR_NAME.test(input.name)) {
    throw new ValidationError(`Invalid pair name "${input.name}" (use a-z, 0-9 and -, max 40)`);
  }
  if (Boolean(input.remoteFolderId) === Boolean(input.remoteFolderName)) {
    throw new ValidationError('Give exactly one of remoteFolderId or remoteFolderName');
  }
  const localDir = await resolveLocalDir(input.localDir);
  return env.store.withLock(input.name, async () => {
    const existing = (await env.store.list()).map((f) => f.pair);
    checkOverlap(existing, {
      name: input.name,
      localDir,
      remoteFolderId: input.remoteFolderId ?? '',
    });
    const id = randomUUID();
    await writeMarker(localDir, input.name, id);
    let remote: { folderId: string; alias: string };
    try {
      remote = await resolveRemoteRoot(env, input);
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
      createdAt: env.clock().toISOString(),
      lastAppliedRunAt: null,
      firstAppliedRunAt: null,
      nativeBaselineDone: false,
    };
    const file: PairFile = { version: 1, pair, records: [] };
    await env.store.save(file);
    return summarize(file);
  });
}

function resolveRemoteRoot(
  env: SyncEnv,
  input: CreatePairInput,
): Promise<{ folderId: string; alias: string }> {
  const folderId = input.remoteFolderId;
  if (folderId) {
    return env.ops.exec(input.account, 'idempotent', folderId, async (ctx) => {
      const root = await ctx.drive.getFile(folderId, SYNC_FILE_FIELDS);
      const problem = remoteRootProblem(root);
      if (problem) throw new ValidationError(`Drive folder ${folderId} ${problem}`);
      return { folderId, alias: ctx.account.alias };
    });
  }
  const parentId = input.remoteParentId ?? 'root';
  return env.ops.exec(input.account, 'create', input.remoteParentId, async (ctx) => {
    const folder = await ctx.drive.createFile({
      requestBody: {
        name: input.remoteFolderName ?? '',
        mimeType: GOOGLE_MIME.folder,
        parents: [parentId],
      },
      fields: 'id, name',
    });
    await env.ops.audit(ctx, 'create_folder', folder, { parentId, pair: input.name });
    return { folderId: folder.id ?? '', alias: ctx.account.alias };
  });
}

export async function listPairs(env: SyncEnv): Promise<PairSummary[]> {
  return (await env.store.list()).map(summarize);
}

export async function removePair(
  env: SyncEnv,
  input: {
    name: string;
  },
): Promise<{ name: string; removed: true; note: string }> {
  return env.store.withLock(input.name, async () => {
    const { pair } = await env.store.load(input.name);
    try {
      await removeMarker(pair.localDir, pair.name);
    } catch (err) {
      env.log.warn('Could not remove the sync marker', { name: pair.name, error: err });
    }
    await env.store.remove(pair.name);
    return {
      name: pair.name,
      removed: true,
      note: 'Pair removed; no local or Drive files were touched.',
    };
  });
}

/** Rewrites the root marker after `confirm` (spec §9) and re-probes case sensitivity. */
export async function repairMarker(
  env: SyncEnv,
  name: string,
  confirm: (pair: Pair) => Promise<boolean>,
): Promise<{ repaired: boolean; localDir: string; caseInsensitive: boolean }> {
  return env.store.withLock(name, async () => {
    const file = await env.store.load(name);
    const { pair } = file;
    const info = await stat(pair.localDir).catch(() => null);
    if (!info?.isDirectory())
      throw new ValidationError(`${pair.localDir} is not an available folder`);
    if (!(await confirm(pair))) {
      return { repaired: false, localDir: pair.localDir, caseInsensitive: pair.caseInsensitive };
    }
    await writeMarker(pair.localDir, pair.name, pair.id);
    pair.caseInsensitive = await probeCaseInsensitive(pair.localDir, pair.name);
    await env.store.save(file);
    return { repaired: true, localDir: pair.localDir, caseInsensitive: pair.caseInsensitive };
  });
}

/** Spec §5 step 2: any failure aborts the whole run. */
export async function checkRoots(env: SyncEnv, pair: Pair): Promise<void> {
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
    root = await env.ops.exec(pair.account, 'idempotent', pair.remoteFolderId, (ctx) =>
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
