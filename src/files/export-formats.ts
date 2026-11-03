import { UnsupportedTypeError, ValidationError } from '../errors.js';

const G = 'application/vnd.google-apps.';

export const GOOGLE_MIME = {
  document: `${G}document`,
  spreadsheet: `${G}spreadsheet`,
  presentation: `${G}presentation`,
  drawing: `${G}drawing`,
  folder: `${G}folder`,
  shortcut: `${G}shortcut`,
} as const;

export const EXPORT_FORMATS = [
  'docx',
  'xlsx',
  'pptx',
  'pdf',
  'md',
  'txt',
  'odt',
  'ods',
  'odp',
  'html',
  'csv',
  'png',
  'svg',
  'jpg',
] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

const FORMAT_MIME: Record<ExportFormat, string> = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  pdf: 'application/pdf',
  md: 'text/markdown',
  txt: 'text/plain',
  odt: 'application/vnd.oasis.opendocument.text',
  ods: 'application/x-vnd.oasis.opendocument.spreadsheet',
  odp: 'application/vnd.oasis.opendocument.presentation',
  html: 'text/html',
  csv: 'text/csv',
  png: 'image/png',
  svg: 'image/svg+xml',
  jpg: 'image/jpeg',
};

interface ExportRule {
  label: string;
  defaultFormat: ExportFormat;
  allowed: readonly ExportFormat[];
}

const RULES: Record<string, ExportRule> = {
  [GOOGLE_MIME.document]: {
    label: 'Google Docs',
    defaultFormat: 'docx',
    allowed: ['docx', 'pdf', 'md', 'txt', 'odt', 'html'],
  },
  [GOOGLE_MIME.spreadsheet]: {
    label: 'Google Sheets',
    defaultFormat: 'xlsx',
    allowed: ['xlsx', 'pdf', 'csv', 'ods'],
  },
  [GOOGLE_MIME.presentation]: {
    label: 'Google Slides',
    defaultFormat: 'pptx',
    allowed: ['pptx', 'pdf', 'txt', 'odp'],
  },
  [GOOGLE_MIME.drawing]: {
    label: 'Google Drawings',
    defaultFormat: 'png',
    allowed: ['png', 'pdf', 'svg', 'jpg'],
  },
};

export interface ExportPlan {
  format: ExportFormat;
  extension: string;
  mimeType: string;
}

export function isGoogleNative(mimeType: string): boolean {
  return mimeType.startsWith(G);
}

/** Export plan for a Google-native file, or `null` for binary files (download as-is). */
export function resolveExport(sourceMimeType: string, requested?: ExportFormat): ExportPlan | null {
  if (!isGoogleNative(sourceMimeType)) {
    if (requested !== undefined) {
      throw new ValidationError(
        'exportFormat only applies to Google Docs, Sheets, Slides and Drawings; omit it for other files',
      );
    }
    return null;
  }
  const rule = RULES[sourceMimeType];
  if (!rule) throw new UnsupportedTypeError(sourceMimeType);
  const format = requested ?? rule.defaultFormat;
  if (!rule.allowed.includes(format)) {
    throw new ValidationError(
      `${rule.label} cannot be exported as "${format}". Allowed: ${rule.allowed.join(', ')}`,
    );
  }
  return { format, extension: format, mimeType: FORMAT_MIME[format] };
}
