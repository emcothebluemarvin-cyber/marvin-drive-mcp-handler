import { describe, expect, it } from 'vitest';
import { ConfigError } from '../../errors.js';
import { KeychainTokenStore, type KeyringEntry } from '../keychain-token-store.js';

const broken = (): KeyringEntry => {
  throw new Error('Platform secure storage failure: DBus error');
};

describe('KeychainTokenStore errors', () => {
  it('wraps keyring failures in a ConfigError pointing to the file store', async () => {
    const store = new KeychainTokenStore('svc', broken);
    for (const call of [store.get('a'), store.set('a', 'rt'), store.delete('a')]) {
      await expect(call).rejects.toThrow(ConfigError);
    }
    await expect(store.get('a')).rejects.toThrow('MARVIN_DRIVE_TOKEN_STORE=file');
  });
});
