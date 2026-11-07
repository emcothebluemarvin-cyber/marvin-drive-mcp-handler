import { describe, expect, it } from 'vitest';
import { planTracked } from '../plan-tracked.js';
import { buildContext } from '../resolve.js';
import type { SyncRecord } from '../types.js';
import { localEntry, nativeEntry, nativeRecord, record, remoteEntry } from './fixtures.js';
import { planInput, type InputOptions } from './plan-input.js';

const K = record('r1', 'a.pdf');
const L = localEntry('a.pdf');
const L_EDITED = localEntry('a.pdf', { mtimeMs: 2000, size: 12 });
const R = remoteEntry('r1', 'a.pdf');
const R_EDITED = remoteEntry('r1', 'a.pdf', {
  md5: 'md5-remote-edit',
  modifiedTime: '2026-11-03T00:00:00.000Z',
});

function run(o: InputOptions, k: SyncRecord = K) {
  return planTracked(buildContext(planInput({ records: [k], ...o })), k);
}

function only(o: InputOptions, k: SyncRecord = K) {
  const result = run(o, k);
  expect(result.actions).toHaveLength(1);
  return result.actions[0];
}

describe('dispatch (spec §6.3)', () => {
  it('type-changed: the Drive file switched between binary and Google-native', () => {
    const fromScan = run({ local: [L], remote: [nativeEntry('r1', 'a.pdf')] });
    expect(fromScan.actions).toEqual([]);
    expect(fromScan.notes[0]).toMatchObject({ code: 'unknown-state', rule: 'type-changed' });
    expect(fromScan.notes[0]?.message).toMatch(/^type-changed:/);
    const fromProbe = run({
      local: [L],
      probes: [['r1', { state: 'present', entry: nativeEntry('r1', 'a.pdf') }]],
    });
    expect(fromProbe.notes[0]).toMatchObject({ rule: 'type-changed' });
    const nativeToBinary = run(
      { local: [localEntry('Plan.docx')], remote: [remoteEntry('g1', 'Plan.docx')] },
      nativeRecord('g1', 'Plan.docx'),
    );
    expect(nativeToBinary.notes[0]).toMatchObject({ rule: 'type-changed' });
  });

  it('(a) unknown subtree beats everything', () => {
    const result = run({ local: [L], remote: [R], unknownLocal: [''] });
    expect(result.actions).toEqual([]);
    expect(result.notes[0]).toMatchObject({ code: 'unknown-state', path: 'a.pdf' });
  });

  it('(a) unknown remote probe', () => {
    const result = run({ local: [L], probes: [['r1', { state: 'unknown', reason: 'x' }]] });
    expect(result.notes[0]).toMatchObject({ code: 'unknown-state', message: 'x' });
  });

  it('(b) ambiguous key', () => {
    const result = run({ local: [L], remote: [R, remoteEntry('r9', 'A.pdf')] });
    expect(result.actions).toEqual([]);
    expect(result.notes[0]).toMatchObject({ code: 'ambiguous', path: 'a.pdf' });
  });
});

