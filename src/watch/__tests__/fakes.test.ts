import { describe, expect, it } from 'vitest';
import { NotFoundError } from '../../errors.js';
import { MemoryFeed, MemorySnapshotter, memoryProvider, testClock } from './fakes.js';

describe('watch test fakes', () => {
  it('MemoryFeed replays its change log from a cursor', async () => {
    const feed = new MemoryFeed();
    const cursor = await feed.start();
    feed.put('D', { name: 'Plan' });
    feed.remove('X');
    const { changes, next } = await feed.poll(cursor);
    expect(changes.map((c) => [c.fileId, c.removed])).toEqual([
      ['D', false],
      ['X', true],
    ]);
    expect((await feed.poll(next)).changes).toEqual([]);
    await expect(feed.file('nope')).rejects.toBeInstanceOf(NotFoundError);
    feed.failures.push(new Error('down'));
    await expect(feed.poll(next)).rejects.toThrow('down');
  });

  it('memoryProvider resolves the alias, email and default account', async () => {
    const p = memoryProvider(new MemoryFeed(), new MemorySnapshotter());
    expect(await p.resolveAccount(undefined)).toEqual({ email: 'me@example.com', alias: 'me' });
    expect(await p.resolveAccount('me')).toEqual({ email: 'me@example.com', alias: 'me' });
    await expect(p.resolveAccount('other')).rejects.toThrow('Unknown account');
  });

  it('testClock advances', () => {
    const clock = testClock('2026-11-07T11:00:00.000Z');
    clock.advance(120_000);
    expect(clock.now().toISOString()).toBe('2026-11-07T11:02:00.000Z');
  });
});
