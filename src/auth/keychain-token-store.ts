import { Entry } from '@napi-rs/keyring';
import type { TokenStore } from './token-store.js';

export const KEYCHAIN_SERVICE = 'marvin-drive';

/** macOS Keychain (service "marvin-drive", account = email). */
export class KeychainTokenStore implements TokenStore {
  constructor(private readonly service: string = KEYCHAIN_SERVICE) {}

  async get(email: string): Promise<string | null> {
    return new Entry(this.service, email).getPassword() ?? null;
  }

  async set(email: string, refreshToken: string): Promise<void> {
    new Entry(this.service, email).setPassword(refreshToken);
  }

  async delete(email: string): Promise<void> {
    // deletePassword() returns false when nothing was stored; that is fine.
    new Entry(this.service, email).deletePassword();
  }
}
