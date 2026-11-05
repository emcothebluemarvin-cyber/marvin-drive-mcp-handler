import { lstat } from 'node:fs/promises';
import path from 'node:path';
import type { AuditOp, AuditSink } from '../audit/audit-log.js';
import type { OperationRunner } from '../core/operation.js';
import type { DriveFile } from '../drive/drive-adapter.js';
import { AppError, ValidationError, hasErrorCode } from '../errors.js';
import { GOOGLE_MIME } from '../files/export-formats.js';
import { escapeQueryValue } from '../files/query.js';
import type { Logger } from '../logger.js';
import { CollisionError, PersistenceError, TargetChangedError, isAbortError } from './errors.js';
import { md5File } from './local-scanner.js';
import { absInside, baseName, foldKey, parentKey, prepareParent } from './paths.js';
import { SYNC_LIST_FIELDS } from './remote-scanner.js';
import {
  downloadReplace,
  moveLocal,
  placeExclusive,
  updateContent,
  uploadNew,
  type StatExpect,
} from './transfer.js';
import type { LocalTrash } from './trash.js';
import {
  SYNC_FILE_FIELDS,
  type Action,
  type ActionKind,
  type ActionOutcome,
  type LocalEntry,
  type PairFile,
  type RemoteEntry,
  type SelectionChange,
  type SyncRecord,
} from './types.js';

/** Spec §7 order; state-only actions first. */
export const STAGES: ActionKind[][] = [
  ['adopt', 'forget', 'untrack', 'refresh'],
  ['upload-new', 'update-remote'],
  ['move-local'],
  ['download-new', 'download-replace'],
  ['conflict'],
  ['trash-remote'],
  ['trash-local'],
];

const DUPLICATE_WINDOW_MS = 10 * 60 * 1000;
const MAX_CONFLICT_NAMES = 100;

export interface ExecutorDeps {
  ops: OperationRunner;
  audit: AuditSink;
  logger: Logger;
  clock: () => Date;
  save: (file: PairFile) => Promise<void>;
  /** Moves local files to the OS trash (tests pass a fake). */
  trash: LocalTrash;
}

interface RemoteFields {
  id: string;
  name: string;
  parentId: string;
  md5: string | null;
  size: number | null;
  modifiedTime: string;
}

interface LocalFields {
  name: string;
  md5: string;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
}

function fromEntry(e: RemoteEntry): RemoteFields {
  return {
    id: e.id,
    name: e.name,
    parentId: e.parentId,
    md5: e.md5,
    size: e.size,
    modifiedTime: e.modifiedTime,
  };
}

function fromDrive(f: DriveFile, fallbackParent: string): RemoteFields {
  return {
    id: f.id ?? '',
    name: f.name ?? '',
    parentId: f.parents?.[0] ?? fallbackParent,
    md5: f.md5Checksum ?? null,
    size: f.size ? Number(f.size) : null,
    modifiedTime: f.modifiedTime ?? '',
  };
}

function statOf(e: LocalEntry): StatExpect {
  return { size: e.size, mtimeMs: e.mtimeMs, ctimeMs: e.ctimeMs };
}

