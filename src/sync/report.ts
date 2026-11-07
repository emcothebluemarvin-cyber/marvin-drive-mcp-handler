import type { ActionOutcome, Note, NoteCode, Plan, SyncReport } from './types.js';

const WARNING_CODES: ReadonlySet<NoteCode> = new Set([
  'conflict-rename',
  'moved-out',
  'moved-into-excluded',
  'remote-unavailable',
  'remote-readonly',
  'cannot-trash',
  'missing',
  'native-unsupported',
  'unrepresentable',
  'ambiguous-native',
  'weak-compare',
  'native-readonly-edited',
  'native-local-missing',
  'native-trashed-edited',
  'remote-only-trashed',
]);

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function warningOf(n: Note): { path: string; code: string; message?: string } {
  return { path: n.path, code: n.code, ...(n.message ? { message: n.message } : {}) };
}

export interface ReportOptions {
  dryRun: boolean;
  aborted?: SyncReport['aborted'];
  outcomes?: readonly ActionOutcome[];
}

/** Turns a plan (dry run / aborted) or executed outcomes into the sync_run report (spec §8). */
export function buildReport(pairName: string, plan: Plan, opts: ReportOptions): SyncReport {
  const notes = plan.notes;
  const report: SyncReport = {
    pair: pairName,
    dryRun: opts.dryRun,
    planId: plan.planId,
    aborted: opts.aborted ?? null,
    actions: {},
    conflicts: [],
    collisions: unique(notes.filter((n) => n.code === 'collision').map((n) => n.path)),
    ambiguous: unique(notes.filter((n) => n.code === 'ambiguous').map((n) => n.path)),
    unknown: notes
      .filter((n) => n.code === 'unknown-state')
      .map((n) => ({ path: n.path, ...(n.message ? { reason: n.message } : {}) })),
    warnings: notes.filter((n) => WARNING_CODES.has(n.code)).map(warningOf),
    failures: [],
    notRun: [],
    candidates: plan.candidates,
  };
  const add = (kind: keyof SyncReport['actions'], path: string): void => {
    (report.actions[kind] ??= []).push(path);
  };
  if (!opts.outcomes) {
    for (const a of plan.actions) {
      if (a.kind === 'refresh') continue;
      add(a.kind, a.key);
      if (a.kind === 'conflict') report.conflicts.push({ path: a.key });
    }
    return report;
  }
  for (const o of opts.outcomes) {
    if (o.status === 'done') {
      if (o.kind !== 'refresh') add(o.kind, o.path);
      if (o.kind === 'conflict') {
        report.conflicts.push({
          path: o.path,
          ...(o.conflictCopy ? { conflictCopy: o.conflictCopy } : {}),
        });
      }
      if (o.warning) {
        report.warnings.push({
          path: o.path,
          code: o.warning,
          ...(o.message ? { message: o.message } : {}),
        });
      }
    } else if (o.status === 'skipped') {
      report.warnings.push({
        path: o.path,
        code: o.warning ?? 'skipped-changed',
        ...(o.message ? { message: o.message } : {}),
      });
    } else if (o.status === 'collision') {
      report.collisions.push(o.path);
    } else if (o.status === 'failed') {
      report.failures.push({ path: o.path, kind: o.kind, message: o.message ?? 'failed' });
    } else {
      report.notRun.push(o.path);
    }
    // N5: an export that did not finish still moved the local edit aside; name the kept copy.
    if (o.status !== 'done' && o.conflictCopy) {
      report.warnings.push({
        path: o.path,
        code: 'native-local-edit-kept',
        message: `your local edit is kept as ${o.conflictCopy}`,
      });
    }
  }
  return report;
}
