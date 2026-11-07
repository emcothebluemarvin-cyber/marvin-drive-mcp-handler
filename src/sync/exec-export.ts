import path from 'node:path';
import type { AuditOp } from '../audit/audit-log.js';
import type { OperationRunner } from '../core/operation.js';
import type { DriveFile } from '../drive/drive-adapter.js';
import type { ExportPlan } from '../files/export-formats.js';
import { openExport } from '../files/export-stream.js';
import type { Logger } from '../logger.js';
import { remoteUnchangedSince } from './content-compare.js';
import { CollisionError, LocalEditKeptError, TargetChangedError } from './errors.js';
import {
  fromEntry,
  localEditName,
  makeRecord,
  need,
  putRecord,
  statOf,
  type LocalFields,
} from './exec-records.js';
import { absInside, prepareParent } from './paths.js';
import {
  downloadReplace,
  moveLocal,
  placeExclusive,
  syncDir,
  type StatExpect,
  type Written,
} from './transfer.js';
import {
  SYNC_FILE_FIELDS,
  type Action,
  type ActionOutcome,
  type PairFile,
  type RemoteEntry,
} from './types.js';

/** The export re-read also needs the 10 MB fallback link and the web link (addendum §4.3). */
export const SYNC_EXPORT_FIELDS = `${SYNC_FILE_FIELDS}, exportLinks, webViewLink`;
const MAX_LOCAL_EDIT_NAMES = 100;

/** What the export actions need from the Executor. */
export interface ExportHost {
  file: PairFile;
  ops: OperationRunner;
  logger: Logger;
  clock: () => Date;
  commit(action: Action, mutate: () => void): Promise<void>;
  audit(op: AuditOp, action: Action, remoteId: string): Promise<void>;
  statFields(name: string, md5: string): Promise<LocalFields>;
}

function planOf(remote: RemoteEntry): ExportPlan {
  const native = need(remote.native, 'export settings');
  return {
    format: native.exportFormat,
    extension: native.exportFormat,
    mimeType: native.exportMime,
  };
}

/** Re-read right before an export; doubles as re-verification (changed/trashed → skip). */
async function reread(host: ExportHost, remote: RemoteEntry): Promise<DriveFile> {
  const current = await host.ops.exec(host.file.pair.account, 'idempotent', remote.id, (ctx) =>
    ctx.drive.getFile(remote.id, SYNC_EXPORT_FIELDS),
  );
  if (current.trashed || !remoteUnchangedSince(remote, current)) {
    throw new TargetChangedError(`${remote.key} changed in Drive since planning`);
  }
  return current;
}

/** Overwrites a tracked export at `abs` (re-stat guarded) with a fresh export of R. */
export async function exportOver(
  host: ExportHost,
  abs: string,
  expect: StatExpect,
  remote: RemoteEntry,
): Promise<{ md5: string; size: number }> {
  const current = await reread(host, remote);
  return host.ops.exec(host.file.pair.account, 'idempotent', remote.id, (ctx) =>
    downloadReplace(abs, () => openExport(ctx.drive, current, planOf(remote), host.logger), {
      expect,
      expectedMd5: null,
    }),
  );
}

/**
 * N5: renames the edited L to `<stem> (local edit …)<ext>` (` 2`, ` 3`… when taken) with the
 * exclusive `moveLocal` (link + EEXIST, re-stat guarded; never overwrites, never unlinks the
 * only copy); returns the kept key.
 */
async function moveLocalEditAside(host: ExportHost, action: Action): Promise<string> {
  const local = need(action.local, 'local');
  const root = host.file.pair.localDir;
  const from = absInside(root, local.name);
  const at = host.clock();
  const base = path.basename(from);
  for (let i = 0; i < MAX_LOCAL_EDIT_NAMES; i++) {
    const to = path.join(path.dirname(from), localEditName(base, at, i));
    try {
      await moveLocal(from, to, { inPlace: false, expect: statOf(local) });
    } catch (err) {
      if (err instanceof CollisionError) continue;
      throw err;
    }
    await syncDir(path.dirname(from));
    return path.relative(root, to).split(path.sep).join('/');
  }
  throw new CollisionError(path.join(path.dirname(from), localEditName(base, at, 0)));
}

/**
 * export-new (U3, U6, N4, N5, N6, O1): exclusive write of the export at the key. The export
 * stream (files.export / exportLinks response) is opened BEFORE a local edit is moved aside,
 * so a failed export (native-too-large, error after retries) leaves L where it is. Anything
 * that fails after the move is rethrown as LocalEditKeptError, so the outcome still names
 * the kept copy. A stream that breaks while writing is not retried; the next run plans again.
 */
export async function exportNew(host: ExportHost, action: Action): Promise<Partial<ActionOutcome>> {
  const remote = need(action.remote, 'remote');
  const current = await reread(host, remote);
  const abs = await prepareParent(host.file.pair.localDir, action.key);
  const source = await host.ops.exec(host.file.pair.account, 'idempotent', remote.id, (ctx) =>
    openExport(ctx.drive, current, planOf(remote), host.logger),
  );
  let kept: string | null = null;
  try {
    if (action.localEdit) kept = await moveLocalEditAside(host, action);
    const written: Written = await placeExclusive(
      path.dirname(abs),
      () => path.basename(abs),
      async () => source,
    );
    const local = await host.statFields(action.key, written.md5);
    await host.commit(action, () =>
      putRecord(host.file, makeRecord(action.key, local, fromEntry(remote))),
    );
  } catch (err) {
    source.destroy();
    if (kept !== null) throw new LocalEditKeptError(kept, err);
    throw err;
  }
  await host.audit('sync_download', action, remote.id);
  if (kept === null) return {};
  return {
    conflictCopy: kept,
    warning: 'native-local-edit-kept',
    message: `your local edit is kept as ${kept}`,
  };
}

/** export-replace (N4): the tracked export is replaced, only if unchanged since the scan. */
export async function exportReplace(
  host: ExportHost,
  action: Action,
): Promise<Partial<ActionOutcome>> {
  const local = need(action.local, 'local');
  const remote = need(action.remote, 'remote');
  const abs = absInside(host.file.pair.localDir, local.name);
  const written = await exportOver(host, abs, statOf(local), remote);
  const after = await host.statFields(local.name, written.md5);
  await host.commit(action, () =>
    putRecord(host.file, makeRecord(action.key, after, fromEntry(remote))),
  );
  await host.audit('sync_download', action, remote.id);
  return {};
}
