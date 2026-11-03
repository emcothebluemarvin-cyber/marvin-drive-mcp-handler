import { Command } from 'commander';
import { describe, expect, it, vi } from 'vitest';
import type { PairSummary } from '../../sync/sync-service.js';
import type { Pair, SyncReport } from '../../sync/types.js';
import { makePair } from '../../sync/__tests__/fixtures.js';
import { registerSyncCommands, type SyncCliDeps } from '../sync-commands.js';
import { formatReport } from '../sync-format.js';

const REPORT: SyncReport = {
  pair: 'docs',
  dryRun: false,
  planId: 'abcdef0123456789',
  aborted: null,
  actions: { 'upload-new': ['a.pdf'] },
  conflicts: [{ path: 'b.pdf', conflictCopy: 'b (Drive conflict 2026-11-03 10.15).pdf' }],
  collisions: [],
  ambiguous: [],
  unknown: [{ path: 'locked/c.pdf', reason: 'local folder could not be read' }],
  warnings: [],
  failures: [],
  notRun: [],
  candidates: { local: [], remote: [], truncated: false },
};

const SUMMARY: PairSummary = {
  name: 'docs',
  account: 'emco',
  localDir: '/Users/x/Docs',
  remoteFolderId: 'F1',
  caseInsensitive: true,
  counts: { selected: 2, tracked: 1, remoteOnly: 0, excluded: 0, baseline: 3 },
  createdAt: '2026-11-03T00:00:00.000Z',
  lastAppliedRunAt: null,
};

function setup(report: SyncReport = REPORT, answer = true) {
  const lines: string[] = [];
  const service = {
    listPairs: vi.fn(async () => [SUMMARY]),
    run: vi.fn(async () => report),
    repairMarker: vi.fn(async (_name: string, confirm: (pair: Pair) => Promise<boolean>) => {
      const repaired = await confirm(makePair({ localDir: '/Users/x/Docs' }));
      return { repaired, localDir: '/Users/x/Docs', caseInsensitive: true };
    }),
  };
  const deps: SyncCliDeps = {
    sync: () => service,
    out: (line) => lines.push(line),
    confirm: vi.fn(async () => answer),
    setExitCode: vi.fn(),
  };
  const program = new Command().exitOverride();
  registerSyncCommands(program, deps);
  const run = (...args: string[]) => program.parseAsync(['node', 'marvin-drive', 'sync', ...args]);
  return { lines, service, deps, run };
}

describe('sync CLI', () => {
  it('lists pairs', async () => {
    const { lines, run } = setup();
    await run('list');
    expect(lines[0]).toContain('docs');
    expect(lines[0]).toContain('/Users/x/Docs ⇄ F1 (emco)');
    expect(lines[0]).toContain('baseline 3');
  });

  it('runs a dry run by default and applies with flags', async () => {
    const { service, run, deps } = setup();
    await run('run', 'docs');
    expect(service.run).toHaveBeenLastCalledWith({
      name: 'docs',
      apply: false,
      allowMassDelete: false,
    });
    await run('run', 'docs', '--apply', '--allow-mass-delete');
    expect(service.run).toHaveBeenLastCalledWith({
      name: 'docs',
      apply: true,
      allowMassDelete: true,
    });
    await run('run', 'docs', '--apply', '--plan-id', 'abc');
    expect(service.run).toHaveBeenLastCalledWith({
      name: 'docs',
      apply: true,
      allowMassDelete: false,
      planId: 'abc',
    });
    expect(deps.setExitCode).not.toHaveBeenCalled();
  });

  it('exits 1 when the run aborted or something failed', async () => {
    const aborted = { ...REPORT, aborted: { reason: 'mass-delete' as const, message: 'too many' } };
    const a = setup(aborted);
    await a.run('run', 'docs', '--apply');
    expect(a.deps.setExitCode).toHaveBeenCalledWith(1);
    const failed = {
      ...REPORT,
      failures: [{ path: 'a.pdf', kind: 'upload-new' as const, message: 'x' }],
    };
    const f = setup(failed);
    await f.run('run', 'docs', '--apply');
    expect(f.deps.setExitCode).toHaveBeenCalledWith(1);
  });

  it('repair-marker asks for confirmation', async () => {
    const yes = setup(REPORT, true);
    await yes.run('repair-marker', 'docs');
    expect(yes.deps.confirm).toHaveBeenCalledWith(expect.stringContaining('/Users/x/Docs'));
    expect(yes.lines).toEqual(['Marker rewritten in /Users/x/Docs (case-insensitive: true).']);
    const no = setup(REPORT, false);
    await no.run('repair-marker', 'docs');
    expect(no.lines).toEqual(['Nothing changed.']);
  });
});

describe('formatReport', () => {
  it('renders actions, conflicts and unknown items', () => {
    expect(formatReport(REPORT)).toBe(
      [
        'docs — applied (planId abcdef012345)',
        'Done:',
        '  upload-new (1): a.pdf',
        'Conflicts:',
        '  b.pdf → Drive version kept as b (Drive conflict 2026-11-03 10.15).pdf',
        'Unknown state (no action):',
        '  locked/c.pdf — local folder could not be read',
      ].join('\n'),
    );
  });

  it('says when there is nothing to do', () => {
    const empty: SyncReport = { ...REPORT, dryRun: true, actions: {}, conflicts: [], unknown: [] };
    expect(formatReport(empty)).toBe('docs — dry run (planId abcdef012345)\nNothing to do.');
  });
});
