import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { expectMode } from '../../__tests__/fs-mode.js';
import { FileLockBusyError } from '../../core/file-lock.js';
import { ValidationError } from '../../errors.js';
import { silentLogger } from '../../files/__tests__/fakes.js';
import { UNKNOWN_READ_SEQ, emptyState, type AccountState } from '../types.js';
import { WatchStore } from '../watch-store.js';
import { fileEntry } from './fakes.js';

const EMAIL = 'me@example.com';
let tmp: string;
let dir: string;
const store = (over: { isAlive?: (pid: number) => boolean } = {}): WatchStore =>
  new WatchStore({ dir, logger: silentLogger(), ...over });

beforeEach(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), 'watch-store-'));
  dir = path.join(tmp, 'watch');
});
afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

function withEntry(): AccountState {
  return { ...emptyState(), entries: [fileEntry()], cursor: 'c1' };
}

describe('WatchStore state files', () => {
  it('loads an empty state for an unknown account and lists no accounts', async () => {
    expect(await store().load(EMAIL)).toEqual(emptyState());
    expect(await store().accounts()).toEqual([]);
  });

  it('saves atomically (0600 file, 0700 dir) with a version and loads it back', async () => {
    const s = store();
    await s.save(EMAIL, withEntry());
    const file = path.join(dir, `${EMAIL}.json`);
    expect(JSON.parse(await readFile(file, 'utf8'))).toMatchObject({ version: 1, cursor: 'c1' });
    await expectMode(file, 0o600);
    await expectMode(dir, 0o700);
    expect(await s.load(EMAIL)).toEqual(withEntry());
  });

  it('rejects unsafe account names and file ids', async () => {
    await expect(store().load('../evil')).rejects.toBeInstanceOf(ValidationError);
    await expect(store().loadSnapshot(EMAIL, '../x')).rejects.toBeInstanceOf(ValidationError);
  });

  it('reports invalid JSON and invalid content', async () => {
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, `${EMAIL}.json`), '{');
    await expect(store().load(EMAIL)).rejects.toThrow('not valid JSON');
    await writeFile(path.join(dir, `${EMAIL}.json`), JSON.stringify({ version: 1 }));
    await expect(store().load(EMAIL)).rejects.toThrow('is invalid');
  });

  it('lists only account state files', async () => {
    const s = store();
    await s.save(EMAIL, withEntry());
    await s.save('b@example.com', emptyState());
    await s.saveRead({ readSeq: 1, readIds: [], pushedSeq: 0 });
    await s.saveDelivery('channel');
    await writeFile(path.join(dir, 'inbox.jsonl'), '');
    expect(await s.accounts()).toEqual(['b@example.com', EMAIL]);
  });
});

describe('WatchStore snapshots, read state and config', () => {
  it('round-trips snapshots and drops corrupt ones', async () => {
    const s = store();
    const snap = { takenAt: 't', snapshot: { type: 'text' as const, text: 'hello' } };
    await s.saveSnapshot(EMAIL, 'D', snap);
    expect(await s.loadSnapshot(EMAIL, 'D')).toEqual(snap);
    await expectMode(path.join(dir, 'snapshots', EMAIL, 'D.json'), 0o600);
    await writeFile(path.join(dir, 'snapshots', EMAIL, 'D.json'), '{"takenAt":1}');
    expect(await s.loadSnapshot(EMAIL, 'D')).toBeNull();
    await s.removeSnapshot(EMAIL, 'D');
    expect(await s.loadSnapshot(EMAIL, 'D')).toBeNull();
  });

  it('defaults read state and delivery mode', async () => {
    const s = store();
    expect(await s.loadRead()).toEqual({ readSeq: 0, readIds: [], pushedSeq: 0 });
    expect(await s.loadDelivery()).toBe('hook');
    await s.saveRead({ readSeq: 3, readIds: [{ id: 'x', seq: 4 }], pushedSeq: 2 });
    await s.saveDelivery('channel');
    expect(await s.loadRead()).toEqual({
      readSeq: 3,
      readIds: [{ id: 'x', seq: 4 }],
      pushedSeq: 2,
    });
    expect(await s.loadDelivery()).toBe('channel');
  });
});

