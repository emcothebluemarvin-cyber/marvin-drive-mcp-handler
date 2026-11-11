import { describe, expect, it } from 'vitest';
import { ValidationError } from '../../errors.js';
import { createAudit, silentLogger } from '../../files/__tests__/fakes.js';
import { RemoteFolders } from '../remote-folders.js';
import { googleRemoteOver } from './fake-remote.js';
import { ROOT_ID, makePair } from './fixtures.js';
import { memoryDrive } from './memory-drive.js';
import { memoryOneDrive } from './memory-onedrive.js';

function folders(caseInsensitive: boolean) {
  const mem = memoryDrive(ROOT_ID);
  const audit = createAudit();
  const remote = googleRemoteOver(mem.drive);
  const pair = makePair({ caseInsensitive });
  const made = new RemoteFolders(
    { remote, audit, logger: silentLogger() },
    pair,
    new Map([[ROOT_ID, '']]),
  );
  return { mem, audit, made };
}

describe('RemoteFolders through SyncRemote', () => {
  it('reuses one existing folder by fold key on a case-insensitive volume', async () => {
    const { mem, made } = folders(true);
    mem.addFolder('d1', 'Docs', ROOT_ID);
    expect(await made.folderFor('docs')).toBe('d1');
    expect(mem.drive.createFile).not.toHaveBeenCalled();
  });

  it('needs the exact NFC name on a case-sensitive volume, else creates and audits', async () => {
    const { mem, audit, made } = folders(false);
    mem.addFolder('d1', 'Docs', ROOT_ID);
    const id = await made.folderFor('docs/inner');
    expect(id).not.toBe('d1');
    expect(mem.childrenOf(ROOT_ID).map((f) => f.name)).toEqual(['Docs', 'docs']);
    expect(audit.entries.map((e) => [e.op, e.name, e.details])).toEqual([
      ['create_folder', 'docs', { pair: 'docs', parentId: ROOT_ID }],
      ['create_folder', 'inner', { pair: 'docs', parentId: mem.childrenOf(ROOT_ID)[1]?.id }],
    ]);
  });

  it('refuses several same-name folders', async () => {
    const { mem, made } = folders(true);
    mem.addFolder('d1', 'Docs', ROOT_ID);
    mem.addFolder('d2', 'docs', ROOT_ID);
    await expect(made.folderFor('docs')).rejects.toThrow(ValidationError);
    await expect(made.folderFor('docs')).rejects.toThrow('Several Drive folders named "docs"');
  });
});

describe('RemoteFolders on OneDrive', () => {
  it('a 409 on createFolder reuses the one folder that appeared meanwhile', async () => {
    const od = memoryOneDrive();
    const remote = od.remote();
    const create = remote.createFolder.bind(remote);
    remote.createFolder = async (parentId, name) => {
      od.addFolder(parentId, name, 'RACE'); // another client created it first
      return create(parentId, name);
    };
    const made = new RemoteFolders(
      { remote, audit: createAudit(), logger: silentLogger() },
      makePair({ caseInsensitive: true, remoteFolderId: od.rootId }),
      new Map([[od.rootId, '']]),
    );
    expect(await made.folderFor('docs')).toBe('RACE');
  });
});
