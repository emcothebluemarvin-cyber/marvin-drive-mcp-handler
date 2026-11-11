import { sameHashOrNone } from './content-compare.js';
import { foldKey } from './paths.js';
import { providerLabel, remoteNameProblem } from './remote/remote-names.js';
import { isExcluded, type PlanContext } from './resolve.js';
import type {
  Action,
  ActionKind,
  LocalDigests,
  LocalEntry,
  Note,
  NoteCode,
  RemoteEntry,
  SelectionChange,
  SyncRecord,
} from './types.js';

export interface TrackedResult {
  actions: Action[];
  notes: Note[];
  /** Folds this record occupies (its key and a remote move target). */
  claimedFolds: string[];
  /** On-disk name of the local file matched to this record. */
  claimedLocal: string | null;
  /** B1/N1: in sync on both sides (releasable hint). */
  inSync: boolean;
}

/** One tracked record being classified (first match wins). */
export interface TrackedScope {
  ctx: PlanContext;
  record: SyncRecord;
  out: TrackedResult;
  note(code: NoteCode, rule: string, message?: string): TrackedResult;
  act(action: Omit<Action, 'record'>): TrackedResult;
}

/** Fields every tracked action starts from. */
export interface ActionBase {
  key: string;
  local: LocalEntry | null;
  localMd5: string | null;
  localDigests: LocalDigests | null;
  selection: SelectionChange;
}

/**
 * Why `key` cannot be uploaded to the pair's remote (OneDrive sync spec §4.3): the file
 * name, or a parent folder the executor would create (one with no scanned remote folder).
 * `path` is that folder for a folder problem, so its subtree is reported once.
 */
export function uploadNameProblem(
  ctx: PlanContext,
  key: string,
): { path: string; message: string } | null {
  const provider = ctx.input.remoteProvider ?? 'google';
  const existing = new Set(ctx.input.remote.folders.values());
  const segments = key.split('/');
  for (let i = 0; i < segments.length; i++) {
    const path = segments.slice(0, i + 1).join('/');
    if (i < segments.length - 1 && existing.has(path)) continue;
    const problem = remoteNameProblem(provider, segments[i] ?? '');
    if (problem) {
      return { path, message: `cannot be uploaded to ${providerLabel(provider)}: ${problem}` };
    }
  }
  return null;
}

export function makeScope(ctx: PlanContext, record: SyncRecord): TrackedScope {
  const out: TrackedResult = {
    actions: [],
    notes: [],
    claimedFolds: [foldKey(record.path)],
    claimedLocal: null,
    inSync: false,
  };
  return {
    ctx,
    record,
    out,
    note: (code, rule, message): TrackedResult => {
      out.notes.push({
        code,
        path: record.path,
        rule,
        remoteId: record.remoteId,
        ...(message ? { message } : {}),
      });
      return out;
    },
    act: (action): TrackedResult => {
      out.actions.push({ ...action, record });
      return out;
    },
  };
}

export function needsRefresh(record: SyncRecord, entry: LocalEntry, remote: RemoteEntry): boolean {
  return (
    entry.name !== record.localName ||
    entry.size !== record.localSize ||
    entry.mtimeMs !== record.localMtimeMs ||
    entry.ctimeMs !== record.localCtimeMs ||
    remote.name !== record.remoteName ||
    remote.parentId !== record.remoteParentId ||
    !sameHashOrNone(remote.hash, record.remoteHash) ||
    remote.size !== record.remoteSize ||
    remote.modifiedTime !== record.remoteModifiedTime
  );
}

/**
 * present-moved: B7–B9 (spec §6.4) and, for Google-native records, N6 (§6.6: exports
 * instead of downloads, never uploads). `lChanged`/`rChanged` compare with the record.
 */
export function planMoved(
  s: TrackedScope,
  base: ActionBase,
  remote: RemoteEntry,
  lChanged: boolean,
  rChanged: boolean,
): TrackedResult {
  const { ctx, record, note, act } = s;
  const entry = base.local;
  const fresh: ActionKind = remote.native ? 'export-new' : 'download-new';
  const rule = (binary: string): string => (remote.native ? 'N6' : binary);
  const target = remote.key;
  if (isExcluded(ctx, target)) {
    note('moved-into-excluded', rule('B7-B9'), `moved in Drive to excluded ${target}`);
    return act({
      ...base,
      kind: 'untrack',
      rule: rule('B7-B9'),
      remote: null,
      selection: { remove: [record.path], exclude: [record.path] },
    });
  }
  const blockers = (ctx.localByFold.get(foldKey(target)) ?? []).filter(
    (e) => !entry || e.ino !== entry.ino,
  );
  const [moved] = blockers;
  if (!entry && !rChanged && blockers.length === 1 && moved) {
    // Resume after a crash between the local move and persistence: the file is already there.
    const digests = ctx.input.digests.get(moved.name);
    if (digests !== undefined && digests.md5 === record.localMd5) {
      return act({
        ...base,
        key: target,
        kind: 'adopt',
        rule: rule('B7-resume'),
        local: moved,
        localMd5: digests.md5,
        localDigests: digests,
        remote,
        selection: { remove: [record.path], add: [target] },
      });
    }
  }
  if (blockers.length > 0) {
    return note('collision', rule('B7-B9'), `moved in Drive to ${target}, which exists locally`);
  }
  const move = { remove: [record.path], add: [target] };
  if (entry && !lChanged) {
    const inPlace = ctx.ci && foldKey(record.path) === foldKey(target);
    return act({
      ...base,
      key: target,
      kind: 'move-local',
      rule: rule('B7'),
      remote,
      selection: move,
      inPlace,
      thenDownload: rChanged,
    });
  }
  if (entry) {
    note(
      'conflict-rename',
      rule('B8'),
      `renamed in Drive to ${target} while edited locally; local copy kept and excluded`,
    );
    return act({
      ...base,
      key: target,
      kind: fresh,
      rule: rule('B8'),
      remote,
      selection: { remove: [record.path], add: [target], exclude: [record.path] },
    });
  }
  return act({ ...base, key: target, kind: fresh, rule: rule('B9'), remote, selection: move });
}
