import type { AccountRecord } from '../config/account-registry.js';
import type { PendingLogin } from './pending-login.js';

export type AccountStatus = 'ok' | 'reauth_required' | 'unknown';

/** What a non-Google sign-in provider implements; `AuthService` dispatches to it (spec §3.4). */
export interface ProviderAuth {
  add(alias?: string): Promise<AccountRecord>;
  startAdd(alias?: string): Promise<string>;
  finishAdd(pending: PendingLogin, redirectUrl: string): Promise<AccountRecord>;
  relogin(record: AccountRecord): Promise<AccountRecord>;
  startRelogin(record: AccountRecord): Promise<string>;
  finishRelogin(
    record: AccountRecord,
    pending: PendingLogin,
    redirectUrl: string,
  ): Promise<AccountRecord>;
  checkStatus(record: AccountRecord, verify: boolean): Promise<AccountStatus>;
  forget(record: AccountRecord): Promise<void>;
}
