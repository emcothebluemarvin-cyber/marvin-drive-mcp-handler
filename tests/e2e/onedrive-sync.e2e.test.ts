import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { FileAuditLog } from '../../src/audit/audit-log.js';
import { DriveClientFactory } from '../../src/drive/client-factory.js';
import { PairStore } from '../../src/sync/pair-store.js';
import { quickXor } from '../../src/sync/remote/quickxor.js';
import type { SyncRemote } from '../../src/sync/remote/sync-remote.js';
import { SyncService } from '../../src/sync/sync-service.js';
import type { LocalTrash } from '../../src/sync/trash.js';
import type { SyncReport } from '../../src/sync/types.js';

/*
 * Live OneDrive sync (OneDrive sync spec §9). MARVIN_E2E_MS_PERSONAL names a signed-in
 * Microsoft account; MARVIN_E2E_MS_SECOND optionally repeats the run on a second one.
 * Everything happens in a new folder of the drive root, which goes to the recycle bin at the
 * end; local files live in a temp dir and the local "trash" is a temp folder.
 */
const ACCOUNTS: Array<[string, string | undefined]> = [
  ['personal', process.env.MARVIN_E2E_MS_PERSONAL],
  ['second', process.env.MARVIN_E2E_MS_SECOND],
];
const LONG_MS = 900_000;
const BIG = 4 * 1024 * 1024 + 4321;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

async function setup(account: string) {
  const app = buildApp();
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'marvin-od-sync-e2e-'));
  const local = path.join(tmp, 'local');
  const trashDir = path.join(tmp, 'trash');
  await mkdir(local);
  await mkdir(trashDir);
  const trash: LocalTrash = {
    trash: async (abs) => {
      await rename(abs, path.join(trashDir, `${Date.now()}-${path.basename(abs)}`));
    },
  };
  const sync = new SyncService({
    runner: new DriveClientFactory(app.auth),
    audit: new FileAuditLog(path.join(tmp, 'audit.jsonl')),
    store: new PairStore({ dir: path.join(tmp, 'sync') }),
    trash,
    openOneDrive: app.openOneDrive,
  });
  const remote = (await app.openOneDrive(account)) as SyncRemote;
  if (remote?.provider !== 'microsoft') throw new Error(`${account} is not a Microsoft account`);
  const at = (...parts: string[]): string => path.join(local, ...parts);
  return { app, tmp, local, trashDir, sync, remote, at };
}

