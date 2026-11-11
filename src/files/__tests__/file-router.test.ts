import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AccountRegistry } from '../../config/account-registry.js';
import { AccountNotFoundError, ValidationError } from '../../errors.js';
import type { FileProvider } from '../file-provider.js';
import { FileRouter } from '../file-router.js';

const METHODS = [
  'list',
  'search',
  'getMetadata',
  'createFolder',
  'move',
  'rename',
  'copy',
  'delete',
  'restore',
  'upload',
  'download',
] as const;

function fakeProvider(): FileProvider {
  return Object.fromEntries(
    METHODS.map((m) => [m, vi.fn(async () => ({ from: m }))]),
  ) as unknown as FileProvider;
}

const INPUTS = { fileId: 'f', name: 'n', newName: 'x', newParentId: 'p', localPath: '/a', q: 'q' };
let registry: AccountRegistry;
let google: FileProvider;
let microsoft: FileProvider;
let router: FileRouter;

beforeEach(async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'router-'));
  registry = new AccountRegistry(path.join(dir, 'a.json'));
  await registry.add({ alias: 'g', email: 'same@example.com' });
  await registry.add({
    alias: 'ms',
    email: 'same@example.com',
    provider: 'microsoft',
    accountId: 't.o',
  });
  google = fakeProvider();
  microsoft = fakeProvider();
  router = new FileRouter({ registry, google, microsoft });
});

describe('FileRouter', () => {
  it.each(METHODS)('%s goes to the account provider with the alias', async (method) => {
    const call = router[method] as (i: unknown, o?: unknown) => Promise<unknown>;
    await call.call(router, { ...INPUTS, account: 'ms' });
    expect(microsoft[method]).toHaveBeenCalledWith(
      expect.objectContaining({ account: 'ms' }),
      ...(method === 'upload' ? [undefined] : []),
    );
    expect(google[method]).not.toHaveBeenCalled();
    await call.call(router, { ...INPUTS, account: 'g' });
    expect(google[method]).toHaveBeenCalledWith(
      expect.objectContaining({ account: 'g' }),
      ...(method === 'upload' ? [undefined] : []),
    );
  });

  it('uses the default account when none is given', async () => {
    await router.list({});
    expect(google.list).toHaveBeenCalledWith({ account: 'g' });
  });

  it('passes the upload options on', async () => {
    const confirmReplace = async (): Promise<'cancel'> => 'cancel';
    await router.upload({ localPath: '/a', account: 'ms' }, { confirmReplace });
    expect(microsoft.upload).toHaveBeenCalledWith(
      { localPath: '/a', account: 'ms' },
      { confirmReplace },
    );
  });

  it('rejects an email shared by several accounts, naming the aliases', async () => {
    await expect(router.list({ account: 'same@example.com' })).rejects.toThrow(ValidationError);
    await expect(router.list({ account: 'same@example.com' })).rejects.toThrow(/g, ms/);
  });

  it('reports an unknown account', async () => {
    await expect(router.list({ account: 'nobody' })).rejects.toThrow(AccountNotFoundError);
  });
});
