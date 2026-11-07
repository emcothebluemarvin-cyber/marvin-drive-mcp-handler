import type { Command } from 'commander';
import { ValidationError } from '../errors.js';
import type { ChangesInput, ChangesResult } from '../watch/changes.js';
import type { DeliveryMode } from '../watch/types.js';
import type { WatchInput, WatchResult } from '../watch/watch-service.js';
import { formatChanges, formatWatchResult } from './watch-format.js';

export interface WatchCliService {
  watch(input: WatchInput): Promise<WatchResult>;
  changes(input: ChangesInput): Promise<ChangesResult>;
  getDelivery(): Promise<DeliveryMode>;
  setDelivery(mode: DeliveryMode): Promise<void>;
}

export interface WatchCliDeps {
  watch: () => WatchCliService;
  out: (line: string) => void;
  /** `changes --hook` (normally caught by the fast path in main.ts). */
  hook: () => Promise<void>;
}

const ACCOUNT_HELP = 'account alias or email (default account if omitted)';

/** `marvin-drive watch …` and `marvin-drive changes` (spec §4, §8.1, §8.3). */
export function registerWatchCommands(program: Command, deps: WatchCliDeps): void {
  const watch = program
    .command('watch')
    .description('Watch Drive files and folders for changes by other people');

  for (const action of ['add', 'remove'] as const) {
    watch
      .command(action)
      .description(
        action === 'add'
          ? 'Watch a file or folder (folders recursively)'
          : 'Stop watching a file or folder',
      )
      .argument('<fileId>', 'Drive file or folder ID')
      .option('--account <alias>', ACCOUNT_HELP)
      .action(async (fileId: string, opts: { account?: string }) => {
        const res = await deps
          .watch()
          .watch({ action, fileId, ...(opts.account ? { account: opts.account } : {}) });
        deps.out(formatWatchResult(res));
      });
  }

  watch
    .command('list')
    .description('List watched files and folders')
    .option('--account <alias>', ACCOUNT_HELP)
    .action(async (opts: { account?: string }) => {
      const res = await deps
        .watch()
        .watch({ action: 'list', ...(opts.account ? { account: opts.account } : {}) });
      deps.out(formatWatchResult(res));
    });

  watch
    .command('delivery')
    .description('Show or set how changes reach Claude Code: hook (default) or channel')
    .argument('[mode]', 'hook | channel')
    .action(async (mode: string | undefined) => {
      if (mode === undefined) {
        deps.out(`Delivery: ${await deps.watch().getDelivery()}`);
        return;
      }
      if (mode !== 'hook' && mode !== 'channel') {
        throw new ValidationError('Delivery mode must be "hook" or "channel"');
      }
      await deps.watch().setDelivery(mode);
      deps.out(`Delivery: ${mode}`);
    });

  program
    .command('changes')
    .description('Show changes in watched files (unread only by default; marks them read)')
    .option('--all', 'include changes already read')
    .option('--own', 'include your own edits')
    .option('--json', 'print JSON')
    .option('--hook', 'UserPromptSubmit hook output: local files only, always exit 0')
    .action(async (opts: { all?: boolean; own?: boolean; json?: boolean; hook?: boolean }) => {
      if (opts.hook) {
        await deps.hook();
        return;
      }
      const res = await deps
        .watch()
        .changes({ unreadOnly: !opts.all, includeOwn: opts.own ?? false });
      deps.out(opts.json ? JSON.stringify(res, null, 2) : formatChanges(res));
    });
}