function makeRecord(key: string, local: LocalFields, remote: RemoteFields): SyncRecord {
  return {
    remoteId: remote.id,
    path: key,
    localName: local.name,
    remoteName: remote.name,
    remoteParentId: remote.parentId,
    localMd5: local.md5,
    localSize: local.size,
    localMtimeMs: local.mtimeMs,
    localCtimeMs: local.ctimeMs,
    remoteMd5: remote.md5,
    remoteSize: remote.size,
    remoteModifiedTime: remote.modifiedTime,
    native: null,
    remoteOnly: false,
    restorePending: false,
    remoteTrashed: false,
  };
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/** `<stem> (Drive conflict YYYY-MM-DD HH.mm)<ext>`, then ` 2`, ` 3`… (spec §6.9, local time). */
export function conflictName(base: string, at: Date, attempt: number): string {
  const dot = base.lastIndexOf('.');
  const stem = dot > 0 ? base.slice(0, dot) : base;
  const ext = dot > 0 ? base.slice(dot) : '';
  const stamp = `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}.${pad(at.getMinutes())}`;
  return `${stem} (Drive conflict ${stamp})${attempt === 0 ? '' : ` ${attempt + 1}`}${ext}`;
}

function applySelection(file: PairFile, change: SelectionChange): void {
  const pair = file.pair;
  const without = (list: string[], keys: string[]): string[] => {
    const folds = new Set(keys.map(foldKey));
    return list.filter((k) => !folds.has(foldKey(k)));
  };
  if (change.remove) pair.selection = without(pair.selection, change.remove);
  if (change.exclude) {
    pair.selection = without(pair.selection, change.exclude);
    pair.excluded = [...without(pair.excluded, change.exclude), ...change.exclude];
  }
  if (change.add) {
    pair.excluded = without(pair.excluded, change.add);
    pair.selection = [...without(pair.selection, change.add), ...change.add];
  }
}

function putRecord(file: PairFile, record: SyncRecord, replaces?: string): void {
  file.records = file.records.filter(
    (r) => r.remoteId !== record.remoteId && r.remoteId !== replaces,
  );
  file.records.push(record);
}

function dropRecord(file: PairFile, remoteId: string): void {
  file.records = file.records.filter((r) => r.remoteId !== remoteId);
}

function messageOf(err: unknown): string {
  if (err instanceof AppError) return err.message;
  return err instanceof Error ? err.message : String(err);
}

/** Executes a plan in spec §7 order, persisting the pair file after every success. */
export class Executor {
  private readonly folderIds = new Map<string, string>();
  private readonly folderErrors = new Map<string, string>();

  constructor(
    private readonly deps: ExecutorDeps,
    private readonly file: PairFile,
    folders: ReadonlyMap<string, string>,
  ) {
    for (const [id, key] of folders) this.folderIds.set(key, id);
  }

  private get pair(): PairFile['pair'] {
    return this.file.pair;
  }

  async run(actions: readonly Action[]): Promise<ActionOutcome[]> {
    const outcomes: ActionOutcome[] = [];
    let aborted = false;
    try {
      await this.ensureFolders(actions.filter((a) => a.kind === 'upload-new'));
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
        } catch (err) {
          if (err instanceof TargetChangedError) {
            outcomes.push({ ...base, status: 'skipped', message: err.message });
          } else if (err instanceof CollisionError) {
            outcomes.push({ ...base, status: 'collision', message: err.message });
          } else {
            if (!(err instanceof AppError)) {
              this.deps.logger.error('Sync action failed', {
                kind: action.kind,
                path: action.key,
                error: err,
              });
            }
            outcomes.push({ ...base, status: 'failed', message: messageOf(err) });
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

  private need<T>(value: T | null | undefined, what: string): T {
    if (value === null || value === undefined)
      throw new ValidationError(`Internal: ${what} missing for sync action`);
    return value;
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

  private readRemote(id: string): Promise<DriveFile> {
    return this.deps.ops.exec(this.pair.account, 'idempotent', id, (ctx) =>
      ctx.drive.getFile(id, SYNC_FILE_FIELDS),
    );
  }

  /** Re-reads R and throws TargetChangedError unless it still matches the plan (spec §7). */
  private async verifyRemote(planned: RemoteEntry): Promise<DriveFile> {
    const current = await this.readRemote(planned.id);
    if (
      current.trashed ||
      (current.md5Checksum ?? null) !== planned.md5 ||
      (current.modifiedTime ?? '') !== planned.modifiedTime
    ) {
      throw new TargetChangedError(`${planned.key} changed in Drive since planning`);
    }
    return current;
  }

  // ---- remote folders -------------------------------------------------------------

  private async ensureFolders(uploads: readonly Action[]): Promise<void> {
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

  private async folderFor(dir: string): Promise<string> {
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
    const q = `'${escapeQueryValue(parentId)}' in parents and trashed = false and mimeType = '${GOOGLE_MIME.folder}'`;
    const folders: DriveFile[] = [];
    let pageToken: string | undefined;
    do {
      const page = await this.deps.ops.exec(this.pair.account, 'idempotent', parentId, (ctx) =>
        ctx.drive.listFiles({
          q,
          pageSize: 1000,
          ...(pageToken ? { pageToken } : {}),
          fields: 'nextPageToken, files(id, name)',
        }),
      );
      folders.push(...(page.files ?? []));
      pageToken = page.nextPageToken ?? undefined;
    } while (pageToken);
    const same = folders.filter((f) =>
      this.pair.caseInsensitive
        ? foldKey(f.name ?? '') === foldKey(name)
        : (f.name ?? '').normalize('NFC') === name.normalize('NFC'),
    );
    if (same.length > 1)
      throw new ValidationError(
        `Several Drive folders named "${name}"; resolve the duplicate first`,
      );
    const existing = same[0]?.id;
    if (existing) return existing;
    const created = await this.deps.ops.exec(this.pair.account, 'create', parentId, (ctx) =>
      ctx.drive.createFile({
        requestBody: { name, mimeType: GOOGLE_MIME.folder, parents: [parentId] },
        fields: 'id, name',
      }),
    );
    const id = this.need(created.id, 'folder id');
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

  // ---- state-only -------------------------------------------------------------------

  private async adopt(action: Action): Promise<Partial<ActionOutcome>> {
    const local = this.need(action.local, 'local');
    const remote = this.need(action.remote, 'remote');
    const md5 = this.need(action.localMd5, 'local md5');
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
    const local = this.need(action.local, 'local');
    const remote = this.need(action.remote, 'remote');
    const md5 = this.need(action.localMd5, 'local md5');
    await this.commit(action, () =>
      putRecord(this.file, makeRecord(action.key, this.localFields(local, md5), fromEntry(remote))),
    );
    return {};
  }

  private async forget(action: Action): Promise<Partial<ActionOutcome>> {
    const record = this.need(action.record, 'record');
    await this.commit(action, () => dropRecord(this.file, record.remoteId));
    return {};
  }

  // ---- uploads ----------------------------------------------------------------------

  private async upload(action: Action): Promise<Partial<ActionOutcome>> {
    const local = this.need(action.local, 'local');
    const planned = this.need(action.localMd5, 'local md5');
    const parentId = await this.folderFor(parentKey(action.key));
    const abs = absInside(this.pair.localDir, local.name);
    const name = baseName(action.key);
    let uploaded: DriveFile;
    try {
      uploaded = await this.deps.ops.exec(this.pair.account, 'create', parentId, (ctx) =>
        uploadNew(ctx.drive, { abs, name, parentId }),
      );
    } catch (err) {
      if (isAbortError(err)) throw err;
      const adopted = await this.findDuplicateUpload(parentId, name, planned);
      if (!adopted) throw err;
      uploaded = adopted;
    }
    const remote = fromDrive(uploaded, parentId);
    const warning =
      remote.md5 !== null && remote.md5 !== planned ? 'changed-during-upload' : undefined;
    await this.commit(action, () =>
      putRecord(
        this.file,
        makeRecord(action.key, this.localFields(local, remote.md5 ?? planned), remote),
        action.rebaseFrom,
      ),
    );
    await this.audit('sync_upload', action, remote.id);
    return warning ? { warning } : {};
  }

  /** After an upload error: a same-name, same-md5 file created within 10 minutes is ours (spec §7). */
  private async findDuplicateUpload(
    parentId: string,
    name: string,
    md5: string,
  ): Promise<DriveFile | null> {
    const q = `'${escapeQueryValue(parentId)}' in parents and trashed = false and name = '${escapeQueryValue(name)}'`;
    try {
      const list = await this.deps.ops.exec(this.pair.account, 'idempotent', parentId, (ctx) =>
        ctx.drive.listFiles({ q, pageSize: 100, fields: SYNC_LIST_FIELDS }),
      );
      const now = this.deps.clock().getTime();
      return (
        (list.files ?? []).find(
          (f) =>
            f.md5Checksum === md5 &&
            f.name === name &&
            Math.abs(now - Date.parse(f.createdTime ?? '')) <= DUPLICATE_WINDOW_MS,
        ) ?? null
      );
    } catch (err) {
      if (isAbortError(err)) throw err;
      return null;
    }
  }

  private async updateRemote(action: Action): Promise<Partial<ActionOutcome>> {
    const local = this.need(action.local, 'local');
    const planned = this.need(action.localMd5, 'local md5');
    const remote = this.need(action.remote, 'remote');
    await this.verifyRemote(remote);
    const abs = absInside(this.pair.localDir, local.name);
    const updated = await this.deps.ops.exec(this.pair.account, 'mutate', remote.id, (ctx) =>
      updateContent(ctx.drive, { fileId: remote.id, abs }),
    );
    const fields = fromDrive(updated, remote.parentId);
    const warning =
      fields.md5 !== null && fields.md5 !== planned ? 'changed-during-upload' : undefined;
    await this.commit(action, () =>
      putRecord(
        this.file,
        makeRecord(action.key, this.localFields(local, fields.md5 ?? planned), fields),
      ),
    );
    await this.audit('sync_update', action, remote.id);
    return warning ? { warning } : {};
  }

  // ---- local writes -----------------------------------------------------------------

  private async move(action: Action): Promise<Partial<ActionOutcome>> {
    const record = this.need(action.record, 'record');
    const local = this.need(action.local, 'local');
    const remote = this.need(action.remote, 'remote');
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
    const written = await this.deps.ops.exec(this.pair.account, 'idempotent', remote.id, (ctx) =>
      downloadReplace(to, () => ctx.drive.downloadMedia(remote.id), {
        expect,
        expectedMd5: remote.md5,
      }),
    );
    const after = await this.statFields(action.key, written.md5);
    putRecord(this.file, makeRecord(action.key, after, fromEntry(remote)));
    await this.persist();
    await this.audit('sync_download', action, remote.id);
    return {};
  }

  private async downloadNew(action: Action): Promise<Partial<ActionOutcome>> {
    const remote = this.need(action.remote, 'remote');
    const abs = await prepareParent(this.pair.localDir, action.key);
    const written = await this.deps.ops.exec(this.pair.account, 'idempotent', remote.id, (ctx) =>
      placeExclusive(
        path.dirname(abs),
        () => path.basename(abs),
        () => ctx.drive.downloadMedia(remote.id),
        {
          expectedMd5: remote.md5,
        },
      ),
    );
    const local = await this.statFields(action.key, written.md5);
    await this.commit(action, () =>
      putRecord(this.file, makeRecord(action.key, local, fromEntry(remote))),
    );
    await this.audit('sync_download', action, remote.id);
    return {};
  }

  private async downloadReplace(action: Action): Promise<Partial<ActionOutcome>> {
    const local = this.need(action.local, 'local');
    const remote = this.need(action.remote, 'remote');
    const abs = absInside(this.pair.localDir, local.name);
    const written = await this.deps.ops.exec(this.pair.account, 'idempotent', remote.id, (ctx) =>
      downloadReplace(abs, () => ctx.drive.downloadMedia(remote.id), {
        expect: statOf(local),
        expectedMd5: remote.md5,
      }),
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
    const local = this.need(action.local, 'local');
    const remote = this.need(action.remote, 'remote');
    const planned = this.need(action.localMd5, 'local md5');
    const abs = absInside(this.pair.localDir, local.name);
    const at = this.deps.clock();
    const base = path.basename(abs);
    const copy = await this.deps.ops.exec(this.pair.account, 'idempotent', remote.id, (ctx) =>
      placeExclusive(
        path.dirname(abs),
        (i) => conflictName(base, at, i),
        () => ctx.drive.downloadMedia(remote.id),
        {
          expectedMd5: remote.md5,
          maxAttempts: MAX_CONFLICT_NAMES,
        },
      ),
    );
    const conflictCopy = path.relative(this.pair.localDir, copy.path).split(path.sep).join('/');
    await this.audit('sync_conflict', action, remote.id);
    if (!action.updateRemote) {
      const record = this.need(action.record, 'record');
      await this.commit(action, () =>
        putRecord(this.file, {
          ...record,
          remoteMd5: remote.md5,
          remoteSize: remote.size,
          remoteModifiedTime: remote.modifiedTime,
          remoteName: remote.name,
          remoteParentId: remote.parentId,
        }),
      );
      return { conflictCopy };
    }
    await this.verifyRemote(remote);
    const updated = await this.deps.ops.exec(this.pair.account, 'mutate', remote.id, (ctx) =>
      updateContent(ctx.drive, { fileId: remote.id, abs }),
    );
    const fields = fromDrive(updated, remote.parentId);
    await this.commit(action, () =>
      putRecord(
        this.file,
        makeRecord(action.key, this.localFields(local, fields.md5 ?? planned), fields),
      ),
    );
    await this.audit('sync_update', action, remote.id);
    return {
      conflictCopy,
      ...(fields.md5 !== null && fields.md5 !== planned
        ? { warning: 'changed-during-upload' }
        : {}),
    };
  }

  // ---- deletions --------------------------------------------------------------------

  private async trashRemote(action: Action): Promise<Partial<ActionOutcome>> {
    const record = this.need(action.record, 'record');
    const remote = this.need(action.remote, 'remote');
    // The local deletion must still hold: the file may be back (restored from the Trash).
    const back = await lstat(absInside(this.pair.localDir, record.localName)).catch(
      (err: unknown) => {
        if (hasErrorCode(err, 'ENOENT')) return null;
        throw err;
      },
    );
    if (back) throw new TargetChangedError(`${action.key} exists locally again`);
    const current = await this.readRemote(remote.id);
    if (!current.trashed) {
      if (
        (current.md5Checksum ?? null) !== remote.md5 ||
        (current.modifiedTime ?? '') !== remote.modifiedTime ||
        (current.parents?.[0] ?? '') !== remote.parentId
      ) {
        throw new TargetChangedError(`${action.key} changed or moved in Drive since planning`);
      }
      await this.deps.ops.exec(this.pair.account, 'idempotent', remote.id, (ctx) =>
        ctx.drive.updateFile({
          fileId: remote.id,
          requestBody: { trashed: true },
          fields: 'id, trashed',
        }),
      );
    }
    await this.commit(action, () => dropRecord(this.file, record.remoteId));
    await this.audit('sync_trash_remote', action, remote.id);
    return {};
  }

  private async trashLocalFile(action: Action): Promise<Partial<ActionOutcome>> {
    const record = this.need(action.record, 'record');
    const local = this.need(action.local, 'local');
    const abs = absInside(this.pair.localDir, local.name);
    let md5: string;
    try {
      md5 = await md5File(abs);
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
