import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { access, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import type { AuditSink } from '../audit/audit-log.js';
import { NotFoundError, ValidationError } from '../errors.js';
import { expandHome } from '../files/destination.js';
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
import { validateGoogleExport } from './remote/google-remote.js';
import type { RemoteItem, SyncRemote } from './remote/sync-remote.js';
import { PAIR_NAME, type GoogleExportPrefs, type Pair, type PairFile } from './types.js';

/** What the split service modules share (one per SyncService). */
export interface SyncEnv {
  audit: AuditSink;
  log: Logger;
  clock: () => Date;
  store: PairStore;
  /** The remote of an existing pair (its account alias and export settings). */
  remoteFor: (pair: Pair) => SyncRemote;
  /** The remote for an account reference (alias, email or default) before a pair exists. */
  openRemote: (accountRef: string | undefined, prefs: GoogleExportPrefs) => Promise<SyncRemote>;
  /** Throws when the account cannot be synced, before anything touches the user's folder. */
  assertSupportedAccount: (ref: string | undefined) => Promise<void>;
}

export interface CreatePairInput {
  name: string;
  localDir: string;
  remoteFolderId?: string;
  remoteFolderName?: string;
  remoteParentId?: string;
  account?: string;
  googleExport?: Partial<GoogleExportPrefs>;
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

/** Why a remote folder cannot be a pair root, or null (spec §5 step 2). */
export function remoteRootProblem(item: RemoteItem): string | null {
  if (item.kind !== 'folder') return 'is not a folder';
  if (item.trashed) return 'is in the Drive trash';
  if (!item.canAddChildren) return 'does not allow adding files';
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
  const googleExport = validateGoogleExport(input.googleExport ?? {});
  const localDir = await resolveLocalDir(input.localDir);
  return env.store.withLock(input.name, async () => {
    const existing = (await env.store.list()).map((f) => f.pair);
    checkOverlap(existing, {
      name: input.name,
      localDir,
      remoteFolderId: input.remoteFolderId ?? '',
    });
    await env.assertSupportedAccount(input.account);
    const id = randomUUID();
    await writeMarker(localDir, input.name, id);
    let remote: { folderId: string; alias: string };
    try {
      remote = await resolveRemoteRoot(env, input, googleExport);
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
      googleExport,
      selection: [],
      excluded: [],
      remoteBaseline: [],
      baselineFolders: [],
      createdAt: env.clock().toISOString(),
      lastAppliedRunAt: null,
      firstAppliedRunAt: null,
      nativeBaselineDone: false,
    };
    const file: PairFile = { version: 2, pair, records: [] };
    await env.store.save(file);
    return summarize(file);
  });
}

async function resolveRemoteRoot(
  env: SyncEnv,
  input: CreatePairInput,
  googleExport: GoogleExportPrefs,
): Promise<{ folderId: string; alias: string }> {
  const remote = await env.openRemote(input.account, googleExport);
  const folderId = input.remoteFolderId;
  if (folderId) {
    const root = await remote.read(folderId);
    const problem = remoteRootProblem(root);
    if (problem) throw new ValidationError(`Drive folder ${folderId} ${problem}`);
    return { folderId, alias: remote.account };
  }
  const parentId = input.remoteParentId ?? remote.rootId;
  const folder = await remote.createFolder(parentId, input.remoteFolderName ?? '');
  const details = { parentId, pair: input.name };
  try {
    await env.audit.record({
      account: remote.account,
      op: 'create_folder',
      fileId: folder.id,
      ...(folder.name ? { name: folder.name } : {}),
      details,
    });
  } catch (err) {
    env.log.warn('Audit log write failed', { op: 'create_folder', fileId: folder.id, error: err });
  }
  return { folderId: folder.id, alias: remote.account };
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
  let root: RemoteItem;
  try {
    root = await env.remoteFor(pair).read(pair.remoteFolderId);
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
