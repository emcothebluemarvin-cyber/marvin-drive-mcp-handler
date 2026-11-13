import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../app.js';
import { AccountRegistry } from '../config/account-registry.js';
import { ProviderNotSupportedError } from '../errors.js';
import { writeMarker } from '../sync/pair-store.js';
import { FileRouter } from '../files/file-router.js';
import { WatchService } from '../watch/watch-service.js';

vi.mock('../sync/pair-store.js', async (original) => {
  const actual = await original<typeof import('../sync/pair-store.js')>();
  return { ...actual, writeMarker: vi.fn(actual.writeMarker) };
});

let tmp: string;
beforeEach(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), 'app-'));
});
afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe('buildApp', () => {
  it('routes a Microsoft account in sync to OneDrive, failing before writeMarker', async () => {
    const app = buildApp({ MARVIN_DRIVE_CONFIG_DIR: tmp, MARVIN_DRIVE_TOKEN_STORE: 'file' });
    await new AccountRegistry(app.paths.accounts).add({
      alias: 'ms',
      email: 'a@b.c',
      provider: 'microsoft',
      accountId: 't.o',
    });
    const localDir = path.join(tmp, 'Local');
    await mkdir(localDir);
    // No Microsoft client or token here: the first Graph call (the delta cursor) fails.
    const failure = await app.sync
      .createPair({ name: 'docs', localDir, remoteFolderId: 'R', account: 'ms' })
      .then(
        () => null,
        (err: unknown) => err,
      );
    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toBeInstanceOf(ProviderNotSupportedError);
    expect(writeMarker).not.toHaveBeenCalled();
  });

  it('routes file operations through the FileRouter', () => {
    const app = buildApp({ MARVIN_DRIVE_CONFIG_DIR: tmp, MARVIN_DRIVE_TOKEN_STORE: 'file' });
    expect(app.files).toBeInstanceOf(FileRouter);
    expect(app.paths.microsoftClient).toBe(path.join(tmp, 'microsoft-client.json'));
  });

  it('wires the watch service under <configDir>/watch', () => {
    const app = buildApp({ MARVIN_DRIVE_CONFIG_DIR: tmp, MARVIN_DRIVE_TOKEN_STORE: 'file' });
    expect(app.watch).toBeInstanceOf(WatchService);
    expect(app.watch.inbox.file).toBe(path.join(tmp, 'watch', 'inbox.jsonl'));
  });
});