describe('binary tracked records (spec §6.4)', () => {
  it('B1 unchanged → nothing', () => {
    expect(run({ local: [L], remote: [R] })).toMatchObject({
      actions: [],
      notes: [],
      claimedLocal: 'a.pdf',
    });
  });

  it('B1 with a touched-but-identical file → refresh', () => {
    const a = only({
      local: [localEntry('a.pdf', { ctimeMs: 5 })],
      remote: [R],
      md5s: [['a.pdf', 'md5-r1']],
    });
    expect(a).toMatchObject({ kind: 'refresh', rule: 'B1' });
  });

  it('B2 local edit → update-remote', () => {
    const a = only({ local: [L_EDITED], remote: [R], md5s: [['a.pdf', 'md5-local-edit']] });
    expect(a).toMatchObject({ kind: 'update-remote', rule: 'B2', localMd5: 'md5-local-edit' });
  });

  it('B2 without canEdit → remote-readonly report', () => {
    const result = run({
      local: [L_EDITED],
      remote: [remoteEntry('r1', 'a.pdf', { canEdit: false })],
      md5s: [['a.pdf', 'x']],
    });
    expect(result.actions).toEqual([]);
    expect(result.notes[0]).toMatchObject({ code: 'remote-readonly', rule: 'B2' });
  });

  it('B3 remote edit → download-replace', () => {
    expect(only({ local: [L], remote: [R_EDITED] })).toMatchObject({
      kind: 'download-replace',
      rule: 'B3',
    });
  });

  it('B4 both edited with equal md5 → adopt', () => {
    const a = only({ local: [L_EDITED], remote: [R_EDITED], md5s: [['a.pdf', 'md5-remote-edit']] });
    expect(a).toMatchObject({ kind: 'adopt', rule: 'B4' });
  });

  it('B4 both edited differently → conflict', () => {
    const a = only({ local: [L_EDITED], remote: [R_EDITED], md5s: [['a.pdf', 'md5-local-edit']] });
    expect(a).toMatchObject({ kind: 'conflict', rule: 'B4', updateRemote: true });
  });

  it('B4 conflict without canEdit → conflict copy only + remote-readonly', () => {
    const result = run({
      local: [L_EDITED],
      remote: [{ ...R_EDITED, canEdit: false }],
      md5s: [['a.pdf', 'md5-local-edit']],
    });
    expect(result.actions[0]).toMatchObject({ kind: 'conflict', updateRemote: false });
    expect(result.notes[0]).toMatchObject({ code: 'remote-readonly' });
  });

  it('B5 deleted locally → trash-remote and unselect', () => {
    expect(only({ remote: [R] })).toMatchObject({
      kind: 'trash-remote',
      rule: 'B5',
      selection: { remove: ['a.pdf'] },
    });
  });

  it('B5 without canTrash → cannot-trash report', () => {
    const result = run({ remote: [remoteEntry('r1', 'a.pdf', { canTrash: false })] });
    expect(result.actions).toEqual([]);
    expect(result.notes[0]).toMatchObject({ code: 'cannot-trash' });
  });

  it('B6 deleted locally but edited remotely → download-new (change beats deletion)', () => {
    expect(only({ remote: [R_EDITED] })).toMatchObject({
      kind: 'download-new',
      rule: 'B6',
      key: 'a.pdf',
    });
  });

  it('B7 moved remotely, local unchanged → move-local and rename the selection', () => {
    const a = only({ local: [L], remote: [remoteEntry('r1', 'sub/b.pdf')] });
    expect(a).toMatchObject({
      kind: 'move-local',
      rule: 'B7',
      key: 'sub/b.pdf',
      inPlace: false,
      thenDownload: false,
      selection: { remove: ['a.pdf'], add: ['sub/b.pdf'] },
    });
  });

  it('B7 moved and edited remotely → move-local then download', () => {
    const a = only({ local: [L], remote: [remoteEntry('r1', 'b.pdf', { md5: 'new' })] });
    expect(a).toMatchObject({ kind: 'move-local', thenDownload: true });
  });

  it('B7 remote case-only rename on a case-insensitive volume → rename in place', () => {
    const a = only({ local: [L], remote: [remoteEntry('r1', 'A.pdf')] });
    expect(a).toMatchObject({ kind: 'move-local', inPlace: true, key: 'A.pdf' });
  });

  it('B7 resumes a crashed move (same inode already at the target)', () => {
    const a = only({
      local: [L, localEntry('b.pdf', { ino: 1 })],
      remote: [remoteEntry('r1', 'b.pdf')],
    });
    expect(a).toMatchObject({ kind: 'move-local', key: 'b.pdf' });
  });

  it('B7 target taken by another local file → collision', () => {
    const result = run({
      local: [L, localEntry('b.pdf', { ino: 2 })],
      remote: [remoteEntry('r1', 'b.pdf')],
    });
    expect(result.actions).toEqual([]);
    expect(result.notes[0]).toMatchObject({ code: 'collision' });
  });

  it('B8 moved remotely, edited locally → download-new at the new key, old key excluded', () => {
    const result = run({
      local: [L_EDITED],
      remote: [remoteEntry('r1', 'b.pdf')],
      md5s: [['a.pdf', 'md5-local-edit']],
    });
    expect(result.actions[0]).toMatchObject({
      kind: 'download-new',
      rule: 'B8',
      key: 'b.pdf',
      selection: { remove: ['a.pdf'], add: ['b.pdf'], exclude: ['a.pdf'] },
    });
    expect(result.notes[0]).toMatchObject({ code: 'conflict-rename' });
  });

  it('B9 moved remotely, gone locally → download-new at the new key', () => {
    expect(only({ remote: [remoteEntry('r1', 'b.pdf')] })).toMatchObject({
      kind: 'download-new',
      rule: 'B9',
      key: 'b.pdf',
      selection: { remove: ['a.pdf'], add: ['b.pdf'] },
    });
  });

  it('B7–B9 into an excluded key → untrack with moved-into-excluded', () => {
    const result = run({
      pair: { excluded: ['b.pdf'] },
      local: [L],
      remote: [remoteEntry('r1', 'b.pdf')],
    });
    expect(result.actions[0]).toMatchObject({ kind: 'untrack' });
    expect(result.notes[0]).toMatchObject({ code: 'moved-into-excluded' });
  });

  it('B10 trashed remotely, local unchanged → trash-local', () => {
    expect(only({ local: [L], probes: [['r1', { state: 'trashed' }]] })).toMatchObject({
      kind: 'trash-local',
      rule: 'B10',
      selection: { remove: ['a.pdf'] },
    });
  });

  it('B11 trashed remotely, edited locally → upload-new rebased', () => {
    const a = only({
      local: [L_EDITED],
      probes: [['r1', { state: 'trashed' }]],
      md5s: [['a.pdf', 'edit']],
    });
    expect(a).toMatchObject({ kind: 'upload-new', rule: 'B11', rebaseFrom: 'r1' });
  });

  it('B11 after a crash adopts the identical re-upload instead of uploading twice', () => {
    const a = only({
      local: [L_EDITED],
      remote: [remoteEntry('r2', 'a.pdf', { md5: 'edit' })],
      probes: [['r1', { state: 'trashed' }]],
      md5s: [['a.pdf', 'edit']],
    });
    expect(a).toMatchObject({ kind: 'adopt', rule: 'B11', rebaseFrom: 'r1', remote: { id: 'r2' } });
  });

  it('B12 trashed remotely, gone locally → forget', () => {
    expect(only({ probes: [['r1', { state: 'trashed' }]] })).toMatchObject({
      kind: 'forget',
      rule: 'B12',
    });
  });

  it('B13 moved out of the pair → untrack, exclude, keep L', () => {
    const result = run({ local: [L], probes: [['r1', { state: 'moved-out' }]] });
    expect(result.actions[0]).toMatchObject({
      kind: 'untrack',
      rule: 'B13',
      selection: { remove: ['a.pdf'], exclude: ['a.pdf'] },
    });
    expect(result.notes[0]).toMatchObject({ code: 'moved-out' });
  });

  it('B14 unavailable → report only', () => {
    const result = run({ local: [L], probes: [['r1', { state: 'unavailable' }]] });
    expect(result.actions).toEqual([]);
    expect(result.notes[0]).toMatchObject({ code: 'remote-unavailable', rule: 'B14' });
  });

  it('warns weak-compare when Drive has no md5', () => {
    const result = run(
      { local: [L], remote: [remoteEntry('r1', 'a.pdf', { md5: null })] },
      { ...K, remoteMd5: null },
    );
    expect(result.notes.map((n) => n.code)).toEqual(['weak-compare']);
  });
});

