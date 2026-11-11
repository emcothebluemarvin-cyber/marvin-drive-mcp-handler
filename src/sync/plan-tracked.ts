import { localMatchesRemote, remoteChanged } from './content-compare.js';
import { foldKey } from './paths.js';
import { planNative } from './plan-native.js';
import { planRemoteOnly } from './plan-remote-only.js';
import { makeScope, needsRefresh, planMoved, type TrackedResult } from './plan-shared.js';
import {
  isUnknownKey,
  localState,
  resolveLocal,
  resolveRemote,
  type PlanContext,
} from './resolve.js';
import type { SyncRecord } from './types.js';

export type { TrackedResult } from './plan-shared.js';

export const TYPE_CHANGED =
  'type-changed: the Drive file switched between a Google Docs/Sheets/Slides file and a regular file; remove it with sync_select remove and select it again';

/** Classifies one tracked record: dispatch §6.3, then B1–B14 (§6.4) or N1–N9 (§6.6). */
export function planTracked(ctx: PlanContext, record: SyncRecord): TrackedResult {
  const s = makeScope(ctx, record);
  const { out, note, act } = s;

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
  // (c) remote-only records, natives included (spec §6.7).
  if (record.remoteOnly) return planRemoteOnly(s, L, R);

  const entry = L.kind === 'present' ? L.entry : null;
  let lChanged = false;
  let lMd5: string | null = null;
  if (entry) {
    const ls = localState(ctx, record, entry);
    if (!ls) return note('unknown-state', 'unknown', 'local file could not be hashed');
    lChanged = ls.changed;
    lMd5 = ls.md5;
  }
  const base = { key: record.path, local: entry, localMd5: lMd5, selection: {} };
  // (d)
  if (record.native) return planNative(s, base, R, lChanged);

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
        out.inSync = true;
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
        reason: 'local-deleted',
        remote,
        selection: { remove: [record.path] },
      });
    }
    return act({ ...base, kind: 'download-new', rule: 'B6', remote });
  }

  return planMoved(s, base, remote, lChanged, rs.changed);
}
