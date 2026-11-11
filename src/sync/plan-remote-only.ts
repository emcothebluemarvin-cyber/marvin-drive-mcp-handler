import { localMatchesRemote, remoteChanged, sameHashOrNone } from './content-compare.js';
import { foldKey } from './paths.js';
import type { ActionBase, TrackedResult, TrackedScope } from './plan-shared.js';
import { isExcluded, localState, type LocalResolution, type RemoteResolution } from './resolve.js';
import type { LocalDigests, RemoteEntry, SyncRecord } from './types.js';

/**
 * Remote-side record fields that differ from R (O3/O4/O6 record refresh). A native's
 * remoteModifiedTime is the baseline of its last export and is never refreshed here, so a
 * Doc edited in Drive after the release still counts as changed when its export comes back.
 */
function remotePatch(record: SyncRecord, remote: RemoteEntry): Partial<SyncRecord> {
  const patch: Partial<SyncRecord> = {};
  if (remote.name !== record.remoteName) patch.remoteName = remote.name;
  if (remote.parentId !== record.remoteParentId) patch.remoteParentId = remote.parentId;
  if (!sameHashOrNone(remote.hash, record.remoteHash)) patch.remoteHash = remote.hash;
  if (remote.size !== record.remoteSize) patch.remoteSize = remote.size;
  if (remote.native === null && remote.modifiedTime !== record.remoteModifiedTime) {
    patch.remoteModifiedTime = remote.modifiedTime;
  }
  return patch;
}

/**
 * Released records, table O0–O8 (spec §6.7). Never downloads or exports unless
 * restorePending, never trashes anything; bookkeeping is a `refresh` with a record patch.
 */
export function planRemoteOnly(
  s: TrackedScope,
  L: LocalResolution,
  R: RemoteResolution,
): TrackedResult {
  const { ctx, record, out, note, act } = s;
  const bin =
    ctx.input.remoteProvider === 'microsoft' ? 'the OneDrive recycle bin' : 'the Drive trash';
  const purged =
    ctx.input.remoteProvider === 'microsoft'
      ? 'it is removed by OneDrive after 30 days'
      : 'it is purged after 30 days';
  const entry = L.kind === 'present' ? L.entry : null;
  let lDigests: LocalDigests | null = null;
  if (entry) {
    const st = localState(ctx, record, entry);
    if (!st) return note('unknown-state', 'unknown', 'local file could not be hashed');
    lDigests = st.digests;
  }
  const base: ActionBase = {
    key: record.path,
    local: entry,
    localMd5: lDigests?.md5 ?? null,
    localDigests: lDigests,
    selection: {},
  };
  const untrack = { remove: [record.path], exclude: [record.path] };
  const present = R.kind === 'present' ? R.entry : null;
  const same =
    present !== null && lDigests !== null && localMatchesRemote(lDigests, record, present);
  // L is the unmodified last export but the Doc changed since: re-export over it (like N4).
  const stale = same && present.native !== null && remoteChanged(record, present).changed;
  const back = (rule: 'O0' | 'O8', remote: RemoteEntry): TrackedResult =>
    act({ ...base, kind: stale ? 'export-replace' : 'adopt', rule, remote });

  if (record.restorePending) {
    if (entry && same) return back('O0', present);
    if (present) {
      const target = present.key;
      if ((ctx.localByFold.get(foldKey(target)) ?? []).length > 0) {
        return note(
          'collision',
          'O1',
          `a different local file is at ${target}; move it away to restore the Drive copy`,
        );
      }
      return act({
        ...base,
        key: target,
        local: null,
        localMd5: null,
        localDigests: null,
        kind: present.native ? 'export-new' : 'download-new',
        rule: 'O1',
        remote: present,
        selection: target === record.path ? {} : { remove: [record.path], add: [target] },
      });
    }
    if (R.kind === 'trashed') {
      return note(
        'remote-only-trashed',
        'O2',
        `cannot restore: the only copy is in ${bin}; restore it there first`,
      );
    }
    if (R.kind === 'unavailable') {
      return note('remote-unavailable', 'O2', 'cannot restore: the Drive file is not available');
    }
  }
  if (R.kind === 'trashed') {
    note('remote-only-trashed', 'O5', `the only copy is in ${bin}; ${purged}`);
    return record.remoteTrashed
      ? out
      : act({
          ...base,
          kind: 'refresh',
          rule: 'O5',
          remote: null,
          patch: { remoteTrashed: true },
        });
  }
  if (R.kind === 'moved-out') {
    note('moved-out', 'O7');
    return act({ ...base, kind: 'untrack', rule: 'O7', remote: null, selection: untrack });
  }
  if (R.kind === 'unavailable') {
    return note('remote-unavailable', 'O7', 'clear it with sync_select remove');
  }
  if (R.kind === 'unknown') return note('unknown-state', 'unknown', R.reason);
  const remote = R.entry;
  if (entry) {
    if (same) return back('O8', remote);
    return note(
      'collision',
      'O8',
      'a different local file is at the path of this Drive-only file; nothing was written',
    );
  }
  const patch: Partial<SyncRecord> = {
    ...remotePatch(record, remote),
    ...(record.remoteTrashed ? { remoteTrashed: false } : {}),
  };
  if (R.moved) {
    if (isExcluded(ctx, remote.key)) {
      note('moved-into-excluded', 'O4', `moved in Drive to excluded ${remote.key}`);
      return act({ ...base, kind: 'untrack', rule: 'O4', remote: null, selection: untrack });
    }
    return act({
      ...base,
      key: remote.key,
      kind: 'refresh',
      rule: 'O4',
      remote: null,
      patch: { ...patch, path: remote.key, localName: remote.key },
      selection: { remove: [record.path], add: [remote.key] },
    });
  }
  if (Object.keys(patch).length === 0) return out;
  return act({
    ...base,
    kind: 'refresh',
    rule: record.remoteTrashed ? 'O6' : 'O3',
    remote: null,
    patch,
  });
}
