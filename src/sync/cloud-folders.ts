import { readdir, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/*
 * Cloud desktop folder guard (OneDrive sync spec §6, all providers). A pair inside a folder
 * the OneDrive or Google Drive desktop app syncs would have two engines syncing the same
 * files, so such a localDir is refused: the folder itself, anything inside it, and anything
 * that contains it.
 */

export type CloudClient = 'OneDrive' | 'Google Drive';

export interface CloudFolder {
  /** Real path (symlinks resolved). */
  path: string;
  client: CloudClient;
}

/** What detection reads from the machine (tests pass a fake). */
export interface CloudHost {
  platform: NodeJS.Platform;
  home: string;
  env: NodeJS.ProcessEnv;
  /** realpath, or null when the path does not exist or cannot be resolved. */
  realpath(p: string): Promise<string | null>;
  /** Entry names, or [] when the folder cannot be read. */
  readdir(dir: string): Promise<string[]>;
}

export function systemHost(): CloudHost {
  return {
    platform: process.platform,
    home: os.homedir(),
    env: process.env,
    realpath: (p) => realpath(p).catch(() => null),
    readdir: (dir) => readdir(dir).catch(() => []),
  };
}

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');

/** Candidate folders per platform, before realpath (spec §6 lists exactly these). */
async function candidates(host: CloudHost): Promise<Array<{ path: string; client: CloudClient }>> {
  if (host.platform === 'darwin') {
    const storage = path.posix.join(host.home, 'Library', 'CloudStorage');
    const inStorage = (await host.readdir(storage)).sort();
    const volumes = (await host.readdir('/Volumes')).sort();
    return [
      ...inStorage
        .filter((n) => n.startsWith('OneDrive-'))
        .map((n) => ({ path: path.posix.join(storage, n), client: 'OneDrive' as const })),
      ...inStorage
        .filter((n) => n.startsWith('GoogleDrive-'))
        .map((n) => ({ path: path.posix.join(storage, n), client: 'Google Drive' as const })),
      ...volumes
        .filter((n) => n.startsWith('GoogleDrive'))
        .map((n) => ({ path: path.posix.join('/Volumes', n), client: 'Google Drive' as const })),
      { path: path.posix.join(host.home, 'OneDrive'), client: 'OneDrive' },
    ];
  }
  if (host.platform === 'win32') {
    const vars = ['OneDrive', 'OneDriveConsumer', 'OneDriveCommercial']
      .map((v) => host.env[v])
      .filter((v): v is string => typeof v === 'string' && v !== '');
    const profile = host.env['USERPROFILE'] || host.home;
    return [
      ...vars.map((p) => ({ path: p, client: 'OneDrive' as const })),
      { path: path.win32.join(profile, 'My Drive'), client: 'Google Drive' },
      ...LETTERS.map((l) => ({ path: `${l}:\\My Drive`, client: 'Google Drive' as const })),
    ];
  }
  return [];
}

/** The cloud desktop folders present on this machine, by real path, without duplicates. */
export async function findCloudFolders(host: CloudHost = systemHost()): Promise<CloudFolder[]> {
  const found: CloudFolder[] = [];
  const seen = new Set<string>();
  for (const c of await candidates(host)) {
    const real = await host.realpath(c.path);
    if (real === null || seen.has(real)) continue;
    seen.add(real);
    found.push({ path: real, client: c.client });
  }
  return found;
}

function isInside(api: path.PlatformPath, parent: string, child: string): boolean {
  const rel = api.relative(parent, child);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${api.sep}`) && !api.isAbsolute(rel));
}

/**
 * The cloud folder `dir` (a real path) is, is inside, or contains; null when none. Paths
 * are case-folded on a case-insensitive volume.
 */
export function cloudFolderConflict(
  dir: string,
  folders: readonly CloudFolder[],
  options: { platform: NodeJS.Platform; caseInsensitive: boolean },
): CloudFolder | null {
  const api = options.platform === 'win32' ? path.win32 : path.posix;
  const norm = (p: string): string => {
    const n = api.normalize(p).normalize('NFC');
    return options.caseInsensitive ? n.toLowerCase() : n;
  };
  const d = norm(dir);
  return (
    folders.find((f) => isInside(api, norm(f.path), d) || isInside(api, d, norm(f.path))) ?? null
  );
}

export function cloudFolderProblem(dir: string, client: CloudClient): string {
  return `${dir} is synced by the ${client} desktop app; pick a folder outside it so the two do not sync the same files`;
}

/** A refusal text for `dir`, or null when it is clear of every cloud desktop folder. */
export async function cloudFolderCheck(
  dir: string,
  caseInsensitive: boolean,
  find: () => Promise<CloudFolder[]>,
  platform: NodeJS.Platform = process.platform,
): Promise<string | null> {
  const hit = cloudFolderConflict(dir, await find(), { platform, caseInsensitive });
  return hit ? cloudFolderProblem(dir, hit.client) : null;
}
