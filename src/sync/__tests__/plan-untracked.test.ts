import { describe, expect, it } from 'vitest';
import { CANDIDATE_CAP, planUntracked, type Claims } from '../plan-untracked.js';
import { plan } from '../planner.js';
import { buildContext } from '../resolve.js';
import { localEntry, nativeEntry, remoteEntry } from './fixtures.js';
import { planInput, type InputOptions } from './plan-input.js';

const NO_CLAIMS: Claims = { folds: new Set(), localNames: new Set() };
const NEW = '2026-11-03T00:00:00.000Z';
const RECENT = Date.parse('2026-11-02T12:00:00.000Z');

function run(o: InputOptions, claims: Claims = NO_CLAIMS) {
  return planUntracked(buildContext(planInput(o)), claims);
}

describe('untracked keys (spec §6.5)', () => {
  it('U0 excluded keys are ignored silently', () => {
    const result = run({
      pair: { excluded: ['a.pdf'] },
      local: [localEntry('a.pdf')],
      remote: [remoteEntry('n1', 'a.pdf')],
    });
    expect(result).toEqual({
      actions: [],
      notes: [],
      candidates: { local: [], remote: [], truncated: false },
    });
  });

  it('U0 under an unknown subtree → unknown-state', () => {
    const result = run({
      selection: ['dup/a.pdf'],
      unknownRemote: ['dup'],
      local: [localEntry('dup/a.pdf')],
    });
    expect(result.actions).toEqual([]);
    expect(result.notes[0]).toMatchObject({ code: 'unknown-state', rule: 'U0' });
  });

  it('U0 selected key occupied by a non-regular entry → unknown-state', () => {
    const result = run({ selection: ['a.pdf'], occupied: ['a.pdf'] });
    expect(result.notes[0]).toMatchObject({ code: 'unknown-state', rule: 'U0' });
  });

  it('U1 selected local file, nothing in Drive → upload-new', () => {
    const result = run({
      selection: ['a.pdf'],
      local: [localEntry('a.pdf')],
      md5s: [['a.pdf', 'm']],
    });
    expect(result.actions[0]).toMatchObject({
      kind: 'upload-new',
      rule: 'U1',
      key: 'a.pdf',
      localMd5: 'm',
      selection: {},
    });
  });

  it('U2 same content on both sides → adopt', () => {
    const result = run({
      selection: ['a.pdf'],
      local: [localEntry('a.pdf')],
      remote: [remoteEntry('n1', 'a.pdf', { md5: 'm' })],
      md5s: [['a.pdf', 'm']],
    });
    expect(result.actions[0]).toMatchObject({ kind: 'adopt', rule: 'U2', remote: { id: 'n1' } });
  });

  it('U2 different content → conflict', () => {
    const result = run({
      selection: ['a.pdf'],
      local: [localEntry('a.pdf')],
      remote: [remoteEntry('n1', 'a.pdf')],
      md5s: [['a.pdf', 'm']],
    });
    expect(result.actions[0]).toMatchObject({ kind: 'conflict', rule: 'U2', updateRemote: true });
  });

  it('U2 different content and read-only Drive file → report only', () => {
    const result = run({
      selection: ['a.pdf'],
      local: [localEntry('a.pdf')],
      remote: [remoteEntry('n1', 'a.pdf', { canEdit: false })],
      md5s: [['a.pdf', 'm']],
    });
    expect(result.actions).toEqual([]);
    expect(result.notes[0]).toMatchObject({ code: 'remote-readonly', rule: 'U2' });
  });

  it('U3 selected Drive file, no local → download-new', () => {
    const result = run({ selection: ['a.pdf'], remote: [remoteEntry('n1', 'a.pdf')] });
    expect(result.actions[0]).toMatchObject({ kind: 'download-new', rule: 'U3', key: 'a.pdf' });
  });

  it('U4 selected but nowhere → missing', () => {
    const result = run({ selection: ['a.pdf'] });
    expect(result.notes[0]).toMatchObject({ code: 'missing', rule: 'U4', path: 'a.pdf' });
  });

  it('U5 baseline Drive files stay candidates (by id, by baseline folder, before the first run)', () => {
    const byId = run({ pair: { remoteBaseline: ['n1'] }, remote: [remoteEntry('n1', 'a.pdf')] });
    expect(byId.actions).toEqual([]);
    expect(byId.candidates.remote).toEqual([
      { path: 'a.pdf', size: 10, modifiedTime: '2026-11-02T00:00:00.000Z', remoteId: 'n1' },
    ]);
    const byFolder = run({
      pair: { baselineFolders: ['folder:old'] },
      remote: [remoteEntry('n2', 'old/b.pdf')],
    });
    expect(byFolder.candidates.remote.map((c) => c.path)).toEqual(['old/b.pdf']);
    const firstRun = run({
      pair: { firstAppliedRunAt: null, lastAppliedRunAt: null },
      remote: [remoteEntry('n3', 'c.pdf')],
    });
    expect(firstRun.candidates.remote.map((c) => c.path)).toEqual(['c.pdf']);
  });

  it('U6 new Drive file after the first run → download-new and select', () => {
    const result = run({ remote: [remoteEntry('n1', 'a.pdf', { modifiedTime: NEW })] });
    expect(result.actions[0]).toMatchObject({
      kind: 'download-new',
      rule: 'U6',
      selection: { add: ['a.pdf'] },
    });
  });

  it('a Drive native and a binary with the same export key are ambiguous (no action)', () => {
    const result = run({
      remote: [nativeEntry('g1', 'Plan.docx'), remoteEntry('b1', 'Plan.docx')],
    });
    expect(result.actions).toEqual([]);
    expect(result.notes).toMatchObject([{ code: 'ambiguous', path: 'Plan.docx' }]);
  });

  it('U7 new Drive file colliding with a local file → collision', () => {
    const result = run({
      remote: [remoteEntry('n1', 'a.pdf')],
      local: [localEntry('A.pdf')],
      onDisk: [['a.pdf', { kind: 'file', ino: 1 }]],
    });
    expect(result.actions).toEqual([]);
    expect(result.notes[0]).toMatchObject({ code: 'collision', rule: 'U7', remoteId: 'n1' });
  });

  it('U8 unselected local files are candidates when modified since the last run', () => {
    const result = run({
      local: [localEntry('old.pdf', { mtimeMs: 1000 }), localEntry('new.pdf', { mtimeMs: RECENT })],
    });
    expect(result.candidates.local).toEqual([
      { path: 'new.pdf', size: 10, modifiedTime: new Date(RECENT).toISOString() },
    ]);
    const first = run({
      pair: { lastAppliedRunAt: null },
      local: [localEntry('old.pdf', { mtimeMs: 1000 })],
    });
    expect(first.candidates.local.map((c) => c.path)).toEqual(['old.pdf']);
  });

  it(`U8 caps candidates at ${CANDIDATE_CAP}`, () => {
    const local = Array.from({ length: CANDIDATE_CAP + 1 }, (_, i) =>
      localEntry(`f${String(i).padStart(3, '0')}.pdf`, { mtimeMs: RECENT }),
    );
    const result = run({ local });
    expect(result.candidates.local).toHaveLength(CANDIDATE_CAP);
    expect(result.candidates.truncated).toBe(true);
  });

  it('duplicate keys on one side make every involved key ambiguous', () => {
    const result = run({
      selection: ['a.pdf'],
      local: [localEntry('a.pdf')],
      remote: [remoteEntry('n1', 'a.pdf'), remoteEntry('n2', 'a.pdf')],
      md5s: [['a.pdf', 'md5-n1']],
    });
    expect(result.actions).toEqual([]);
    expect(result.notes.map((n) => n.code)).toEqual(['ambiguous']);
  });

  it('keys claimed by a tracked record are collisions for untracked Drive files', () => {
    const claims: Claims = { folds: new Set(['a.pdf']), localNames: new Set(['a.pdf']) };
    const result = run(
      { local: [localEntry('a.pdf')], remote: [remoteEntry('n1', 'a.pdf')] },
      claims,
    );
    expect(result.actions).toEqual([]);
    expect(result.notes[0]).toMatchObject({ code: 'collision', rule: 'U-tracked' });
  });
});

