import { createInterface } from 'node:readline/promises';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { Command } from 'commander';
import { buildApp } from '../app.js';
import { providerOf } from '../config/account-registry.js';
import { ValidationError } from '../errors.js';
import { logger } from '../logger.js';
import { createMcpServer } from '../mcp/server.js';
import { VERSION } from '../version.js';
import {
  parseProviderOption,
  providerFlag,
  removedMessage,
  twoStepInstructions,
} from './auth-text.js';
import { formatAccounts } from './format.js';
import { runHookCli } from './hook.js';
import { serve } from './serve.js';
import { registerSyncCommands } from './sync-commands.js';
import { registerWatchCommands } from './watch-commands.js';

const TESTING_MODE_HINT =
  'Note: while the OAuth app is in Testing mode, the Google account must be listed under Audience → Test users, and the login expires every 7 days.';

function out(line: string): void {
  process.stdout.write(`${line}\n`);
}

async function confirm(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return /^y(es)?$/i.test((await rl.question(question)).trim());
  } finally {
    rl.close();
  }
}

interface LineReader {
  readLine: (prompt: string, signal: AbortSignal) => Promise<string | null>;
  close: () => void;
}

/**
 * Queues stdin lines for the no-browser login, so lines pasted (or piped) before a prompt
 * are never dropped. readLine resolves null once stdin is closed.
 */
function stdinLineReader(): LineReader {
  const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: false });
  const queue: string[] = [];
  let closed = false;
  let waiter: ((line: string | null) => void) | null = null;
  const deliver = (line: string | null): void => {
    const w = waiter;
    waiter = null;
    w?.(line);
  };
  rl.on('line', (line) => (waiter ? deliver(line) : queue.push(line)));
  rl.once('close', () => {
    closed = true;
    deliver(null);
  });
  return {
    readLine: (prompt, signal): Promise<string | null> => {
      process.stderr.write(prompt);
      const queued = queue.shift();
      if (queued !== undefined) return Promise.resolve(queued);
      if (closed) return Promise.resolve(null);
      return new Promise<string | null>((resolve, reject) => {
        waiter = resolve;
        signal.addEventListener(
          'abort',
          () => {
            if (waiter === resolve) waiter = null;
            reject(signal.reason);
          },
          { once: true },
        );
      });
    },
    close: () => rl.close(),
  };
}

/** Runs a login with a browser, or with `--no-browser` by reading the pasted redirect URL. */
async function withLoginApp<T>(
  opts: { browser?: boolean },
  run: (app: ReturnType<typeof buildApp>) => Promise<T>,
): Promise<T> {
  if (opts.browser !== false) return run(buildApp());
  const reader = stdinLineReader();
  try {
    return await run(buildApp(process.env, { manualLogin: { readLine: reader.readLine } }));
  } finally {
    reader.close();
  }
}

function googleHint(provider: 'google' | 'microsoft'): void {
  if (provider === 'google') process.stderr.write(`${TESTING_MODE_HINT}\n`);
}

const NO_BROWSER_HELP = 'do not open a browser; paste the redirect URL instead (servers, SSH)';
const PRINT_URL_HELP =
  'step 1 of a login without waiting: print the sign-in URL and exit (finish with --redirect-url)';
const REDIRECT_URL_HELP =
  'step 2: finish a --print-url login with the URL the browser was redirected to (quote it)';

interface LoginOpts {
  browser?: boolean;
  printUrl?: boolean;
  redirectUrl?: string;
}

/** Which two-step login part the options ask for, or null for the interactive login. */
function twoStepMode(opts: LoginOpts): 'print' | 'finish' | null {
  if (opts.printUrl && opts.redirectUrl !== undefined) {
    throw new ValidationError('Use --print-url and --redirect-url in two separate runs.');
  }
  if (opts.printUrl) return 'print';
  if (opts.redirectUrl !== undefined) return 'finish';
  return null;
}

function printTwoStepUrl(url: string, command: string, provider: 'google' | 'microsoft'): void {
  out(url);
  process.stderr.write(twoStepInstructions(command, provider));
}

const program = new Command()
  .name('marvin-drive')
  .description('Multi-account Google Drive and OneDrive MCP server and CLI')
  .version(VERSION);

