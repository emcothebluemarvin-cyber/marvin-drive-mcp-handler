import { describe, expect, it } from 'vitest';
import { plan } from '../planner.js';
import { localEntry, nativeEntry, nativeRecord } from './fixtures.js';
import { planInput, type InputOptions } from './plan-input.js';

const NEWER = '2026-11-04T00:00:00.000Z';
const K = nativeRecord('g1', 'Plan.docx');
const L = localEntry('Plan.docx');
const L_EDITED = localEntry('Plan.docx', { mtimeMs: 2000, size: 12 });
const EDITED: InputOptions['md5s'] = [['Plan.docx', 'edited']];
const R = nativeEntry('g1', 'Plan.docx');
const R_MOD = nativeEntry('g1', 'Plan.docx', { modifiedTime: NEWER });
const FOLDERS: InputOptions['folders'] = [['folder:sub', 'sub']];

function run(o: InputOptions) {
  return plan(planInput({ records: [K], ...o }));
}
const kinds = (o: InputOptions) => run(o).actions.map((a) => [a.kind, a.rule, a.key]);

describe('Google-native tracked records (spec §6.6)', () => {
  it('N1 unmodified and unchanged → nothing', () => {
    const p = run({ local: [L], remote: [R] });
    expect(p.actions).toEqual([]);
    expect(p.notes).toEqual([]);
  });
  it('N2 edited locally → native-readonly-edited, never uploaded', () => {
    const p = run({ local: [L_EDITED], remote: [R], md5s: EDITED });
    expect(p.actions).toEqual([]);
    expect(p.notes[0]).toMatchObject({ code: 'native-readonly-edited', rule: 'N2' });
    expect(p.notes[0]?.message).toMatch(/docs_\*/);
  });
  it('N3 local copy missing → native-local-missing, never trash-remote', () => {
    const p = run({ remote: [R] });
    expect(p.actions).toEqual([]);
    expect(p.notes[0]).toMatchObject({ code: 'native-local-missing', rule: 'N3' });
    expect(p.notes[0]?.message).toMatch(/sync_release/);
  });
  it('N4 modified in Drive → export-replace, or export-new when L is gone', () => {
    expect(kinds({ local: [L], remote: [R_MOD] })).toEqual([['export-replace', 'N4', 'Plan.docx']]);
    expect(kinds({ remote: [R_MOD] })).toEqual([['export-new', 'N4', 'Plan.docx']]);
  });
  it('N5 modified in Drive and edited locally → keep the edit, export-new', () => {
    expect(run({ local: [L_EDITED], remote: [R_MOD], md5s: EDITED }).actions).toMatchObject([
      { kind: 'export-new', rule: 'N5', key: 'Plan.docx', localEdit: true, local: L_EDITED },
    ]);
  });
  it('N6 moved in Drive → move-local (export after it when modified) or export-new', () => {
    const moved = nativeEntry('g1', 'sub/Plan.docx');
    const movedMod = nativeEntry('g1', 'sub/Plan.docx', { modifiedTime: NEWER });
    expect(run({ local: [L], remote: [movedMod], folders: FOLDERS }).actions).toMatchObject([
      { kind: 'move-local', rule: 'N6', key: 'sub/Plan.docx', thenDownload: true },
    ]);
    expect(run({ local: [L], remote: [moved], folders: FOLDERS }).actions).toMatchObject([
      { kind: 'move-local', thenDownload: false },
    ]);
    expect(kinds({ remote: [moved], folders: FOLDERS })).toEqual([
      ['export-new', 'N6', 'sub/Plan.docx'],
    ]);
    const edited = run({ local: [L_EDITED], remote: [moved], md5s: EDITED, folders: FOLDERS });
    expect(edited.actions.map((a) => [a.kind, a.rule])).toEqual([['export-new', 'N6']]);
    expect(edited.notes[0]).toMatchObject({ code: 'conflict-rename' });
  });
  it('N6 also when the native is found only by the probe', () => {
    const probed = nativeEntry('g1', 'sub/Plan.docx');
    expect(
      kinds({
        local: [L],
        probes: [['g1', { state: 'present', entry: probed }]],
        folders: FOLDERS,
      }),
    ).toEqual([['move-local', 'N6', 'sub/Plan.docx']]);
  });
  it('N6 moved into an excluded key → untrack with moved-into-excluded', () => {
    const p = run({
      pair: { excluded: ['sub/Plan.docx'] },
      local: [L],
      remote: [nativeEntry('g1', 'sub/Plan.docx')],
      folders: FOLDERS,
    });
    expect(p.actions).toMatchObject([
      { kind: 'untrack', rule: 'N6', selection: { exclude: ['Plan.docx'] } },
    ]);
    expect(p.notes[0]).toMatchObject({ code: 'moved-into-excluded', rule: 'N6' });
  });
  it('N6 resume: the moved file is already at the new key → adopt, record stays native', () => {
    const p = run({
      local: [localEntry('sub/Plan.docx')],
      remote: [nativeEntry('g1', 'sub/Plan.docx')],
      md5s: [['sub/Plan.docx', K.localMd5 ?? '']],
      folders: FOLDERS,
    });
    expect(p.actions).toMatchObject([
      {
        kind: 'adopt',
        rule: 'N6',
        key: 'sub/Plan.docx',
        selection: { remove: ['Plan.docx'], add: ['sub/Plan.docx'] },
      },
    ]);
    expect(p.actions[0]?.record?.native).toEqual(K.native);
    expect(p.actions[0]?.remote?.native).toBeTruthy();
  });
  it('N7 trashed → trash-local when unchanged, forget when gone', () => {
    const trashed: InputOptions['probes'] = [['g1', { state: 'trashed' }]];
    expect(kinds({ local: [L], probes: trashed })).toEqual([['trash-local', 'N7', 'Plan.docx']]);
    expect(kinds({ probes: trashed })).toEqual([['forget', 'N7', 'Plan.docx']]);
  });
  it('N8 trashed while edited → untrack, keep L, exclude the key', () => {
    const p = run({ local: [L_EDITED], md5s: EDITED, probes: [['g1', { state: 'trashed' }]] });
    expect(p.actions).toMatchObject([
      { kind: 'untrack', rule: 'N8', selection: { exclude: ['Plan.docx'] } },
    ]);
    expect(p.notes[0]).toMatchObject({ code: 'native-trashed-edited' });
  });
  it('N9 moved-out → untrack; unavailable → report only', () => {
    expect(kinds({ local: [L], probes: [['g1', { state: 'moved-out' }]] })).toEqual([
      ['untrack', 'N9', 'Plan.docx'],
    ]);
    const p = run({ local: [L], probes: [['g1', { state: 'unavailable' }]] });
    expect(p.actions).toEqual([]);
    expect(p.notes[0]).toMatchObject({ code: 'remote-unavailable', rule: 'N9' });
  });
  it('never produces upload-new, update-remote, conflict or trash-remote', () => {
    const all = [
      run({ local: [L_EDITED], remote: [R], md5s: EDITED }),
      run({ remote: [R] }),
      run({ local: [L_EDITED], remote: [R_MOD], md5s: EDITED }),
    ].flatMap((p) => p.actions.map((a) => a.kind));
    for (const k of ['upload-new', 'update-remote', 'conflict', 'trash-remote']) {
      expect(all).not.toContain(k);
    }
  });
});
