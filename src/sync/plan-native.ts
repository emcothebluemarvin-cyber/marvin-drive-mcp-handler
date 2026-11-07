import { remoteChanged } from './content-compare.js';
import {
  needsRefresh,
  planMoved,
  type ActionBase,
  type TrackedResult,
  type TrackedScope,
} from './plan-shared.js';
import type { RemoteResolution } from './resolve.js';

/** Google-native tracked records, table N1–N9 (spec §6.6). Pull-only: no uploads or Drive trash. */
export function planNative(
  s: TrackedScope,
  base: ActionBase,
  R: RemoteResolution,
  lChanged: boolean,
): TrackedResult {
  const { record, out, note, act } = s;
  const entry = base.local;
  const drop = { remove: [record.path] };
  const untrack = { remove: [record.path], exclude: [record.path] };
  if (R.kind === 'trashed') {
    if (!entry) return act({ ...base, kind: 'forget', rule: 'N7', remote: null, selection: drop });
    if (!lChanged) {
      return act({ ...base, kind: 'trash-local', rule: 'N7', remote: null, selection: drop });
    }
    note(
      'native-trashed-edited',
      'N8',
      'trashed in Drive while edited locally; your copy is kept and no longer synced',
    );
    return act({ ...base, kind: 'untrack', rule: 'N8', remote: null, selection: untrack });
  }
  if (R.kind === 'moved-out') {
    note('moved-out', 'N9');
    return act({ ...base, kind: 'untrack', rule: 'N9', remote: null, selection: untrack });
  }
  if (R.kind === 'unavailable') {
    return note('remote-unavailable', 'N9', 'clear it with sync_select remove');
  }
  if (R.kind === 'unknown') return note('unknown-state', 'unknown', R.reason);
  const remote = R.entry;
  const changed = remoteChanged(record, remote).changed;
  if (R.moved) return planMoved(s, base, remote, lChanged, changed);
  if (!changed) {
    if (entry && !lChanged) {
      s.out.inSync = true;
      return needsRefresh(record, entry, remote)
        ? act({ ...base, kind: 'refresh', rule: 'N1', remote })
        : out;
    }
    if (entry) {
      return note(
        'native-readonly-edited',
        'N2',
        'Google Docs/Sheets/Slides sync is pull-only; edit the original in Drive or with docs_*/sheets_*/slides_*',
      );
    }
    return note(
      'native-local-missing',
      'N3',
      'it will be re-exported on the next remote change; use sync_select remove or sync_release to stop that',
    );
  }
  if (!entry) return act({ ...base, kind: 'export-new', rule: 'N4', remote });
  if (!lChanged) return act({ ...base, kind: 'export-replace', rule: 'N4', remote });
  return act({ ...base, kind: 'export-new', rule: 'N5', remote, localEdit: true });
}
