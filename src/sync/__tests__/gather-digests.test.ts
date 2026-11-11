import { createHash } from 'node:crypto';
import { lstat, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createAudit, silentLogger } from '../../files/__tests__/fakes.js';
import type { Digester } from '../local-scanner.js';
import type { SyncEnv } from '../pair-admin.js';
import { PairStore } from '../pair-store.js';
import { selectReleasable } from '../release.js';
import type { RemoteItem, SyncRemote } from '../remote/sync-remote.js';
import { gatherInput } from '../scan-select.js';
import type { PairFile } from '../types.js';
import { googleRemoteOver } from './fake-remote.js';
import { makePairFile, record } from './fixtures.js';
import { memoryDrive } from './memory-drive.js';

const md5 = (s: string): string => createHash('md5').update(s).digest('hex');

/** Test-only "quickXor": `QX-` + the md5 of the content (the real one arrives in stage 3). */
const qx = (md5hex: string): string => `QX-${md5hex}`;
const stubDigester = (): Digester => {
  const h = createHash('md5');
  return { update: (c) => void h.update(c), digest: () => qx(h.digest('hex')) };
};

/** A remote that reports quickXor hashes (derived from the memory Drive's md5). */
function quickXorRemote(inner: SyncRemote): SyncRemote {
  const convert = (i: RemoteItem): RemoteItem =>
    i.hash ? { ...i, hash: { kind: 'quickXor', value: qx(i.hash.value) } } : i;
  return Object.assign(Object.create(inner) as SyncRemote, {
    hashKind: 'quickXor' as const,
    listChildren: async (id: string, token: string | undefined) => {
      const page = await inner.listChildren(id, token);
      return { ...page, items: page.items.map(convert) };
    },
  });
}

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'sync-digests-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('gatherInput on a non-md5 remote (spec §3.1 stat-unchanged files)', () => {
  it('a stat-unchanged file gets a remote-kind digest only when release asks for it', async () => {
    const mem = memoryDrive('ROOT');
    mem.addFile('r1', 'a.pdf', 'ROOT', 'hello');
    await writeFile(path.join(dir, 'a.pdf'), 'hello');
    const info = await lstat(path.join(dir, 'a.pdf'));
    const file: PairFile = makePairFile({ localDir: dir, remoteFolderId: 'ROOT' }, [
      record('r1', 'a.pdf', {
        remoteParentId: 'ROOT',
        localMd5: md5('hello'),
        localSize: info.size,
        localMtimeMs: info.mtimeMs,
        localCtimeMs: info.ctimeMs,
        remoteHash: { kind: 'quickXor', value: qx(md5('hello')) },
        remoteSize: 5,
        remoteModifiedTime: mem.files.get('r1')?.modifiedTime ?? '',
      }),
    ]);
    const remote = quickXorRemote(googleRemoteOver(mem.drive));
    const env: SyncEnv = {
      audit: createAudit(),
      log: silentLogger(),
      clock: () => new Date('2026-11-03T12:00:00.000Z'),
      store: new PairStore({ dir: path.join(dir, '.store'), logger: silentLogger() }),
      remoteFor: () => remote,
      openRemote: async () => remote,
      assertSupportedAccount: async () => {},
      digesters: stubDigester,
    };
    const plain = await gatherInput(env, file);
    expect(plain.input.digests.size).toBe(0);
    expect(selectReleasable(plain.input, { all: true }).skipped).toEqual([
      { path: 'a.pdf', reason: 'not in sync (changed locally or in Drive); run sync_run first' },
    ]);
    const asked = await gatherInput(env, file, 'all');
    expect(asked.input.digests.get('a.pdf')).toEqual({
      md5: md5('hello'),
      remote: { kind: 'quickXor', value: qx(md5('hello')) },
    });
    expect(selectReleasable(asked.input, { all: true }).eligible.map((c) => c.record.path)).toEqual(
      ['a.pdf'],
    );
  });
});
