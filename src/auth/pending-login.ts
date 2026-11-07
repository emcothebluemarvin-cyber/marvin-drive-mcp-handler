import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { AuthFlowError, ConfigError, hasErrorCode } from '../errors.js';
import { renameReplacing } from '../files/rename-replacing.js';

/** How long a printed login URL can be completed with --redirect-url. */
export const PENDING_LOGIN_TTL_MS = 10 * 60_000;

/** A login started with --print-url, waiting for the redirect URL (two-step no-browser login). */
export interface PendingLogin {
  state: string;
  codeVerifier: string;
  redirectUri: string;
  /** `add`: the alias asked for (null = derived from the email); `login`: the account's email. */
  command: 'add' | 'login';
  account: string | null;
  createdAt: string;
}

interface PendingFile {
  version: 1;
  logins: PendingLogin[];
}

/**
 * Pending two-step logins in a 0600 JSON file (0700 directory). An entry holds the PKCE
 * verifier, so it is kept only until it is used once or expires after 10 minutes.
 */
export class PendingLoginStore {
  constructor(
    private readonly file: string,
    private readonly now: () => Date = (): Date => new Date(),
  ) {}

  async save(entry: Omit<PendingLogin, 'createdAt'>): Promise<void> {
    const logins = this.fresh(await this.read());
    logins.push({ ...entry, createdAt: this.now().toISOString() });
    await this.write(logins);
  }

  /**
   * Removes and returns the login for `state`. The authorization code is single-use, so the
   * entry is gone afterwards whatever happens next. Null when no such login was started.
   */
  async take(state: string): Promise<PendingLogin | null> {
    const all = await this.read();
    const found = all.find((l) => l.state === state) ?? null;
    const rest = this.fresh(all.filter((l) => l !== found));
    if (found || rest.length !== all.length) await this.write(rest);
    if (found && this.expired(found)) {
      throw new AuthFlowError(
        'This login link expired (it is valid for 10 minutes). Run the command with --print-url again.',
      );
    }
    return found;
  }

  private expired(l: PendingLogin): boolean {
    return this.now().getTime() - Date.parse(l.createdAt) > PENDING_LOGIN_TTL_MS;
  }

  private fresh(logins: PendingLogin[]): PendingLogin[] {
    return logins.filter((l) => !this.expired(l));
  }

  private async read(): Promise<PendingLogin[]> {
    let raw: string;
    try {
      raw = await readFile(this.file, 'utf8');
    } catch (err) {
      if (hasErrorCode(err, 'ENOENT')) return [];
      throw err;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new ConfigError(`Pending login file ${this.file} is not valid JSON; delete it.`, {
        cause: err,
      });
    }
    if (!isPendingFile(parsed)) {
      throw new ConfigError(`Pending login file ${this.file} has an unexpected format; delete it.`);
    }
    return parsed.logins;
  }

  private async write(logins: PendingLogin[]): Promise<void> {
    if (logins.length === 0) {
      await rm(this.file, { force: true });
      return;
    }
    const dir = path.dirname(this.file);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await chmod(dir, 0o700);
    const data: PendingFile = { version: 1, logins };
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

function isPendingFile(value: unknown): value is PendingFile {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as { version?: unknown; logins?: unknown };
  if (v.version !== 1 || !Array.isArray(v.logins)) return false;
  return v.logins.every((l: unknown) => {
    if (typeof l !== 'object' || l === null) return false;
    const e = l as Record<string, unknown>;
    return (
      typeof e.state === 'string' &&
      typeof e.codeVerifier === 'string' &&
      typeof e.redirectUri === 'string' &&
      (e.command === 'add' || e.command === 'login') &&
      (e.account === null || typeof e.account === 'string') &&
      typeof e.createdAt === 'string'
    );
  });
}
