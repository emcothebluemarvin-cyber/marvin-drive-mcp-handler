import { lstat } from 'node:fs/promises';
import path from 'node:path';
import type { AuditOp, AuditSink } from '../audit/audit-log.js';
import { AppError, ExportTooLargeError, hasErrorCode } from '../errors.js';
import type { Logger } from '../logger.js';
import { remoteUnchangedSince, sameContent } from './content-compare.js';
import {
  CollisionError,
  LocalEditKeptError,
  PersistenceError,
  TargetChangedError,
  isAbortError,
  messageOf,
} from './errors.js';
import {
  applySelection,
  conflictName,
  dropRecord,
  fromEntry,
  fromRemote,
  makeRecord,
  need,
  putRecord,
  statOf,
  type LocalFields,
  type RemoteFields,
} from './exec-records.js';
import { exportNew, exportOver, exportReplace, type ExportHost } from './exec-export.js';
import { defaultDigesters, hashFileDigests, type DigesterFactory } from './local-scanner.js';
import { absInside, baseName, parentKey, prepareParent } from './paths.js';
import { RemoteFolders } from './remote-folders.js';
import type { RemoteItem, SyncRemote } from './remote/sync-remote.js';
import { downloadReplace, moveLocal, placeExclusive, type DownloadCheck } from './transfer.js';
import type { LocalTrash } from './trash.js';
import {
  type Action,
  type ActionKind,
  type ActionOutcome,
  type LocalDigests,
  type LocalEntry,
  type PairFile,
  type RemoteEntry,
} from './types.js';

/** Spec §7 order; state-only actions first. */
export const STAGES: ActionKind[][] = [
  ['adopt', 'forget', 'untrack', 'refresh'],
  ['upload-new', 'update-remote'],
  ['move-local'],
  ['download-new', 'download-replace', 'export-new', 'export-replace'],
  ['conflict'],
  ['trash-remote'],
  ['trash-local'],
];

const DUPLICATE_WINDOW_MS = 10 * 60 * 1000;
const MAX_CONFLICT_NAMES = 100;

export { conflictName } from './exec-records.js';

export interface ExecutorDeps {
  /** The pair's remote; every remote read and write goes through it. */
  remote: SyncRemote;
  audit: AuditSink;
  logger: Logger;
  clock: () => Date;
  save: (file: PairFile) => Promise<void>;
  /** Moves local files to the OS trash (tests pass a fake). */
  trash: LocalTrash;
  /** Local digests of the remote's hash kind (default: built-in digesters). */
  digesters?: DigesterFactory;
}

/** Executes a plan in spec §7 order, persisting the pair file after every success. */
export class Executor {
  private readonly folders: RemoteFolders;

  constructor(
    private readonly deps: ExecutorDeps,
    private readonly file: PairFile,
    folders: ReadonlyMap<string, string>,
  ) {
    this.folders = new RemoteFolders(deps, file.pair, folders);
  }

  private get digesters(): DigesterFactory {
    return this.deps.digesters ?? defaultDigesters;
  }

  private get pair(): PairFile['pair'] {
    return this.file.pair;
  }

