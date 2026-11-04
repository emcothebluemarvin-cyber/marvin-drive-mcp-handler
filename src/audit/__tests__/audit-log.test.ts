import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { FileAuditLog } from '../audit-log.js';
import { expectMode } from '../../__tests__/fs-mode.js';

describe('FileAuditLog', () => {
  it('appends one JSON line per entry with a timestamp, file mode 0600', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'marvin-audit-'));
    const file = path.join(dir, 'sub', 'audit.jsonl');
    const log = new FileAuditLog(file, () => new Date('2026-11-03T12:00:00.000Z'));
    await log.record({
      account: 'emco',
      op: 'rename',
      fileId: 'f1',
      name: 'b',
      details: { oldName: 'a', newName: 'b' },
    });
    await log.record({ account: 'emco', op: 'restore', fileId: 'f2', details: {} });

    const lines = (await readFile(file, 'utf8')).trim().split('\n');
    expect(lines.map((l) => JSON.parse(l) as unknown)).toEqual([
      {
        ts: '2026-11-03T12:00:00.000Z',
        account: 'emco',
        op: 'rename',
        fileId: 'f1',
        name: 'b',
        details: { oldName: 'a', newName: 'b' },
      },
      { ts: '2026-11-03T12:00:00.000Z', account: 'emco', op: 'restore', fileId: 'f2', details: {} },
    ]);
    await expectMode(file, 0o600);
  });
});
