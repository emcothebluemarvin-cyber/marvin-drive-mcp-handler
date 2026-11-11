import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import {
  NameConflictError,
  NotFoundError,
  TargetChangedError,
  ValidationError,
} from '../../src/errors.js';
import type { FileSummary, UploadCancelled } from '../../src/files/file-provider.js';

const ACCOUNTS: Array<['personal' | 'work', string | undefined]> = [
  ['personal', process.env.MARVIN_E2E_MS_PERSONAL],
  ['work', process.env.MARVIN_E2E_MS_WORK],
];
const LARGE_SIZE = 10 * 1024 * 1024 + 1234;
const LONG_MS = 600_000;

function created(result: FileSummary | UploadCancelled): FileSummary {
  if ('cancelled' in result) throw new Error('upload was cancelled');
  return result;
}

const sha = (data: Buffer): string => createHash('sha256').update(data).digest('hex');

describe.each(ACCOUNTS)('OneDrive E2E (%s)', (kind, account) => {
  it.runIf(account)(
    'files, conflicts and cleanup on the live drive',
    { timeout: LONG_MS },
    async () => {
      const { files } = buildApp();
      const tmp = await mkdtemp(path.join(os.tmpdir(), 'marvin-od-e2e-'));
      const stamp = `marvin-e2e-${Date.now()}`;
      const root = await files.createFolder({ account, name: stamp });
      const local = async (name: string, data: Buffer | string): Promise<string> => {
        const file = path.join(tmp, name);
        await writeFile(file, data);
        return file;
      };
      const readBack = async (fileId: string): Promise<Buffer> => {
        const down = await files.download({
          account,
          fileId,
          destPath: `${tmp}/dl-${Date.now()}/`,
        });
        return readFile(down.path);
      };

      try {
        // Uploads: empty (PUT), small and over one fragment (session).
        const empty = created(
          await files.upload({
            account,
            localPath: await local('empty.txt', ''),
            parentId: root.id,
          }),
        );
        expect(empty.size ?? 0).toBe(0);
        const small = created(
          await files.upload({
            account,
            localPath: await local('small.txt', 'hello onedrive'),
            parentId: root.id,
          }),
        );
        const largeData = randomBytes(LARGE_SIZE);
        const large = created(
          await files.upload({
            account,
            localPath: await local('large.bin', largeData),
            parentId: root.id,
          }),
        );

        // List and page: proves the @odata.nextLink shape is accepted (spec §10).
        const first = await files.list({ account, folderId: root.id, pageSize: 2 });
        expect(first.files).toHaveLength(2);
        expect(first.nextPageToken).toBeDefined();
        const second = await files.list({
          account,
          folderId: root.id,
          pageToken: first.nextPageToken ?? '',
        });
        expect([...first.files, ...second.files].map((f) => f.id).sort()).toEqual(
          [empty.id, small.id, large.id].sort(),
        );

        // Search: new items on personal OneDrive stayed out of the index for over
        // 30 minutes (live run 2026-11-11), so prove the call against an item that
        // existed before this run instead of one uploaded now.
        const existing = (await files.list({ account, pageSize: 50 })).files.find(
          (f) => f.id !== root.id,
        );
        if (existing) {
          const word = existing.name.split(/[^\p{L}\p{N}]+/u).find((w) => w.length >= 3);
          if (word) {
            const found = await files.search({ account, query: word });
            expect(found.files.some((f) => f.id === existing.id)).toBe(true);
          }
        }

        // Download and compare.
        expect((await readBack(small.id)).toString()).toBe('hello onedrive');
        expect(sha(await readBack(large.id))).toBe(sha(largeData));

        // Rename, move (also to root and back), copy.
        const sub = await files.createFolder({ account, name: 'sub', parentId: root.id });
        const renamed = await files.rename({ account, fileId: small.id, newName: 'renamed.txt' });
        expect(renamed.name).toBe('renamed.txt');
        const moved = await files.move({ account, fileId: small.id, newParentId: sub.id });
        expect(moved.parents).toEqual([sub.id]);
        const atRoot = await files.move({ account, fileId: small.id, newParentId: 'root' });
        expect(atRoot.name).toBe('renamed.txt');
        await files.move({ account, fileId: small.id, newParentId: sub.id });
        const copy = await files.copy({ account, fileId: small.id, name: 'copied.txt' });
        expect(copy.name).toBe('copied.txt');

        // Conflicts leave the original or the target unchanged.
        await expect(
          files.upload({
            account,
            localPath: await local('renamed.txt', 'other'),
            parentId: sub.id,
          }),
        ).rejects.toThrow(NameConflictError);
        expect((await readBack(small.id)).toString()).toBe('hello onedrive');

        await expect(
          files.rename({ account, fileId: copy.id, newName: 'renamed.txt' }),
        ).rejects.toThrow(NameConflictError);
        expect((await files.getMetadata({ account, fileId: copy.id })).name).toBe('copied.txt');

        const twin = created(
          await files.upload({
            account,
            localPath: await local('renamed.txt', 'other'),
            parentId: root.id,
          }),
        );
        await expect(files.move({ account, fileId: twin.id, newParentId: sub.id })).rejects.toThrow(
          NameConflictError,
        );
        expect((await readBack(twin.id)).toString()).toBe('other');

        await expect(files.copy({ account, fileId: copy.id, name: 'renamed.txt' })).rejects.toThrow(
          NameConflictError,
        );
        expect((await readBack(small.id)).toString()).toBe('hello onedrive');

        // A stale eTag: the file changes between the question and the overwrite.
        const staleSource = await local('renamed.txt', 'loses the race');
        await expect(
          files.upload(
            { account, localPath: staleSource, parentId: sub.id },
            {
              confirmReplace: async () => {
                await files.upload(
                  {
                    account,
                    localPath: await local('winner.txt', 'wins the race'),
                    parentId: sub.id,
                    name: 'renamed.txt',
                  },
                  { confirmReplace: async () => 'overwrite' },
                );
                return 'overwrite';
              },
            },
          ),
        ).rejects.toThrow(TargetChangedError);
        expect((await readBack(small.id)).toString()).toBe('wins the race');

        // Delete and, on personal drives, restore.
        await files.delete({ account, fileId: copy.id });
        await expect(files.getMetadata({ account, fileId: copy.id })).rejects.toThrow(
          NotFoundError,
        );
        if (kind === 'personal') {
          const restored = await files.restore({ account, fileId: copy.id });
          expect(restored.name).toBe('copied.txt');
        } else {
          await expect(files.restore({ account, fileId: copy.id })).rejects.toThrow(
            ValidationError,
          );
        }
      } finally {
        await files.delete({ account, fileId: root.id }).catch(() => undefined);
        await rm(tmp, { recursive: true, force: true });
      }
    },
  );
});