  async run(actions: readonly Action[]): Promise<ActionOutcome[]> {
    const outcomes: ActionOutcome[] = [];
    let aborted = false;
    try {
      await this.folders.ensureAll(actions.filter((a) => a.kind === 'upload-new'));
    } catch (err) {
      if (!isAbortError(err)) throw err;
      aborted = true;
    }
    for (const stage of STAGES) {
      for (const action of actions.filter((a) => stage.includes(a.kind))) {
        const base = { kind: action.kind, path: action.key };
        if (aborted) {
          outcomes.push({ ...base, status: 'not-run' });
          continue;
        }
        try {
          outcomes.push({ ...base, status: 'done', ...(await this.execute(action)) });
        } catch (caught) {
          // N5: whatever went wrong after the local edit was moved aside, name the kept copy.
          const kept = caught instanceof LocalEditKeptError ? { conflictCopy: caught.kept } : {};
          const err = caught instanceof LocalEditKeptError ? caught.original : caught;
          if (err instanceof TargetChangedError) {
            outcomes.push({ ...base, ...kept, status: 'skipped', message: err.message });
          } else if (err instanceof ExportTooLargeError) {
            outcomes.push({
              ...base,
              ...kept,
              status: 'skipped',
              message: err.message,
              warning: 'native-too-large',
            });
          } else if (err instanceof CollisionError) {
            outcomes.push({ ...base, ...kept, status: 'collision', message: err.message });
          } else {
            if (!(err instanceof AppError)) {
              this.deps.logger.error('Sync action failed', {
                kind: action.kind,
                path: action.key,
                error: err,
              });
            }
            outcomes.push({ ...base, ...kept, status: 'failed', message: messageOf(err) });
            if (isAbortError(err)) aborted = true;
          }
        }
      }
    }
    return outcomes;
  }

  private async execute(action: Action): Promise<Partial<ActionOutcome>> {
    switch (action.kind) {
      case 'adopt':
        return this.adopt(action);
      case 'refresh':
        return this.refresh(action);
      case 'forget':
      case 'untrack':
        return this.forget(action);
      case 'upload-new':
        return this.upload(action);
      case 'update-remote':
        return this.updateRemote(action);
      case 'move-local':
        return this.move(action);
      case 'download-new':
        return this.downloadNew(action);
      case 'download-replace':
        return this.downloadReplace(action);
      case 'export-new':
        return exportNew(this.host(), action);
      case 'export-replace':
        return exportReplace(this.host(), action);
      case 'conflict':
        return this.conflict(action);
      case 'trash-remote':
        return this.trashRemote(action);
      case 'trash-local':
        return this.trashLocalFile(action);
    }
  }

  /** Atomic pair-file save; a failure aborts the run (see PersistenceError). */
  private async persist(): Promise<void> {
    try {
      await this.deps.save(this.file);
    } catch (err) {
      throw new PersistenceError(`Could not save the pair file: ${messageOf(err)}`, {
        cause: err,
      });
    }
  }

  private async commit(action: Action, mutate: () => void): Promise<void> {
    mutate();
    applySelection(this.file, action.selection);
    await this.persist();
  }

  private async audit(op: AuditOp, action: Action, remoteId: string): Promise<void> {
    try {
      await this.deps.audit.record({
        account: this.pair.account,
        op,
        fileId: remoteId,
        name: baseName(action.key),
        details: { pair: this.pair.name, path: action.key, remoteId },
      });
    } catch (err) {
      this.deps.logger.warn('Audit log write failed', { op, error: err });
    }
  }

  /** What the export actions (exec-export.ts) need from this executor. */
  private host(): ExportHost {
    return {
      file: this.file,
      remote: this.deps.remote,
      clock: this.deps.clock,
      commit: (action, mutate) => this.commit(action, mutate),
      audit: (op, action, remoteId) => this.audit(op, action, remoteId),
      statFields: (name, md5) => this.statFields(name, md5),
    };
  }

  private localFields(entry: LocalEntry, md5: string): LocalFields {
    return {
      name: entry.name,
      md5,
      size: entry.size,
      mtimeMs: entry.mtimeMs,
      ctimeMs: entry.ctimeMs,
    };
  }

  private async statFields(name: string, md5: string): Promise<LocalFields> {
    const info = await lstat(absInside(this.pair.localDir, name));
    return { name, md5, size: info.size, mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs };
  }

  /** Re-reads R and throws TargetChangedError unless it still matches the plan (spec §7). */
  private async verifyRemote(planned: RemoteEntry): Promise<RemoteItem> {
    const current = await this.deps.remote.read(planned.id);
    if (current.trashed || !remoteUnchangedSince(planned, current)) {
      throw new TargetChangedError(`${planned.key} changed in Drive since planning`);
    }
    return current;
  }

