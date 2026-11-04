import { describe, expect, it } from 'vitest';
import { ConfigError } from '../../errors.js';
import { FileTokenStore } from '../file-token-store.js';
import { KeychainTokenStore } from '../keychain-token-store.js';
import { selectTokenStore } from '../select-token-store.js';

const FILE = '/tmp/x/tokens.json';

describe('selectTokenStore', () => {
  it('defaults to the OS keychain', () => {
    expect(selectTokenStore({}, FILE)).toBeInstanceOf(KeychainTokenStore);
    expect(selectTokenStore({ MARVIN_DRIVE_TOKEN_STORE: '' }, FILE)).toBeInstanceOf(
      KeychainTokenStore,
    );
    expect(selectTokenStore({ MARVIN_DRIVE_TOKEN_STORE: 'keychain' }, FILE)).toBeInstanceOf(
      KeychainTokenStore,
    );
  });

  it('uses the file store when MARVIN_DRIVE_TOKEN_STORE=file', () => {
    expect(selectTokenStore({ MARVIN_DRIVE_TOKEN_STORE: 'file' }, FILE)).toBeInstanceOf(
      FileTokenStore,
    );
  });

  it('rejects unknown values', () => {
    expect(() => selectTokenStore({ MARVIN_DRIVE_TOKEN_STORE: 'vault' }, FILE)).toThrow(
      ConfigError,
    );
  });
});
