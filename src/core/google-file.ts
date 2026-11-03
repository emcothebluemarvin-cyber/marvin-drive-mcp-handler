import type { DriveAdapter } from '../drive/drive-adapter.js';
import { API_LABEL, NotFoundError, ValidationError } from '../errors.js';
import { GOOGLE_MIME } from '../files/export-formats.js';

export type GoogleKind = 'docs' | 'sheets' | 'slides';

export interface ResolvedFile {
  id: string;
  name: string;
}

const KIND_MIME: Record<GoogleKind, string> = {
  docs: GOOGLE_MIME.document,
  sheets: GOOGLE_MIME.spreadsheet,
  slides: GOOGLE_MIME.presentation,
};

const MIME_KIND = new Map<string, GoogleKind>(
  (Object.entries(KIND_MIME) as Array<[GoogleKind, string]>).map(([kind, mime]) => [mime, kind]),
);

const PREFLIGHT_FIELDS = 'id, name, mimeType, shortcutDetails';

/** Content-tool pre-flight: resolves shortcuts and checks the file is the expected Google type. */
export async function resolveGoogleFile(
  drive: DriveAdapter,
  fileId: string,
  kind: GoogleKind,
): Promise<ResolvedFile> {
  let file = await drive.getFile(fileId, PREFLIGHT_FIELDS);
  if (file.mimeType === GOOGLE_MIME.shortcut) {
    const targetId = file.shortcutDetails?.targetId;
    if (!targetId) throw new NotFoundError(fileId);
    file = await drive.getFile(targetId, PREFLIGHT_FIELDS);
  }
  const name = file.name ?? fileId;
  if (file.mimeType !== KIND_MIME[kind]) {
    const actual = file.mimeType ? MIME_KIND.get(file.mimeType) : undefined;
    throw new ValidationError(
      actual
        ? `"${name}" is a Google ${API_LABEL[actual]} file; use the ${actual}_* tools.`
        : `"${name}" is not a Google ${API_LABEL[kind]} file (type: ${file.mimeType ?? 'unknown'}).`,
    );
  }
  return { id: file.id ?? fileId, name };
}
