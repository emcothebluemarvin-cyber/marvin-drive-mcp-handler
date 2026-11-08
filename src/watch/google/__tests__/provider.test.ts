import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { AccountRegistry } from '../../../config/account-registry.js';
import { ProviderNotSupportedError } from '../../../errors.js';
import {
  createAudit,
  createFakeDrive,
  createRunner,
  silentLogger,
} from '../../../files/__tests__/fakes.js';
import { emptyState, type WatchEntry } from '../../types.js';
import { listWatches, removeWatch } from '../../watch-list.js';
import { WatchStore } from '../../watch-store.js';
import { createGoogleWatchProvider } from '../provider.js';

const SHARED = 'same@example.com';
const ENTRY: WatchEntry = {
  id: 'f1',
  name: 'File',
  kind: 'other',
  folder: false,
  addedAt: '2026-01-01T00:00:00.000Z',
};

let registry: AccountRegistry;
let store: WatchStore;
let deps: Parameters<typeof removeWatch>[0];

beforeEach(async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'watch-provider-'));
  registry = new AccountRegistry(path.join(dir, 'a.json'));
  await registry.add({ alias: 'g', email: SHARED });
  await registry.add({ alias: 'ms', email: SHARED, provider: 'microsoft', accountId: 't.o' });
  store = new WatchStore({ dir: path.join(dir, 'watch') });
  await store.ensureDir();
  await store.save(SHARED, { ...emptyState(), entries: [ENTRY] });
  deps = {
    store,
    provider: createGoogleWatchProvider({
      runner: createRunner(createFakeDrive()),
      audit: createAudit(),
      resolveAccount: (ref) => registry.resolveGoogleFirst(ref),
      logger: silentLogger(),
    }),
    now: () => new Date(),
    log: silentLogger(),
  };
});

describe('Google watch provider with Microsoft accounts (spec §3.3)', () => {
  it('rejects a Microsoft alias', async () => {
    await expect(deps.provider.resolveAccount('ms')).rejects.toThrow(ProviderNotSupportedError);
  });

  it('remove with the Microsoft alias leaves the Google watch of the same address alone', async () => {
    await expect(removeWatch(deps, { fileId: 'f1', account: 'ms' })).rejects.toThrow(
      ProviderNotSupportedError,
    );
    expect((await store.load(SHARED)).entries).toHaveLength(1);
  });

  it('list with the Microsoft alias is rejected too', async () => {
    await expect(listWatches(deps, { account: 'ms' })).rejects.toThrow(ProviderNotSupportedError);
  });

  it('the shared address means the Google account', async () => {
    await expect(removeWatch(deps, { fileId: 'f1', account: SHARED })).resolves.toMatchObject({
      action: 'remove',
    });
    expect((await store.load(SHARED)).entries).toEqual([]);
  });
});
