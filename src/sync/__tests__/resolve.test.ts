import { describe, expect, it } from 'vitest';
import {
  buildContext,
  hashTargets,
  onDiskProbeKeys,
  localState,
  resolveLocal,
  resolveRemote,
} from '../resolve.js';
import { localEntry, record, remoteEntry } from './fixtures.js';
import { planInput } from './plan-input.js';

const NFD = 'şartname.pdf'.normalize('NFD');

describe('resolveLocal (spec §6.1)', () => {
  it('1: exact key match (NFD on disk matches the NFC key)', () => {
    const ctx = buildContext(planInput({ local: [localEntry(NFD)] }));
    expect(resolveLocal(ctx, 'şartname.pdf')).toMatchObject({
      kind: 'present',
      renamedCase: false,
      entry: { name: NFD },
    });
  });

  it('2: fold match on a case-insensitive volume is renamed-case when the volume agrees', () => {
    const agreed = buildContext(
      planInput({
        local: [localEntry('report.pdf')],
        onDisk: [['Report.pdf', { kind: 'file', ino: 1 }]],
      }),
    );
    expect(resolveLocal(agreed, 'Report.pdf')).toMatchObject({
      kind: 'present',
      renamedCase: true,
    });
    const unprobed = buildContext(planInput({ local: [localEntry('report.pdf')] }));
    expect(resolveLocal(unprobed, 'Report.pdf')).toEqual({ kind: 'ambiguous' });
    const other = buildContext(
      planInput({
        local: [localEntry('report.pdf')],
        onDisk: [['Report.pdf', { kind: 'file', ino: 2 }]],
      }),
    );
    expect(resolveLocal(other, 'Report.pdf')).toEqual({ kind: 'ambiguous' });
  });

  it('2: fold-only match on a case-sensitive volume is ambiguous', () => {
    const ctx = buildContext(
      planInput({ pair: { caseInsensitive: false }, local: [localEntry('report.pdf')] }),
    );
    expect(resolveLocal(ctx, 'Report.pdf')).toEqual({ kind: 'ambiguous' });
  });

  it('3: under an unreadable local folder is unknown', () => {
    const ctx = buildContext(planInput({ unknownLocal: ['locked'] }));
    expect(resolveLocal(ctx, 'locked/a.pdf').kind).toBe('unknown');
  });

  it('4: a non-regular entry at the key is unknown', () => {
    const ctx = buildContext(planInput({ occupied: ['a.pdf'] }));
    expect(resolveLocal(ctx, 'a.pdf')).toEqual({
      kind: 'unknown',
      reason: 'local path is occupied by a non-regular or ignored entry',
    });
  });

  it('5: otherwise absent', () => {
    expect(resolveLocal(buildContext(planInput()), 'a.pdf')).toEqual({ kind: 'absent' });
  });
});

describe('resolveRemote (spec §6.2)', () => {
  const k = record('r1', 'a.pdf');

  it('present-same and present-moved from the scan', () => {
    const same = buildContext(planInput({ remote: [remoteEntry('r1', 'a.pdf')] }));
    expect(resolveRemote(same, k)).toMatchObject({ kind: 'present', moved: false });
    const moved = buildContext(planInput({ remote: [remoteEntry('r1', 'sub/a.pdf')] }));
    expect(resolveRemote(moved, k)).toMatchObject({ kind: 'present', moved: true });
  });

  it('uses probes for records missing from the scan', () => {
    for (const state of ['trashed', 'moved-out', 'unavailable'] as const) {
      const ctx = buildContext(planInput({ probes: [['r1', { state }]] }));
      expect(resolveRemote(ctx, k)).toEqual({ kind: state });
    }
    const probed = buildContext(
      planInput({ probes: [['r1', { state: 'present', entry: remoteEntry('r1', 'b.pdf') }]] }),
    );
    expect(resolveRemote(probed, k)).toMatchObject({ kind: 'present', moved: true });
    const unknown = buildContext(
      planInput({ probes: [['r1', { state: 'unknown', reason: 'x' }]] }),
    );
    expect(resolveRemote(unknown, k)).toEqual({ kind: 'unknown', reason: 'x' });
    expect(resolveRemote(buildContext(planInput()), k).kind).toBe('unknown');
  });

  it('is unknown when the file was renamed to an ignored name', () => {
    const ctx = buildContext(
      planInput({
        ignored: [{ id: 'r1', path: '.a.pdf', reason: 'ignored-name', isFolder: false }],
      }),
    );
    expect(resolveRemote(ctx, k).kind).toBe('unknown');
  });
});