describe.each(ACCOUNTS)('OneDrive sync E2E (%s)', (_kind, account) => {
  it.runIf(account)(
    'two-way sync, conflicts, deletions, release, names',
    { timeout: LONG_MS },
    async () => {
      const alias = account as string;
      const { app, tmp, local, trashDir, sync, remote, at } = await setup(alias);
      // Windows cannot hold ':' in a local name; the name-rule check runs elsewhere.
      const colon = process.platform !== 'win32';
      const root = await remote.createFolder(remote.rootId, `marvin-sync-e2e-${Date.now()}`);
      const byName = async (name: string) =>
        (await remote.findChildren(root.id, name)).find((i) => i.name === name);
      const apply = async (extra: { confirmRemoteTrash?: boolean } = {}): Promise<SyncReport> => {
        const dry = await sync.run({ name: 'od' });
        const done = await sync.run({ name: 'od', apply: true, planId: dry.planId, ...extra });
        expect(done.failures).toEqual([]);
        return done;
      };
      try {
        const names = [
          'edit-local.txt',
          'edit-remote.txt',
          'both.txt',
          'del-local.txt',
          'del-remote.txt',
          'release.txt',
        ];
        for (const n of names) await writeFile(at(n), `${n} v1`);
        const big = randomBytes(BIG);
        await writeFile(at('big.bin'), big);
        if (colon) await writeFile(at('a:b.txt'), 'colon');
        await sync.createPair({
          name: 'od',
          localDir: local,
          remoteFolderId: root.id,
          account: alias,
        });
        expect((await sync.listPairs())[0]?.account).toBe(alias);

        // First pair: everything uploads except the name OneDrive refuses.
        await sync.select({
          name: 'od',
          add: [...names, 'big.bin', ...(colon ? ['a:b.txt'] : [])],
        });
        const first = await apply();
        expect(first.actions['upload-new']?.sort()).toEqual([...names, 'big.bin'].sort());
        if (colon) {
          expect(first.warnings).toContainEqual(
            expect.objectContaining({ path: 'a:b.txt', code: 'remote-name-invalid' }),
          );
        }

        // QuickXorHash equals OneDrive's own value, for the small files and the session upload.
        for (const n of ['edit-local.txt', 'big.bin']) {
          const item = await byName(n);
          expect(item?.hash).toEqual({ kind: 'quickXor', value: quickXor(await readFile(at(n))) });
        }

        // Nothing to do on the second run.
        expect((await sync.run({ name: 'od' })).actions).toEqual({});

        // Two-way changes and a conflict; the remote edits are Graph PUTs from the test.
        const putRemote = async (name: string, text: string): Promise<void> => {
          const item = await byName(name);
          const file = path.join(tmp, `put-${Date.now()}.txt`);
          await writeFile(file, text);
          if (!item) throw new Error(`${name} missing on OneDrive`);
          await remote.replaceContent(item, file);
        };
        await writeFile(at('edit-local.txt'), 'local v2');
        await putRemote('edit-remote.txt', 'remote v2');
        await writeFile(at('both.txt'), 'both local');
        await putRemote('both.txt', 'both remote');
        const changes = await apply();
        expect(changes.actions['update-remote']).toEqual(['edit-local.txt']);
        expect(changes.actions['download-replace']).toEqual(['edit-remote.txt']);
        expect(changes.actions.conflict).toEqual(['both.txt']);
        expect(await readFile(at('edit-remote.txt'), 'utf8')).toBe('remote v2');
        expect(changes.conflicts[0]?.conflictCopy).toMatch(/^both \(OneDrive conflict .*\)\.txt$/);

        // Local deletion waits for confirmation, then goes to the OneDrive recycle bin.
        await rm(at('del-local.txt'));
        const pending = await sync.run({ name: 'od' });
        expect(pending.pendingConfirmation.map((p) => p.path)).toEqual(['del-local.txt']);
        const deletedId = (await byName('del-local.txt'))?.id ?? '';
        const confirmed = await apply({ confirmRemoteTrash: true });
        expect(confirmed.actions['trash-remote']).toEqual(['del-local.txt']);
        expect(await remote.get(deletedId)).toBeNull();

        // A remote delete is applied through delta evidence (the feed may lag a little).
        const remoteDel = await byName('del-remote.txt');
        await app.files.delete({ account: alias, fileId: remoteDel?.id ?? '' });
        let planned: SyncReport | undefined;
        for (let i = 0; i < 12; i++) {
          planned = await sync.run({ name: 'od' });
          if (planned.actions['trash-local']) break;
          await sleep(5000);
        }
        expect(planned?.actions['trash-local']).toEqual(['del-remote.txt']);
        expect((await apply()).actions['trash-local']).toEqual(['del-remote.txt']);
        expect((await readdir(trashDir)).some((n) => n.endsWith('del-remote.txt'))).toBe(true);

        // Release to OneDrive only, then restore by selecting it again.
        const released = await sync.release({ name: 'od', paths: ['release.txt'], apply: true });
        expect(released.released.map((r) => r.path)).toEqual(['release.txt']);
        await sync.select({ name: 'od', add: ['release.txt'] });
        const restored = await apply();
        expect(restored.actions['download-new']).toEqual(['release.txt']);
        expect(await readFile(at('release.txt'), 'utf8')).toBe('release.txt v1');

        // The large file comes back intact after a remote edit (session upload + download).
        await writeFile(at('big.bin'), randomBytes(BIG));
        expect((await apply()).actions['update-remote']).toEqual(['big.bin']);
        const bigItem = await byName('big.bin');
        expect(bigItem?.hash?.value).toBe(quickXor(await readFile(at('big.bin'))));
      } finally {
        await app.files.delete({ account: alias, fileId: root.id }).catch(() => undefined);
        await rm(tmp, { recursive: true, force: true });
      }
    },
  );
});
