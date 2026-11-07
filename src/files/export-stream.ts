import type { Readable } from 'node:stream';
import type { DriveAdapter, DriveFile } from '../drive/drive-adapter.js';
import { ExportTooLargeError } from '../errors.js';
import type { Logger } from '../logger.js';
import { reasonOf } from './drive-errors.js';
import type { ExportPlan } from './export-formats.js';
import { retryKind } from './retry.js';

/**
 * Opens an export of a Google-native file: files.export, and over Drive's 10 MB export
 * limit the file's `exportLinks` URL (`file` must carry `exportLinks`/`webViewLink`).
 * When both fail → ExportTooLargeError. Retryable fallback errors are rethrown so the
 * caller's retry loop runs again. Used by FileService.download and the sync executor.
 */
export async function openExport(
  drive: DriveAdapter,
  file: DriveFile,
  plan: ExportPlan,
  log: Logger,
): Promise<Readable> {
  const fileId = file.id ?? '';
  try {
    return await drive.exportMedia(fileId, plan.mimeType);
  } catch (err) {
    if (reasonOf(err) !== 'exportSizeLimitExceeded') throw err;
    const link = file.exportLinks?.[plan.mimeType];
    if (link) {
      try {
        return await drive.fetchExportLink(link);
      } catch (fallbackErr) {
        if (retryKind(fallbackErr) !== null) throw fallbackErr;
        log.warn('exportLinks fallback failed', { fileId, error: fallbackErr });
      }
    }
    throw new ExportTooLargeError(file.webViewLink ?? null, { cause: err, format: plan.format });
  }
}
