import type { ReleaseResult } from '../sync/release.js';
import type { PairSummary } from '../sync/sync-service.js';
import type { SyncReport } from '../sync/types.js';

export function formatPairs(pairs: readonly PairSummary[]): string {
  if (pairs.length === 0) return 'No sync pairs. Create one with the sync_create_pair tool.';
  return pairs
    .map((p) => {
      const c = p.counts;
      const last = p.lastAppliedRunAt ?? 'never';
      return `${p.name.padEnd(20)} ${p.localDir} ⇄ ${p.remoteFolderId} (${p.account})\n  selected ${c.selected} · tracked ${c.tracked} · excluded ${c.excluded} · baseline ${c.baseline} · last applied ${last}`;
    })
    .join('\n');
}

function section(title: string, lines: string[]): string[] {
  return lines.length === 0 ? [] : [`${title}:`, ...lines.map((l) => `  ${l}`)];
}

export function formatReport(r: SyncReport): string {
  const lines = [
    `${r.pair} — ${r.dryRun ? 'dry run' : 'applied'} (planId ${r.planId.slice(0, 12)})`,
  ];
  if (r.aborted) lines.push(`ABORTED (${r.aborted.reason}): ${r.aborted.message}`);
  const actions = Object.entries(r.actions).map(
    ([kind, paths]) => `${kind} (${paths.length}): ${paths.join(', ')}`,
  );
  lines.push(...section(r.dryRun ? 'Planned' : 'Done', actions));
  lines.push(
    ...section(
      'Conflicts',
      r.conflicts.map((c) =>
        c.conflictCopy ? `${c.path} → Drive version kept as ${c.conflictCopy}` : c.path,
      ),
    ),
  );
  lines.push(...section('Collisions (nothing written)', r.collisions));
  lines.push(...section('Ambiguous (no action)', r.ambiguous));
  lines.push(
    ...section(
      'Unknown state (no action)',
      r.unknown.map((u) => (u.reason ? `${u.path} — ${u.reason}` : u.path)),
    ),
  );
  lines.push(
    ...section(
      'Warnings',
      r.warnings.map((w) => `${w.path}: ${w.code}${w.message ? ` — ${w.message}` : ''}`),
    ),
  );
  lines.push(
    ...section(
      'Failures',
      r.failures.map((f) => `${f.path} [${f.kind}]: ${f.message}`),
    ),
  );
  lines.push(...section('Not run', r.notRun));
  const { local, remote, truncated } = r.candidates;
  if (local.length + remote.length > 0) {
    lines.push(
      `Candidates: ${local.length} local, ${remote.length} in Drive${truncated ? ' (truncated)' : ''} — choose with sync_scan / sync_select`,
    );
  }
  if (lines.length === 1) lines.push('Nothing to do.');
  return lines.join('\n');
}

/** Exit code 1 if anything failed or the run aborted (spec §9). */
export function reportFailed(r: SyncReport): boolean {
  return r.aborted !== null || r.failures.length > 0 || r.notRun.length > 0;
}

export function formatRelease(r: ReleaseResult): string {
  const lines = [`${r.pair} — ${r.dryRun ? 'release dry run' : 'release applied'}`];
  lines.push(
    ...section(
      'Release',
      r.released.map((x) => `${x.status}: ${x.path}`),
    ),
  );
  lines.push(
    ...section(
      'Skipped',
      r.skipped.map((s) => `${s.path} — ${s.reason}`),
    ),
  );
  lines.push(
    ...section(
      'Failed (nothing changed)',
      r.failed.map((f) => `${f.path} — ${f.reason}`),
    ),
  );
  lines.push(...section('Removed empty folders', r.removedDirs));
  if (r.dryRun && r.released.length > 0) lines.push('Run again with --apply to release.');
  if (lines.length === 1) lines.push('Nothing to release.');
  return lines.join('\n');
}
