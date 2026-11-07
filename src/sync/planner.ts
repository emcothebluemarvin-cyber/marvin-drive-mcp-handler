import { createHash } from 'node:crypto';
import { planTracked } from './plan-tracked.js';
import { planUntracked } from './plan-untracked.js';
import { buildContext, type PlanInput } from './resolve.js';
import type { Action, ActionKind, BrakeInfo, Note, Plan } from './types.js';

export type { PlanInput } from './resolve.js';

const KIND_ORDER: ActionKind[] = [
  'adopt',
  'forget',
  'untrack',
  'refresh',
  'upload-new',
  'update-remote',
  'move-local',
  'download-new',
  'download-replace',
  'conflict',
  'trash-remote',
  'trash-local',
];

function byKindThenKey(a: Action, b: Action): number {
  const k = KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind);
  if (k !== 0) return k;
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
}

/** Spec §6.8. */
export function brakeFor(actions: readonly Action[], tracked: number): BrakeInfo {
  const trashRemote = actions.filter((a) => a.kind === 'trash-remote').length;
  const trashLocal = actions.filter((a) => a.kind === 'trash-local').length;
  const tripped =
    trashRemote + trashLocal > Math.max(10, 0.2 * tracked) ||
    (tracked >= 3 && (trashRemote === tracked || trashLocal === tracked));
  return { tripped, trashRemote, trashLocal, tracked };
}

/**
 * SHA-256 over the canonical `(kind, remoteId, key, local md5, remote md5)` list of
 * every non-refresh action — no generated names or timestamps (spec §5 step 5).
 */
export function computePlanId(actions: readonly Action[]): string {
  const rows = actions
    .filter((a) => a.kind !== 'refresh')
    .map((a) =>
      JSON.stringify([
        a.kind,
        a.record?.remoteId ?? a.remote?.id ?? '',
        a.key,
        a.localMd5 ?? '',
        a.remote?.md5 ?? '',
      ]),
    )
    .sort();
  return createHash('sha256').update(rows.join('\n')).digest('hex');
}

/** PURE planner (spec §6): tracked records first, then untracked keys. */
export function plan(input: PlanInput): Plan {
  const ctx = buildContext(input);
  const actions: Action[] = [];
  const notes: Note[] = [];
  const claimedFolds = new Set<string>();
  const claimedLocal = new Set<string>();
  const records = [...input.records].sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
  );
  for (const record of records) {
    const result = planTracked(ctx, record);
    actions.push(...result.actions);
    notes.push(...result.notes);
    for (const f of result.claimedFolds) claimedFolds.add(f);
    if (result.claimedLocal !== null) claimedLocal.add(result.claimedLocal);
  }
  const untracked = planUntracked(ctx, { folds: claimedFolds, localNames: claimedLocal });
  actions.push(...untracked.actions);
  notes.push(...untracked.notes);

  for (const ignored of input.remote.ignored) {
    if (ctx.trackedIds.has(ignored.id)) continue;
    if (ignored.reason === 'native-unsupported') {
      notes.push({
        code: 'native-unsupported',
        path: ignored.path,
        rule: 'ignored',
        remoteId: ignored.id,
        message:
          'Google Forms, Sites, Apps Script and similar files cannot be exported; they are not synced',
      });
    } else if (ignored.reason === 'unrepresentable') {
      notes.push({
        code: 'unrepresentable',
        path: ignored.path,
        rule: 'ignored',
        remoteId: ignored.id,
        message:
          'name cannot be a local file name here (too long, or reserved/invalid on Windows: CON, NUL, a:b, trailing dot…); rename it in Drive to sync it',
      });
    }
  }

  actions.sort(byKindThenKey);
  const tracked = input.records.filter((r) => !r.remoteOnly).length;
  const baselineFiles = [
    ...input.remote.entries.map((r) => r.id),
    ...input.remote.ignored.filter((i) => !i.isFolder).map((i) => i.id),
  ].filter((id) => !ctx.trackedIds.has(id));
  return {
    planId: computePlanId(actions),
    actions,
    notes,
    candidates: untracked.candidates,
    brake: brakeFor(actions, tracked),
    baseline: {
      files: [...new Set(baselineFiles)].sort(),
      folders: [
        ...input.remote.unknownFolderIds,
        ...input.remote.ignored.filter((i) => i.isFolder).map((i) => i.id),
      ].sort(),
    },
    nativeBaseline: [
      ...new Set(
        input.remote.entries
          .filter((r) => r.native !== null && !ctx.trackedIds.has(r.id))
          .map((r) => r.id),
      ),
    ].sort(),
  };
}
