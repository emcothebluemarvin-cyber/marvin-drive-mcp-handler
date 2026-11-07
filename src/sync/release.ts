import { AppError } from '../errors.js';
import { localMatchesRemote, remoteChanged } from './content-compare.js';
import { foldKey, validateRelPath } from './paths.js';
import { TYPE_CHANGED } from './plan-tracked.js';
import {
  buildContext,
  isUnknownKey,
  localState,
  resolveLocal,
  resolveRemote,
  type PlanContext,
  type PlanInput,
} from './resolve.js';
import type { RemoteEntry, SyncRecord } from './types.js';

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
    if (st.changed || !localMatchesRemote(st.md5, record, R.entry)) {
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
