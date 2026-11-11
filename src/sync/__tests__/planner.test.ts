import { afterEach, describe, expect, it, vi } from 'vitest';
import { brakeFor, computePlanId, plan } from '../planner.js';
import type { Action } from '../types.js';
import { localEntry, nativeEntry, nativeRecord, record, remoteEntry } from './fixtures.js';
import { md5Digests, planInput } from './plan-input.js';

function trash(kind: 'trash-remote' | 'trash-local', n: number): Action[] {
  return Array.from({ length: n }, (_, i) => ({
    kind,
    rule: kind === 'trash-remote' ? 'B5' : 'B10',
    key: `f${i}`,
    record: null,
    local: null,
    localMd5: null,
    remote: null,
    selection: {},
  }));
}

afterEach(() => {
  vi.useRealTimers();
});

describe('plan composition', () => {
  it('orders actions by execution stage, then key', () => {
    const p = plan(
      planInput({
        records: [record('r1', 'b.pdf'), record('r2', 'a.pdf')],
        selection: ['up.pdf'],
        local: [localEntry('b.pdf'), localEntry('up.pdf')],
        remote: [remoteEntry('r2', 'a.pdf', { md5: 'changed' })],
        probes: [['r1', { state: 'trashed' }]],
        md5s: [['up.pdf', 'u']],
      }),
    );
    expect(p.actions.map((a) => [a.kind, a.key])).toEqual([
      ['upload-new', 'up.pdf'],
      ['download-new', 'a.pdf'],
      ['trash-local', 'b.pdf'],
    ]);
  });

  it('reports native-unsupported and unrepresentable Drive files', () => {
    const p = plan(
      planInput({
        ignored: [
          { id: 'g1', path: 'Survey', reason: 'native-unsupported', isFolder: false },
          { id: 'u1', path: 'a/b', reason: 'unrepresentable', isFolder: false },
          { id: 's1', path: 'link', reason: 'shortcut', isFolder: false },
        ],
      }),
    );
    expect(p.notes.map((n) => [n.code, n.path])).toEqual([
      ['native-unsupported', 'Survey'],
      ['unrepresentable', 'a/b'],
    ]);
    expect(p.notes[0]?.message).toMatch(/cannot be exported/);
    expect(p.notes[1]?.message).toMatch(/rename it in Drive/);
    expect(p.notes[1]?.message).toMatch(/Windows/);
  });

  it('computes the first-run baseline from every untracked Drive file, unknown and ignored folder', () => {
    const p = plan(
      planInput({
        pair: { firstAppliedRunAt: null, lastAppliedRunAt: null },
        records: [record('r1', 'a.pdf')],
        local: [localEntry('a.pdf')],
        remote: [
          remoteEntry('r1', 'a.pdf'),
          remoteEntry('n1', 'n.pdf'),
          remoteEntry('d1', 'x.pdf'),
          remoteEntry('d2', 'X.pdf'),
        ],
        ignored: [
          { id: 'g1', path: 'Plan', reason: 'native-unsupported', isFolder: false },
          { id: 'f9', path: '.git', reason: 'ignored-name', isFolder: true },
        ],
        unknownFolderIds: ['dupF'],
      }),
    );
    expect(p.baseline).toEqual({ files: ['d1', 'd2', 'g1', 'n1'], folders: ['dupF', 'f9'] });
  });

  it('lists untracked Google-native Drive files for the upgrade baseline', () => {
    const p = plan(
      planInput({
        records: [record('r0', 'a.pdf')],
        local: [localEntry('a.pdf')],
        remote: [
          remoteEntry('r0', 'a.pdf'),
          nativeEntry('g2', 'B.docx'),
          nativeEntry('g1', 'A.docx'),
          remoteEntry('n1', 'new.pdf'),
        ],
      }),
    );
    expect(p.nativeBaseline).toEqual(['g1', 'g2']);
  });
  it('lists records in sync (B1, N1) for releasable', () => {
    const p = plan(
      planInput({
        records: [record('r1', 'a.pdf'), record('r2', 'b.pdf'), nativeRecord('g1', 'Plan.docx')],
        local: [localEntry('a.pdf'), localEntry('Plan.docx')],
        remote: [
          remoteEntry('r1', 'a.pdf'),
          remoteEntry('r2', 'b.pdf'),
          nativeEntry('g1', 'Plan.docx'),
        ],
      }),
    );
    expect(p.inSync).toEqual(['Plan.docx', 'a.pdf']);
  });
});

