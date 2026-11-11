import { lstat, readdir, rmdir } from 'node:fs/promises';
import path from 'node:path';
import type { AuditSink } from '../audit/audit-log.js';
import { AppError, hasErrorCode } from '../errors.js';
import type { Logger } from '../logger.js';
import { localMatchesRemote, remoteChanged, remoteUnchangedSince } from './content-compare.js';
import { isAbortError, messageOf, PersistenceError, TargetChangedError } from './errors.js';
import { md5File } from './local-scanner.js';
import { absInside, baseName, foldKey, parentKey, toKey, validateRelPath } from './paths.js';
import { TYPE_CHANGED } from './plan-tracked.js';
import type { SyncRemote } from './remote/sync-remote.js';
import {
  buildContext,
  isUnknownKey,
  localState,
  resolveLocal,
  resolveRemote,
  type PlanContext,
  type PlanInput,
} from './resolve.js';
import type { LocalTrash } from './trash.js';
import type { Pair, PairFile, RemoteEntry, SyncRecord } from './types.js';

export type ReleaseStatus =
  | 'released'
  | 'would release'
  | 'released (already deleted locally)'
  | 'would release (already deleted locally)';

export interface ReleaseInput {
  name: string;
  paths?: string[];
  all?: boolean;
  apply?: boolean;
}

export interface ReleaseCandidate {
  record: SyncRecord;
  remote: RemoteEntry;
  /** present: local copy goes to the trash; deleted: R0, only the flag is set. */
  kind: 'present' | 'deleted';
  localName: string | null;
}

export interface ReleaseSelection {
  eligible: ReleaseCandidate[];
  skipped: Array<{ path: string; reason: string }>;
}

export interface ReleaseResult {
  pair: string;
  dryRun: boolean;
  released: Array<{ path: string; status: ReleaseStatus }>;
  skipped: Array<{ path: string; reason: string }>;
  failed: Array<{ path: string; reason: string }>;
  removedDirs: string[];
}

export function releaseStatus(kind: ReleaseCandidate['kind'], dryRun: boolean): ReleaseStatus {
  const verb = dryRun ? 'would release' : 'released';
  return kind === 'present' ? verb : `${verb} (already deleted locally)`;
}

/** Spec §10 eligibility, or R0 (addendum §3.2) for an explicitly named, deleted file. */
function check(ctx: PlanContext, record: SyncRecord, explicit: boolean): ReleaseCandidate | string {
  if (record.remoteOnly) return 'already in Drive only';
  if (isUnknownKey(ctx, record.path)) return 'inside a folder that could not be read';
  if (ctx.ambiguousFolds.has(foldKey(record.path))) return 'several files share this name';
  const R = resolveRemote(ctx, record);
  if (R.kind === 'unknown') return R.reason;
  if (R.kind !== 'present') return `the Drive file is ${R.kind}`;
  if (R.moved) return 'moved or renamed in Drive since the last sync; run sync_run first';
  if ((record.native !== null) !== (R.entry.native !== null)) return TYPE_CHANGED;
  const L = resolveLocal(ctx, record.path);
  // Native: a Drive change since the last export does not block release. This is intentional
  // (sync spec §10 only requires L unchanged and R present-same): Drive holds the newer version.
  if (L.kind === 'present') {
    const st = localState(ctx, record, L.entry);
    if (!st) return 'local file could not be hashed';
    if (st.changed || !localMatchesRemote(st.digests, record, R.entry)) {
      return 'not in sync (changed locally or in Drive); run sync_run first';
    }
    return { record, remote: R.entry, kind: 'present', localName: L.entry.name };
  }
  // R0 needs L truly absent (§6.1): unknown-state, occupied, unseen-on-disk and fold-only
  // matches resolve to `unknown` / `ambiguous` and are refused here.
  if (L.kind === 'unknown') return L.reason;
  if (L.kind === 'ambiguous') return 'a local file with a similar name exists';
  if (!explicit) return 'deleted locally; name it in paths to keep it in Drive only';
  if (remoteChanged(record, R.entry).changed) {
    return 'changed in Drive since the last sync; run sync_run first';
  }
  return { record, remote: R.entry, kind: 'deleted', localName: null };
}

