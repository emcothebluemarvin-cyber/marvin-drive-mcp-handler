import { describe, expect, it } from 'vitest';
import { GOOGLE_MIME } from '../../files/export-formats.js';
import { remoteRootProblem } from '../pair-admin.js';
import { toRemoteItem } from '../remote/google-remote.js';
import type { RemoteItem } from '../remote/sync-remote.js';
import { DEFAULT_GOOGLE_EXPORT } from '../types.js';
import { binary, folder } from './drive-tree.js';

const root = (overrides: Partial<RemoteItem> = {}): RemoteItem => ({
  ...toRemoteItem(folder('R', 'Sync', 'my-drive'), DEFAULT_GOOGLE_EXPORT),
  ...overrides,
});

describe('remoteRootProblem on a RemoteItem', () => {
  it('accepts a writable folder, also when Drive omits canAddChildren', () => {
    expect(remoteRootProblem(root())).toBeNull();
    expect(
      remoteRootProblem(
        toRemoteItem({ id: 'R', mimeType: GOOGLE_MIME.folder }, DEFAULT_GOOGLE_EXPORT),
      ),
    ).toBeNull();
  });
  it('names what is wrong', () => {
    expect(remoteRootProblem(toRemoteItem(binary('f', 'a.pdf', 'P'), DEFAULT_GOOGLE_EXPORT))).toBe(
      'is not a folder',
    );
    expect(remoteRootProblem(root({ trashed: true }))).toBe('is in the Drive trash');
    expect(remoteRootProblem(root({ canAddChildren: false }))).toBe('does not allow adding files');
  });
});
