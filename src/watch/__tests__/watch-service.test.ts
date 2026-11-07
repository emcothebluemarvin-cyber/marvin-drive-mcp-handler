import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ValidationError } from '../../errors.js';
import { silentLogger } from '../../files/__tests__/fakes.js';
import { QUIET_MS } from '../coalesce.js';
import type { PushFn } from '../delivery.js';
import { PollerLease } from '../lease.js';
import { WatchService, pollIntervalMs } from '../watch-service.js';
import { WatchStore } from '../watch-store.js';
import {
  AYSE,
  ME,
  MemoryFeed,
  MemorySnapshotter,
  memoryProvider,
  testClock,
  textSnap,
} from './fakes.js';

const INTERVAL = 30_000;
let dir: string;
let feed: MemoryFeed;
let snap: MemorySnapshotter;
let clock: ReturnType<typeof testClock>;
let alive: Set<number>;
const services: WatchService[] = [];

function session(pid: number): WatchService {
  const logger = silentLogger();
  const svc = new WatchService({
    store: new WatchStore({ dir, logger }),
    provider: memoryProvider(feed, snap),
    intervalMs: INTERVAL,
    now: clock.now,
    logger,
    lease: new PollerLease({
      dir,
      intervalMs: INTERVAL,
      now: clock.now,
      pid,
      host: 'h',
      isAlive: (p) => alive.has(p),
      logger,
    }),
  });
  services.push(svc);
  alive.add(pid);
  return svc;
}

function edit(modifier = AYSE): void {
  feed.put('D', { modifiedTime: clock.now().toISOString(), modifier });
  snap.content.set('D', textSnap('a\nB\n'));
}

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'watch-service-'));
  feed = new MemoryFeed();
  snap = new MemorySnapshotter();
  clock = testClock();
  alive = new Set();
  feed.seed('D', { parents: ['ROOT'], modifiedTime: '2026-11-06T00:00:00.000Z' });
  snap.content.set('D', textSnap('a\nb\n'));
});
afterEach(async () => {
  for (const s of services.splice(0)) await s.stop();
  await rm(dir, { recursive: true, force: true });
});

describe('pollIntervalMs', () => {
  it('defaults to 30 s, honours the env and enforces 15 s', () => {
    expect(pollIntervalMs({})).toBe(30_000);
    expect(pollIntervalMs({ MARVIN_WATCH_POLL_SECONDS: '60' })).toBe(60_000);
    expect(pollIntervalMs({ MARVIN_WATCH_POLL_SECONDS: '5' })).toBe(15_000);
    expect(pollIntervalMs({ MARVIN_WATCH_POLL_SECONDS: 'x' })).toBe(30_000);
  });
});

