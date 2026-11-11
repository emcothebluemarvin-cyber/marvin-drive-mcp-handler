import type { SyncRemote } from './sync-remote.js';

/*
 * Names a provider refuses (OneDrive sync spec §4.3). The engine checks every name it
 * creates on the remote: uploaded files, the folders created for them and the pair root.
 */

const ONEDRIVE_FORBIDDEN = /["*:<>?/\\|]/;
const ONEDRIVE_RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;
const ONEDRIVE_MAX_LENGTH = 255;

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
  if ([...name].length > ONEDRIVE_MAX_LENGTH) return 'the name is longer than 255 characters';
  return null;
}

/** Why `provider` cannot store `name` as one file or folder name, or null when it can. */
export function remoteNameProblem(provider: SyncRemote['provider'], name: string): string | null {
  return provider === 'microsoft' ? oneDriveProblem(name) : null;
}

/** The provider's name in user-facing texts. */
export function providerLabel(provider: SyncRemote['provider']): string {
  return provider === 'microsoft' ? 'OneDrive' : 'Drive';
}
