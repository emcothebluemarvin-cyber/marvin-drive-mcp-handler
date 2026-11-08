export abstract class AppError extends Error {
  abstract readonly code: string;

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

export type GoogleApi = 'drive' | 'docs' | 'sheets' | 'slides';

export const API_LABEL: Record<GoogleApi, string> = {
  drive: 'Drive',
  docs: 'Docs',
  sheets: 'Sheets',
  slides: 'Slides',
};

export class ValidationError extends AppError {
  readonly code = 'VALIDATION_ERROR';
}

export class ConfigError extends AppError {
  readonly code = 'CONFIG_ERROR';
}

export class AuthFlowError extends AppError {
  readonly code = 'AUTH_FLOW_ERROR';
}

export class AccountNotFoundError extends AppError {
  readonly code = 'ACCOUNT_NOT_FOUND';
}

export class ReauthRequiredError extends AppError {
  readonly code = 'REAUTH_REQUIRED';

  constructor(
    readonly alias: string,
    options?: ErrorOptions,
  ) {
    super(`Session for "${alias}" expired. Run: marvin-drive auth login ${alias}`, options);
  }
}

export class NotFoundError extends AppError {
  readonly code = 'NOT_FOUND';

  constructor(
    readonly fileId: string,
    options?: ErrorOptions,
  ) {
    super(`File not found: ${fileId}`, options);
  }
}

export class PermissionDeniedError extends AppError {
  readonly code = 'PERMISSION_DENIED';

  constructor(target: string, options?: ErrorOptions) {
    super(`No permission for ${target}`, options);
  }
}

export class RateLimitError extends AppError {
  readonly code = 'RATE_LIMITED';

  constructor(options?: ErrorOptions & { api?: GoogleApi }) {
    super(
      `Google ${API_LABEL[options?.api ?? 'drive']} rate limit exceeded; try again shortly`,
      options,
    );
  }
}

export class ExportTooLargeError extends AppError {
  readonly code = 'EXPORT_TOO_LARGE';

  constructor(webViewLink: string | null, options?: ErrorOptions & { format?: string }) {
    const hint = options?.format === 'pdf' ? '' : '; try exportFormat "pdf"';
    const tail = webViewLink ? `${hint ? ' or' : ';'} open ${webViewLink}` : '';
    super(`Export exceeds Drive's 10 MB limit${hint}${tail}`, options);
  }
}

export class QuotaExceededError extends AppError {
  readonly code = 'QUOTA_EXCEEDED';

  constructor(alias: string, options?: ErrorOptions) {
    super(`Drive storage is full for "${alias}"`, options);
  }
}

export class AbusiveFileError extends AppError {
  readonly code = 'ABUSIVE_FILE';

  constructor(fileId: string, options?: ErrorOptions) {
    super(`Google flagged ${fileId} as abusive; download blocked`, options);
  }
}

export class UnsupportedTypeError extends AppError {
  readonly code = 'UNSUPPORTED_TYPE';

  constructor(mimeType: string, options?: ErrorOptions) {
    super(`Cannot download files of type ${mimeType}`, options);
  }
}

export class ConflictError extends AppError {
  readonly code = 'CONFLICT';

  constructor(fileLabel: string, rereadTool: string, options?: ErrorOptions) {
    super(
      `${fileLabel} changed since it was read (or the revisionId expired); re-read it with ${rereadTool} and retry with the new revisionId.`,
      options,
    );
  }
}

export class ApiDisabledError extends AppError {
  readonly code = 'API_DISABLED';

  constructor(api: GoogleApi, options?: ErrorOptions) {
    super(
      `The Google ${API_LABEL[api]} API is not enabled for this OAuth project. Enable it in Cloud Console → APIs & Services, then retry.`,
      options,
    );
  }
}

export class DriveApiError extends AppError {
  readonly code = 'DRIVE_API_ERROR';

  constructor(
    readonly status: number | undefined,
    detail: string,
    options?: ErrorOptions & { api?: GoogleApi },
  ) {
    const api = options?.api ?? 'drive';
    const label = api === 'drive' ? 'Drive API error' : `Google ${API_LABEL[api]} API error`;
    super(`${label}${status === undefined ? '' : ` (${status})`}: ${detail}`, options);
  }
}

export class ProviderNotSupportedError extends AppError {
  readonly code = 'PROVIDER_NOT_SUPPORTED';

  constructor(
    readonly account: string,
    options?: ErrorOptions,
  ) {
    super(
      `"${account}" is a Microsoft account; this feature is not available on OneDrive yet.`,
      options,
    );
  }
}

export class NameConflictError extends AppError {
  readonly code = 'NAME_CONFLICT';

  constructor(name: string, options?: ErrorOptions) {
    super(`An item named "${name}" already exists there; choose another name.`, options);
  }
}

export class TargetChangedError extends AppError {
  readonly code = 'TARGET_CHANGED';

  constructor(name: string, options?: ErrorOptions) {
    super(
      `"${name}" changed on OneDrive after it was checked, so the upload stopped (a lost final response can look the same). Check the file, then try again if needed.`,
      options,
    );
  }
}

export class GraphThrottledError extends AppError {
  readonly code = 'GRAPH_THROTTLED';

  constructor(options?: ErrorOptions) {
    super('OneDrive is limiting requests right now; try again later.', options);
  }
}

export class CopyStillRunningError extends AppError {
  readonly code = 'COPY_STILL_RUNNING';

  constructor(name: string, options?: ErrorOptions) {
    super(
      `The copy of "${name}" is still running on OneDrive and continues on the server; check the target folder later.`,
      options,
    );
  }
}

export class FileLockedError extends AppError {
  readonly code = 'FILE_LOCKED';

  constructor(name: string, options?: ErrorOptions) {
    super(`File is locked, probably open in Office: ${name}`, options);
  }
}

export class OneDriveFullError extends AppError {
  readonly code = 'ONEDRIVE_FULL';

  constructor(alias: string, options?: ErrorOptions) {
    super(`OneDrive storage is full for "${alias}"`, options);
  }
}

export class GraphApiError extends AppError {
  readonly code = 'GRAPH_API_ERROR';

  constructor(
    readonly status: number | undefined,
    options?: ErrorOptions,
  ) {
    super(
      `OneDrive request failed${status === undefined ? '' : ` (${status})`}; try again.`,
      options,
    );
  }
}

/** True when `err` is an object whose `code` property equals `code` (Node fs errors). */
export function hasErrorCode(err: unknown, code: string): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === code;
}
