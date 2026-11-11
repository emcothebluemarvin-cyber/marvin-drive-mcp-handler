import { describe, expect, it } from 'vitest';
import { plan } from '../planner.js';
import type { SyncRecord } from '../types.js';
import { localEntry, nativeEntry, nativeRecord, record, remoteEntry } from './fixtures.js';
import { planInput, type InputOptions } from './plan-input.js';

const NEWER = '2026-11-04T00:00:00.000Z';
const K = record('r1', 'a.pdf', { remoteOnly: true });
const PENDING = { ...K, restorePending: true };
const R = remoteEntry('r1', 'a.pdf');
const BACK = localEntry('a.pdf', { mtimeMs: 5000 });
const FOLDERS: InputOptions['folders'] = [['folder:sub', 'sub']];
const run = (o: InputOptions, k: SyncRecord = K) => plan(planInput({ records: [k], ...o }));
const summary = (o: InputOptions, k: SyncRecord = K) =>
  run(o, k).actions.map((a) => [a.kind, a.rule, a.key]);

describe('remote-only records (spec §6.7)', () => {
  it('O0 restorePending and the same file is back → adopt (binary: Drive md5, native: last export)', () => {
    expect(summary({ local: [BACK], remote: [R], md5s: [['a.pdf', 'md5-r1']] }, PENDING)).toEqual([
      ['adopt', 'O0', 'a.pdf'],
    ]);
    const n = nativeRecord('g1', 'Plan.docx', {
      remoteOnly: true,
      restorePending: true,
      localMd5: 'exp',
    });
    const back = localEntry('Plan.docx', { mtimeMs: 5000 });
    expect(
      summary(
        { local: [back], remote: [nativeEntry('g1', 'Plan.docx')], md5s: [['Plan.docx', 'exp']] },
        n,
      ),
    ).toEqual([['adopt', 'O0', 'Plan.docx']]);
  });
  it('O1 restorePending → download-new / export-new at the current Drive key', () => {
    expect(summary({ remote: [R] }, PENDING)).toEqual([['download-new', 'O1', 'a.pdf']]);
    expect(
      run({ remote: [remoteEntry('r1', 'sub/a.pdf')], folders: FOLDERS }, PENDING).actions,
    ).toMatchObject([
      {
        kind: 'download-new',
        rule: 'O1',
        key: 'sub/a.pdf',
        selection: { remove: ['a.pdf'], add: ['sub/a.pdf'] },
      },
    ]);
    const n = nativeRecord('g1', 'Plan.docx', { remoteOnly: true, restorePending: true });
    expect(summary({ remote: [nativeEntry('g1', 'Plan.docx')] }, n)).toEqual([
      ['export-new', 'O1', 'Plan.docx'],
    ]);
  });
  it('O1 a different local file at the key → collision, never trash-remote', () => {
    const p = run({ local: [BACK], remote: [R], md5s: [['a.pdf', 'other']] }, PENDING);
    expect(p.actions).toEqual([]);
    expect(p.notes[0]).toMatchObject({ code: 'collision', rule: 'O1' });
  });
  it('O2 restorePending but trashed or unavailable → report, flags kept', () => {
    for (const state of ['trashed', 'unavailable'] as const) {
      const p = run({ probes: [['r1', { state }]] }, PENDING);
      expect(p.actions).toEqual([]);
      expect(p.notes[0]?.rule).toBe('O2');
    }
  });
  it('O3 L absent, R present-same → nothing; a changed R only refreshes the record', () => {
    expect(run({ remote: [R] }).actions).toEqual([]);
    expect(
      run({ remote: [remoteEntry('r1', 'a.pdf', { md5: 'new', modifiedTime: NEWER })] }).actions,
    ).toMatchObject([
      { kind: 'refresh', rule: 'O3', patch: { remoteMd5: 'new', remoteModifiedTime: NEWER } },
    ]);
  });
  it('a released Google Doc modified in Drive is never exported', () => {
    const n = nativeRecord('g1', 'Plan.docx', { remoteOnly: true });
    const p = run({ remote: [nativeEntry('g1', 'Plan.docx', { modifiedTime: NEWER })] }, n);
    expect(p.actions).toEqual([]);
  });
  it('O3 a native keeps remoteModifiedTime (the export baseline); other fields refresh', () => {
    const n = nativeRecord('g1', 'Plan.docx', { remoteOnly: true });
    const p = run(
      { remote: [nativeEntry('g1', 'Plan.docx', { name: 'Plan v2', modifiedTime: NEWER })] },
      n,
    );
    expect(p.actions).toMatchObject([
      { kind: 'refresh', rule: 'O3', patch: { remoteName: 'Plan v2' } },
    ]);
    expect(p.actions[0]?.patch).not.toHaveProperty('remoteModifiedTime');
    const touched = run({ remote: [nativeEntry('g1', 'Plan.docx', { modifiedTime: NEWER })] }, n);
    expect(touched.actions).toEqual([]);
    const o6 = run(
      { remote: [nativeEntry('g1', 'Plan.docx', { modifiedTime: NEWER })] },
      { ...n, remoteTrashed: true },
    );
    expect(o6.actions).toMatchObject([{ rule: 'O6', patch: { remoteTrashed: false } }]);
    expect(o6.actions[0]?.patch).not.toHaveProperty('remoteModifiedTime');
  });
  it('O0/O8 a native whose last export is back but the Doc changed since → export-replace', () => {
    const n = nativeRecord('g1', 'Plan.docx', { remoteOnly: true, localMd5: 'exp' });
    const back = localEntry('Plan.docx', { mtimeMs: 5000 });
    const changed = nativeEntry('g1', 'Plan.docx', { modifiedTime: NEWER });
    const o = { local: [back], remote: [changed], md5s: [['Plan.docx', 'exp']] } as InputOptions;
    expect(summary(o, n)).toEqual([['export-replace', 'O8', 'Plan.docx']]);
    expect(summary(o, { ...n, restorePending: true })).toEqual([
      ['export-replace', 'O0', 'Plan.docx'],
    ]);
    const same = { ...o, remote: [nativeEntry('g1', 'Plan.docx')] };
    expect(summary(same, n)).toEqual([['adopt', 'O8', 'Plan.docx']]);
  });
  it('O8 binary: a back file equal to the changed Drive md5 is still adopted', () => {
    const changed = remoteEntry('r1', 'a.pdf', { md5: 'new', modifiedTime: NEWER });
    expect(summary({ local: [BACK], remote: [changed], md5s: [['a.pdf', 'new']] })).toEqual([
      ['adopt', 'O8', 'a.pdf'],
    ]);
    expect(
      summary({ local: [BACK], remote: [changed], md5s: [['a.pdf', 'new']] }, PENDING),
    ).toEqual([['adopt', 'O0', 'a.pdf']]);
  });
  it('O4 moved in Drive → record path and selection follow', () => {
    expect(
      run({ remote: [remoteEntry('r1', 'sub/a.pdf')], folders: FOLDERS }).actions,
    ).toMatchObject([
      {
        kind: 'refresh',
        rule: 'O4',
        key: 'sub/a.pdf',
        patch: { path: 'sub/a.pdf', localName: 'sub/a.pdf' },
        selection: { remove: ['a.pdf'], add: ['sub/a.pdf'] },
      },
    ]);
  });
  it('O5 trashed → remoteTrashed + warning every run; O6 present again → cleared', () => {
    const trashed: InputOptions['probes'] = [['r1', { state: 'trashed' }]];
    const first = run({ probes: trashed });
    expect(first.actions).toMatchObject([
      { kind: 'refresh', rule: 'O5', patch: { remoteTrashed: true } },
    ]);
    expect(first.notes[0]).toMatchObject({ code: 'remote-only-trashed', rule: 'O5' });
    const again = run({ probes: trashed }, { ...K, remoteTrashed: true });
    expect(again.actions).toEqual([]);
    expect(again.notes[0]?.code).toBe('remote-only-trashed');
    expect(run({ remote: [R] }, { ...K, remoteTrashed: true }).actions).toMatchObject([
      { kind: 'refresh', rule: 'O6', patch: { remoteTrashed: false } },
    ]);
  });
  it('O7 moved-out → untrack; unavailable → report', () => {
    expect(summary({ probes: [['r1', { state: 'moved-out' }]] })).toEqual([
      ['untrack', 'O7', 'a.pdf'],
    ]);
    expect(run({ probes: [['r1', { state: 'unavailable' }]] }).notes[0]).toMatchObject({
      code: 'remote-unavailable',
      rule: 'O7',
    });
  });
  it('O8 the file is back locally: same content → adopt, else collision', () => {
    expect(summary({ local: [BACK], remote: [R], md5s: [['a.pdf', 'md5-r1']] })).toEqual([
      ['adopt', 'O8', 'a.pdf'],
    ]);
    const p = run({ local: [BACK], remote: [R], md5s: [['a.pdf', 'different']] });
    expect(p.actions).toEqual([]);
    expect(p.notes[0]).toMatchObject({ code: 'collision', rule: 'O8' });
  });
});
