import type { Command } from 'commander';
import type { SyncService } from '../sync/sync-service.js';
import { formatPairs, formatReport, reportFailed } from './sync-format.js';

export interface SyncCliDeps {
  sync: () => Pick<SyncService, 'listPairs' | 'run' | 'repairMarker'>;
  out: (line: string) => void;
  /** Asks a yes/no question on the terminal; injectable for tests. */
  confirm: (question: string) => Promise<boolean>;
  setExitCode: (code: number) => void;
}

/** `marvin-drive sync list | run | repair-marker` (spec §9, Phase A). */
export function registerSyncCommands(program: Command, deps: SyncCliDeps): void {
  const sync = program
    .command('sync')
    .description('Selective two-way sync between local and Drive folders');

  sync
    .command('list')
    .description('List sync pairs')
    .action(async () => {
      deps.out(formatPairs(await deps.sync().listPairs()));
    });

  sync
    .command('run')
    .description('Plan a sync (dry run) or apply it with --apply')
    .argument('<name>', 'pair name')
    .option('--apply', 'apply the plan (default: dry run)')
    .option('--allow-mass-delete', 'allow more deletions than the safety brake permits')
    .option('--plan-id <id>', 'apply only if the plan still matches this dry-run planId')
    .action(
      async (
        name: string,
        opts: { apply?: boolean; allowMassDelete?: boolean; planId?: string },
      ) => {
        const report = await deps.sync().run({
          name,
          apply: opts.apply ?? false,
          allowMassDelete: opts.allowMassDelete ?? false,
          ...(opts.planId ? { planId: opts.planId } : {}),
        });
        deps.out(formatReport(report));
        if (reportFailed(report)) deps.setExitCode(1);
      },
    );

  sync
    .command('repair-marker')
    .description('Rewrite the .marvin-sync-<name> marker after confirming the local folder')
    .argument('<name>', 'pair name')
    .action(async (name: string) => {
      const res = await deps
        .sync()
        .repairMarker(name, (pair) =>
          deps.confirm(
            `Pair "${pair.name}" syncs ${pair.localDir}. Is this the same folder as before (not a different disk or copy)? Rewrite its marker? [y/N] `,
          ),
        );
      deps.out(
        res.repaired
          ? `Marker rewritten in ${res.localDir} (case-insensitive: ${res.caseInsensitive}).`
          : 'Nothing changed.',
      );
    });
}
