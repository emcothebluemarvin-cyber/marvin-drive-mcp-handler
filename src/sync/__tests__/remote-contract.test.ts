import { describe, expect, it } from 'vitest';
import { createFakeDrive, httpError } from '../../files/__tests__/fakes.js';
import { GOOGLE_MIME } from '../../files/export-formats.js';
import { graphError, json } from '../../onedrive/__tests__/fake-graph.js';
import type { SyncRemote } from '../remote/sync-remote.js';
import { googleRemoteOver } from './fake-remote.js';
import { NEXT, graphFile, graphFolder, remoteOver } from './fake-onedrive.js';

/** One fake per provider, answering the same scenario (OneDrive sync spec §9). */
interface Setup {
  /** `ok` is readable, `gone` 404, `hidden` 403. */
  reads(): SyncRemote;
  /** Children of P over two pages: folders Docs and DOCS, file docs, folder other. */
  children(): SyncRemote;
}

const google: Setup = {
  reads: () => {
    const drive = createFakeDrive();
    drive.getFile.mockImplementation(async (id: string) => {
      if (id === 'gone') throw httpError(404, 'notFound');
      if (id === 'hidden') throw httpError(403, 'insufficientFilePermissions');
      return { id, name: 'a.pdf', mimeType: 'application/pdf', parents: ['P'] };
    });
    return googleRemoteOver(drive);
  },
  children: () => {
    const drive = createFakeDrive();
    const folder = GOOGLE_MIME.folder;
    drive.listFiles.mockImplementation(async (params: { pageToken?: string; q?: string }) => {
      const page1 = [
        { id: 'd1', name: 'Docs', mimeType: folder, parents: ['P'] },
        { id: 'f1', name: 'docs', mimeType: 'text/plain', parents: ['P'] },
      ];
      const page2 = [
        { id: 'd2', name: 'DOCS', mimeType: folder, parents: ['P'] },
        { id: 'o', name: 'other', mimeType: folder, parents: ['P'] },
      ];
      const onlyFolders = params.q?.includes(folder) === true;
      const keep = (files: typeof page1) =>
        onlyFolders ? files.filter((f) => f.mimeType === folder) : files;
      return params.pageToken
        ? { files: keep(page2) }
        : { files: keep(page1), nextPageToken: 'n2' };
    });
    return googleRemoteOver(drive);
  },
};

const onedrive: Setup = {
  reads: () =>
    remoteOver((call) => {
      if (call.path.startsWith('/me/drive/items/gone')) return graphError(404, 'itemNotFound');
      if (call.path.startsWith('/me/drive/items/hidden')) return graphError(403, 'accessDenied');
      return json(graphFile('ok', 'a.pdf'));
    }).remote,
  children: () =>
    remoteOver((call) =>
      call.url === NEXT
        ? json({ value: [graphFolder('d2', 'DOCS'), graphFolder('o', 'other')] })
        : json({
            value: [graphFolder('d1', 'Docs'), graphFile('f1', 'docs')],
            '@odata.nextLink': NEXT,
          }),
    ).remote,
};

describe.each([
  ['google', google],
  ['microsoft', onedrive],
] as const)('SyncRemote contract: %s', (provider, setup) => {
  it('get: an item, or null on 404 and 403', async () => {
    const remote = setup.reads();
    expect(remote.provider).toBe(provider);
    expect((await remote.get('ok'))?.name).toBe('a.pdf');
    expect(await remote.get('gone')).toBeNull();
    expect(await remote.get('hidden')).toBeNull();
  });

  it('listChildren pages until there is no next token', async () => {
    const remote = setup.children();
    const ids: string[] = [];
    let token: string | undefined;
    do {
      const page = await remote.listChildren('P', token);
      ids.push(...page.items.map((i) => i.id));
      token = page.next;
    } while (token);
    expect(ids).toEqual(['d1', 'f1', 'd2', 'o']);
  });

  it('findChildren folders: every fold match over all pages', async () => {
    const found = await setup.children().findChildren('P', 'docs', 'folder');
    expect(found.map((f) => [f.id, f.kind])).toEqual([
      ['d1', 'folder'],
      ['d2', 'folder'],
    ]);
  });
});