describe('case and normalization across sides', () => {
  const NFD = 'şartname.pdf'.normalize('NFD');

  it('NFD local + NFC Drive name are the same key → adopt on equal md5', () => {
    const result = run({
      selection: ['şartname.pdf'],
      local: [localEntry(NFD)],
      remote: [remoteEntry('n1', 'şartname.pdf', { md5: 'm' })],
      md5s: [[NFD, 'm']],
    });
    expect(result.actions[0]).toMatchObject({ kind: 'adopt', key: 'şartname.pdf' });
  });

  it('Report.pdf vs report.pdf on a case-insensitive volume pairs them (record key = Drive key)', () => {
    const result = run({
      selection: ['Report.pdf'],
      local: [localEntry('Report.pdf')],
      remote: [remoteEntry('n1', 'report.pdf', { md5: 'm' })],
      md5s: [['Report.pdf', 'm']],
      onDisk: [['report.pdf', { kind: 'file', ino: 1 }]],
    });
    expect(result.actions[0]).toMatchObject({
      kind: 'adopt',
      key: 'report.pdf',
      selection: { remove: ['Report.pdf'], add: ['report.pdf'] },
    });
  });

  it('Report.pdf vs report.pdf without the volume confirming the match is ambiguous', () => {
    const result = run({
      selection: ['Report.pdf'],
      local: [localEntry('Report.pdf')],
      remote: [remoteEntry('n1', 'report.pdf', { md5: 'm' })],
      md5s: [['Report.pdf', 'm']],
    });
    expect(result.actions).toEqual([]);
    expect(result.notes.map((n) => n.code)).toEqual(['ambiguous', 'ambiguous']);
  });

  it('Report.pdf vs report.pdf on a case-sensitive volume is ambiguous', () => {
    const result = run({
      pair: { caseInsensitive: false },
      selection: ['Report.pdf'],
      local: [localEntry('Report.pdf')],
      remote: [remoteEntry('n1', 'report.pdf')],
      md5s: [['Report.pdf', 'm']],
    });
    expect(result.actions).toEqual([]);
    expect(result.notes.map((n) => [n.code, n.path])).toEqual([
      ['ambiguous', 'Report.pdf'],
      ['ambiguous', 'report.pdf'],
    ]);
  });
});

