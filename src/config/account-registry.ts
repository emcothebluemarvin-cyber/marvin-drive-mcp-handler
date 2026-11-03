import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { AccountNotFoundError, ConfigError, ValidationError, hasErrorCode } from '../errors.js';

export const ALIAS_PATTERN = /^[a-z0-9-]{1,32}$/;

export interface AccountRecord {
  alias: string;
  email: string;
  addedAt: string;
}

export interface RegistryData {
  default: string | null;
  accounts: AccountRecord[];
}

const registrySchema = z.object({
  default: z.string().nullable(),
  accounts: z.array(
    z.object({
      alias: z.string().regex(ALIAS_PATTERN),
      email: z.string().includes('@'),
      addedAt: z.string(),
    }),
  ),
});

/** Alias derived from the email's local part, e.g. "john.doe@x" → "john-doe". */
export function defaultAlias(email: string): string {
  const local = (email.split('@')[0] ?? '').toLowerCase();
  const alias = local
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 32)
    .replace(/-$/, '');
  return alias === '' ? 'account' : alias;
}

function describeAccounts(accounts: AccountRecord[]): string {
  return accounts.length === 0
    ? 'none — run: marvin-drive auth add'
    : accounts.map((a) => `${a.alias} (${a.email})`).join(', ');
}

export class AccountRegistry {
  private cache: { mtimeMs: number; data: RegistryData } | null = null;

  constructor(private readonly file: string) {}

  async read(): Promise<RegistryData> {
    let mtimeMs: number;
    try {
      mtimeMs = (await stat(this.file)).mtimeMs;
    } catch (err) {
      if (hasErrorCode(err, 'ENOENT')) {
        this.cache = null;
        return { default: null, accounts: [] };
      }
      throw err;
    }
    if (this.cache && this.cache.mtimeMs === mtimeMs) return structuredClone(this.cache.data);

    let json: unknown;
    try {
      json = JSON.parse(await readFile(this.file, 'utf8'));
    } catch (err) {
      throw new ConfigError(`${this.file} is not valid JSON; fix or delete it.`, { cause: err });
    }
    const parsed = registrySchema.safeParse(json);
    if (!parsed.success) {
      throw new ConfigError(`${this.file} is corrupted; fix or delete it and re-add accounts.`);
    }
    this.cache = { mtimeMs, data: parsed.data };
    return structuredClone(parsed.data);
  }

  async find(ref: string): Promise<AccountRecord | undefined> {
    const needle = ref.trim().toLowerCase();
    const { accounts } = await this.read();
    return accounts.find((a) => a.alias === needle || a.email === needle);
  }

  /** Account by alias/email; without `ref`: the default, or the only account. */
  async resolve(ref?: string): Promise<AccountRecord> {
    const data = await this.read();
    if (ref !== undefined) {
      const found = await this.find(ref);
      if (!found) {
        throw new AccountNotFoundError(
          `Unknown account "${ref}". Registered: ${describeAccounts(data.accounts)}`,
        );
      }
      return found;
    }
    const byDefault = data.accounts.find((a) => a.alias === data.default);
    if (byDefault) return byDefault;
    if (data.accounts.length === 1 && data.accounts[0]) return data.accounts[0];
    if (data.accounts.length === 0) {
      throw new AccountNotFoundError('No accounts registered. Run: marvin-drive auth add');
    }
    throw new AccountNotFoundError(
      `No default account. Pass "account" or run: marvin-drive auth default <alias>. Registered: ${describeAccounts(data.accounts)}`,
    );
  }

  async add(
    input: { alias: string; email: string },
    now: Date = new Date(),
  ): Promise<AccountRecord> {
    const alias = input.alias.trim().toLowerCase();
    const email = input.email.trim().toLowerCase();
    if (!ALIAS_PATTERN.test(alias)) {
      throw new ValidationError(`Alias must match ${ALIAS_PATTERN.source} (got "${input.alias}")`);
    }
    const data = await this.read();
    const sameEmail = data.accounts.find((a) => a.email === email);
    if (sameEmail) {
      throw new ValidationError(
        `${email} is already registered as "${sameEmail.alias}"; use: marvin-drive auth login ${sameEmail.alias}`,
      );
    }
    const sameAlias = data.accounts.find((a) => a.alias === alias);
    if (sameAlias) {
      throw new ValidationError(
        `Alias "${alias}" is already used by ${sameAlias.email}; pass --alias <name>`,
      );
    }
    const record: AccountRecord = { alias, email, addedAt: now.toISOString() };
    data.accounts.push(record);
    data.default ??= alias;
    await this.write(data);
    return record;
  }

  async remove(ref: string): Promise<AccountRecord> {
    const record = await this.resolve(ref);
    const data = await this.read();
    data.accounts = data.accounts.filter((a) => a.alias !== record.alias);
    if (data.default === record.alias) data.default = data.accounts[0]?.alias ?? null;
    await this.write(data);
    return record;
  }

  async setDefault(ref: string): Promise<AccountRecord> {
    const record = await this.resolve(ref);
    const data = await this.read();
    data.default = record.alias;
    await this.write(data);
    return record;
  }

  private async write(data: RegistryData): Promise<void> {
    await mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${process.pid}.tmp`;
    await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
    await rename(tmp, this.file);
    this.cache = null;
  }
}