describe('WatchService', () => {
  it('watch → foreign edit → one push → drive_changes reads it', async () => {
    const a = session(1);
    await a.setDelivery('channel');
    const push = vi.fn<PushFn>(async () => {});
    await a.start(push, { timers: false });
    expect(await a.watch({ action: 'add', fileId: 'D' })).toMatchObject({
      action: 'add',
      alreadyWatched: false,
    });
    edit();
    await a.tick(); // takes the lease, polls: pending
    expect(a.isLeader).toBe(true);
    clock.advance(QUIET_MS);
    await a.tick(); // releases the event, delivers it
    expect(push).toHaveBeenCalledTimes(1);
    const res = await a.changes({});
    expect(res.events.map((e) => [e.kind, e.diff])).toEqual([['edited', '  a\n- b\n+ B']]);
    expect((await a.changes({})).events).toEqual([]);
  });

  it('stores own edits without pushing them', async () => {
    const a = session(1);
    await a.setDelivery('channel');
    const push = vi.fn<PushFn>(async () => {});
    await a.start(push, { timers: false });
    await a.watch({ action: 'add', fileId: 'D' });
    edit(ME);
    await a.tick();
    clock.advance(QUIET_MS);
    await a.tick();
    expect(push).not.toHaveBeenCalled();
    expect((await a.changes({})).events).toEqual([]);
    expect((await a.changes({ includeOwn: true, unreadOnly: false })).events[0]?.own).toBe(true);
  });

  it('starts polling on the local tick after an external add (CLI)', async () => {
    const a = session(1);
    await a.start(null, { timers: false });
    expect(a.isLeader).toBe(false);
    await session(2).watch({ action: 'add', fileId: 'D' }); // never started: like the CLI
    await a.tick();
    expect(a.isLeader).toBe(true);
  });

  it('another session takes over after a clean exit or a crash', async () => {
    const a = session(1);
    const b = session(2);
    await a.watch({ action: 'add', fileId: 'D' });
    await a.start(null, { timers: false });
    await b.start(null, { timers: false });
    expect([a.isLeader, b.isLeader]).toEqual([true, false]);
    await a.stop();
    await b.tick();
    expect(b.isLeader).toBe(true);
    const c = session(3);
    await c.start(null, { timers: false });
    alive.delete(2); // b crashes: no stop, no heartbeat
    clock.advance(3 * INTERVAL + 1);
    await c.tick();
    expect(c.isLeader).toBe(true);
  });

  it('pushes to every session in channel mode and to none in hook mode', async () => {
    const a = session(1);
    const b = session(2);
    const pa = vi.fn<PushFn>(async () => {});
    const pb = vi.fn<PushFn>(async () => {});
    await a.watch({ action: 'add', fileId: 'D' });
    await a.start(pa, { timers: false });
    await b.start(pb, { timers: false });
    edit();
    await a.tick();
    clock.advance(QUIET_MS);
    await a.tick();
    await b.tick();
    expect([pa.mock.calls.length, pb.mock.calls.length]).toEqual([0, 0]); // default mode: hook
    await a.setDelivery('channel');
    feed.put('D', { modifiedTime: clock.now().toISOString(), name: 'Plan 2' });
    await a.tick();
    clock.advance(QUIET_MS);
    await a.tick();
    await b.tick();
    expect([pa.mock.calls.length, pb.mock.calls.length]).toEqual([1, 1]);
  });

  it('releases the lease when the last watch is removed', async () => {
    const a = session(1);
    await a.watch({ action: 'add', fileId: 'D' });
    await a.start(null, { timers: false });
    expect(a.isLeader).toBe(true);
    await a.watch({ action: 'remove', fileId: 'D' });
    await a.tick();
    expect(a.isLeader).toBe(false);
  });

  it('requires fileId for add and remove', async () => {
    await expect(session(1).watch({ action: 'add' })).rejects.toBeInstanceOf(ValidationError);
    expect(await session(1).watch({ action: 'list' })).toEqual({ action: 'list', watches: [] });
  });

  it('does not append when the lease was lost during enrichment, and drops leadership', async () => {
    const a = session(1);
    await a.watch({ action: 'add', fileId: 'D' });
    await a.start(null, { timers: false });
    edit();
    await a.tick(); // pending
    clock.advance(QUIET_MS);
    const other = new PollerLease({
      dir,
      intervalMs: INTERVAL,
      now: clock.now,
      pid: 2,
      host: 'h',
      isAlive: () => true,
      logger: silentLogger(),
    });
    const original = snap.snapshot.bind(snap);
    snap.snapshot = async (fileId) => {
      snap.snapshot = original;
      // a is mid-release: its lease is broken and taken by another session meanwhile.
      await rm(path.join(dir, 'poller.lock'), { force: true });
      expect(await other.tryAcquire()).toBe(true);
      return original(fileId);
    };
    await a.tick();
    expect(a.isLeader).toBe(false);
    expect(await a.inbox.readAll()).toEqual([]);
    await other.release();
    const b = session(2);
    await b.tick(); // the new leader releases the still-pending item once
    expect(b.isLeader).toBe(true);
    expect((await a.inbox.readAll()).map((e) => e.kind)).toEqual(['edited']);
  });

  it('heartbeats first on every tick and stops polling once the lease is gone', async () => {
    const a = session(1);
    await a.watch({ action: 'add', fileId: 'D' });
    await a.start(null, { timers: false });
    expect(a.isLeader).toBe(true);
    await rm(path.join(dir, 'poller.lock'), { force: true });
    const b = session(2);
    await b.tick();
    const polls = feed.calls.filter((c) => c.startsWith('poll')).length;
    await a.tick();
    expect(a.isLeader).toBe(false);
    expect(feed.calls.filter((c) => c.startsWith('poll')).length).toBe(polls);
  });
});