describe('review regressions', () => {
  it('U0: a selected key below a symlinked folder is unknown-state', () => {
    const result = run({
      selection: ['a/x.pdf'],
      blocking: ['a'],
      remote: [remoteEntry('n1', 'a/x.pdf')],
    });
    expect(result.actions).toEqual([]);
    expect(result.notes[0]).toMatchObject({ code: 'unknown-state', rule: 'U0' });
  });

  it('U1 reuses the Drive folder spelling on a case-insensitive volume (no second folder)', () => {
    const result = run({
      selection: ['docs/a.pdf'],
      local: [localEntry('docs/a.pdf')],
      folders: [['F-Docs', 'Docs']],
      md5s: [['docs/a.pdf', 'm']],
    });
    expect(result.actions[0]).toMatchObject({
      kind: 'upload-new',
      key: 'Docs/a.pdf',
      selection: { remove: ['docs/a.pdf'], add: ['Docs/a.pdf'] },
    });
  });

  it('U1 with a case-only folder mismatch on a case-sensitive volume is ambiguous', () => {
    const result = run({
      pair: { caseInsensitive: false },
      selection: ['docs/a.pdf'],
      local: [localEntry('docs/a.pdf')],
      folders: [['F-Docs', 'Docs']],
      md5s: [['docs/a.pdf', 'm']],
    });
    expect(result.actions).toEqual([]);
    expect(result.notes[0]).toMatchObject({
      code: 'ambiguous',
      rule: 'U1',
      message: 'a Drive folder name differs only in case',
    });
  });

  it('U8 counts ctime: a copied file with an old mtime is still a candidate', () => {
    const result = run({ local: [localEntry('copied.pdf', { mtimeMs: 1000, ctimeMs: RECENT })] });
    expect(result.candidates.local.map((c) => c.path)).toEqual(['copied.pdf']);
  });
});

