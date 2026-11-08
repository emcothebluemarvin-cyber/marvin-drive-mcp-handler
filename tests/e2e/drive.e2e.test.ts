import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';

const account = process.env.MARVIN_E2E_ACCOUNT;

describe.runIf(account)('Drive E2E (live)', () => {
  it('folder → upload → move → rename → search → download → export → trash → restore → delete', async () => {
    const { googleFiles: files } = buildApp();
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'marvin-e2e-'));
    const root = await files.createFolder({ account, name: `marvin-e2e-${Date.now()}` });
    try {
      const sub = await files.createFolder({ account, name: 'sub', parentId: root.id });
      const local = path.join(tmp, 'hello.txt');
      await writeFile(local, 'hello drive');

      const up = await files.upload({ account, localPath: local, parentId: root.id });
      const moved = await files.move({ account, fileId: up.id, newParentId: sub.id });
      expect(moved.parents).toEqual([sub.id]);

      const renamed = await files.rename({ account, fileId: up.id, newName: 'renamed.txt' });
      expect(renamed.name).toBe('renamed.txt');

      const found = await files.search({ account, rawQuery: `'${sub.id}' in parents` });
      expect(found.files.map((f) => f.id)).toContain(up.id);

      const dl = await files.download({ account, fileId: up.id, destPath: `${tmp}/` });
      expect(await readFile(dl.path, 'utf8')).toBe('hello drive');

      // A missing folder named with the platform separator (\ on Windows) is created.
      const fresh = path.join(tmp, 'fresh');
      const into = await files.download({ account, fileId: up.id, destPath: fresh + path.sep });
      expect(path.dirname(into.path)).toBe(fresh);
      expect(await readFile(into.path, 'utf8')).toBe('hello drive');

      const doc = await files.upload({
        account,
        localPath: local,
        parentId: root.id,
        name: 'as-doc',
        convertToGoogle: true,
      });
      const md = await files.download({
        account,
        fileId: doc.id,
        destPath: `${tmp}/`,
        exportFormat: 'md',
      });
      expect(path.extname(md.path)).toBe('.md');
      expect(await readFile(md.path, 'utf8')).toContain('hello drive');

      await files.delete({ account, fileId: up.id });
      expect((await files.getMetadata({ account, fileId: up.id })).trashed).toBe(true);
      await files.restore({ account, fileId: up.id });
      expect((await files.getMetadata({ account, fileId: up.id })).trashed).toBe(false);
    } finally {
      await files.delete({ account, fileId: root.id, permanent: true });
      await rm(tmp, { recursive: true, force: true });
    }
  });
});