  // ---- state-only -------------------------------------------------------------------

  private async adopt(action: Action): Promise<Partial<ActionOutcome>> {
    const local = need(action.local, 'local');
    const remote = need(action.remote, 'remote');
    const md5 = need(action.localMd5, 'local md5');
    await this.commit(action, () =>
      putRecord(
        this.file,
        makeRecord(action.key, this.localFields(local, md5), fromEntry(remote)),
        action.rebaseFrom,
      ),
    );
    return {};
  }

  private async refresh(action: Action): Promise<Partial<ActionOutcome>> {
    if (action.patch) {
      // Remote-only bookkeeping (O3–O6): only the record changes, no file is touched.
      const record = need(action.record, 'record');
      const patch = action.patch;
      await this.commit(action, () => putRecord(this.file, { ...record, ...patch }));
      return {};
    }
    const local = need(action.local, 'local');
    const remote = need(action.remote, 'remote');
    const md5 = need(action.localMd5, 'local md5');
    await this.commit(action, () =>
      putRecord(this.file, makeRecord(action.key, this.localFields(local, md5), fromEntry(remote))),
    );
    return {};
  }

  private async forget(action: Action): Promise<Partial<ActionOutcome>> {
    const record = need(action.record, 'record');
    await this.commit(action, () => dropRecord(this.file, record.remoteId));
    return {};
  }

  // ---- uploads ----------------------------------------------------------------------

  /** A download must match R's hash and size (OneDrive sync spec §3.3). */
  private check(remote: RemoteEntry): DownloadCheck {
    return { expected: remote.hash, expectedSize: remote.size, digesters: this.digesters };
  }

  /** The planned local content; actions built without digests carry the md5 alone. */
  private plannedDigests(action: Action): LocalDigests {
    if (action.localDigests) return action.localDigests;
    const md5 = need(action.localMd5, 'local md5');
    return {
      md5,
      remote: this.deps.remote.hashKind === 'md5' ? { kind: 'md5', value: md5 } : null,
    };
  }

  /** Only a hash that differs warns; a missing or other-kind hash is not a warning (§3.2). */
  private changedDuringUpload(planned: LocalDigests, fields: RemoteFields): string | undefined {
    return sameContent(planned, fields.hash) === false ? 'changed-during-upload' : undefined;
  }

  private async upload(action: Action): Promise<Partial<ActionOutcome>> {
    const local = need(action.local, 'local');
    const planned = this.plannedDigests(action);
    const parentId = await this.folders.folderFor(parentKey(action.key));
    const abs = absInside(this.pair.localDir, local.name);
    const name = baseName(action.key);
    let uploaded: RemoteItem;
    try {
      uploaded = await this.deps.remote.uploadNew(parentId, name, abs);
    } catch (err) {
      if (isAbortError(err)) throw err;
      const adopted = await this.findDuplicateUpload(parentId, name, planned, local.size);
      if (!adopted) throw err;
      uploaded = adopted;
    }
    const remote = fromRemote(uploaded, parentId);
    const warning = this.changedDuringUpload(planned, remote);
    await this.commit(action, () =>
      putRecord(
        this.file,
        makeRecord(action.key, this.localFields(local, planned.md5), remote),
        action.rebaseFrom,
      ),
    );
    await this.audit('sync_upload', action, remote.id);
    return warning ? { warning } : {};
  }

  /**
   * After an upload error: a same-name file with the planned size and content, created
   * within 10 minutes, is ours (spec §7; OneDrive sync spec §3.2).
   */
  private async findDuplicateUpload(
    parentId: string,
    name: string,
    planned: LocalDigests,
    size: number,
  ): Promise<RemoteItem | null> {
    try {
      const list = await this.deps.remote.findChildren(parentId, name);
      const now = this.deps.clock().getTime();
      return (
        list.find(
          (f) =>
            f.size === size &&
            sameContent(planned, f.hash) === true &&
            f.name === name &&
            Math.abs(now - Date.parse(f.createdTime)) <= DUPLICATE_WINDOW_MS,
        ) ?? null
      );
    } catch (err) {
      if (isAbortError(err)) throw err;
      return null;
    }
  }

