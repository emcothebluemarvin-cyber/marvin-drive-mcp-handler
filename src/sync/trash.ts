import { LocalTrashError } from './errors.js';
import {
  checkTrashable,
  defaultExec,
  nodeTrashFs,
  type ExecFn,
  type LocalTrash,
  type TrashFs,
} from './trash-common.js';
import { WindowsTrash } from './trash-windows.js';
import { XdgTrash } from './trash-xdg.js';

export { defaultExec, type ExecFn, type LocalTrash } from './trash-common.js';

export const TRASH_BIN = '/usr/bin/trash';

/** macOS: `/usr/bin/trash -s <path>` (macOS 15+), one path per call, no shell. Never unlinks. */
export class MacTrash implements LocalTrash {
  constructor(
    private readonly exec: ExecFn = defaultExec,
    private readonly fs: TrashFs = nodeTrashFs,
  ) {}

  async trash(absPath: string): Promise<void> {
    await checkTrashable(absPath, this.fs);
    try {
      await this.exec(TRASH_BIN, ['-s', absPath]);
    } catch (err) {
      throw new LocalTrashError(
        `Could not move ${absPath} to the Trash (volumes without a Trash are not supported). Nothing was deleted.`,
        { cause: err },
      );
    }
  }
}

/** The OS trash for this platform (local trash spec §3). */
export function createLocalTrash(platform: NodeJS.Platform = process.platform): LocalTrash {
  if (platform === 'darwin') return new MacTrash();
  if (platform === 'win32') return new WindowsTrash();
  return new XdgTrash();
}
