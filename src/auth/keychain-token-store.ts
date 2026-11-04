import { Entry } from '@napi-rs/keyring';
import { ConfigError } from '../errors.js';
import type { TokenStore } from './token-store.js';

export const KEYCHAIN_SERVICE = 'marvin-drive';

export interface KeyringEntry {
  getPassword(): string | null | undefined;
  setPassword(password: string): void;
  deletePassword(): boolean;
}

export type KeyringEntryFactory = (service: string, account: string) => KeyringEntry;

const defaultEntry: KeyringEntryFactory = (service, account) => new Entry(service, account);

/** OS credential store (macOS Keychain, Windows Credential Manager, Linux Secret Service). */
export class KeychainTokenStore implements TokenStore {
  constructor(
    private readonly service: string = KEYCHAIN_SERVICE,
    private readonly entry: KeyringEntryFactory = defaultEntry,
  ) {}

  async get(email: string): Promise<string | null> {
    return this.call(() => this.entry(this.service, email).getPassword() ?? null);
  }

  async set(email: string, refreshToken: string): Promise<void> {
    this.call(() => this.entry(this.service, email).setPassword(refreshToken));
  }

  async delete(email: string): Promise<void> {
    // deletePassword() returns false when nothing was stored; that is fine.
    this.call(() => this.entry(this.service, email).deletePassword());
  }

  private call<T>(fn: () => T): T {
    try {
      return fn();
    } catch (err) {
      throw new ConfigError(
        `OS credential store unavailable (${err instanceof Error ? err.message : String(err)}). ` +
          'On a headless server set MARVIN_DRIVE_TOKEN_STORE=file to keep tokens in the config directory.',
        { cause: err },
      );
    }
  }
}