describe('mass-delete brake (spec §6.8)', () => {
  it('brake counts every deletion; brakeUnconfirmed only those not awaiting confirmation', () => {
    const records = ['a', 'b', 'c'].map((n, i) => record(`r${i}`, `${n}.pdf`));
    const p = plan(
      planInput({ records, remote: records.map((r) => remoteEntry(r.remoteId, r.path)) }),
    );
    expect(p.actions.map((a) => a.reason)).toEqual([
      'local-deleted',
      'local-deleted',
      'local-deleted',
    ]);
    expect(p.brake.tripped).toBe(true);
    expect(p.brakeUnconfirmed).toEqual({
      tripped: false,
      trashRemote: 0,
      trashLocal: 0,
      tracked: 3,
    });
  });

  it('planId does not depend on the reason', () => {
    const [a] = trash('trash-remote', 1);
    expect(computePlanId([{ ...a!, reason: 'local-deleted' }])).toBe(computePlanId([a!]));
  });

  it('trips above max(10, 20% of tracked)', () => {
    expect(brakeFor(trash('trash-remote', 10), 100).tripped).toBe(false);
    expect(brakeFor(trash('trash-remote', 11), 30).tripped).toBe(true);
    expect(brakeFor([...trash('trash-remote', 10), ...trash('trash-local', 10)], 100).tripped).toBe(
      false,
    );
    expect(brakeFor([...trash('trash-remote', 11), ...trash('trash-local', 10)], 100).tripped).toBe(
      true,
    );
  });

  it('trips when every tracked file of one side would go (≥ 3 tracked)', () => {
    expect(brakeFor(trash('trash-local', 3), 3)).toEqual({
      tripped: true,
      trashRemote: 0,
      trashLocal: 3,
      tracked: 3,
    });
    expect(brakeFor(trash('trash-remote', 3), 3).tripped).toBe(true);
    expect(brakeFor(trash('trash-remote', 2), 2).tripped).toBe(false);
    expect(brakeFor(trash('trash-remote', 2), 3).tripped).toBe(false);
  });

  it('is computed for a plan, ignoring remote-only records in the count', () => {
    const records = ['a', 'b', 'c'].map((n) => record(`r-${n}`, `${n}.pdf`));
    const p = plan(
      planInput({ records, remote: records.map((k) => remoteEntry(k.remoteId, k.path)) }),
    );
    expect(p.brake).toEqual({ tripped: true, trashRemote: 3, trashLocal: 0, tracked: 3 });
  });
});

describe('planId (spec §5)', () => {
  const input = () =>
    planInput({
      records: [record('r1', 'a.pdf')],
      selection: ['b.pdf'],
      local: [localEntry('a.pdf', { size: 12, mtimeMs: 5 }), localEntry('b.pdf')],
      remote: [remoteEntry('r1', 'a.pdf', { md5: 'remote' })],
      md5s: [
        ['a.pdf', 'local'],
        ['b.pdf', 'bb'],
      ],
    });

  it('is stable across minute boundaries and ignores refresh-only changes', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-03T10:59:59.900Z'));
    const first = plan(input());
    vi.setSystemTime(new Date('2026-11-03T11:00:00.100Z'));
    const second = plan(input());
    expect(second.planId).toBe(first.planId);
    expect(first.planId).toMatch(/^[0-9a-f]{64}$/);
    expect(first.actions.map((a) => a.kind)).toEqual(['upload-new', 'conflict']);
    const withRefresh: Action = { ...first.actions[0]!, kind: 'refresh' };
    expect(computePlanId([...first.actions, withRefresh])).toBe(first.planId);
  });

  it('changes when content changes', () => {
    const changed = input();
    const digests = new Map(changed.digests);
    digests.set('a.pdf', md5Digests('local-2'));
    expect(plan({ ...changed, digests }).planId).not.toBe(plan(input()).planId);
  });
});

