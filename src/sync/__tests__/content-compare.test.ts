import { describe, expect, it } from 'vitest';
import type { DriveFile } from '../../drive/drive-adapter.js';
import {
  localMatchesRemote,
  remoteChanged,
  remoteUnchangedSince,
  sameContent,
} from '../content-compare.js';
import { toRemoteItem } from '../remote/google-remote.js';
import type { RemoteItem } from '../remote/sync-remote.js';
import { DEFAULT_GOOGLE_EXPORT } from '../types.js';
import { nativeEntry, nativeRecord, record, remoteEntry } from './fixtures.js';
import { md5Digests } from './plan-input.js';

const item = (file: DriveFile): RemoteItem => toRemoteItem(file, DEFAULT_GOOGLE_EXPORT);

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
    const md5Checksum = r.hash?.value;
    expect(remoteUnchangedSince(r, item({ md5Checksum, modifiedTime: r.modifiedTime }))).toBe(true);
    expect(remoteUnchangedSince(r, item({ md5Checksum: 'x', modifiedTime: r.modifiedTime }))).toBe(
      false,
    );
    expect(remoteUnchangedSince(r, item({ md5Checksum, modifiedTime: LATER }))).toBe(false);
  });
  it('a quickXor hash compares by kind and value (never always-changed)', () => {
    const hash = { kind: 'quickXor' as const, value: 'QX' };
    const r = remoteEntry('r1', 'a.pdf', { hash });
    const current = { ...item({ modifiedTime: r.modifiedTime }), hash };
    expect(remoteUnchangedSince(r, current)).toBe(true);
    expect(remoteUnchangedSince(r, { ...current, hash: { ...hash, value: 'other' } })).toBe(false);
    expect(remoteUnchangedSince(r, { ...current, hash: { kind: 'md5', value: 'QX' } })).toBe(false);
  });
  it('without a hash, a OneDrive eTag change counts even when modifiedTime is kept', () => {
    const r = remoteEntry('r1', 'a.pdf', { hash: null, version: '"{r1},1"' });
    const current = { ...item({ modifiedTime: r.modifiedTime }), hash: null, version: '"{r1},1"' };
    expect(remoteUnchangedSince(r, current)).toBe(true);
    expect(remoteUnchangedSince(r, { ...current, version: '"{r1},2"' })).toBe(false);
    expect(remoteUnchangedSince(r, { ...current, version: null })).toBe(false);
  });
  it('Google entries carry no version; a missing hash still compares as before', () => {
    const r = remoteEntry('r1', 'a.pdf', { md5: null });
    expect(r.version).toBeUndefined();
    expect(remoteUnchangedSince(r, item({ modifiedTime: r.modifiedTime }))).toBe(true);
  });
  it('native needs modifiedTime equal', () => {
    const r = nativeEntry('g1', 'Plan.docx');
    expect(remoteUnchangedSince(r, item({ modifiedTime: r.modifiedTime }))).toBe(true);
    expect(remoteUnchangedSince(r, item({ modifiedTime: LATER }))).toBe(false);
  });
});
describe('sameContent', () => {
  it('compares the local digest of the remote kind; null when unknown or of another kind', () => {
    const qx = { kind: 'quickXor' as const, value: 'QX' };
    expect(sameContent(md5Digests('a'), { kind: 'md5', value: 'a' })).toBe(true);
    expect(sameContent(md5Digests('a'), { kind: 'md5', value: 'b' })).toBe(false);
    expect(sameContent(md5Digests('a'), null)).toBeNull();
    expect(sameContent(md5Digests('a'), qx)).toBeNull();
    expect(sameContent({ md5: 'a', remote: null }, qx)).toBeNull();
    expect(sameContent({ md5: 'a', remote: qx }, qx)).toBe(true);
  });
});
describe('localMatchesRemote', () => {
  it('binary without a comparable remote hash is never a match (no weak fallback)', () => {
    const r = remoteEntry('r1', 'a.pdf', { hash: { kind: 'quickXor', value: 'QX' } });
    expect(localMatchesRemote(md5Digests('md5-r1'), null, r)).toBe(false);
    expect(localMatchesRemote({ md5: 'md5-r1', remote: null }, null, r)).toBe(false);
    expect(
      localMatchesRemote({ md5: 'x', remote: { kind: 'quickXor', value: 'QX' } }, null, r),
    ).toBe(true);
  });
  it('binary: local md5 = Drive md5 (no record needed)', () => {
    const r = remoteEntry('r1', 'a.pdf');
    expect(localMatchesRemote(md5Digests('md5-r1'), null, r)).toBe(true);
    expect(localMatchesRemote(md5Digests('other'), null, r)).toBe(false);
    expect(localMatchesRemote(md5Digests('md5-r1'), null, { ...r, hash: null })).toBe(false);
  });
  it('native: local md5 = md5 of the last export (record required)', () => {
    const k = nativeRecord('g1', 'Plan.docx', { localMd5: 'export-md5' });
    const r = nativeEntry('g1', 'Plan.docx');
    expect(localMatchesRemote(md5Digests('export-md5'), k, r)).toBe(true);
    expect(localMatchesRemote(md5Digests('edited'), k, r)).toBe(false);
    expect(() => localMatchesRemote(md5Digests('export-md5'), null, r)).toThrow(/needs its record/);
  });
});
