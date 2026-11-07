import { ancestorKeys, foldKey, isUnder } from './paths.js';
import type {
  LocalEntry,
  LocalScan,
  OnDiskProbe,
  Pair,
  Probe,
  RemoteEntry,
  RemoteIgnored,
  RemoteScan,
  SyncRecord,
} from './types.js';

export interface PlanInput {
  pair: Pair;
  records: readonly SyncRecord[];
  local: LocalScan;
  remote: RemoteScan;
  /** Probe results for records missing from the remote scan (spec §6.2). */
  probes: ReadonlyMap<string, Probe>;
  /** md5 by on-disk relative name, for the names `hashTargets` asked for. */
  md5s: ReadonlyMap<string, string>;
  /** lstat of record keys that have no exact scan match (absent keys are omitted). */
  onDisk: ReadonlyMap<string, OnDiskProbe>;
}

export interface PlanContext {
  input: PlanInput;
  ci: boolean;
  localByKey: Map<string, LocalEntry>;
  localByFold: Map<string, LocalEntry[]>;
  remoteById: Map<string, RemoteEntry>;
  remoteByFold: Map<string, RemoteEntry[]>;
  ignoredById: Map<string, RemoteIgnored>;
  trackedIds: Set<string>;
  /** Folds with two entries on one side (spec §6.5 last paragraph). */
  ambiguousFolds: Set<string>;
  occupiedKeys: Set<string>;
  occupiedFolds: Set<string>;
  blockingKeys: Set<string>;
  blockingFolds: Set<string>;
  localByIno: Map<number, LocalEntry>;
  excludedFolds: Set<string>;
  /** Selected key by fold. */
  selectionByFold: Map<string, string>;
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

export function buildContext(input: PlanInput): PlanContext {
  const localByKey = new Map<string, LocalEntry>();
  const localByFold = new Map<string, LocalEntry[]>();
  for (const e of input.local.entries) {
    localByKey.set(e.key, e);
    push(localByFold, e.foldKey, e);
  }
  const remoteById = new Map<string, RemoteEntry>();
  const remoteByFold = new Map<string, RemoteEntry[]>();
  for (const r of input.remote.entries) {
    remoteById.set(r.id, r);
    push(remoteByFold, r.foldKey, r);
  }
  const ambiguousFolds = new Set<string>();
  for (const [fold, list] of localByFold) if (list.length > 1) ambiguousFolds.add(fold);
  for (const [fold, list] of remoteByFold) if (list.length > 1) ambiguousFolds.add(fold);
  return {
    input,
    ci: input.pair.caseInsensitive,
    localByKey,
    localByFold,
    remoteById,
    remoteByFold,
    ignoredById: new Map(input.remote.ignored.map((i) => [i.id, i])),
    trackedIds: new Set(input.records.map((r) => r.remoteId)),
    ambiguousFolds,
    occupiedKeys: new Set(input.local.occupied),
    occupiedFolds: new Set(input.local.occupied.map(foldKey)),
    blockingKeys: new Set(input.local.blocking),
    blockingFolds: new Set(input.local.blocking.map(foldKey)),
    localByIno: new Map(input.local.entries.map((e) => [e.ino, e])),
    excludedFolds: new Set(input.pair.excluded.map(foldKey)),
    selectionByFold: new Map(input.pair.selection.map((k) => [foldKey(k), k])),
  };
}

/** Under a local or remote unknown subtree (spec §4). */
export function isUnknownKey(ctx: PlanContext, key: string): boolean {
  return (
    ctx.input.local.unknownSubtrees.some((u) => isUnder(key, u)) ||
    ctx.input.remote.unknownSubtrees.some((u) => isUnder(key, u))
  );
}

export function isOccupied(ctx: PlanContext, key: string): boolean {
  return ctx.ci ? ctx.occupiedFolds.has(foldKey(key)) : ctx.occupiedKeys.has(key);
}

/** An ancestor of `key` is a symlink, special file or dot-named folder (never treat as absent). */
export function isBlocked(ctx: PlanContext, key: string): boolean {
  return ancestorKeys(key).some((a) =>
    ctx.ci ? ctx.blockingFolds.has(foldKey(a)) : ctx.blockingKeys.has(a),
  );
}

export function isExcluded(ctx: PlanContext, key: string): boolean {
  return ctx.excludedFolds.has(foldKey(key));
}

export type LocalResolution =
  | { kind: 'present'; entry: LocalEntry; renamedCase: boolean }
  | { kind: 'absent' }
  | { kind: 'ambiguous' }
  | { kind: 'unknown'; reason: string };

/** The volume resolves `key` to `entry` itself (from the service's lstat probe). */
export function sameFileOnDisk(ctx: PlanContext, key: string, entry: LocalEntry): boolean {
  const probe = ctx.input.onDisk.get(key);
  return probe?.kind === 'file' && probe.ino === entry.ino;
}

/** Spec §6.1. */
export function resolveLocal(ctx: PlanContext, key: string): LocalResolution {
  const exact = ctx.localByKey.get(key);
  if (exact) return { kind: 'present', entry: exact, renamedCase: false };
  const folded = ctx.localByFold.get(foldKey(key)) ?? [];
  if (folded.length > 0) {
    const [only] = folded;
    // A fold-only match counts as the same file only when the volume agrees: lstat(key)
    // must hit exactly that inode (protects against any fold/APFS mismatch).
    if (ctx.ci && folded.length === 1 && only && sameFileOnDisk(ctx, key, only)) {
      return { kind: 'present', entry: only, renamedCase: true };
    }
    return { kind: 'ambiguous' };
  }
  if (ctx.input.local.unknownSubtrees.some((u) => isUnder(key, u))) {
    return { kind: 'unknown', reason: 'local folder could not be read' };
  }
  if (isBlocked(ctx, key)) {
    return {
      kind: 'unknown',
      reason: 'a parent folder is a symlink, special file or ignored folder',
    };
  }
  if (isOccupied(ctx, key)) {
    return { kind: 'unknown', reason: 'local path is occupied by a non-regular or ignored entry' };
  }
  const probe = ctx.input.onDisk.get(key);
  if (probe) {
    // The volume resolves the key to a scanned file our fold missed (APFS folding is fuller).
    const same = probe.kind === 'file' ? ctx.localByIno.get(probe.ino) : undefined;
    if (same) return { kind: 'present', entry: same, renamedCase: true };
    return { kind: 'unknown', reason: 'exists on disk but was not seen by the scan' };
  }
  return { kind: 'absent' };
}

export type RemoteResolution =
  | { kind: 'present'; entry: RemoteEntry; moved: boolean }
  | { kind: 'trashed' }
  | { kind: 'moved-out' }
  | { kind: 'unavailable' }
  | { kind: 'unknown'; reason: string };

/** Spec §6.2. */
export function resolveRemote(ctx: PlanContext, record: SyncRecord): RemoteResolution {
  const scanned = ctx.remoteById.get(record.remoteId);
  if (scanned) return { kind: 'present', entry: scanned, moved: scanned.key !== record.path };
  if (ctx.ignoredById.has(record.remoteId)) {
    return { kind: 'unknown', reason: 'renamed in Drive to a name that cannot be synced' };
  }
  const probe = ctx.input.probes.get(record.remoteId);
  if (!probe) return { kind: 'unknown', reason: 'Drive file was not probed' };
  switch (probe.state) {
    case 'present':
      return { kind: 'present', entry: probe.entry, moved: probe.entry.key !== record.path };
    case 'unknown':
      return { kind: 'unknown', reason: probe.reason };
    default:
      return { kind: probe.state };
  }
}

function statMatches(entry: LocalEntry, record: SyncRecord): boolean {
  return (
    entry.size === record.localSize &&
    entry.mtimeMs === record.localMtimeMs &&
    entry.ctimeMs === record.localCtimeMs
  );
}

/** L content vs the record; null when a needed hash is missing. */
export function localState(
  ctx: PlanContext,
  record: SyncRecord,
  entry: LocalEntry,
): { changed: boolean; md5: string } | null {
  if (statMatches(entry, record)) return { changed: false, md5: record.localMd5 };
  const md5 = ctx.input.md5s.get(entry.name);
  if (md5 === undefined) return null;
  return { changed: md5 !== record.localMd5, md5 };
}

/**
 * Keys the service must `lstat` before planning (`PlanInput.onDisk`): record keys without
 * an exact scan match, and Drive/selected keys that match a local file only by fold.
 */
export function onDiskProbeKeys(
  input: Pick<PlanInput, 'pair' | 'records' | 'local' | 'remote'>,
): string[] {
  const exact = new Set(input.local.entries.map((e) => e.key));
  const folds = new Set(input.local.entries.map((e) => e.foldKey));
  const keys = new Set<string>();
  for (const r of input.records) if (!exact.has(r.path)) keys.add(r.path);
  for (const r of input.remote.entries) {
    if (!exact.has(r.key) && folds.has(r.foldKey)) keys.add(r.key);
  }
  for (const k of input.pair.selection) {
    if (!exact.has(k) && folds.has(foldKey(k))) keys.add(k);
  }
  return [...keys].sort();
}

/**
 * On-disk names the service must hash before planning (spec §5 step 3): tracked
 * files whose stat differs from the record, selected files not yet recorded, and a
 * local file already at a vanished record's Drive-move target (crash after a move).
 */
export function hashTargets(input: Omit<PlanInput, 'md5s'>): string[] {
  const ctx = buildContext({ ...input, md5s: new Map() });
  const names = new Set<string>();
  const recordFolds = new Set<string>();
  for (const record of input.records) {
    recordFolds.add(foldKey(record.path));
    const l = resolveLocal(ctx, record.path);
    if (l.kind === 'present' && !statMatches(l.entry, record)) names.add(l.entry.name);
    const moved = ctx.remoteById.get(record.remoteId);
    if (l.kind === 'absent' && moved && moved.key !== record.path) {
      for (const e of ctx.localByFold.get(moved.foldKey) ?? []) names.add(e.name);
    }
  }
  for (const key of input.pair.selection) {
    const fold = foldKey(key);
    if (recordFolds.has(fold)) continue;
    for (const e of ctx.localByFold.get(fold) ?? []) names.add(e.name);
  }
  return [...names].sort();
}
