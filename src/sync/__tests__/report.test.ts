import { describe, expect, it } from 'vitest';
import { buildReport } from '../report.js';
import type { Action, Plan } from '../types.js';

function action(kind: Action['kind'], key: string): Action {
  return {
    kind,
    rule: 'x',
    key,
    record: null,
    local: null,
    localMd5: null,
    remote: null,
    selection: {},
  };
}

const PLAN: Plan = {
  planId: 'p1',
  actions: [action('upload-new', 'a.pdf'), action('refresh', 'r.pdf'), action('conflict', 'c.pdf')],
  notes: [
    {
      code: 'unknown-state',
      path: 'u.pdf',
      rule: 'unknown',
      message: 'local folder could not be read',
    },
    { code: 'ambiguous', path: 'x.pdf', rule: 'ambiguous' },
    { code: 'ambiguous', path: 'x.pdf', rule: 'ambiguous' },
    { code: 'collision', path: 'k.pdf', rule: 'U7' },
    { code: 'remote-readonly', path: 'ro.pdf', rule: 'B2', message: 'no edit permission in Drive' },
  ],
  candidates: {
    local: [{ path: 'l.pdf', size: 1, modifiedTime: 't' }],
    remote: [],
    truncated: false,
  },
  brake: { tripped: false, trashRemote: 0, trashLocal: 0, tracked: 0 },
  baseline: { files: [], folders: [] },
};

describe('buildReport', () => {
  it('lists planned actions (without refreshes) and classifies notes on a dry run', () => {
    expect(buildReport('docs', PLAN, { dryRun: true })).toEqual({
      pair: 'docs',
      dryRun: true,
      planId: 'p1',
      aborted: null,
      actions: { 'upload-new': ['a.pdf'], conflict: ['c.pdf'] },
      conflicts: [{ path: 'c.pdf' }],
      collisions: ['k.pdf'],
      ambiguous: ['x.pdf'],
      unknown: [{ path: 'u.pdf', reason: 'local folder could not be read' }],
      warnings: [
        { path: 'ro.pdf', code: 'remote-readonly', message: 'no edit permission in Drive' },
      ],
      failures: [],
      notRun: [],
      candidates: PLAN.candidates,
    });
  });

  it('reports executed outcomes', () => {
    const report = buildReport('docs', PLAN, {
      dryRun: false,
      outcomes: [
        { kind: 'upload-new', path: 'a.pdf', status: 'done', warning: 'changed-during-upload' },
        { kind: 'refresh', path: 'r.pdf', status: 'done' },
        {
          kind: 'conflict',
          path: 'c.pdf',
          status: 'done',
          conflictCopy: 'c (Drive conflict 2026-11-03 10.15).pdf',
        },
        { kind: 'download-replace', path: 'd.pdf', status: 'skipped', message: 'changed' },
        { kind: 'download-new', path: 'e.pdf', status: 'collision', message: 'exists' },
        { kind: 'update-remote', path: 'f.pdf', status: 'failed', message: 'boom' },
        { kind: 'trash-local', path: 'g.pdf', status: 'not-run' },
      ],
    });
    expect(report.actions).toEqual({ 'upload-new': ['a.pdf'], conflict: ['c.pdf'] });
    expect(report.conflicts).toEqual([
      { path: 'c.pdf', conflictCopy: 'c (Drive conflict 2026-11-03 10.15).pdf' },
    ]);
    expect(report.warnings).toEqual([
      { path: 'ro.pdf', code: 'remote-readonly', message: 'no edit permission in Drive' },
      { path: 'a.pdf', code: 'changed-during-upload' },
      { path: 'd.pdf', code: 'skipped-changed', message: 'changed' },
    ]);
    expect(report.collisions).toEqual(['k.pdf', 'e.pdf']);
    expect(report.failures).toEqual([{ path: 'f.pdf', kind: 'update-remote', message: 'boom' }]);
    expect(report.notRun).toEqual(['g.pdf']);
  });

  it('carries an abort reason', () => {
    const aborted = { reason: 'mass-delete' as const, message: 'too many' };
    expect(buildReport('docs', PLAN, { dryRun: true, aborted }).aborted).toEqual(aborted);
  });
});
