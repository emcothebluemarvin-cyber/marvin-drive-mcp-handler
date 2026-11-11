#!/usr/bin/env node
// Entry: the UserPromptSubmit hook path loads only local-file modules (spec §8.3);
// everything else (googleapis, MCP SDK, commander) loads lazily through program.js.
const args = process.argv.slice(2);
if (args[0] === 'changes' && args.includes('--hook')) {
  try {
    const { runHookCli } = await import('./hook.js');
    await runHookCli();
  } catch (err) {
    // Even a broken install must not block the prompt.
    process.stderr.write(
      `marvin-drive changes --hook: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exitCode = 0;
  }
} else {
  await import('./program.js');
}
export {};