/** PURE: which records sync_release may release; `all` never includes R0 paths. */
export function selectReleasable(
  input: PlanInput,
  request: { paths?: readonly string[]; all?: boolean },
): ReleaseSelection {
  const ctx = buildContext(input);
  const out: ReleaseSelection = { eligible: [], skipped: [] };
  const take = (record: SyncRecord, explicit: boolean): void => {
    const verdict = check(ctx, record, explicit);
    if (typeof verdict === 'string') out.skipped.push({ path: record.path, reason: verdict });
    else out.eligible.push(verdict);
  };
  if (request.all) {
    const records = [...input.records].sort((a, b) => (a.path < b.path ? -1 : 1));
    for (const r of records) if (!r.remoteOnly) take(r, false);
    return out;
  }
  const seen = new Set<string>();
  for (const raw of request.paths ?? []) {
    let key: string;
    try {
      key = validateRelPath(raw);
    } catch (err) {
      out.skipped.push({
        path: raw,
        reason: err instanceof AppError ? err.message : 'invalid path',
      });
      continue;
    }
    const fold = foldKey(key);
    if (seen.has(fold)) continue;
    seen.add(fold);
    const record = input.records.find((r) => foldKey(r.path) === fold);
    if (record) take(record, true);
    else out.skipped.push({ path: key, reason: 'not a synced file of this pair' });
  }
  return out;
}

/**
 * Moves candidates whose local copy the trash certainly cannot take (e.g. a Windows network
 * path) to skipped, so a dry run never promises a release the apply would fail. R0 candidates
 * need no trash and are kept.
 */
export async function withoutTrash(
  selection: ReleaseSelection,
  localDir: string,
  trash: LocalTrash,
): Promise<ReleaseSelection> {
  if (!trash.unavailableReason) return selection;
  const out: ReleaseSelection = { eligible: [], skipped: [...selection.skipped] };
  for (const c of selection.eligible) {
    const reason =
      c.kind === 'present' && c.localName !== null
        ? await trash.unavailableReason(absInside(localDir, c.localName))
        : null;
    if (reason === null) out.eligible.push(c);
    else out.skipped.push({ path: c.record.path, reason: `no trash for this location: ${reason}` });
  }
  return out;
}

export interface ReleaseDeps {
  /** The pair's remote. */
  remote: SyncRemote;
  audit: AuditSink;
  logger: Logger;
  trash: LocalTrash;
  save: (file: PairFile) => Promise<void>;
}

/** rmdir outcomes that just mean "keep this folder" (not empty, already gone, not a folder). */
const KEEP_DIR = ['ENOTEMPTY', 'EEXIST', 'ENOENT', 'ENOTDIR'];

/** R must still be present-same: not trashed, content unchanged, same name and parent. */
async function verifyRemote(deps: ReleaseDeps, planned: RemoteEntry): Promise<void> {
  const current = await deps.remote.read(planned.id);
  if (
    current.trashed ||
    !remoteUnchangedSince(planned, current) ||
    current.name !== planned.name ||
    (current.parentId ?? '') !== planned.parentId
  ) {
    throw new TargetChangedError(
      `${planned.key} changed, moved or was trashed in Drive since the scan`,
    );
  }
}

/** Present: L re-hashed must equal the record (binary: and R's md5) — never trash an edit. */
async function verifyLocal(abs: string, c: ReleaseCandidate): Promise<void> {
  const key = c.record.path;
  const md5 = await md5File(abs).catch((err: unknown) => {
    if (hasErrorCode(err, 'ENOENT')) throw new TargetChangedError(`${key} is already gone`);
    throw err;
  });
  const digests = { md5, remote: { kind: 'md5' as const, value: md5 } };
  if (md5 !== c.record.localMd5 || !localMatchesRemote(digests, c.record, c.remote)) {
    throw new TargetChangedError(`${key} changed locally since the scan`);
  }
}

/** R0: L must still be absent — the key, and on a case-insensitive volume any fold match. */
async function assertStillAbsent(pair: Pair, key: string): Promise<void> {
  const abs = absInside(pair.localDir, key);
  const exists = await lstat(abs).then(
    () => true,
    (err: unknown) => {
      if (hasErrorCode(err, 'ENOENT')) return false;
      throw new TargetChangedError(`${key} cannot be checked locally`, { cause: err });
    },
  );
  if (exists) throw new TargetChangedError(`${key} exists locally again`);
  if (!pair.caseInsensitive) return;
  const names = await readdir(path.dirname(abs)).catch((err: unknown) => {
    if (hasErrorCode(err, 'ENOENT')) return [] as string[];
    throw new TargetChangedError(`${key} cannot be checked locally`, { cause: err });
  });
  const parent = parentKey(key);
  const fold = foldKey(key);
  if (names.some((n) => foldKey(parent === '' ? toKey(n) : `${parent}/${toKey(n)}`) === fold)) {
    throw new TargetChangedError(`${key} exists locally again under another spelling`);
  }
}

