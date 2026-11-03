#!/usr/bin/env node
import { createInterface } from 'node:readline/promises';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { Command } from 'commander';
import { buildApp } from '../app.js';
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

const program = new Command()
  .name('marvin-drive')
  .description('Multi-account Google Drive MCP server and CLI')
  .version(VERSION);

const auth = program.command('auth').description('Manage Google accounts');

auth
  .command('add')
  .description('Sign in with a Google account and register it')
  .option('--alias <alias>', 'short name for the account (default: email local part)')
  .action(async (opts: { alias?: string }) => {
    process.stderr.write(`${TESTING_MODE_HINT}\n`);
    const record = await buildApp().auth.addAccount(opts.alias);
    out(`Added ${record.alias} (${record.email})`);
  });

auth
  .command('login')
  .description('Sign in again for an existing account (expired session)')
  .argument('<account>', 'alias or email')
  .action(async (ref: string) => {
    process.stderr.write(`${TESTING_MODE_HINT}\n`);
    const record = await buildApp().auth.relogin(ref);
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
      auth: app.auth,
      version: VERSION,
    });
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
