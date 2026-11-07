import type { Command } from 'commander';
import { ValidationError } from '../errors.js';
import type { SyncService } from '../sync/sync-service.js';
import { formatPairs, formatRelease, formatReport, reportFailed } from './sync-format.js';

export interface SyncCliDeps {
  sync: () => Pick<SyncService, 'listPairs' | 'run' | 'repairMarker' | 'release'>;
  out: (line: string) => void;
  /** Asks a yes/no question on the terminal; injectable for tests. */
  confirm: (question: string) => Promise<boolean>;
  setExitCode: (code: number) => void;
}

/** `marvin-drive sync list | run | release | repair-marker` (spec §9). */
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
    .option('--confirm-remote-trash', 'also trash the Drive copies of files deleted locally')
    .action(
      async (
        name: string,
        opts: {
          apply?: boolean;
          allowMassDelete?: boolean;
          planId?: string;
          confirmRemoteTrash?: boolean;
        },
      ) => {
        if (opts.confirmRemoteTrash && !opts.planId) {
          throw new ValidationError(
            '--confirm-remote-trash: pass the planId of the dry run you reviewed (--plan-id <id>)',
          );
        }
        const report = await deps.sync().run({
          name,
          apply: opts.apply ?? false,
          allowMassDelete: opts.allowMassDelete ?? false,
          ...(opts.planId ? { planId: opts.planId } : {}),
          ...(opts.confirmRemoteTrash ? { confirmRemoteTrash: true } : {}),
        });
        deps.out(formatReport(report));
        if (reportFailed(report)) deps.setExitCode(1);
      },
    );

  sync
    .command('release')
    .description(
      'Remove local copies of synced files and keep them in Drive only (dry run unless --apply)',
    )
    .argument('<name>', 'pair name')
    .argument('[paths...]', 'relative paths to release')
    .option('--all', 'every file that is in sync')
    .option('--apply', 'release (default: dry run)')
    .action(async (name: string, paths: string[], opts: { all?: boolean; apply?: boolean }) => {
      const res = await deps.sync().release({
        name,
        apply: opts.apply ?? false,
        // Pass both through: `--all a.pdf` hits the service's "exactly one" ValidationError.
        ...(opts.all ? { all: true } : {}),
        ...(paths.length > 0 ? { paths } : {}),
      });
      deps.out(formatRelease(res));
      if (res.failed.length > 0) deps.setExitCode(1);
    });

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
