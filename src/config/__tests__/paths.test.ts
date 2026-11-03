import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolvePaths } from '../paths.js';

describe('resolvePaths', () => {
  it('defaults to ~/.config/google-handler and ~/Downloads/marvin-drive', () => {
    const p = resolvePaths({});
    const dir = path.join(os.homedir(), '.config', 'google-handler');
    expect(p).toEqual({
      configDir: dir,
      clientSecret: path.join(dir, 'client_secret.json'),
      accounts: path.join(dir, 'accounts.json'),
      audit: path.join(dir, 'audit.jsonl'),
      downloadsDir: path.join(os.homedir(), 'Downloads', 'marvin-drive'),
    });
  });

  it('treats an empty MARVIN_DRIVE_CONFIG_DIR as unset and resolves relative paths', () => {
    const dir = path.join(os.homedir(), '.config', 'google-handler');
    expect(resolvePaths({ MARVIN_DRIVE_CONFIG_DIR: '' }).configDir).toBe(dir);
    expect(resolvePaths({ MARVIN_DRIVE_CONFIG_DIR: 'rel/dir' }).configDir).toBe(
      path.resolve('rel/dir'),
    );
  });

  it('honours MARVIN_DRIVE_CONFIG_DIR', () => {
    const p = resolvePaths({ MARVIN_DRIVE_CONFIG_DIR: '/tmp/x' });
    expect(p.configDir).toBe('/tmp/x');
    expect(p.accounts).toBe('/tmp/x/accounts.json');
  });
});
