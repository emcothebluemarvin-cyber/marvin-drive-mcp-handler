import os from 'node:os';
import path from 'node:path';

export interface Paths {
  configDir: string;
  clientSecret: string;
  accounts: string;
  tokens: string;
  audit: string;
  syncDir: string;
  downloadsDir: string;
}

export function resolvePaths(env: NodeJS.ProcessEnv = process.env): Paths {
  const configDir = path.resolve(
    env.MARVIN_DRIVE_CONFIG_DIR || path.join(os.homedir(), '.config', 'google-handler'),
  );
  return {
    configDir,
    clientSecret: path.join(configDir, 'client_secret.json'),
    accounts: path.join(configDir, 'accounts.json'),
    tokens: path.join(configDir, 'tokens.json'),
    audit: path.join(configDir, 'audit.jsonl'),
    syncDir: path.join(configDir, 'sync'),
    downloadsDir: path.join(os.homedir(), 'Downloads', 'marvin-drive'),
  };
}
