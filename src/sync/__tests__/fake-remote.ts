import { OperationRunner } from '../../core/operation.js';
import type { DriveAdapter } from '../../drive/drive-adapter.js';
import { createAudit, createRunner, noSleep, silentLogger } from '../../files/__tests__/fakes.js';
import type { Logger } from '../../logger.js';
import { GoogleSyncRemote } from '../remote/google-remote.js';
import { DEFAULT_GOOGLE_EXPORT, type GoogleExportPrefs } from '../types.js';

/** A GoogleSyncRemote for account `emco` over a fake Drive adapter (no sleeps between retries). */
export function googleRemoteOver(
  drive: DriveAdapter,
  opts: { prefs?: GoogleExportPrefs; logger?: Logger } = {},
): GoogleSyncRemote {
  const ops = new OperationRunner({
    runner: createRunner(drive),
    audit: createAudit(),
    retry: noSleep,
    logger: opts.logger ?? silentLogger(),
  });
  return new GoogleSyncRemote(ops, 'emco', opts.prefs ?? DEFAULT_GOOGLE_EXPORT);
}
