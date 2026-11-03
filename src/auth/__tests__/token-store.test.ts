import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { KeychainTokenStore } from '../keychain-token-store.js';
import { InMemoryTokenStore, type TokenStore } from '../token-store.js';

async function exercise(store: TokenStore, email: string): Promise<void> {
  await expect(store.get(email)).resolves.toBeNull();
  await store.set(email, 'rt-1');
  await expect(store.get(email)).resolves.toBe('rt-1');
  await store.set(email, 'rt-2');
  await expect(store.get(email)).resolves.toBe('rt-2');
  await store.delete(email);
  await expect(store.get(email)).resolves.toBeNull();
  await expect(store.delete(email)).resolves.toBeUndefined(); // idempotent
}

describe('InMemoryTokenStore', () => {
  it('stores, replaces and deletes tokens', async () => {
    await exercise(new InMemoryTokenStore(), 'a@example.com');
  });
});

describe.runIf(process.env.MARVIN_KEYCHAIN_TEST === '1')(
  'KeychainTokenStore (real Keychain)',
  () => {
    it('stores, replaces and deletes tokens', async () => {
      const store = new KeychainTokenStore('marvin-drive-test');
      await exercise(store, `test-${randomUUID()}@example.com`);
    });
  },
);