describe('untracked Google-native files (spec §6.5, §6.6)', () => {
  const DOC = nativeEntry('g1', 'Plan.docx');

  it('U0b a local file at the export path → ambiguous-native, nothing written', () => {
    for (const selection of [[], ['Plan.docx']]) {
      const result = run({ selection, local: [localEntry('Plan.docx')], remote: [DOC] });
      expect(result.actions).toEqual([]);
      expect(result.notes).toMatchObject([
        { code: 'ambiguous-native', rule: 'U0b', path: 'Plan.docx', remoteId: 'g1' },
      ]);
    }
  });
  it('U0b a hashed local file colliding with a native, also in the upgrade window → ambiguous-native, never upload/adopt/conflict', () => {
    for (const pair of [{}, { nativeBaselineDone: false }]) {
      for (const selection of [[], ['Plan.docx']]) {
        const result = run({
          pair,
          selection,
          local: [localEntry('Plan.docx')],
          remote: [DOC],
          md5s: [['Plan.docx', 'md5-local']],
        });
        expect(result.actions).toEqual([]);
        expect(result.candidates.remote).toEqual([]);
        expect(result.notes).toMatchObject([
          { code: 'ambiguous-native', rule: 'U0b', path: 'Plan.docx', remoteId: 'g1' },
        ]);
      }
    }
  });
  it('U3 selected → export-new', () => {
    const result = run({ selection: ['Plan.docx'], remote: [DOC] });
    expect(result.actions.map((a) => [a.kind, a.rule, a.key])).toEqual([
      ['export-new', 'U3', 'Plan.docx'],
    ]);
  });
  it('U6 new after the first applied run → export-new and selected', () => {
    expect(run({ remote: [DOC] }).actions).toMatchObject([
      { kind: 'export-new', rule: 'U6', key: 'Plan.docx', selection: { add: ['Plan.docx'] } },
    ]);
  });
  it('U5 upgrade window: unselected natives are candidates, binaries still adopt, selected natives export', () => {
    const pair = { nativeBaselineDone: false };
    const unselected = run({ pair, remote: [DOC, remoteEntry('n1', 'new.pdf')] });
    expect(unselected.actions.map((a) => [a.kind, a.key])).toEqual([['download-new', 'new.pdf']]);
    expect(unselected.candidates.remote.map((c) => c.path)).toEqual(['Plan.docx']);
    const selected = run({ pair, selection: ['Plan.docx'], remote: [DOC] });
    expect(selected.actions.map((a) => [a.kind, a.rule])).toEqual([['export-new', 'U3']]);
  });
  it('U5 upgrade window: a native selected during the window is exported (U3), with its selection kept', () => {
    const result = run({
      pair: { nativeBaselineDone: false },
      selection: ['Plan.docx'],
      remote: [DOC],
    });
    expect(result.actions).toMatchObject([
      { kind: 'export-new', rule: 'U3', key: 'Plan.docx', remote: { id: 'g1' }, selection: {} },
    ]);
    expect(result.candidates.remote).toEqual([]);
  });
});

describe('remote names (OneDrive sync spec §4.3)', () => {
  it('U1 on OneDrive: a refused file name is a note, the file stays local', () => {
    const result = run({
      selection: ['a:b.txt', 'ok.txt'],
      local: [localEntry('a:b.txt'), localEntry('ok.txt')],
      remoteProvider: 'microsoft',
    });
    expect(result.actions.map((a) => a.key)).toEqual(['ok.txt']);
    expect(result.notes).toEqual([
      {
        code: 'remote-name-invalid',
        path: 'a:b.txt',
        rule: 'U1',
        message:
          'cannot be uploaded to OneDrive: the name contains a character OneDrive does not allow (" * : < > ? / \\ |)',
      },
    ]);
  });

  it('a refused folder segment is reported once for its subtree', () => {
    const p = plan(
      planInput({
        selection: ['CON/a.txt', 'CON/b.txt', 'CON/deep/c.txt'],
        local: [localEntry('CON/a.txt'), localEntry('CON/b.txt'), localEntry('CON/deep/c.txt')],
        remoteProvider: 'microsoft',
      }),
    );
    expect(p.actions).toEqual([]);
    expect(p.notes.map((n) => [n.code, n.path])).toEqual([['remote-name-invalid', 'CON']]);
  });

  it('an existing remote folder is not checked; Google checks no names', () => {
    const onedrive = run({
      selection: ['Weird/a.txt'],
      local: [localEntry('Weird/a.txt')],
      folders: [['fw', 'Weird']],
      remoteProvider: 'microsoft',
    });
    expect(onedrive.actions.map((a) => a.kind)).toEqual(['upload-new']);
    const google = run({ selection: ['a:b.txt'], local: [localEntry('a:b.txt')] });
    expect(google.actions.map((a) => a.kind)).toEqual(['upload-new']);
  });

  it('on a case-sensitive volume a case-only folder mismatch stays ambiguous on OneDrive too', () => {
    // Reusing the remote spelling would record Docs/a.txt for the local docs/a.txt, which a
    // case-sensitive volume never resolves again (see the plan's Chunk 3 decisions).
    const result = run({
      pair: { caseInsensitive: false },
      selection: ['docs/a.txt'],
      local: [localEntry('docs/a.txt')],
      folders: [['fd', 'Docs']],
      remoteProvider: 'microsoft',
    });
    expect(result.actions).toEqual([]);
    expect(result.notes[0]).toMatchObject({
      code: 'ambiguous',
      rule: 'U1',
      message: 'a OneDrive folder name differs only in case',
    });
  });

  it('on a case-insensitive volume the remote spelling is reused on OneDrive', () => {
    const result = run({
      selection: ['docs/a.txt'],
      local: [localEntry('docs/a.txt')],
      folders: [['fd', 'Docs']],
      remoteProvider: 'microsoft',
    });
    expect(result.actions[0]).toMatchObject({ kind: 'upload-new', key: 'Docs/a.txt' });
  });
});
