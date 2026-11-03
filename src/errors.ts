export abstract class AppError extends Error {
  abstract readonly code: string;

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

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

  constructor(options?: ErrorOptions) {
    super('Google Drive rate limit exceeded; try again shortly', options);
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

export class DriveApiError extends AppError {
  readonly code = 'DRIVE_API_ERROR';

  constructor(
    readonly status: number | undefined,
    detail: string,
    options?: ErrorOptions,
  ) {
    super(`Drive API error${status === undefined ? '' : ` (${status})`}: ${detail}`, options);
  }
}

/** True when `err` is an object whose `code` property equals `code` (Node fs errors). */
export function hasErrorCode(err: unknown, code: string): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === code;
}
