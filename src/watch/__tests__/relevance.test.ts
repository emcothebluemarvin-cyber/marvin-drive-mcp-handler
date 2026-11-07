import { describe, expect, it } from 'vitest';
import { applyChange, toKnown, type Tracking } from '../relevance.js';
import { AYSE, BORA, ME, change, fileEntry, folderEntry, rawFile } from './fakes.js';

const NOW = '2026-11-07T11:00:05.000Z';
const LATER = '2026-11-07T11:01:00.000Z';
const F = folderEntry();
const empty: Tracking = { known: {}, pending: {} };

function knowing(id: string, file = rawFile(), via = ['F']): Tracking {
  return { known: { [id]: toKnown(file, via) }, pending: {} };
}

describe('applyChange (spec §5.3)', () => {
  it('R1: a removed known file becomes pending removed and is forgotten', () => {
    const t = applyChange(knowing('x'), { change: change('x', null), covering: [], now: NOW });
    expect(t.known).toEqual({});
    expect(t.pending.x).toMatchObject({
      flags: ['removed'],
      firstSeen: NOW,
      lastSeen: NOW,
      modifiers: [],
      after: null,
      before: { name: 'Plan', via: ['F'] },
    });
  });

  it('R2: a removed unknown file is ignored', () => {
    expect(applyChange(empty, { change: change('x', null), covering: [], now: NOW })).toBe(empty);
  });

  it('R3: a known file no longer under any watch is moved-out and forgotten', () => {
    const moved = rawFile({ parents: ['ELSEWHERE'] });
    const t = applyChange(knowing('x'), { change: change('x', moved), covering: [], now: NOW });
    expect(t.known).toEqual({});
    expect(t.pending.x?.flags).toEqual(['moved-out']);
    expect(t.pending.x?.modifiers).toEqual([]);
    expect(t.pending.x?.after?.parents).toEqual(['ELSEWHERE']);
  });

  it('R4: an unknown file outside every watch is ignored', () => {
    expect(applyChange(empty, { change: change('x', rawFile()), covering: [], now: NOW })).toBe(
      empty,
    );
  });

  it('R5: a file created after the folder was watched is added', () => {
    const created = rawFile({ createdTime: '2026-11-07T10:30:00.000Z' });
    const t = applyChange(empty, { change: change('x', created), covering: [F], now: NOW });
    expect(t.known.x).toMatchObject({ name: 'Plan', via: ['F'], kind: 'doc' });
    expect(t.pending.x).toMatchObject({ flags: ['added'], before: null, modifiers: [AYSE] });
  });

  it('R6: an old member seen for the first time (opened, starred, moved in) is only recorded', () => {
    const old = rawFile({ modifiedTime: '2026-11-06T09:00:00.000Z' });
    const t = applyChange(empty, { change: change('x', old), covering: [F], now: NOW });
    expect(t.known.x?.modifiedTime).toBe('2026-11-06T09:00:00.000Z');
    expect(t.pending).toEqual({});
  });

  it('R7: the first edit of an old member after a lazy folder add is edited + first-seen', () => {
    const t = applyChange(empty, { change: change('x', rawFile()), covering: [F], now: NOW });
    expect(t.pending.x?.flags).toEqual(['edited', 'first-seen']);
    expect(t.pending.x?.before).toBeNull();
  });

  it('R7: an unknown pre-existing subfolder with a recent modifiedTime is only recorded', () => {
    const sub = rawFile({ name: 'Sub', kind: 'folder' });
    const t = applyChange(empty, { change: change('S', sub), covering: [F], now: NOW });
    expect(t.known.S?.kind).toBe('folder');
    expect(t.pending).toEqual({});
  });

  it('a file that comes back after moved-out drops the stale pending item', () => {
    const out = applyChange(knowing('x'), {
      change: change('x', rawFile({ parents: ['ELSEWHERE'] })),
      covering: [],
      now: NOW,
    });
    const back = applyChange(out, {
      change: change('x', rawFile({ modifiedTime: '2026-11-06T09:00:00.000Z' })),
      covering: [F],
      now: LATER,
    });
    expect(back.pending).toEqual({});
    expect(back.known.x).toBeDefined();
  });

  it('R8 keeps an existing pending item up to date', () => {
    const edited = applyChange(knowing('x'), {
      change: change('x', rawFile({ modifiedTime: '2026-11-07T11:30:00.000Z' })),
      covering: [F],
      now: NOW,
    });
    const bumped = applyChange(edited, {
      change: change('x', rawFile({ modifiedTime: '2026-11-07T11:30:00.000Z', version: '8' })),
      covering: [F],
      now: LATER,
    });
    expect(bumped.pending.x?.after?.version).toBe('8');
    expect(bumped.pending.x?.lastSeen).toBe(NOW);
  });

  it('uses the earliest addedAt of nested watched folders', () => {
    const G = folderEntry({ id: 'G', addedAt: '2026-11-07T12:00:00.000Z' });
    const created = rawFile({ createdTime: '2026-11-07T11:00:00.000Z' });
    const t = applyChange(empty, { change: change('x', created), covering: [G, F], now: NOW });
    expect(t.pending.x?.flags).toEqual(['added']);
    expect(t.known.x?.via).toEqual(['F', 'G']);
  });

  it('R8: views, stars and sharing (identical fields) are ignored', () => {
    const start = knowing('x');
    const t = applyChange(start, { change: change('x', rawFile()), covering: [F], now: NOW });
    expect(t.pending).toEqual({});
  });

  it('R8: a version-only bump is ignored but remembered', () => {
    const t = applyChange(knowing('x'), {
      change: change('x', rawFile({ version: '9' })),
      covering: [F],
      now: NOW,
    });
    expect(t.pending).toEqual({});
    expect(t.known.x?.version).toBe('9');
  });

  it('R9: a content edit is pending edited with the prior state as before', () => {
    const edited = rawFile({ modifiedTime: '2026-11-07T11:30:00.000Z' });
    const t = applyChange(knowing('x'), { change: change('x', edited), covering: [F], now: NOW });
    expect(t.pending.x).toMatchObject({
      flags: ['edited'],
      before: { modifiedTime: '2026-11-07T11:00:00.000Z' },
      after: { modifiedTime: '2026-11-07T11:30:00.000Z' },
    });
  });

  it('R9: md5, rename, move, trash and restore flags', () => {
    const md5 = applyChange(knowing('x', rawFile({ md5: 'a' })), {
      change: change('x', rawFile({ md5: 'b' })),
      covering: [F],
      now: NOW,
    });
    expect(md5.pending.x?.flags).toEqual(['edited']);
    const meta = applyChange(knowing('x'), {
      change: change('x', rawFile({ name: 'Plan v2', parents: ['F', 'X'], trashed: true })),
      covering: [F],
      now: NOW,
    });
    expect(meta.pending.x?.flags).toEqual(['renamed', 'moved', 'trashed']);
    const restored = applyChange(knowing('x', rawFile({ trashed: true })), {
      change: change('x', rawFile()),
      covering: [F],
      now: NOW,
    });
    expect(restored.pending.x?.flags).toEqual(['restored']);
  });

  it('a watched folder itself only reports renamed / trashed / restored', () => {
    const self = rawFile({ name: 'Team', kind: 'folder', parents: ['ROOT'] });
    const start = knowing('F', self, ['F']);
    const touched = applyChange(start, {
      change: change('F', { ...self, modifiedTime: '2026-11-07T12:00:00.000Z', parents: ['X'] }),
      covering: [F],
      now: NOW,
    });
    expect(touched.pending).toEqual({});
    const renamed = applyChange(start, {
      change: change('F', { ...self, name: 'Team 2' }),
      covering: [F],
      now: NOW,
    });
    expect(renamed.pending.F?.flags).toEqual(['renamed']);
  });

  it('a member subfolder ignores modifiedTime noise but reports a rename', () => {
    const sub = rawFile({ name: 'Sub', kind: 'folder' });
    const start = knowing('S', sub);
    const noise = applyChange(start, {
      change: change('S', { ...sub, modifiedTime: '2026-11-07T12:00:00.000Z' }),
      covering: [F],
      now: NOW,
    });
    expect(noise.pending).toEqual({});
    const renamed = applyChange(start, {
      change: change('S', { ...sub, name: 'Sub 2' }),
      covering: [F],
      now: NOW,
    });
    expect(renamed.pending.S?.flags).toEqual(['renamed']);
  });

  it('a watched file entry covers itself', () => {
    const D = fileEntry();
    const start = knowing('D', rawFile(), ['D']);
    const t = applyChange(start, {
      change: change('D', rawFile({ modifiedTime: '2026-11-07T11:30:00.000Z', parents: ['ROOT'] })),
      covering: [D],
      now: NOW,
    });
    expect(t.pending.D?.flags).toEqual(['edited', 'moved']);
  });

  it('merges later changes into the pending item', () => {
    const first = applyChange(knowing('x'), {
      change: change('x', rawFile({ modifiedTime: '2026-11-07T11:30:00.000Z' })),
      covering: [F],
      now: NOW,
    });
    const second = applyChange(first, {
      change: change('x', rawFile({ modifiedTime: '2026-11-07T11:31:00.000Z', name: 'P2' })),
      covering: [F],
      now: LATER,
    });
    const third = applyChange(second, {
      change: change(
        'x',
        rawFile({ modifiedTime: '2026-11-07T11:32:00.000Z', name: 'P2', modifier: ME }),
      ),
      covering: [F],
      now: LATER,
    });
    const fourth = applyChange(third, {
      change: change(
        'x',
        rawFile({ modifiedTime: '2026-11-07T11:33:00.000Z', name: 'P2', modifier: BORA }),
      ),
      covering: [F],
      now: LATER,
    });
    expect(fourth.pending.x).toMatchObject({
      firstSeen: NOW,
      lastSeen: LATER,
      flags: ['edited', 'renamed'],
      modifiers: [AYSE, ME, BORA],
      before: { name: 'Plan', modifiedTime: '2026-11-07T11:00:00.000Z' },
      after: { name: 'P2', modifiedTime: '2026-11-07T11:33:00.000Z' },
    });
  });

  it('does not mutate its input', () => {
    const start = knowing('x');
    const snapshot = JSON.stringify(start);
    applyChange(start, { change: change('x', null), covering: [], now: NOW });
    expect(JSON.stringify(start)).toBe(snapshot);
  });
});
