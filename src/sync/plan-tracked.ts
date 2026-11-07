import { localMatchesRemote, remoteChanged } from './content-compare.js';
import { foldKey } from './paths.js';
import {
  isExcluded,
  isUnknownKey,
  localState,
  resolveLocal,
  resolveRemote,
  type PlanContext,
} from './resolve.js';
import type { Action, LocalEntry, Note, NoteCode, RemoteEntry, SyncRecord } from './types.js';

export const TYPE_CHANGED =
  'type-changed: the Drive file switched between a Google Docs/Sheets/Slides file and a regular file; remove it with sync_select remove and select it again';

export interface TrackedResult {
  actions: Action[];
  notes: Note[];
  /** Folds this record occupies (its key and a remote move target). */
  claimedFolds: string[];
  /** On-disk name of the local file matched to this record. */
  claimedLocal: string | null;
}

function needsRefresh(record: SyncRecord, entry: LocalEntry, remote: RemoteEntry): boolean {
  return (
    entry.name !== record.localName ||
    entry.size !== record.localSize ||
    entry.mtimeMs !== record.localMtimeMs ||
    entry.ctimeMs !== record.localCtimeMs ||
    remote.name !== record.remoteName ||
    remote.parentId !== record.remoteParentId ||
    remote.md5 !== record.remoteMd5 ||
    remote.size !== record.remoteSize ||
    remote.modifiedTime !== record.remoteModifiedTime
  );
}

