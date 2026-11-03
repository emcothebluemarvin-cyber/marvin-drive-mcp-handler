import { resolveGoogleFile, type GoogleKind, type ResolvedFile } from '../core/google-file.js';
import { OperationRunner, type OperationDeps } from '../core/operation.js';
import type { DriveContext } from '../drive/client-factory.js';
import type { OperationKind } from '../files/drive-errors.js';

/** How an edit was protected against concurrent changes (audit detail). */
export type Guard = 'caller' | 'implicit' | false;

export interface AccountInput {
  account?: string;
}

export interface ContentFileRef extends AccountInput {
  fileId: string;
}

/** First key of each raw API request, deduped — audit detail for *_batch_update. */
export function requestKinds(requests: ReadonlyArray<Record<string, unknown>>): string[] {
  return [...new Set(requests.map((r) => Object.keys(r)[0] ?? 'unknown'))];
}

/** Base for Docs/Sheets/Slides services: Drive pre-flight, then API calls with api/name-aware errors. */
export abstract class ContentService {
  protected readonly ops: OperationRunner;
  protected abstract readonly api: GoogleKind;

  constructor(deps: OperationDeps) {
    this.ops = new OperationRunner(deps);
  }

  protected resolve(account: string | undefined, fileId: string): Promise<ResolvedFile> {
    return this.ops.exec(account, 'idempotent', fileId, (ctx) =>
      resolveGoogleFile(ctx.drive, fileId, this.api),
    );
  }

  protected run<T>(
    account: string | undefined,
    file: ResolvedFile,
    kind: OperationKind,
    fn: (ctx: DriveContext) => Promise<T>,
  ): Promise<T> {
    return this.ops.exec(account, kind, file.id, (ctx) => fn(ctx), {
      api: this.api,
      name: file.name,
    });
  }
}
