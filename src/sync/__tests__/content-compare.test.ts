import { describe, expect, it } from 'vitest';
import { localMatchesRemote, remoteChanged, remoteUnchangedSince } from '../content-compare.js';
import { nativeEntry, nativeRecord, record, remoteEntry } from './fixtures.js';

const LATER = '2026-11-04T00:00:00.000Z';

describe('remoteChanged', () => {
  it('binary: md5 compare, else weak size + modifiedTime', () => {
    const k = record('r1', 'a.pdf');
    expect(remoteChanged(k, remoteEntry('r1', 'a.pdf', { md5: 'other' }))).toEqual({
      changed: true,
      weak: false,
    });
    expect(remoteChanged(k, remoteEntry('r1', 'a.pdf', { md5: null }))).toEqual({
      changed: false,
      weak: true,
    });
    expect(remoteChanged(k, remoteEntry('r1', 'a.pdf', { md5: null, size: 11 })).changed).toBe(
      true,
    );
  });
  it('native: modifiedTime only', () => {
    const k = nativeRecord('g1', 'Plan.docx');
    expect(remoteChanged(k, nativeEntry('g1', 'Plan.docx'))).toEqual({
      changed: false,
      weak: false,
    });
    expect(remoteChanged(k, nativeEntry('g1', 'Plan.docx', { modifiedTime: LATER }))).toEqual({
      changed: true,
      weak: false,
    });
  });
});
describe('remoteUnchangedSince', () => {
  it('binary needs md5 and modifiedTime equal', () => {
    const r = remoteEntry('r1', 'a.pdf');
    expect(remoteUnchangedSince(r, { md5Checksum: r.md5, modifiedTime: r.modifiedTime })).toBe(
      true,
    );
    expect(remoteUnchangedSince(r, { md5Checksum: 'x', modifiedTime: r.modifiedTime })).toBe(false);
    expect(remoteUnchangedSince(r, { md5Checksum: r.md5, modifiedTime: LATER })).toBe(false);
  });
  it('native needs modifiedTime equal', () => {
    const r = nativeEntry('g1', 'Plan.docx');
    expect(remoteUnchangedSince(r, { modifiedTime: r.modifiedTime })).toBe(true);
    expect(remoteUnchangedSince(r, { modifiedTime: LATER })).toBe(false);
  });
});
describe('localMatchesRemote', () => {
  it('binary: local md5 = Drive md5 (no record needed)', () => {
    const r = remoteEntry('r1', 'a.pdf');
    expect(localMatchesRemote('md5-r1', null, r)).toBe(true);
    expect(localMatchesRemote('other', null, r)).toBe(false);
    expect(localMatchesRemote('md5-r1', null, { ...r, md5: null })).toBe(false);
  });
  it('native: local md5 = md5 of the last export (record required)', () => {
    const k = nativeRecord('g1', 'Plan.docx', { localMd5: 'export-md5' });
    const r = nativeEntry('g1', 'Plan.docx');
    expect(localMatchesRemote('export-md5', k, r)).toBe(true);
    expect(localMatchesRemote('edited', k, r)).toBe(false);
    expect(() => localMatchesRemote('export-md5', null, r)).toThrow(/needs its record/);
  });
});
