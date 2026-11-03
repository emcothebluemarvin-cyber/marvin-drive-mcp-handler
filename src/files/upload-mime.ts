import path from 'node:path';
import { lookup } from 'mime-types';
import { ValidationError } from '../errors.js';
import { GOOGLE_MIME } from './export-formats.js';

const CONVERSIONS: Record<string, string> = {
  '.doc': GOOGLE_MIME.document,
  '.docx': GOOGLE_MIME.document,
  '.odt': GOOGLE_MIME.document,
  '.rtf': GOOGLE_MIME.document,
  '.txt': GOOGLE_MIME.document,
  '.html': GOOGLE_MIME.document,
  '.htm': GOOGLE_MIME.document,
  '.md': GOOGLE_MIME.document,
  '.xls': GOOGLE_MIME.spreadsheet,
  '.xlsx': GOOGLE_MIME.spreadsheet,
  '.ods': GOOGLE_MIME.spreadsheet,
  '.csv': GOOGLE_MIME.spreadsheet,
  '.tsv': GOOGLE_MIME.spreadsheet,
  '.ppt': GOOGLE_MIME.presentation,
  '.pptx': GOOGLE_MIME.presentation,
  '.odp': GOOGLE_MIME.presentation,
};

export function uploadMimeType(localPath: string): string {
  return lookup(localPath) || 'application/octet-stream';
}

/** Google-native target type for `convertToGoogle: true` uploads. */
export function googleTargetMime(localPath: string): string {
  const ext = path.extname(localPath).toLowerCase();
  const target = CONVERSIONS[ext];
  if (!target) {
    throw new ValidationError(
      `convertToGoogle is not supported for ${ext ? `"${ext}"` : 'files without an extension'}. Supported: ${Object.keys(CONVERSIONS).join(', ')}`,
    );
  }
  return target;
}
