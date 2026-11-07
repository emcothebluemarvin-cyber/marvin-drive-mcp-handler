import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { FileAuditLog } from '../../src/audit/audit-log.js';
import { DocsService } from '../../src/content/docs-service.js';
import { DriveClientFactory } from '../../src/drive/client-factory.js';
import { FileService } from '../../src/files/file-service.js';
import { PairStore } from '../../src/sync/pair-store.js';
import { SyncService } from '../../src/sync/sync-service.js';
import type { LocalTrash } from '../../src/sync/trash.js';

const account = process.env.MARVIN_E2E_ACCOUNT;

/** Temp local + trash dirs, a temp audit log and services on the live account; never the real trash. */
async function e2eSetup() {
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
  // Every audit entry of the test (sync, file and content operations) goes to a temp file.
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
  /** Purges every child of the test folder (incl. ones trashed by the test), the folder, then tmp. */
  const cleanup = async (rootId: string): Promise<void> => {
    try {
      const children = await files.list({
        account,
        folderId: rootId,
        includeTrashed: true,
        pageSize: 200,
      });
      for (const child of children.files) {
        await files.delete({ account, fileId: child.id, permanent: true }).catch(() => undefined);
      }
      await files.delete({ account, fileId: rootId, permanent: true });
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  };
  return { app, tmp, local, trashDir, trash, runner, audit, files, sync, at, cleanup };
}

describe.runIf(account)('Sync E2E (live)', () => {
  it('scan → select → dry run → apply → edits, conflict, deletions, rename, adoption', async () => {
    const { tmp, local, trashDir, runner, files, sync, at, cleanup } = await e2eSetup();
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

      const third = await sync.run({ name: 'e2e', apply: true, confirmRemoteTrash: true });
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
      await cleanup(root.id);
    }
  });

  it('Phase B: Google Doc export → release → no re-export → restore; confirmation; R0', async () => {
    const { tmp, local, trashDir, runner, audit, files, sync, at, cleanup } = await e2eSetup();
    const docs = new DocsService({ runner, audit }); // audit entries go to the temp log
    const root = await files.createFolder({ account, name: `marvin-sync-e2e-b-${Date.now()}` });
    try {
      await sync.createPair({ name: 'e2eb', localDir: local, remoteFolderId: root.id, account });
      await sync.run({ name: 'e2eb', apply: true }); // first applied run: later files are adopted
      const src = path.join(tmp, 'Plan.txt');
      await writeFile(src, 'plan v1');
      const doc = await files.upload({
        account,
        localPath: src,
        parentId: root.id,
        name: 'Plan',
        convertToGoogle: true,
      });
      const exported = await sync.run({ name: 'e2eb', apply: true });
      expect(exported.actions).toEqual({ 'export-new': ['Plan.docx'] });
      expect((await readFile(at('Plan.docx'))).subarray(0, 2).toString()).toBe('PK');

      // release → a later Drive edit is not exported
      const released = await sync.release({ name: 'e2eb', paths: ['Plan.docx'], apply: true });
      expect(released.released).toEqual([{ path: 'Plan.docx', status: 'released' }]);
      expect(await readdir(trashDir)).toEqual(['Plan.docx']);
      await docs.insertText({ account, fileId: doc.id, text: ' more', position: { at: 'end' } });
      expect((await sync.run({ name: 'e2eb', apply: true })).actions).toEqual({});
      await expect(readFile(at('Plan.docx'))).rejects.toThrow();

      // select add restores it
      await sync.select({ name: 'e2eb', add: ['Plan.docx'] });
      expect((await sync.run({ name: 'e2eb', apply: true })).actions).toEqual({
        'export-new': ['Plan.docx'],
      });

      // local deletion: unconfirmed → pending; confirmed → Drive trash
      await writeFile(at('note.txt'), 'note');
      await sync.select({ name: 'e2eb', add: ['note.txt'] });
      await sync.run({ name: 'e2eb', apply: true });
      await rm(at('note.txt'));
      const pending = await sync.run({ name: 'e2eb', apply: true });
      expect(pending.pendingConfirmation.map((p) => p.path)).toEqual(['note.txt']);
      const dry = await sync.run({ name: 'e2eb' });
      const confirmed = await sync.run({
        name: 'e2eb',
        apply: true,
        planId: dry.planId,
        confirmRemoteTrash: true,
      });
      expect(confirmed.actions['trash-remote']).toEqual(['note.txt']);

      // R0: a file deleted locally is kept in Drive only
      await writeFile(at('keep.txt'), 'keep');
      await sync.select({ name: 'e2eb', add: ['keep.txt'] });
      await sync.run({ name: 'e2eb', apply: true });
      await rm(at('keep.txt'));
      const r0 = await sync.release({ name: 'e2eb', paths: ['keep.txt'], apply: true });
      expect(r0.released).toEqual([
        { path: 'keep.txt', status: 'released (already deleted locally)' },
      ]);
      const final = await sync.run({ name: 'e2eb' });
      expect(final.actions).toEqual({});
      expect(final.pendingConfirmation).toEqual([]);
      await sync.removePair({ name: 'e2eb' });
    } finally {
      await cleanup(root.id);
    }
  });
});
