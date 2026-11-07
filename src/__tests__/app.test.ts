import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { WatchService } from '../watch/watch-service.js';

let tmp: string;
beforeEach(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), 'app-'));
});
afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe('buildApp', () => {
  it('wires the watch service under <configDir>/watch', () => {
    const app = buildApp({ MARVIN_DRIVE_CONFIG_DIR: tmp, MARVIN_DRIVE_TOKEN_STORE: 'file' });
    expect(app.watch).toBeInstanceOf(WatchService);
    expect(app.watch.inbox.file).toBe(path.join(tmp, 'watch', 'inbox.jsonl'));
  });
});
