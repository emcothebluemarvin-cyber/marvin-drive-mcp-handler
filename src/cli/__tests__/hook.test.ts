import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Inbox } from '../../watch/inbox.js';
import { HOOK_LIMIT, PREAMBLE_MANY } from '../../watch/render.js';
import { WatchStore } from '../../watch/watch-store.js';
import { makeEvent } from '../../watch/__tests__/fakes.js';
import { silentLogger } from '../../files/__tests__/fakes.js';
import { runHookCli } from '../hook.js';

let configDir: string;
let watchDir: string;
let store: WatchStore;
let inbox: Inbox;
let out: string[];
let err: string[];

const env = (): NodeJS.ProcessEnv => ({ MARVIN_DRIVE_CONFIG_DIR: configDir });
const run = (): Promise<void> =>
  runHookCli(
    env(),
    (t) => out.push(t),
    (t) => err.push(t),
  );

beforeEach(async () => {
  configDir = await mkdtemp(path.join(os.tmpdir(), 'hook-'));
  watchDir = path.join(configDir, 'watch');
  store = new WatchStore({ dir: watchDir, logger: silentLogger() });
  inbox = new Inbox(path.join(watchDir, 'inbox.jsonl'));
  out = [];
  err = [];
  process.exitCode = undefined;
});
afterEach(async () => {
  process.exitCode = undefined;
  await rm(configDir, { recursive: true, force: true });
});

function parsed(): { hookSpecificOutput: { hookEventName: string; additionalContext: string } } {
  return JSON.parse(out.join('')) as never;
}

describe('marvin-drive changes --hook', () => {
  it('prints unread foreign events as UserPromptSubmit context and marks them read', async () => {
    await inbox.append(makeEvent({ seq: 1 }));
    await inbox.append(makeEvent({ seq: 2, own: true }));
    await run();
    const res = parsed();
    expect(res.hookSpecificOutput.hookEventName).toBe('UserPromptSubmit');
    expect(res.hookSpecificOutput.additionalContext.startsWith(PREAMBLE_MANY)).toBe(true);
    expect(res.hookSpecificOutput.additionalContext).toContain('edited "Plan" by Ayşe Demir');
    expect(out.join('').endsWith('\n')).toBe(true);
    expect((await store.loadRead()).readSeq).toBe(1);
    out = [];
    await run();
    expect(out).toEqual([]);
    expect(process.exitCode).toBe(0);
  });

  it(`caps the context at ${HOOK_LIMIT} characters and counts the rest`, async () => {
    const diff = Array.from({ length: 300 }, (_, i) => `+ line ${i}`).join('\n');
    for (let i = 1; i <= 40; i++) await inbox.append(makeEvent({ seq: i, diff }));
    await run();
    const text = parsed().hookSpecificOutput.additionalContext;
    expect(text.length).toBeLessThanOrEqual(HOOK_LIMIT);
    expect(text).toMatch(/… \d+ more Drive changes; use drive_changes$/);
  });

  it('prints nothing in channel mode', async () => {
    await store.saveDelivery('channel');
    await inbox.append(makeEvent({ seq: 1 }));
    await run();
    expect(out).toEqual([]);
    expect((await store.loadRead()).readSeq).toBe(0);
  });

  it('prints without marking read when watch.lock stays busy', async () => {
    await inbox.append(makeEvent({ seq: 1 }));
    await mkdir(watchDir, { recursive: true });
    await writeFile(path.join(watchDir, 'watch.lock'), JSON.stringify({ pid: process.pid }));
    await run();
    expect(parsed().hookSpecificOutput.additionalContext).toContain('edited "Plan"');
    await rm(path.join(watchDir, 'watch.lock'));
    expect((await store.loadRead()).readSeq).toBe(0);
  });

  it('never fails the prompt: corrupt state → message on stderr, exit 0', async () => {
    await mkdir(watchDir, { recursive: true });
    await writeFile(path.join(watchDir, 'config.json'), '{');
    await run();
    expect(out).toEqual([]);
    expect(err.join('')).toContain('marvin-drive changes --hook');
    expect(process.exitCode).toBe(0);
  });

  it('is fast (target < 200 ms, budget 1 s) with a full inbox', async () => {
    await mkdir(watchDir, { recursive: true });
    const lines = Array.from({ length: 1000 }, (_, i) => JSON.stringify(makeEvent({ seq: i + 1 })));
    await writeFile(inbox.file, `${lines.join('\n')}\n`);
    const t0 = performance.now();
    await run();
    expect(performance.now() - t0).toBeLessThan(1000);
    expect(out).toHaveLength(1);
  });
});
