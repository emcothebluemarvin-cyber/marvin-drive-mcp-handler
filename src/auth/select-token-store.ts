import { ConfigError } from '../errors.js';
import { FileTokenStore } from './file-token-store.js';
import { KeychainTokenStore } from './keychain-token-store.js';
import type { TokenStore } from './token-store.js';

/** MARVIN_DRIVE_TOKEN_STORE: "keychain" (default) or "file". */
export function selectTokenStore(env: NodeJS.ProcessEnv, tokensFile: string): TokenStore {
  const kind = env.MARVIN_DRIVE_TOKEN_STORE || 'keychain';
  if (kind === 'keychain') return new KeychainTokenStore();
  if (kind === 'file') return new FileTokenStore(tokensFile);
  throw new ConfigError(`Unknown MARVIN_DRIVE_TOKEN_STORE "${kind}"; use "keychain" or "file".`);
}
