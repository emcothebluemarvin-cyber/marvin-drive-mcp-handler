import { resolvePaths } from '../config/paths.js';
import { runHook } from '../watch/hook.js';

/** `marvin-drive changes --hook`: never blocks the prompt (exit code 0, errors on stderr). */
export async function runHookCli(
  env: NodeJS.ProcessEnv = process.env,
  write: (text: string) => void = (text) => {
    process.stdout.write(text);
  },
  warn: (text: string) => void = (text) => {
    process.stderr.write(text);
  },
): Promise<void> {
  try {
    const output = await runHook({ watchDir: resolvePaths(env).watchDir });
    if (output !== null) write(`${output}\n`);
  } catch (err) {
    warn(`marvin-drive changes --hook: ${err instanceof Error ? err.message : String(err)}\n`);
  }
  process.exitCode = 0;
}