/** Classifies one tracked record: dispatch §6.3, then table B1–B14 (§6.4). First match wins. */
export function planTracked(ctx: PlanContext, record: SyncRecord): TrackedResult {
  const out: TrackedResult = {
    actions: [],
    notes: [],
    claimedFolds: [foldKey(record.path)],
    claimedLocal: null,
  };
  const note = (code: NoteCode, rule: string, message?: string): TrackedResult => {
    out.notes.push({
      code,
      path: record.path,
      rule,
      remoteId: record.remoteId,
      ...(message ? { message } : {}),
    });
    return out;
  };
  const act = (action: Omit<Action, 'record'>): TrackedResult => {
    out.actions.push({ ...action, record });
    return out;
  };

  const L = resolveLocal(ctx, record.path);
  if (L.kind === 'present') out.claimedLocal = L.entry.name;
  const R = resolveRemote(ctx, record);
  const newKey = R.kind === 'present' && R.moved ? R.entry.key : null;
  if (newKey !== null) out.claimedFolds.push(foldKey(newKey));

  // (a) unknown-state
  if (isUnknownKey(ctx, record.path) || (newKey !== null && isUnknownKey(ctx, newKey))) {
    return note('unknown-state', 'unknown', 'inside a folder that could not be read');
  }
  if (L.kind === 'unknown') return note('unknown-state', 'unknown', L.reason);
  if (R.kind === 'unknown') return note('unknown-state', 'unknown', R.reason);
  // (b) ambiguous
  if (
    L.kind === 'ambiguous' ||
    ctx.ambiguousFolds.has(foldKey(record.path)) ||
    (newKey !== null && ctx.ambiguousFolds.has(foldKey(newKey)))
  ) {
    return note('ambiguous', 'ambiguous');
  }
  if (R.kind === 'present' && (record.native !== null) !== (R.entry.native !== null)) {
    return note('unknown-state', 'type-changed', TYPE_CHANGED);
  }
  // (c), (d): Phase B records cannot exist in Phase A — never act on them.
  if (record.remoteOnly || record.native) {
    return note('unknown-state', 'phase-b', 'needs Google-native/release support (Phase B)');
  }

  const entry = L.kind === 'present' ? L.entry : null;
  let lChanged = false;
  let lMd5: string | null = null;
  if (entry) {
    const s = localState(ctx, record, entry);
    if (!s) return note('unknown-state', 'unknown', 'local file could not be hashed');
    lChanged = s.changed;
    lMd5 = s.md5;
  }
  const base = { key: record.path, local: entry, localMd5: lMd5, selection: {} };

  if (R.kind === 'trashed') {
    if (!entry) {
      return act({
        ...base,
        kind: 'forget',
        rule: 'B12',
        remote: null,
        selection: { remove: [record.path] },
      });
    }
    if (!lChanged) {
      return act({
        ...base,
        kind: 'trash-local',
        rule: 'B10',
        remote: null,
        selection: { remove: [record.path] },
      });
    }
    // Resume after a crash between upload and persistence: adopt the identical new upload.
    const others = (ctx.remoteByFold.get(foldKey(record.path)) ?? []).filter(
      (r) => !ctx.trackedIds.has(r.id),
    );
    const reuploaded = others.find((r) => r.md5 !== null && r.md5 === lMd5);
    if (reuploaded)
      return act({
        ...base,
        kind: 'adopt',
        rule: 'B11',
        remote: reuploaded,
        rebaseFrom: record.remoteId,
      });
    if (others.length > 0) {
      return note(
        'collision',
        'B11',
        'trashed in Drive, and a different Drive file now uses this name',
      );
    }
    return act({
      ...base,
      kind: 'upload-new',
      rule: 'B11',
      remote: null,
      rebaseFrom: record.remoteId,
    });
  }
  if (R.kind === 'moved-out') {
    note('moved-out', 'B13');
    return act({
      ...base,
      kind: 'untrack',
      rule: 'B13',
      remote: null,
      selection: { remove: [record.path], exclude: [record.path] },
    });
  }
  if (R.kind === 'unavailable') {
    return note('remote-unavailable', 'B14', 'clear it with sync_select remove');
  }

  const remote = R.entry;
  const rs = remoteChanged(record, remote);
  if (rs.weak) note('weak-compare', 'R', 'Drive has no md5; compared size and modifiedTime');

  if (!R.moved) {
    if (entry) {
      if (!rs.changed && !lChanged) {
        if (needsRefresh(record, entry, remote)) {
          return act({ ...base, kind: 'refresh', rule: 'B1', remote });
        }
        return out;
      }
      if (!rs.changed && lChanged) {
        if (!remote.canEdit) return note('remote-readonly', 'B2', 'no edit permission in Drive');
        return act({ ...base, kind: 'update-remote', rule: 'B2', remote });
      }
      if (rs.changed && !lChanged)
        return act({ ...base, kind: 'download-replace', rule: 'B3', remote });
      if (lMd5 !== null && localMatchesRemote(lMd5, null, remote))
        return act({ ...base, kind: 'adopt', rule: 'B4', remote });
      if (!remote.canEdit)
        note('remote-readonly', 'B4', 'no edit permission; kept a conflict copy only');
      return act({ ...base, kind: 'conflict', rule: 'B4', remote, updateRemote: remote.canEdit });
    }
    if (!rs.changed) {
      if (!remote.canTrash) return note('cannot-trash', 'B5', 'no permission to trash it in Drive');
      return act({
        ...base,
        kind: 'trash-remote',
        rule: 'B5',
        remote,
        selection: { remove: [record.path] },
      });
    }
    return act({ ...base, kind: 'download-new', rule: 'B6', remote });
  }

  // present-moved (B7–B9)
  const target = remote.key;
  if (isExcluded(ctx, target)) {
    note('moved-into-excluded', 'B7-B9', `moved in Drive to excluded ${target}`);
    return act({
      ...base,
      kind: 'untrack',
      rule: 'B7-B9',
      remote: null,
      selection: { remove: [record.path], exclude: [record.path] },
    });
  }
  const blockers = (ctx.localByFold.get(foldKey(target)) ?? []).filter(
    (e) => !entry || e.ino !== entry.ino,
  );
  const [moved] = blockers;
  if (!entry && !rs.changed && blockers.length === 1 && moved) {
    // Resume after a crash between the local move and persistence: the file is already there.
    const md5 = ctx.input.md5s.get(moved.name);
    if (md5 === record.localMd5) {
      return act({
        ...base,
        key: target,
        kind: 'adopt',
        rule: 'B7-resume',
        local: moved,
        localMd5: md5,
        remote,
        selection: { remove: [record.path], add: [target] },
      });
    }
  }
  if (blockers.length > 0) {
    return note('collision', 'B7-B9', `moved in Drive to ${target}, which exists locally`);
  }
  const move = { remove: [record.path], add: [target] };
  if (entry && !lChanged) {
    const inPlace = ctx.ci && foldKey(record.path) === foldKey(target);
    return act({
      ...base,
      key: target,
      kind: 'move-local',
      rule: 'B7',
      remote,
      selection: move,
      inPlace,
      thenDownload: rs.changed,
    });
  }
  if (entry) {
    note(
      'conflict-rename',
      'B8',
      `renamed in Drive to ${target} while edited locally; local copy kept and excluded`,
    );
    return act({
      ...base,
      key: target,
      kind: 'download-new',
      rule: 'B8',
      remote,
      selection: { remove: [record.path], add: [target], exclude: [record.path] },
    });
  }
  return act({ ...base, key: target, kind: 'download-new', rule: 'B9', remote, selection: move });
}
