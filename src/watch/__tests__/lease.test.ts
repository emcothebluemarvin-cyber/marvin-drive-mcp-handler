import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { silentLogger } from '../../files/__tests__/fakes.js';
import { HEARTBEAT_FILE, LEASE_FILE, PollerLease, type LeaseOptions } from '../lease.js';

const INTERVAL = 30_000;
let dir: string;
let nowMs: number;
const now = (): Date => new Date(nowMs);

function lease(over: Partial<LeaseOptions> = {}): PollerLease {
  return new PollerLease({
    dir,
    intervalMs: INTERVAL,
    now,
    host: 'h1',
    pid: 111,
    isAlive: () => true,
    logger: silentLogger(),
    ...over,
  });
}

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'lease-'));
  nowMs = Date.parse('2026-11-07T11:00:00.000Z');
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function heartbeatAt(): Promise<string> {
  return (JSON.parse(await readFile(path.join(dir, HEARTBEAT_FILE), 'utf8')) as { at: string }).at;
}

describe('PollerLease', () => {
  it('is exclusive while the heartbeat is fresh', async () => {
    const a = lease();
    expect(await a.tryAcquire()).toBe(true);
    expect(a.held).toBe(true);
    expect(await a.tryAcquire()).toBe(true); // idempotent for the holder
    const b = lease({ pid: 222, isAlive: () => false });
    expect(await b.tryAcquire()).toBe(false);
    expect(JSON.parse(await readFile(path.join(dir, LEASE_FILE), 'utf8'))).toMatchObject({
      pid: 111,
      host: 'h1',
      token: expect.any(String),
    });
  });

  it('rewrites the heartbeat on every beat', async () => {
    const a = lease();
    await a.tryAcquire();
    expect(await heartbeatAt()).toBe('2026-11-07T11:00:00.000Z');
    nowMs += INTERVAL;
    expect(await a.heartbeat()).toBe(true);
    expect(await heartbeatAt()).toBe('2026-11-07T11:00:30.000Z');
  });

  it('is taken over after 3 × interval when the same-host pid is dead', async () => {
    const a = lease();
    await a.tryAcquire();
    nowMs += 3 * INTERVAL + 1;
    const b = lease({ pid: 222, isAlive: () => false });
    expect(await b.tryAcquire()).toBe(true);
    expect(await a.heartbeat()).toBe(false);
    expect(a.held).toBe(false);
    await a.release(); // must not remove b's lease
    expect(await lease({ pid: 333 }).tryAcquire()).toBe(false);
  });

  it('is not taken over while the same-host pid is alive', async () => {
    await lease().tryAcquire();
    nowMs += 10 * INTERVAL;
    expect(await lease({ pid: 222, isAlive: () => true }).tryAcquire()).toBe(false);
  });

  it('is taken over from another host on heartbeat age alone', async () => {
    await lease({ host: 'other' }).tryAcquire();
    nowMs += 3 * INTERVAL + 1;
    expect(await lease({ isAlive: () => true }).tryAcquire()).toBe(true);
  });

  it('a holder that keeps beating is never stale', async () => {
    const a = lease();
    await a.tryAcquire();
    for (let i = 0; i < 5; i++) {
      nowMs += INTERVAL;
      await a.heartbeat();
    }
    expect(await lease({ pid: 222, isAlive: () => false }).tryAcquire()).toBe(false);
  });

  it('release lets another session acquire immediately', async () => {
    const a = lease();
    await a.tryAcquire();
    await a.release();
    expect(a.held).toBe(false);
    expect(await lease({ pid: 222 }).tryAcquire()).toBe(true);
  });

  it('treats non-object lock JSON like unreadable content (decided by file age)', async () => {
    const { utimes, writeFile } = await import('node:fs/promises');
    const file = path.join(dir, LEASE_FILE);
    for (const raw of ['null', '42', '"x"']) {
      await writeFile(file, raw);
      const fresh = new Date(nowMs);
      await utimes(file, fresh, fresh);
      expect(await lease().tryAcquire()).toBe(false);
      const old = new Date(nowMs - 3 * INTERVAL - 1_000);
      await utimes(file, old, old);
      const taker = lease();
      expect(await taker.tryAcquire()).toBe(true);
      await taker.release();
    }
  });

  it('verify() checks the lock without rewriting the heartbeat and forgets a lost lease', async () => {
    const a = lease();
    expect(await a.verify()).toBe(false); // not held
    await a.tryAcquire();
    nowMs += INTERVAL;
    expect(await a.verify()).toBe(true);
    expect(await heartbeatAt()).toBe('2026-11-07T11:00:00.000Z');
    await rm(path.join(dir, LEASE_FILE));
    expect(await lease({ pid: 222 }).tryAcquire()).toBe(true);
    expect(await a.verify()).toBe(false);
    expect(a.held).toBe(false);
  });
});
