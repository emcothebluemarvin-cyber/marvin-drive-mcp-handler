import type { AuditSink } from '../audit/audit-log.js';
import { ValidationError } from '../errors.js';
import type { Logger } from '../logger.js';
import { isAbortError, messageOf } from './errors.js';
import { baseName, foldKey, parentKey } from './paths.js';
import type { SyncRemote } from './remote/sync-remote.js';
import type { Action, Pair } from './types.js';

export interface RemoteFolderDeps {
  remote: SyncRemote;
  audit: AuditSink;
  logger: Logger;
}

/** Remote folders for uploads: scanned ids first, then reuse-or-create (spec §4). */
export class RemoteFolders {
  private readonly folderIds = new Map<string, string>();
  private readonly folderErrors = new Map<string, string>();

  constructor(
    private readonly deps: RemoteFolderDeps,
    private readonly pair: Pair,
    folders: ReadonlyMap<string, string>,
  ) {
    for (const [id, key] of folders) this.folderIds.set(key, id);
  }

  async ensureAll(uploads: readonly Action[]): Promise<void> {
    const dirs = [...new Set(uploads.map((a) => parentKey(a.key)))].sort(
      (a, b) => a.split('/').length - b.split('/').length || (a < b ? -1 : 1),
    );
    for (const dir of dirs) {
      try {
        await this.folderFor(dir);
      } catch (err) {
        if (isAbortError(err)) throw err;
        this.folderErrors.set(dir, messageOf(err));
      }
    }
  }

  async folderFor(dir: string): Promise<string> {
    const known =
      this.folderIds.get(dir) ??
      (this.pair.caseInsensitive
        ? [...this.folderIds].find(([key]) => foldKey(key) === foldKey(dir))?.[1]
        : undefined);
    if (known) return known;
    const failed = this.folderErrors.get(dir);
    if (failed) throw new ValidationError(failed);
    const parentId = await this.folderFor(parentKey(dir));
    const id = await this.ensureRemoteFolder(parentId, baseName(dir));
    this.folderIds.set(dir, id);
    return id;
  }

  /** Reuses exactly one non-trashed same-name folder; several → refuse (spec §4). */
  private async ensureRemoteFolder(parentId: string, name: string): Promise<string> {
    // findChildren already matched the fold key; a case-sensitive volume needs the NFC name.
    const folders = await this.deps.remote.findChildren(parentId, name, 'folder');
    const same = this.pair.caseInsensitive
      ? folders
      : folders.filter((f) => f.name.normalize('NFC') === name.normalize('NFC'));
    if (same.length > 1)
      throw new ValidationError(
        `Several Drive folders named "${name}"; resolve the duplicate first`,
      );
    const existing = same[0]?.id;
    if (existing) return existing;
    const created = await this.deps.remote.createFolder(parentId, name);
    const id = created.id;
    if (!id) throw new ValidationError('Internal: folder id missing for sync action');
    try {
      await this.deps.audit.record({
        account: this.pair.account,
        op: 'create_folder',
        fileId: id,
        name,
        details: { pair: this.pair.name, parentId },
      });
    } catch (err) {
      this.deps.logger.warn('Audit log write failed', { op: 'create_folder', error: err });
    }
    return id;
  }
}
