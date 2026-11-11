import { describe, expect, it } from 'vitest';
import { selectReleasable, type ReleaseSelection } from '../release.js';
import { localEntry, nativeEntry, nativeRecord, record, remoteEntry } from './fixtures.js';
import { planInput, type InputOptions } from './plan-input.js';

const A = record('r1', 'a.pdf');
const RA = remoteEntry('r1', 'a.pdf');
const sel = (o: InputOptions, request: { paths?: string[]; all?: boolean }) =>
  selectReleasable(planInput(o), request);
const eligible = (r: ReleaseSelection) => r.eligible.map((c) => [c.record.path, c.kind]);

describe('selectReleasable (spec §10, addendum §3)', () => {
  it('all: true takes only files in sync on both sides; deleted ones need their name', () => {
    const r = sel(
      {
        records: [A, record('r2', 'b.pdf'), record('r3', 'c.pdf')],
        local: [localEntry('a.pdf'), localEntry('b.pdf', { mtimeMs: 9 })],
        md5s: [['b.pdf', 'edited']],
        remote: [RA, remoteEntry('r2', 'b.pdf'), remoteEntry('r3', 'c.pdf')],
      },
      { all: true },
    );
    expect(eligible(r)).toEqual([['a.pdf', 'present']]);
    expect(r.skipped.map((s) => s.path)).toEqual(['b.pdf', 'c.pdf']);
    expect(r.skipped[1]?.reason).toMatch(/name it in paths/);
  });
  it('binary needs L = record = Drive md5; native needs L = last export', () => {
    const r = sel(
      {
        records: [A, nativeRecord('g1', 'Plan.docx')],
        local: [localEntry('a.pdf'), localEntry('Plan.docx')],
        remote: [
          remoteEntry('r1', 'a.pdf', { md5: 'other' }),
          nativeEntry('g1', 'Plan.docx', { modifiedTime: '2026-11-04T00:00:00.000Z' }),
        ],
      },
      { all: true },
    );
    expect(eligible(r)).toEqual([['Plan.docx', 'present']]);
  });
  it('a present native with a locally edited export is not eligible', () => {
    const r = sel(
      {
        records: [nativeRecord('g1', 'Plan.docx')],
        local: [localEntry('Plan.docx', { mtimeMs: 9 })],
        md5s: [['Plan.docx', 'edited']],
        remote: [nativeEntry('g1', 'Plan.docx')],
      },
      { paths: ['Plan.docx'] },
    );
    expect(r.eligible).toEqual([]);
    expect(r.skipped[0]?.reason).toMatch(/not in sync/);
  });
  it('R0: a named, locally deleted file whose Drive copy is unchanged', () => {
    expect(eligible(sel({ records: [A], remote: [RA] }, { paths: ['a.pdf'] }))).toEqual([
      ['a.pdf', 'deleted'],
    ]);
    const n = sel(
      { records: [nativeRecord('g1', 'Plan.docx')], remote: [nativeEntry('g1', 'Plan.docx')] },
      { paths: ['Plan.docx'] },
    );
    expect(eligible(n)).toEqual([['Plan.docx', 'deleted']]);
  });
  it('R0 refusals: unknown local subtree, fold-only match, Drive changed or trashed', () => {
    const sub = record('r1', 'locked/a.pdf');
    const locked = sel(
      { records: [sub], remote: [remoteEntry('r1', 'locked/a.pdf')], unknownLocal: ['locked'] },
      { paths: ['locked/a.pdf'] },
    );
    expect(locked.eligible).toEqual([]);
    expect(locked.skipped[0]?.reason).toMatch(/could not be read/);
    const fold = sel(
      { records: [A], local: [localEntry('A.pdf', { ino: 7 })], remote: [RA] },
      { paths: ['a.pdf'] },
    );
    expect(fold.eligible).toEqual([]);
    expect(fold.skipped[0]?.reason).toMatch(/similar name/);
    const changed = sel(
      { records: [A], remote: [remoteEntry('r1', 'a.pdf', { md5: 'new' })] },
      { paths: ['a.pdf'] },
    );
    expect(changed.eligible).toEqual([]);
    expect(changed.skipped[0]?.reason).toMatch(/changed in Drive/);
    const trashed = sel(
      { records: [A], probes: [['r1', { state: 'trashed' }]] },
      { paths: ['a.pdf'] },
    );
    expect(trashed.eligible).toEqual([]);
    expect(trashed.skipped[0]?.reason).toMatch(/trashed/);
  });
  it('R0 refusals: native changed in Drive, occupied path, unseen on disk', () => {
    const native = sel(
      {
        records: [nativeRecord('g1', 'Plan.docx')],
        remote: [nativeEntry('g1', 'Plan.docx', { modifiedTime: '2026-11-04T00:00:00.000Z' })],
      },
      { paths: ['Plan.docx'] },
    );
    expect(native.eligible).toEqual([]);
    expect(native.skipped[0]?.reason).toMatch(/changed in Drive/);
    const occupied = sel({ records: [A], remote: [RA], occupied: ['a.pdf'] }, { paths: ['a.pdf'] });
    expect(occupied.eligible).toEqual([]);
    expect(occupied.skipped[0]?.reason).toMatch(/non-regular/);
    const unseen = sel(
      { records: [A], remote: [RA], onDisk: [['a.pdf', { kind: 'other', ino: 3 }]] },
      { paths: ['a.pdf'] },
    );
    expect(unseen.eligible).toEqual([]);
    expect(unseen.skipped[0]?.reason).toMatch(/not seen by the scan/);
  });
  it('all: true never releases R0 paths; the same path named in paths is released', () => {
    const o: InputOptions = { records: [A], remote: [RA] };
    const all = sel(o, { all: true });
    expect(all.eligible).toEqual([]);
    expect(all.skipped).toEqual([
      { path: 'a.pdf', reason: 'deleted locally; name it in paths to keep it in Drive only' },
    ]);
    expect(eligible(sel(o, { paths: ['a.pdf'] }))).toEqual([['a.pdf', 'deleted']]);
  });
  it('skips released records, Drive moves, unknown and invalid paths', () => {
    const r = sel(
      {
        records: [{ ...A, remoteOnly: true }, record('r2', 'b.pdf')],
        local: [localEntry('b.pdf')],
        remote: [RA, remoteEntry('r2', 'sub/b.pdf')],
        folders: [['folder:sub', 'sub']],
      },
      { paths: ['a.pdf', 'b.pdf', 'zzz.pdf', '../x'] },
    );
    expect(r.eligible).toEqual([]);
    expect(r.skipped.map((s) => s.path)).toEqual(['a.pdf', 'b.pdf', 'zzz.pdf', '../x']);
    expect(r.skipped[0]?.reason).toBe('already in Drive only');
    expect(r.skipped[1]?.reason).toMatch(/moved or renamed in Drive/);
  });
  it('all: true leaves remote-only records out entirely', () => {
    const r = sel({ records: [{ ...A, remoteOnly: true }], remote: [RA] }, { all: true });
    expect(r).toEqual({ eligible: [], skipped: [] });
  });
});
