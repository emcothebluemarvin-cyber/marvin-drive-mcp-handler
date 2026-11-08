import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { google } from 'googleapis';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { FileAuditLog } from '../../src/audit/audit-log.js';
import { OperationRunner } from '../../src/core/operation.js';
import { DriveClientFactory } from '../../src/drive/client-factory.js';
import type { PushFn } from '../../src/watch/delivery.js';
import { GoogleChangeFeed } from '../../src/watch/google/feed.js';
import { createGoogleWatchProvider } from '../../src/watch/google/provider.js';
import { applyChange, toKnown } from '../../src/watch/relevance.js';
import type { ChangeEvent, RawChange } from '../../src/watch/types.js';
import { WatchService } from '../../src/watch/watch-service.js';
import { WatchStore } from '../../src/watch/watch-store.js';

/** Opt-in: the owner account and a second registered account that edits (spec §10). */
const account = process.env.MARVIN_E2E_ACCOUNT;
const editor = process.env.MARVIN_E2E_EDITOR;

const sleep = (ms: number): Promise<void> => new Promise<void>((r) => setTimeout(r, ms));

async function until<T>(probe: () => Promise<T | undefined>, timeoutMs: number): Promise<T> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== undefined) return value;
    if (Date.now() > end) throw new Error('timed out waiting for a Drive change');
    await sleep(5_000);
  }
}

describe.runIf(account && editor)('Watch E2E (live)', () => {
  it('foreign edit → edited event with diff and push; own edit → stored, no push; comment finding', async () => {
    const app = buildApp();
    const { googleFiles: files, docs } = app;
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'marvin-watch-e2e-'));
    // A temp watch dir (own lease): a running `marvin-drive serve` is not disturbed.
    const runner = new DriveClientFactory(app.auth);
    const audit = new FileAuditLog(path.join(tmp, 'audit.jsonl'));
    const store = new WatchStore({ dir: path.join(tmp, 'watch') });
    const pushes: string[] = [];
    const push: PushFn = async (content) => {
      pushes.push(content);
    };
    const watch = new WatchService({
      store,
      provider: createGoogleWatchProvider({
        runner,
        audit,
        resolveAccount: (r) => app.auth.resolveAccount(r),
      }),
      intervalMs: 15_000,
      quietMs: 5_000,
      maxWaitMs: 60_000,
    });
    const owner = await app.auth.resolveAccount(account);
    const ed = await app.auth.resolveAccount(editor);
    const root = await files.createFolder({ account, name: `marvin-watch-e2e-${Date.now()}` });
    try {
      const md = path.join(tmp, 'watch.md');
      await writeFile(md, '# Watch test\n\nfirst line\n');
      const doc = await files.upload({
        account,
        localPath: md,
        parentId: root.id,
        convertToGoogle: true,
      });
      // Tests sit outside the provider boundary: sharing and comments use googleapis directly.
      const { client } = await app.auth.authorize(account);
      await google.drive({ version: 'v3', auth: client }).permissions.create({
        fileId: doc.id,
        sendNotificationEmail: false,
        requestBody: { type: 'user', role: 'writer', emailAddress: ed.email },
      });

      await store.saveDelivery('channel');
      await watch.watch({ action: 'add', fileId: doc.id, account });
      await watch.start(push, { timers: false });

      // foreign edit
      await docs.insertText({
        account: editor,
        fileId: doc.id,
        // `at: 'end'` inserts before the final newline, so a new line needs a leading \n.
        text: '\nedited by the second account',
        position: { at: 'end' },
      });
      const edited = await until<ChangeEvent>(async () => {
        await watch.tick();
        return (await watch.changes({ markRead: false })).events.find((e) => e.kind === 'edited');
      }, 300_000);
      expect(edited.own).toBe(false);
      expect(edited.diff).toContain('+ edited by the second account');
      expect(pushes.some((p) => p.includes('edited by the second account'))).toBe(true);

      // own edit: stored, never pushed
      const pushed = pushes.length;
      await docs.insertText({
        account,
        fileId: doc.id,
        text: '\nown line',
        position: { at: 'end' },
      });
      const own = await until<ChangeEvent>(async () => {
        await watch.tick();
        const all = await watch.changes({ unreadOnly: false, includeOwn: true, markRead: false });
        return all.events.find((e) => e.own);
      }, 300_000);
      expect(own.diff).toContain('+ own line');
      expect(pushes.length).toBe(pushed);
      await watch.stop();

      // Spec §6 open point: does a new comment surface in changes.list, and survive §5.3?
      const feed = new GoogleChangeFeed(new OperationRunner({ runner, audit }), owner.email);
      const before = await feed.file(doc.id);
      const cursor = await feed.start();
      const { client: editorClient } = await app.auth.authorize(editor);
      await google.drive({ version: 'v3', auth: editorClient }).comments.create({
        fileId: doc.id,
        fields: 'id',
        requestBody: { content: 'Is this final?' },
      });
      // Up to 5 minutes: the feed can lag, and a false "no entry" would trigger plan Task 33.
      const commentedAt = Date.now();
      let seen: RawChange | undefined;
      for (let i = 0; i < 30 && seen === undefined; i++) {
        await sleep(10_000);
        seen = (await feed.poll(cursor)).changes.find((c) => c.fileId === doc.id);
      }
      const waited = Math.round((Date.now() - commentedAt) / 1000);
      const survives =
        seen !== undefined &&
        Object.keys(
          applyChange(
            { known: { [doc.id]: toKnown(before, [doc.id]) }, pending: {} },
            {
              change: seen,
              covering: [
                {
                  id: doc.id,
                  name: 'x',
                  kind: 'doc',
                  folder: false,
                  addedAt: new Date(0).toISOString(),
                },
              ],
              now: new Date().toISOString(),
            },
          ).pending,
        ).length > 0;
      process.stdout.write(
        `\n[watch e2e] comment finding: changes.list entry=${seen !== undefined} (after ${waited} s); survives no-op rule=${survives}\n`,
      );
    } finally {
      await watch.stop();
      // Spec §10: cleanup trashes the test files (Drive trash, restorable for 30 days).
      await files.delete({ account, fileId: root.id }).catch(() => undefined);
      await rm(tmp, { recursive: true, force: true });
    }
  }, 900_000);
});