  private async updateRemote(action: Action): Promise<Partial<ActionOutcome>> {
    const local = need(action.local, 'local');
    const planned = this.plannedDigests(action);
    const remote = need(action.remote, 'remote');
    const current = await this.verifyRemote(remote);
    const abs = absInside(this.pair.localDir, local.name);
    const updated = await this.deps.remote.replaceContent(current, abs);
    const fields = fromRemote(updated, remote.parentId);
    const warning = this.changedDuringUpload(planned, fields);
    await this.commit(action, () =>
      putRecord(this.file, makeRecord(action.key, this.localFields(local, planned.md5), fields)),
    );
    await this.audit('sync_update', action, remote.id);
    return warning ? { warning } : {};
  }

  // ---- local writes -----------------------------------------------------------------

  private async move(action: Action): Promise<Partial<ActionOutcome>> {
    const record = need(action.record, 'record');
    const local = need(action.local, 'local');
    const remote = need(action.remote, 'remote');
    const from = absInside(this.pair.localDir, local.name);
    const to = action.inPlace
      ? absInside(this.pair.localDir, action.key)
      : await prepareParent(this.pair.localDir, action.key);
    await moveLocal(from, to, { inPlace: action.inPlace ?? false, expect: statOf(local) });
    const moved = await this.statFields(action.key, record.localMd5);
    // Persist the move with the old remote content so a failed follow-up download is retried (B3).
    await this.commit(action, () =>
      putRecord(this.file, {
        ...record,
        path: action.key,
        localName: moved.name,
        localSize: moved.size,
        localMtimeMs: moved.mtimeMs,
        localCtimeMs: moved.ctimeMs,
        remoteName: remote.name,
        remoteParentId: remote.parentId,
      }),
    );
    await this.audit('sync_move_local', action, remote.id);
    if (!action.thenDownload) return {};
    const expect = { size: moved.size, mtimeMs: moved.mtimeMs, ctimeMs: moved.ctimeMs };
    // N6: a Google-native file is re-read and exported instead of downloaded.
    const written = remote.native
      ? await exportOver(this.host(), to, expect, remote)
      : await this.deps.remote.download(remote.id, (open) =>
          downloadReplace(to, open, { expect, ...this.check(remote) }),
        );
    const after = await this.statFields(action.key, written.md5);
    putRecord(this.file, makeRecord(action.key, after, fromEntry(remote)));
    await this.persist();
    await this.audit('sync_download', action, remote.id);
    return {};
  }

  private async downloadNew(action: Action): Promise<Partial<ActionOutcome>> {
    const remote = need(action.remote, 'remote');
    const abs = await prepareParent(this.pair.localDir, action.key);
    const written = await this.deps.remote.download(remote.id, (open) =>
      placeExclusive(path.dirname(abs), () => path.basename(abs), open, {
        ...this.check(remote),
      }),
    );
    const local = await this.statFields(action.key, written.md5);
    await this.commit(action, () =>
      putRecord(this.file, makeRecord(action.key, local, fromEntry(remote))),
    );
    await this.audit('sync_download', action, remote.id);
    return {};
  }

  private async downloadReplace(action: Action): Promise<Partial<ActionOutcome>> {
    const local = need(action.local, 'local');
    const remote = need(action.remote, 'remote');
    const abs = absInside(this.pair.localDir, local.name);
    const written = await this.deps.remote.download(remote.id, (open) =>
      downloadReplace(abs, open, { expect: statOf(local), ...this.check(remote) }),
    );
    const after = await this.statFields(local.name, written.md5);
    await this.commit(action, () =>
      putRecord(this.file, makeRecord(action.key, after, fromEntry(remote))),
    );
    await this.audit('sync_download', action, remote.id);
    return {};
  }

