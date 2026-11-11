import { chmod, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { AccountNotFoundError, ConfigError, ValidationError, hasErrorCode } from '../errors.js';
import { renameReplacing } from '../files/rename-replacing.js';

export const ALIAS_PATTERN = /^[a-z0-9-]{1,32}$/;

const EMAIL_PATTERN = /^[^@\s]+@[^@\s]+$/;

export type AccountProvider = 'google' | 'microsoft';

export interface AccountRecord {
  alias: string;
  /** Google: the identity. Microsoft: the display address only (see `accountId`). */
  email: string;
  addedAt: string;
  /** Absent means `google`. */
  provider?: AccountProvider;
  /** Microsoft only: `<tid>.<oid>`, the account's identity. */
  accountId?: string;
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
      provider: z.enum(['google', 'microsoft']).optional(),
      accountId: z.string().min(1).optional(),
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

export function providerOf(record: AccountRecord): AccountProvider {
  return record.provider ?? 'google';
}

export function isMicrosoft(record: AccountRecord): boolean {
  return providerOf(record) === 'microsoft';
}

/** The only way to derive a token store key (spec §3.2). */
export function tokenKey(record: AccountRecord): string {
  if (!isMicrosoft(record)) return record.email;
  if (!record.accountId) {
    throw new ConfigError(`Microsoft account "${record.alias}" has no accountId; add it again.`);
  }
  return `microsoft:${record.accountId}`;
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

  private unknown(ref: string, data: RegistryData): AccountNotFoundError {
    return new AccountNotFoundError(
      `Unknown account "${ref}". Registered: ${describeAccounts(data.accounts)}`,
    );
  }

  private matching(ref: string, data: RegistryData): AccountRecord[] {
    const needle = ref.trim().toLowerCase();
    return data.accounts.filter((a) => a.alias === needle || a.email === needle);
  }

  /**
   * Where both providers are valid. An email shared by several accounts is an error listing
   * the aliases. Without `ref`: the default, or the only account.
   */
  async resolve(ref?: string): Promise<AccountRecord> {
    const data = await this.read();
    if (ref !== undefined) {
      const found = this.matching(ref, data);
      const [first] = found;
      if (!first) throw this.unknown(ref, data);
      if (found.length > 1) {
        const aliases = found.map((a) => a.alias).join(', ');
        throw new ValidationError(`"${ref}" matches several accounts (${aliases}); use an alias.`);
      }
      return first;
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

  /** For Google-only surfaces: an email means the Google account of that address (spec §3.2). */
  async resolveGoogleFirst(ref?: string): Promise<AccountRecord> {
    if (ref === undefined) return this.resolve();
    const data = await this.read();
    const found = this.matching(ref, data);
    const [first] = found;
    if (!first) throw this.unknown(ref, data);
    return found.find((a) => !isMicrosoft(a)) ?? first;
  }

  async add(
    input: {
      alias: string;
      email: string;
      provider?: AccountProvider;
      accountId?: string;
    },
    now: Date = new Date(),
  ): Promise<AccountRecord> {
    const alias = input.alias.trim().toLowerCase();
    const email = input.email.trim().toLowerCase();
    if (!ALIAS_PATTERN.test(alias)) {
      throw new ValidationError(`Alias must match ${ALIAS_PATTERN.source} (got "${input.alias}")`);
    }
    if (!EMAIL_PATTERN.test(email)) {
      throw new ValidationError(`"${input.email}" is not a valid email address`);
    }
    const microsoft = input.provider === 'microsoft';
    if (microsoft && !input.accountId) {
      throw new ValidationError('A Microsoft account needs an accountId');
    }
    const data = await this.read();
    const sameIdentity = data.accounts.find((a) =>
      microsoft ? a.accountId === input.accountId : !isMicrosoft(a) && a.email === email,
    );
    if (sameIdentity) {
      throw new ValidationError(
        `${email} is already registered as "${sameIdentity.alias}"; use: marvin-drive auth login ${sameIdentity.alias}`,
      );
    }
    const sameAlias = data.accounts.find((a) => a.alias === alias);
    if (sameAlias) {
      throw new ValidationError(
        `Alias "${alias}" is already used by ${sameAlias.email}; pass --alias <name>`,
      );
    }
    const record: AccountRecord = {
      alias,
      email,
      addedAt: now.toISOString(),
      ...(microsoft ? { provider: 'microsoft' as const, accountId: input.accountId ?? '' } : {}),
    };
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
    this.cache = null;
  }
}