const auth = program.command('auth').description('Manage Google and Microsoft accounts');

auth
  .command('add')
  .description('Sign in with a Google or Microsoft account and register it')
  .option('--provider <provider>', 'google (default) or microsoft')
  .option('--alias <alias>', 'short name for the account (default: email local part)')
  .option('--no-browser', NO_BROWSER_HELP)
  .option('--print-url', PRINT_URL_HELP)
  .option('--redirect-url <url>', REDIRECT_URL_HELP)
  .action(async (opts: LoginOpts & { alias?: string; provider?: string }) => {
    const step = twoStepMode(opts);
    const app = (): ReturnType<typeof buildApp> => buildApp();
    const asked = parseProviderOption(opts.provider);
    const provider = asked ?? 'google';
    if (step === 'print') {
      googleHint(provider);
      const url = await app().auth.startAddAccount(opts.alias, provider);
      const command = `auth add${opts.alias ? ` --alias ${opts.alias}` : ''}${providerFlag(provider)}`;
      printTwoStepUrl(url, command, provider);
      return;
    }
    if (step === 'finish') {
      const record = await app().auth.finishAddAccount(opts.alias, opts.redirectUrl ?? '', asked);
      out(`Added ${record.alias} (${record.email})`);
      return;
    }
    googleHint(provider);
    const record = await withLoginApp(opts, (a) => a.auth.addAccount(opts.alias, provider));
    out(`Added ${record.alias} (${record.email})`);
  });

auth
  .command('login')
  .description('Sign in again for an existing account (expired session)')
  .argument('<account>', 'alias or email')
  .option('--no-browser', NO_BROWSER_HELP)
  .option('--print-url', PRINT_URL_HELP)
  .option('--redirect-url <url>', REDIRECT_URL_HELP)
  .action(async (ref: string, opts: LoginOpts) => {
    const step = twoStepMode(opts);
    if (step === 'print') {
      const provider = providerOf(await buildApp().auth.accountFor(ref));
      googleHint(provider);
      printTwoStepUrl(await buildApp().auth.startRelogin(ref), `auth login ${ref}`, provider);
      return;
    }
    if (step === 'finish') {
      const record = await buildApp().auth.finishRelogin(ref, opts.redirectUrl ?? '');
      out(`Signed in again: ${record.alias} (${record.email})`);
      return;
    }
    googleHint(providerOf(await buildApp().auth.accountFor(ref)));
    const record = await withLoginApp(opts, (app) => app.auth.relogin(ref));
    out(`Signed in again: ${record.alias} (${record.email})`);
  });

auth
  .command('list')
  .description('List accounts and token status')
  .option('--verify', 'perform a live token refresh per account')
  .action(async (opts: { verify?: boolean }) => {
    out(formatAccounts(await buildApp().auth.status(opts.verify ?? false)));
  });

auth
  .command('remove')
  .description('Remove an account (Google: also revokes its token)')
  .argument('<account>', 'alias or email')
  .action(async (ref: string) => {
    out(removedMessage(await buildApp().auth.removeAccount(ref)));
  });

auth
  .command('default')
  .description('Set the default account')
  .argument('<account>', 'alias or email')
  .action(async (ref: string) => {
    const record = await buildApp().auth.setDefault(ref);
    out(`Default account: ${record.alias} (${record.email})`);
  });

program
  .command('serve')
  .description('Run the MCP server on stdio (used by Claude Code)')
  .action(async () => {
    const app = buildApp();
    const server = createMcpServer({
      files: app.files,
      docs: app.docs,
      sheets: app.sheets,
      slides: app.slides,
      sync: app.sync,
      watch: app.watch,
      auth: app.auth,
      version: VERSION,
    });
    await serve({
      server,
      watch: app.watch,
      transport: new StdioServerTransport(),
      log: logger,
      stdin: process.stdin,
      signals: process,
      exit: (code) => process.exit(code),
    });
  });

registerSyncCommands(program, {
  sync: () => buildApp().sync,
  out,
  confirm,
  setExitCode: (code) => {
    process.exitCode = code;
  },
});

registerWatchCommands(program, {
  watch: () => buildApp().watch,
  out,
  hook: () => runHookCli(),
});

program.parseAsync().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
});