describe('regressions (spec §11, Phase A)', () => {
  it('baseline candidates never auto-download on later runs (U5)', () => {
    const p = plan(
      planInput({ pair: { remoteBaseline: ['n1'] }, remote: [remoteEntry('n1', 'old.pdf')] }),
    );
    expect(p.actions).toEqual([]);
    expect(p.candidates.remote.map((c) => c.path)).toEqual(['old.pdf']);
  });

  it('a local case-only rename does not trash the Drive file', () => {
    const k = record('r1', 'Report.pdf');
    const ci = plan(
      planInput({
        records: [k],
        local: [localEntry('report.pdf')],
        remote: [remoteEntry('r1', 'Report.pdf')],
        onDisk: [['Report.pdf', { kind: 'file', ino: 1 }]],
      }),
    );
    expect(ci.actions.map((a) => [a.kind, a.local?.name])).toEqual([['refresh', 'report.pdf']]);
    const cs = plan(
      planInput({
        pair: { caseInsensitive: false },
        records: [k],
        local: [localEntry('report.pdf')],
        remote: [remoteEntry('r1', 'Report.pdf')],
      }),
    );
    expect(cs.actions).toEqual([]);
    expect(cs.notes.map((n) => n.code)).toContain('ambiguous');
  });

  it('an unknown local subtree never yields trash-remote', () => {
    const k = record('r1', 'locked/a.pdf');
    const p = plan(
      planInput({
        records: [k],
        unknownLocal: ['locked'],
        remote: [remoteEntry('r1', 'locked/a.pdf')],
      }),
    );
    expect(p.actions).toEqual([]);
    expect(p.notes[0]).toMatchObject({ code: 'unknown-state', path: 'locked/a.pdf' });
  });

  it('an ambiguous Drive folder never yields untrack', () => {
    const k = record('r1', 'dup/a.pdf');
    const p = plan(
      planInput({
        records: [k],
        local: [localEntry('dup/a.pdf')],
        unknownRemote: ['dup'],
        unknownFolderIds: ['d1', 'd2'],
        probes: [['r1', { state: 'moved-out' }]],
      }),
    );
    expect(p.actions).toEqual([]);
    expect(p.notes[0]).toMatchObject({ code: 'unknown-state' });
  });

  it('P5: Turkish ılık.pdf is not the deleted ilik.pdf (no upload of unrelated content)', () => {
    const k = record('r1', 'ilik.pdf');
    const p = plan(
      planInput({
        pair: { lastAppliedRunAt: null },
        records: [k],
        local: [localEntry('ılık.pdf', { ino: 9 })],
        remote: [remoteEntry('r1', 'ilik.pdf')],
      }),
    );
    expect(p.actions.map((a) => [a.kind, a.key])).toEqual([['trash-remote', 'ilik.pdf']]);
    expect(p.candidates.local.map((c) => c.path)).toEqual(['ılık.pdf']);
    expect(p.actions.some((a) => a.kind === 'update-remote' || a.kind === 'conflict')).toBe(false);
  });

  it('a fold match the volume does not confirm is ambiguous, never written over', () => {
    const k = record('r1', 'Report.pdf', { localMd5: 'old' });
    const p = plan(
      planInput({
        records: [k],
        local: [localEntry('report.pdf', { size: 99 })],
        remote: [remoteEntry('r1', 'Report.pdf', { md5: 'old' })],
        md5s: [['report.pdf', 'unrelated']],
        onDisk: [['Report.pdf', { kind: 'file', ino: 2 }]],
      }),
    );
    expect(p.actions).toEqual([]);
    expect(p.notes.map((n) => n.code)).toEqual(['ambiguous']);
  });

  it('a remote-only record (Phase B data) is never trashed in Phase A', () => {
    const k = record('r1', 'a.pdf', { remoteOnly: true });
    const p = plan(planInput({ records: [k], remote: [remoteEntry('r1', 'a.pdf')] }));
    expect(p.actions).toEqual([]);
  });
});
