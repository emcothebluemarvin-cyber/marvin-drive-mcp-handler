import { describe, expect, it } from 'vitest';
import { MAX_WAIT_MS, QUIET_MS, isOwnItem, readyToRelease } from '../coalesce.js';
import type { PendingItem } from '../types.js';
import { AYSE, ME } from './fakes.js';

const T0 = Date.parse('2026-11-07T11:00:00.000Z');
const iso = (ms: number): string => new Date(ms).toISOString();

function item(fileId: string, firstSeen: number, lastSeen: number): PendingItem {
  return {
    fileId,
    firstSeen: iso(firstSeen),
    lastSeen: iso(lastSeen),
    modifiers: [AYSE],
    flags: ['edited'],
    before: null,
    after: null,
  };
}

describe('readyToRelease', () => {
  it('uses 120 s quiet and 600 s max windows', () => {
    expect(QUIET_MS).toBe(120_000);
    expect(MAX_WAIT_MS).toBe(600_000);
  });

  it('releases a file once it has been quiet for 120 s', () => {
    const pending = { a: item('a', T0, T0) };
    expect(readyToRelease(pending, new Date(T0 + 119_999))).toEqual([]);
    expect(readyToRelease(pending, new Date(T0 + 120_000)).map((p) => p.fileId)).toEqual(['a']);
  });

  it('releases a busy file 600 s after its first pending change', () => {
    const pending = { a: item('a', T0, T0 + 590_000) };
    expect(readyToRelease(pending, new Date(T0 + 599_999))).toEqual([]);
    expect(readyToRelease(pending, new Date(T0 + 600_000))).toHaveLength(1);
  });

  it('releases a startup backlog observed "now" 120 s later, oldest first', () => {
    const pending = { b: item('b', T0, T0), a: item('a', T0, T0), c: item('c', T0 - 1, T0) };
    expect(readyToRelease(pending, new Date(T0 + 60_000))).toEqual([]);
    expect(readyToRelease(pending, new Date(T0 + 120_000)).map((p) => p.fileId)).toEqual([
      'c',
      'a',
      'b',
    ]);
  });

  it('accepts custom windows', () => {
    const pending = { a: item('a', T0, T0) };
    expect(readyToRelease(pending, new Date(T0 + 5_000), 5_000, 60_000)).toHaveLength(1);
  });
});

describe('isOwnItem', () => {
  it('is own only when there is at least one modifier and all are the account', () => {
    expect(isOwnItem({ modifiers: [] })).toBe(false);
    expect(isOwnItem({ modifiers: [ME] })).toBe(true);
    expect(isOwnItem({ modifiers: [ME, ME] })).toBe(true);
    expect(isOwnItem({ modifiers: [ME, AYSE] })).toBe(false);
    expect(isOwnItem({ modifiers: [AYSE] })).toBe(false);
  });
});