  /** Spec §6.9: conflict copy first (verified, fsynced), only then upload L over R. */
  private async conflict(action: Action): Promise<Partial<ActionOutcome>> {
    const local = need(action.local, 'local');
    const remote = need(action.remote, 'remote');
    const planned = this.plannedDigests(action);
    const abs = absInside(this.pair.localDir, local.name);
    const at = this.deps.clock();
    const base = path.basename(abs);
    const copy = await this.deps.remote.download(remote.id, (open) =>
      placeExclusive(path.dirname(abs), (i) => conflictName(base, at, i), open, {
        ...this.check(remote),
        maxAttempts: MAX_CONFLICT_NAMES,
      }),
    );
    const conflictCopy = path.relative(this.pair.localDir, copy.path).split(path.sep).join('/');
    await this.audit('sync_conflict', action, remote.id);
    if (!action.updateRemote) {
      const record = need(action.record, 'record');
      await this.commit(action, () =>
        putRecord(this.file, {
          ...record,
          remoteHash: remote.hash,
          remoteSize: remote.size,
          remoteModifiedTime: remote.modifiedTime,
          remoteName: remote.name,
          remoteParentId: remote.parentId,
        }),
      );
      return { conflictCopy };
    }
    const current = await this.verifyRemote(remote);
    const updated = await this.deps.remote.replaceContent(current, abs);
    const fields = fromRemote(updated, remote.parentId);
    const warning = this.changedDuringUpload(planned, fields);
    await this.commit(action, () =>
      putRecord(this.file, makeRecord(action.key, this.localFields(local, planned.md5), fields)),
    );
    await this.audit('sync_update', action, remote.id);
    return { conflictCopy, ...(warning ? { warning } : {}) };
  }

  // ---- deletions --------------------------------------------------------------------

  private async trashRemote(action: Action): Promise<Partial<ActionOutcome>> {
    const record = need(action.record, 'record');
    const remote = need(action.remote, 'remote');
    // The local deletion must still hold: the file may be back (restored from the Trash).
    const back = await lstat(absInside(this.pair.localDir, record.localName)).catch(
      (err: unknown) => {
        if (hasErrorCode(err, 'ENOENT')) return null;
        throw err;
      },
    );
    if (back) throw new TargetChangedError(`${action.key} exists locally again`);
    const current = await this.deps.remote.read(remote.id);
    if (!current.trashed) {
      if (!remoteUnchangedSince(remote, current) || (current.parentId ?? '') !== remote.parentId) {
        throw new TargetChangedError(`${action.key} changed or moved in Drive since planning`);
      }
      await this.deps.remote.trash(current);
    }
    await this.commit(action, () => dropRecord(this.file, record.remoteId));
    await this.audit('sync_trash_remote', action, remote.id);
    return {};
  }

  private async trashLocalFile(action: Action): Promise<Partial<ActionOutcome>> {
    const record = need(action.record, 'record');
    const local = need(action.local, 'local');
    const abs = absInside(this.pair.localDir, local.name);
    let md5: string;
    try {
      md5 = (await hashFileDigests(abs, 'md5', this.digesters)).md5;
    } catch (err) {
      if (hasErrorCode(err, 'ENOENT'))
        throw new TargetChangedError(`${action.key} is already gone`);
      throw err;
    }
    if (md5 !== action.localMd5)
      throw new TargetChangedError(`${action.key} changed locally since planning`);
    try {
      await this.deps.trash.trash(abs);
    } catch (err) {
      if (hasErrorCode(err, 'ENOENT'))
        throw new TargetChangedError(`${action.key} is already gone`);
      throw err;
    }
    await this.commit(action, () => dropRecord(this.file, record.remoteId));
    await this.audit('sync_trash_local', action, record.remoteId);
    return {};
  }
}
