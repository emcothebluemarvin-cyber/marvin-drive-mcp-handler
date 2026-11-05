import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { FileAuditLog } from '../../src/audit/audit-log.js';
import { DriveClientFactory } from '../../src/drive/client-factory.js';
import { FileService } from '../../src/files/file-service.js';
import { PairStore } from '../../src/sync/pair-store.js';
import { SyncService } from '../../src/sync/sync-service.js';
import type { LocalTrash } from '../../src/sync/trash.js';

const account = process.env.MARVIN_E2E_ACCOUNT;

describe.runIf(account)('Sync E2E (live)', () => {
  it('scan → select → dry run → apply → edits, conflict, deletions, rename, adoption', async () => {
    const app = buildApp();
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'marvin-sync-e2e-'));
    const local = path.join(tmp, 'local');
    const trashDir = path.join(tmp, 'trash');
    await mkdir(local);
    await mkdir(trashDir);
    // Local trash is redirected into the temp dir: the user's real trash is never touched.
    const trash: LocalTrash = {
      trash: async (abs) => {
        await rename(abs, path.join(trashDir, path.basename(abs)));
      },
    };
    // Every audit entry of this test (sync and plain file operations) goes to a temp file.
    const runner = new DriveClientFactory(app.auth);
    const audit = new FileAuditLog(path.join(tmp, 'audit.jsonl'));
    const files = new FileService({ runner, audit, downloadsDir: path.join(tmp, 'downloads') });
    const sync = new SyncService({
      runner,
      audit,
      store: new PairStore({ dir: path.join(tmp, 'sync') }),
      trash,
    });
    const at = (name: string): string => path.join(local, name);
    const setRemote = (fileId: string, text: string): Promise<unknown> =>
      runner.run(account, (ctx) =>
        ctx.drive.updateFile({
          fileId,
          media: { mimeType: 'text/plain', body: Readable.from([Buffer.from(text)]) },
          fields: 'id',
        }),
      );
    const root = await files.createFolder({ account, name: `marvin-sync-e2e-${Date.now()}` });
    try {
      const pre = path.join(tmp, 'pre.txt');
      await writeFile(pre, 'already in Drive');
      await files.upload({ account, localPath: pre, parentId: root.id });
      const names = ['edit-local', 'edit-remote', 'both', 'del-local', 'del-remote', 'moved'].map(
        (n) => `${n}.txt`,
      );
      for (const n of names) await writeFile(at(n), `${n.slice(0, -4)} v1`);
      await sync.createPair({ name: 'e2e', localDir: local, remoteFolderId: root.id, account });

      // scan → select → dry run → apply with planId
      const scan = await sync.scan({ name: 'e2e' });
      expect(scan.entries.map((e) => e.path).sort()).toEqual([...names].sort());
      expect(scan.entries.find((e) => e.path === 'both.txt')?.preview).toBe('both v1');
      expect(scan.remoteCandidates.map((c) => c.path)).toEqual(['pre.txt']);
      await sync.select({ name: 'e2e', add: names });
      const dry = await sync.run({ name: 'e2e' });
      expect(dry.actions['upload-new']).toHaveLength(6);
      const first = await sync.run({ name: 'e2e', apply: true, planId: dry.planId });
      expect(first.failures).toEqual([]);
      expect(first.actions['upload-new']).toHaveLength(6);

      // run 2: the pre-existing Drive file stays a candidate, nothing to do
      const second = await sync.run({ name: 'e2e' });
      expect(second.actions).toEqual({});
      expect(second.candidates.remote.map((c) => c.path)).toEqual(['pre.txt']);

      // edit both sides, conflict, delete on each side, rename within the folder
      const listed = await files.list({ account, folderId: root.id, pageSize: 200 });
      const id = (name: string): string => listed.files.find((f) => f.name === name)?.id ?? '';
      await writeFile(at('edit-local.txt'), 'local v2');
      await setRemote(id('edit-remote.txt'), 'remote v2');
      await writeFile(at('both.txt'), 'both local');
      await setRemote(id('both.txt'), 'both remote');
      await rm(at('del-local.txt'));
      await files.delete({ account, fileId: id('del-remote.txt') });
      await files.rename({ account, fileId: id('moved.txt'), newName: 'renamed.txt' });

      const third = await sync.run({ name: 'e2e', apply: true });
      expect(third.failures).toEqual([]);
      expect(third.actions).toEqual({
        'update-remote': ['edit-local.txt'],
        'move-local': ['renamed.txt'],
        'download-replace': ['edit-remote.txt'],
        conflict: ['both.txt'],
        'trash-remote': ['del-local.txt'],
        'trash-local': ['del-remote.txt'],
      });
      const copy = third.conflicts[0]?.conflictCopy ?? '';
      expect(copy).toMatch(/^both \(Drive conflict \d{4}-\d{2}-\d{2} \d{2}\.\d{2}\)\.txt$/);
      expect(await readFile(at(copy), 'utf8')).toBe('both remote');
      expect(await readFile(at('edit-remote.txt'), 'utf8')).toBe('remote v2');
      expect(await readFile(at('renamed.txt'), 'utf8')).toBe('moved v1');
      expect(await readdir(trashDir)).toEqual(['del-remote.txt']);

      // a Drive file added after the first applied run is adopted
      const late = path.join(tmp, 'late.txt');
      await writeFile(late, 'added after the first run');
      await files.upload({ account, localPath: late, parentId: root.id });
      const fourth = await sync.run({ name: 'e2e', apply: true });
      expect(fourth.actions).toEqual({ 'download-new': ['late.txt'] });
      expect(await readFile(at('late.txt'), 'utf8')).toBe('added after the first run');

      const final = await sync.run({ name: 'e2e' });
      expect(final.actions).toEqual({});
      expect(final.candidates.remote.map((c) => c.path)).toEqual(['pre.txt']);
      await sync.removePair({ name: 'e2e' });
    } finally {
      // Purge every child (including the ones this test trashed in Drive), then the folder.
      const children = await files.list({
        account,
        folderId: root.id,
        includeTrashed: true,
        pageSize: 200,
      });
      for (const child of children.files) {
        await files.delete({ account, fileId: child.id, permanent: true }).catch(() => undefined);
      }
      await files.delete({ account, fileId: root.id, permanent: true });
      await rm(tmp, { recursive: true, force: true });
    }
  });
});