describe('content state', () => {
  it('local: unchanged by stat, else by md5; null when not hashed', () => {
    const k = record('r1', 'a.pdf');
    const ctx = buildContext(planInput({ md5s: [['b.pdf', 'md5-r1']] }));
    expect(localState(ctx, k, localEntry('a.pdf'))).toEqual({ changed: false, md5: 'md5-r1' });
    expect(localState(ctx, k, localEntry('b.pdf', { mtimeMs: 5 }))).toEqual({
      changed: false,
      md5: 'md5-r1',
    });
    expect(localState(ctx, k, localEntry('a.pdf', { mtimeMs: 5 }))).toBeNull();
  });
});

describe('hashTargets', () => {
  it('hashes tracked files with a changed stat and unrecorded selected files only', () => {
    const input = planInput({
      records: [record('r1', 'same.pdf'), record('r2', 'touched.pdf')],
      selection: ['New.pdf'],
      local: [
        localEntry('same.pdf'),
        localEntry('touched.pdf', { ctimeMs: 2 }),
        localEntry('new.pdf'),
        localEntry('unselected.pdf'),
      ],
    });
    expect(hashTargets(input)).toEqual(['new.pdf', 'touched.pdf']);
  });
});

describe('resolveLocal safety (blocking ancestors, on-disk probe)', () => {
  it('a key below a symlinked, special or dot-named folder is unknown, never absent', () => {
    const ctx = buildContext(planInput({ blocking: ['a'] }));
    expect(resolveLocal(ctx, 'a/x.pdf')).toEqual({
      kind: 'unknown',
      reason: 'a parent folder is a symlink, special file or ignored folder',
    });
  });

  it('a key that exists on disk but was not scanned is unknown', () => {
    const ctx = buildContext(planInput({ onDisk: [['a/x.pdf', { kind: 'file', ino: 99 }]] }));
    expect(resolveLocal(ctx, 'a/x.pdf').kind).toBe('unknown');
  });

  it('an on-disk inode equal to a scanned entry is that entry, renamed by case folding', () => {
    const ctx = buildContext(
      planInput({
        // A volume that folds more than foldKey: the scan sees `alias.pdf`, lstat(`x.pdf`) hits it.
        local: [localEntry('alias.pdf', { ino: 7 })],
        onDisk: [['x.pdf', { kind: 'file', ino: 7 }]],
      }),
    );
    expect(resolveLocal(ctx, 'x.pdf')).toMatchObject({
      kind: 'present',
      renamedCase: true,
      entry: { name: 'alias.pdf' },
    });
  });
});

describe('onDiskProbeKeys', () => {
  it('asks the volume about record keys without an exact match and fold-only matches', () => {
    const input = planInput({
      records: [record('r1', 'kept.pdf'), record('r2', 'Gone.pdf')],
      selection: ['Sel.pdf', 'nowhere.pdf'],
      local: [localEntry('kept.pdf'), localEntry('sel.pdf'), localEntry('drive.pdf')],
      remote: [remoteEntry('n1', 'Drive.pdf'), remoteEntry('n2', 'other.pdf')],
    });
    expect(onDiskProbeKeys(input)).toEqual(['Drive.pdf', 'Gone.pdf', 'Sel.pdf']);
  });
});