/** Removes folders left empty by released files, deepest first; rmdir only (never recursive). */
async function removeEmptyDirs(
  deps: ReleaseDeps,
  root: string,
  dirs: Set<string>,
): Promise<string[]> {
  const removed: string[] = [];
  const queue = [...dirs].sort((a, b) => b.split('/').length - a.split('/').length);
  const tried = new Set<string>();
  for (let dir = queue.shift(); dir !== undefined; dir = queue.shift()) {
    if (dir === '' || tried.has(dir)) continue;
    tried.add(dir);
    try {
      await rmdir(absInside(root, dir));
    } catch (err) {
      if (!KEEP_DIR.some((c) => hasErrorCode(err, c))) {
        deps.logger.warn('Could not remove an emptied folder', { dir, error: err });
      }
      continue;
    }
    removed.push(dir);
    queue.push(parentKey(dir));
  }
  return removed.sort();
}

/**
 * Spec §10 + addendum §3: per path re-read R, then re-check L (present: re-hash; R0:
 * re-lstat), persist remoteOnly (write-ahead), then — present only — the injected
 * LocalTrash (never an unlink). Audit after success, then drop emptied folders.
 */
export async function applyRelease(
  deps: ReleaseDeps,
  file: PairFile,
  eligible: readonly ReleaseCandidate[],
): Promise<Pick<ReleaseResult, 'released' | 'failed' | 'removedDirs'>> {
  const { pair } = file;
  const out: Pick<ReleaseResult, 'released' | 'failed' | 'removedDirs'> = {
    released: [],
    failed: [],
    removedDirs: [],
  };
  const emptied = new Set<string>();
  for (const c of eligible) {
    const key = c.record.path;
    const target = file.records.find((r) => r.remoteId === c.record.remoteId) ?? c.record;
    const before = { remoteOnly: target.remoteOnly, restorePending: target.restorePending };
    const persist = async (what: string): Promise<void> => {
      try {
        await deps.save(file);
      } catch (err) {
        throw new PersistenceError(`Could not save the pair file (${what}): ${messageOf(err)}`, {
          cause: err,
        });
      }
    };
    let name: string | null = null;
    let abs = '';
    try {
      await verifyRemote(deps, c.remote);
      if (c.kind === 'present') {
        name = c.localName ?? key;
        abs = absInside(pair.localDir, name);
        await verifyLocal(abs, c);
      } else {
        await assertStillAbsent(pair, key);
      }
    } catch (err) {
      if (isAbortError(err)) throw err;
      out.failed.push({ path: key, reason: messageOf(err) });
      continue;
    }
    // Write-ahead: remoteOnly is durable before the local copy goes to the trash, so a crash
    // or a failed save can never leave a trashed file whose record still says "synced" (that
    // would plan B5 and trash the Drive copy). A crash after this save but before the trash
    // leaves remoteOnly with L present and equal to R: O8 adopt, a harmless un-release.
    target.remoteOnly = true;
    target.restorePending = false;
    try {
      await persist('marking the file as Drive-only');
    } catch (err) {
      Object.assign(target, before);
      throw err;
    }
    if (name !== null) {
      try {
        await deps.trash.trash(abs);
      } catch (err) {
        Object.assign(target, before);
        try {
          await persist('restoring the record after the trash failed');
        } catch (saveErr) {
          // Both failed: the file is still in place and the stored record says remoteOnly,
          // which the next run adopts (O8). Nothing was deleted.
          throw new PersistenceError(
            `${messageOf(err)}; restoring the record also failed: ${messageOf(saveErr)}`,
            { cause: saveErr },
          );
        }
        if (isAbortError(err)) throw err;
        out.failed.push({ path: key, reason: messageOf(err) });
        continue;
      }
      emptied.add(parentKey(name));
    }
    try {
      await deps.audit.record({
        account: pair.account,
        op: 'sync_release',
        fileId: c.record.remoteId,
        name: baseName(key),
        details: { pair: pair.name, path: key, remoteId: c.record.remoteId },
      });
    } catch (err) {
      deps.logger.warn('Audit log write failed', { op: 'sync_release', error: err });
    }
    out.released.push({ path: key, status: releaseStatus(c.kind, false) });
  }
  out.removedDirs = await removeEmptyDirs(deps, pair.localDir, emptied);
  return out;
}
