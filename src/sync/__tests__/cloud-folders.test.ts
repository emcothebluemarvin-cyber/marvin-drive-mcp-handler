import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  cloudFolderConflict,
  cloudFolderProblem,
  findCloudFolders,
  systemHost,
  type CloudHost,
} from '../cloud-folders.js';

/** A host whose file system is a set of existing paths (realpath is the identity). */
function fakeHost(
  platform: NodeJS.Platform,
  home: string,
  existing: string[],
  env: NodeJS.ProcessEnv = {},
): CloudHost {
  const api = platform === 'win32' ? path.win32 : path.posix;
  const set = new Set(existing.map((p) => api.normalize(p)));
  return {
    platform,
    home,
    env,
    realpath: async (p) => (set.has(api.normalize(p)) ? api.normalize(p) : null),
    readdir: async (dir) => {
      const prefix = api.normalize(dir) + api.sep;
      return [...set]
        .filter((p) => p.startsWith(prefix) && !p.slice(prefix.length).includes(api.sep))
        .map((p) => p.slice(prefix.length));
    },
  };
}

describe('findCloudFolders (OneDrive sync spec §6)', () => {
  it('macOS: CloudStorage OneDrive-* and GoogleDrive-*, /Volumes/GoogleDrive*, ~/OneDrive', async () => {
    const host = fakeHost('darwin', '/Users/u', [
      '/Users/u/Library/CloudStorage/OneDrive-Personal',
      '/Users/u/Library/CloudStorage/GoogleDrive-u@example.com',
      '/Users/u/Library/CloudStorage/Dropbox',
      '/Volumes/GoogleDrive',
      '/Volumes/Backup',
      '/Users/u/OneDrive',
      '/Users/u/OneDrive old',
    ]);
    expect(await findCloudFolders(host)).toEqual([
      { path: '/Users/u/Library/CloudStorage/OneDrive-Personal', client: 'OneDrive' },
      { path: '/Users/u/Library/CloudStorage/GoogleDrive-u@example.com', client: 'Google Drive' },
      { path: '/Volumes/GoogleDrive', client: 'Google Drive' },
      { path: '/Users/u/OneDrive', client: 'OneDrive' },
    ]);
  });

  it('Windows: the OneDrive variables, %USERPROFILE%\\My Drive and <letter>:\\My Drive', async () => {
    const host = fakeHost(
      'win32',
      'C:\\Users\\u',
      ['C:\\Users\\u\\OneDrive', 'D:\\Work OneDrive', 'C:\\Users\\u\\My Drive', 'G:\\My Drive'],
      {
        OneDrive: 'C:\\Users\\u\\OneDrive',
        OneDriveConsumer: 'C:\\Users\\u\\OneDrive',
        OneDriveCommercial: 'D:\\Work OneDrive',
        USERPROFILE: 'C:\\Users\\u',
      },
    );
    expect(await findCloudFolders(host)).toEqual([
      { path: 'C:\\Users\\u\\OneDrive', client: 'OneDrive' },
      { path: 'D:\\Work OneDrive', client: 'OneDrive' },
      { path: 'C:\\Users\\u\\My Drive', client: 'Google Drive' },
      { path: 'G:\\My Drive', client: 'Google Drive' },
    ]);
  });

  it('Linux: none', async () => {
    const host = fakeHost('linux', '/home/u', ['/home/u/OneDrive', '/home/u/Google Drive']);
    expect(await findCloudFolders(host)).toEqual([]);
  });
});

describe('cloudFolderConflict', () => {
  const folders = [
    { path: '/Users/u/Library/CloudStorage/OneDrive-Personal', client: 'OneDrive' as const },
  ];
  const mac = { platform: 'darwin' as const, caseInsensitive: true };

  it('the folder itself, a folder inside it, and a folder containing it', () => {
    for (const dir of [
      '/Users/u/Library/CloudStorage/OneDrive-Personal',
      '/Users/u/Library/CloudStorage/OneDrive-Personal/Docs',
      '/Users/u',
    ]) {
      expect(cloudFolderConflict(dir, folders, mac)).toEqual(folders[0]);
    }
    expect(cloudFolderConflict('/Users/u/Documents', folders, mac)).toBeNull();
    expect(
      cloudFolderConflict('/Users/u/Library/CloudStorage/OneDrive-Personal2', folders, mac),
    ).toBeNull();
  });

  it('case-folded on a case-insensitive volume only', () => {
    const upper = '/USERS/U/Library/CloudStorage/onedrive-personal/Docs';
    expect(cloudFolderConflict(upper, folders, mac)).toEqual(folders[0]);
    expect(
      cloudFolderConflict(upper, folders, { platform: 'darwin', caseInsensitive: false }),
    ).toBeNull();
  });

  it('Windows paths compare with Windows rules', () => {
    const win = [{ path: 'C:\\Users\\u\\OneDrive', client: 'OneDrive' as const }];
    const opts = { platform: 'win32' as const, caseInsensitive: true };
    expect(cloudFolderConflict('c:\\users\\u\\onedrive\\Docs', win, opts)).toEqual(win[0]);
    expect(cloudFolderConflict('C:\\Users\\u\\Documents', win, opts)).toBeNull();
  });

  it('the refusal text names the client', () => {
    expect(cloudFolderProblem('/x/OneDrive-P', 'OneDrive')).toBe(
      '/x/OneDrive-P is synced by the OneDrive desktop app; pick a folder outside it so the two do not sync the same files',
    );
  });
});

describe('systemHost realpath', () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), 'cloud-folders-'));
  });
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it('resolves a symlinked cloud folder to its target; a missing one is null', async () => {
    const target = path.join(tmp, 'CloudStorage', 'OneDrive-Personal');
    await mkdir(target, { recursive: true });
    await symlink(target, path.join(tmp, 'OneDrive'));
    const system = systemHost();
    const host: CloudHost = {
      ...system,
      platform: 'darwin',
      home: tmp,
      readdir: async (dir) => (dir === '/Volumes' ? [] : system.readdir(dir)),
    };
    const found = await findCloudFolders(host);
    expect(found).toEqual([{ path: await host.realpath(target), client: 'OneDrive' }]);
    expect(await host.realpath(path.join(tmp, 'missing'))).toBeNull();
  });
});
