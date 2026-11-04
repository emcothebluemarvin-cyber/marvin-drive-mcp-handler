import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ConfigError } from '../errors.js';
import type { TokenStore } from './token-store.js';
import { renameReplacing } from '../files/rename-replacing.js';

interface TokenFile {
  version: 1;
  tokens: Record<string, string>;
}

/**
 * Refresh tokens in a 0600 JSON file (0700 directory) — for hosts without an OS
 * credential store, e.g. headless Linux servers. Opt in with MARVIN_DRIVE_TOKEN_STORE=file.
 */
export class FileTokenStore implements TokenStore {
  constructor(private readonly file: string) {}

  async get(email: string): Promise<string | null> {
    return (await this.read()).tokens[email] ?? null;
  }

  async set(email: string, refreshToken: string): Promise<void> {
    const data = await this.read();
    data.tokens[email] = refreshToken;
    await this.write(data);
  }

  async delete(email: string): Promise<void> {
    const data = await this.read();
    if (!(email in data.tokens)) return;
    delete data.tokens[email];
    await this.write(data);
  }

  private async read(): Promise<TokenFile> {
    let raw: string;
    try {
      raw = await readFile(this.file, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, tokens: {} };
      throw err;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new ConfigError(`Token file ${this.file} is not valid JSON.`, { cause: err });
    }
    if (!isTokenFile(parsed)) {
      throw new ConfigError(`Token file ${this.file} has an unexpected format.`);
    }
    return { version: 1, tokens: { ...parsed.tokens } };
  }

  private async write(data: TokenFile): Promise<void> {
    const dir = path.dirname(this.file);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await chmod(dir, 0o700);
    const tmp = `${this.file}.${process.pid}.tmp`;
    try {
      await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
      await renameReplacing(tmp, this.file);
    } catch (err) {
      await rm(tmp, { force: true });
      throw err;
    }
  }
}

function isTokenFile(value: unknown): value is TokenFile {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as { version?: unknown; tokens?: unknown };
  if (v.version !== 1 || typeof v.tokens !== 'object' || v.tokens === null) return false;
  return Object.values(v.tokens).every((t) => typeof t === 'string');
}
