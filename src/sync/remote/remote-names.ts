import type { SyncRemote } from './sync-remote.js';

/*
 * Names a provider refuses (OneDrive sync spec §4.3). The engine checks every name it
 * creates on the remote: uploaded files, the folders created for them and the pair root.
 */

const ONEDRIVE_FORBIDDEN = /["*:<>?/\\|]/;
const ONEDRIVE_RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;
/*
 * Microsoft documents 255 characters per name and fewer than 400 for the whole path without
 * saying how characters are counted; JavaScript's UTF-16 length is the stricter count (an
 * astral character is two units, never fewer than one code point), so it is used.
 */
const ONEDRIVE_MAX_LENGTH = 255;
const ONEDRIVE_MAX_PATH = 400;

function oneDriveProblem(name: string): string | null {
  if (name === '') return 'the name is empty';
  if (ONEDRIVE_FORBIDDEN.test(name)) {
    return 'the name contains a character OneDrive does not allow (" * : < > ? / \\ |)';
  }
  if (name.startsWith(' ') || name.endsWith(' ')) return 'the name starts or ends with a space';
  if (name.endsWith('.')) return 'the name ends with a dot';
  const lower = name.toLowerCase();
  if (lower === '.lock' || lower === 'desktop.ini') return `"${name}" is a reserved name`;
  if (ONEDRIVE_RESERVED.test(name.split('.')[0] ?? '')) {
    return `"${name}" is a reserved name (CON, PRN, AUX, NUL, COM0–9, LPT0–9)`;
  }
  if (name.startsWith('~$')) return 'names starting with ~$ are not allowed';
  if (lower.includes('_vti_')) return 'names containing _vti_ are not allowed';
  if (name.length > ONEDRIVE_MAX_LENGTH) return 'the name is longer than 255 characters';
  return null;
}

/** Why `provider` cannot store `name` as one file or folder name, or null when it can. */
export function remoteNameProblem(provider: SyncRemote['provider'], name: string): string | null {
  return provider === 'microsoft' ? oneDriveProblem(name) : null;
}

/**
 * Why `provider` cannot store an item at `key` (a pair-relative path): OneDrive needs the
 * whole path under 400 characters. The pair root's own path is not known to the planner, so
 * this is a lower bound; a longer root can still make Graph refuse the upload.
 */
export function remotePathProblem(provider: SyncRemote['provider'], key: string): string | null {
  if (provider !== 'microsoft' || key.length < ONEDRIVE_MAX_PATH) return null;
  return `the path is ${ONEDRIVE_MAX_PATH} characters or longer (OneDrive allows fewer than ${ONEDRIVE_MAX_PATH})`;
}

/** The provider's name in user-facing texts. */
export function providerLabel(provider: SyncRemote['provider']): string {
  return provider === 'microsoft' ? 'OneDrive' : 'Drive';
}

/** "in Drive" / "on OneDrive", for "changed <where> since …" texts. */
export function providerIn(provider: SyncRemote['provider']): string {
  return provider === 'microsoft' ? 'on OneDrive' : 'in Drive';
}