describe('WatchStore.withLock', () => {
  it('serializes concurrent critical sections', async () => {
    const s = store();
    const order: string[] = [];
    await Promise.all([
      s.withLock(async () => {
        order.push('a1');
        await new Promise((r) => setTimeout(r, 30));
        order.push('a2');
      }),
      s.withLock(async () => {
        order.push('b1');
        order.push('b2');
      }),
    ]);
    expect(order.join()).toMatch(/^(a1,a2,b1,b2|b1,b2,a1,a2)$/);
  });

  it('gives up after the timeout while a live process holds the lock', async () => {
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'watch.lock'), JSON.stringify({ pid: process.pid }));
    await expect(store().withLock(async () => 1, 50)).rejects.toBeInstanceOf(FileLockBusyError);
  });

  it('breaks the lock of a dead process', async () => {
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'watch.lock'), JSON.stringify({ pid: 999_999 }));
    await expect(store({ isAlive: () => false }).withLock(async () => 7)).resolves.toBe(7);
  });
});

describe('WatchStore.hasEntries', () => {
  it('is false without a directory or without entries, true after an external add', async () => {
    const reader = store();
    expect(await reader.hasEntries()).toBe(false);
    await store().save(EMAIL, emptyState());
    expect(await reader.hasEntries()).toBe(false);
    await new Promise((r) => setTimeout(r, 5));
    await store().save(EMAIL, withEntry()); // another process (CLI) adds a watch
    expect(await reader.hasEntries()).toBe(true);
  });
});

describe('WatchStore review fixes', () => {
  it('reads legacy string read ids with an unknown seq', async () => {
    await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(dir, 'read.json'),
      JSON.stringify({ readSeq: 2, readIds: ['old'], pushedSeq: 1 }),
    );
    expect(await store().loadRead()).toEqual({
      readSeq: 2,
      readIds: [{ id: 'old', seq: UNKNOWN_READ_SEQ }],
      pushedSeq: 1,
    });
  });

  it('judges an unreadable lock by the real clock, not the injected one', async () => {
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'watch.lock'), '');
    const future = new WatchStore({
      dir,
      logger: silentLogger(),
      now: () => new Date(Date.now() + 2 * 60 * 60 * 1000),
    });
    await expect(future.withLock(async () => 1, 50)).rejects.toBeInstanceOf(FileLockBusyError);
  });

  it('rejects email characters that are unsafe in file names', async () => {
    for (const bad of [
      'a:b@c.d',
      'a*@c.d',
      'a?@c.d',
      'a"@c.d',
      'a|b@c.d',
      'a@c\u0001.d',
      'a@c<.d',
    ]) {
      await expect(store().load(bad)).rejects.toBeInstanceOf(ValidationError);
    }
  });

  it('sweeps temp files older than an hour from the watch and snapshot dirs', async () => {
    const snapDir = path.join(dir, 'snapshots', EMAIL);
    await mkdir(snapDir, { recursive: true });
    const old = [path.join(dir, '.me.json.a.tmp'), path.join(snapDir, '.D.json.b.tmp')];
    const young = path.join(dir, '.me.json.c.tmp');
    const keep = path.join(dir, 'old.json');
    const hoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    for (const f of [...old, young, keep]) await writeFile(f, 'x');
    for (const f of [...old, keep]) await utimes(f, hoursAgo, hoursAgo);
    await store().save(EMAIL, emptyState());
    for (const f of old) await expect(stat(f)).rejects.toThrow();
    await expect(stat(young)).resolves.toBeDefined();
    await expect(stat(keep)).resolves.toBeDefined();
  });
});