describe('review regressions', () => {
  const KA = record('r1', 'a/x.pdf');
  const RA = remoteEntry('r1', 'a/x.pdf');

  it('a folder replaced by a symlink (moved to another disk) never trashes Drive files', () => {
    const viaSymlink = run({ remote: [RA], blocking: ['a'], occupied: ['a'] }, KA);
    expect(viaSymlink.actions).toEqual([]);
    expect(viaSymlink.notes[0]).toMatchObject({ code: 'unknown-state' });
    const reachable = run({ remote: [RA], onDisk: [['a/x.pdf', { kind: 'file', ino: 42 }]] }, KA);
    expect(reachable.actions).toEqual([]);
    expect(reachable.notes[0]).toMatchObject({ code: 'unknown-state' });
  });

  it('a local ß → SS rename is the same file (no trash-remote)', () => {
    const k = record('r1', 'straße.pdf');
    const result = run(
      {
        local: [localEntry('STRASSE.pdf')],
        remote: [remoteEntry('r1', 'straße.pdf')],
        onDisk: [['straße.pdf', { kind: 'file', ino: 1 }]],
      },
      k,
    );
    expect(result.actions.map((a) => [a.kind, a.local?.name])).toEqual([
      ['refresh', 'STRASSE.pdf'],
    ]);
  });

  it('a Drive ß → SS rename moves the local file in place', () => {
    const k = record('r1', 'straße.pdf');
    const a = only(
      { local: [localEntry('straße.pdf')], remote: [remoteEntry('r1', 'STRASSE.pdf')] },
      k,
    );
    expect(a).toMatchObject({ kind: 'move-local', key: 'STRASSE.pdf', inPlace: true });
  });

  it('renamed-case needs no refresh when localName already matches', () => {
    const k = record('r1', 'Report.pdf', { localName: 'report.pdf' });
    const result = run(
      {
        local: [localEntry('report.pdf')],
        remote: [remoteEntry('r1', 'Report.pdf')],
        onDisk: [['Report.pdf', { kind: 'file', ino: 1 }]],
      },
      k,
    );
    expect(result).toMatchObject({ actions: [], notes: [] });
  });

  it('B11 with a different Drive file now at the key → collision, no duplicate upload', () => {
    const result = run({
      local: [L_EDITED],
      remote: [remoteEntry('r2', 'a.pdf', { md5: 'someone-else' })],
      probes: [['r1', { state: 'trashed' }]],
      md5s: [['a.pdf', 'edit']],
    });
    expect(result.actions).toEqual([]);
    expect(result.notes[0]).toMatchObject({ code: 'collision', rule: 'B11' });
  });

  it('resumes a move that crashed after unlink: adopts the file already at the target', () => {
    const result = run({
      local: [localEntry('b.pdf', { ino: 7, ctimeMs: 5 })],
      remote: [remoteEntry('r1', 'b.pdf')],
      md5s: [['b.pdf', 'md5-r1']],
    });
    expect(result.actions[0]).toMatchObject({
      kind: 'adopt',
      rule: 'B7-resume',
      key: 'b.pdf',
      selection: { remove: ['a.pdf'], add: ['b.pdf'] },
    });
  });
});
