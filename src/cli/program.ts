import { createInterface } from 'node:readline/promises';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { Command } from 'commander';
import { buildApp } from '../app.js';
import { ValidationError } from '../errors.js';
import { logger } from '../logger.js';
import { channelPush } from '../mcp/channel.js';
import { createMcpServer } from '../mcp/server.js';
import { VERSION } from '../version.js';
import { formatAccounts } from './format.js';
import { registerSyncCommands } from './sync-commands.js';

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

const NO_BROWSER_HELP = 'do not open a browser; paste the redirect URL instead (servers, SSH)';
const PRINT_URL_HELP =
  'step 1 of a login without waiting: print the Google URL and exit (finish with --redirect-url)';
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

function printTwoStepUrl(url: string, command: string): void {
  out(url);
  process.stderr.write(
    '\nOpen the URL above in a browser on any device and sign in. Google then redirects to ' +
      'http://127.0.0.1:<port>/?…, which fails to load — that is expected. Copy the full URL ' +
      'from the address bar and, within 10 minutes, run:\n' +
      `  marvin-drive ${command} --redirect-url '<that URL>'\n`,
  );
}

const program = new Command()
  .name('marvin-drive')
  .description('Multi-account Google Drive MCP server and CLI')
  .version(VERSION);

const auth = program.command('auth').description('Manage Google accounts');

auth
  .command('add')
  .description('Sign in with a Google account and register it')
  .option('--alias <alias>', 'short name for the account (default: email local part)')
  .option('--no-browser', NO_BROWSER_HELP)
  .option('--print-url', PRINT_URL_HELP)
  .option('--redirect-url <url>', REDIRECT_URL_HELP)
  .action(async (opts: LoginOpts & { alias?: string }) => {
    const step = twoStepMode(opts);
    const app = (): ReturnType<typeof buildApp> => buildApp();
    if (step === 'print') {
      process.stderr.write(`${TESTING_MODE_HINT}\n`);
      const url = await app().auth.startAddAccount(opts.alias);
      printTwoStepUrl(url, `auth add${opts.alias ? ` --alias ${opts.alias}` : ''}`);
      return;
    }
    if (step === 'finish') {
      const record = await app().auth.finishAddAccount(opts.alias, opts.redirectUrl ?? '');
      out(`Added ${record.alias} (${record.email})`);
      return;
    }
    process.stderr.write(`${TESTING_MODE_HINT}\n`);
    const record = await withLoginApp(opts, (a) => a.auth.addAccount(opts.alias));
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
      process.stderr.write(`${TESTING_MODE_HINT}\n`);
      printTwoStepUrl(await buildApp().auth.startRelogin(ref), `auth login ${ref}`);
      return;
    }
    if (step === 'finish') {
      const record = await buildApp().auth.finishRelogin(ref, opts.redirectUrl ?? '');
      out(`Signed in again: ${record.alias} (${record.email})`);
      return;
    }
    process.stderr.write(`${TESTING_MODE_HINT}\n`);
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
  .description('Remove an account and revoke its token')
  .argument('<account>', 'alias or email')
  .action(async (ref: string) => {
    const record = await buildApp().auth.removeAccount(ref);
    out(`Removed ${record.alias} (${record.email})`);
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
    // Drive watch starts once the client is initialized (pushes before that would be lost).
    server.server.oninitialized = (): void => {
      app.watch.start(channelPush(server, logger)).catch((err: unknown) => {
        logger.error('Drive watch failed to start', { error: err });
      });
    };
    let stopping = false;
    const shutdown = (): void => {
      if (stopping) return;
      stopping = true;
      // A slow poll must not delay the exit for long: give the clean stop 3 s.
      const timeout = new Promise<void>((resolve) => setTimeout(resolve, 3_000).unref());
      Promise.race([app.watch.stop(), timeout])
        .catch((err: unknown) => {
          logger.error('Drive watch failed to stop cleanly', { error: err });
        })
        .finally(() => process.exit(0));
    };
    process.stdin.once('end', shutdown);
    process.stdin.once('close', shutdown);
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
    await server.connect(new StdioServerTransport());
  });

registerSyncCommands(program, {
  sync: () => buildApp().sync,
  out,
  confirm,
  setExitCode: (code) => {
    process.exitCode = code;
  },
});

program.parseAsync().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
});
