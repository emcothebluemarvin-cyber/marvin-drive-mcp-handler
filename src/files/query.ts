import { ValidationError } from '../errors.js';

/** Escapes a value for use inside single quotes in a Drive `q` string. */
export function escapeQueryValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

export function buildListQuery(folderId: string, includeTrashed: boolean): string {
  const base = `'${escapeQueryValue(folderId)}' in parents`;
  return includeTrashed ? base : `${base} and trashed = false`;
}

export interface SearchCriteria {
  query?: string;
  mimeType?: string;
  modifiedAfter?: string;
  rawQuery?: string;
}

const TRASHED_WORD = /\btrashed\b/i;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}(T[\d:.]+(Z|[+-]\d{2}:?\d{2})?)?$/;

export function buildSearchQuery(criteria: SearchCriteria): string {
  const clauses: string[] = [];
  const text = criteria.query?.trim();
  if (text) {
    const v = escapeQueryValue(text);
    clauses.push(`(name contains '${v}' or fullText contains '${v}')`);
  }
  const mimeType = criteria.mimeType?.trim();
  if (mimeType) clauses.push(`mimeType = '${escapeQueryValue(mimeType)}'`);
  if (criteria.modifiedAfter !== undefined) {
    const time = ISO_DATE.test(criteria.modifiedAfter) ? Date.parse(criteria.modifiedAfter) : NaN;
    if (Number.isNaN(time)) {
      throw new ValidationError(
        `modifiedAfter must be an ISO 8601 date (got "${criteria.modifiedAfter}")`,
      );
    }
    clauses.push(`modifiedTime > '${new Date(time).toISOString()}'`);
  }
  const raw = criteria.rawQuery?.trim();
  if (raw) clauses.push(`(${raw})`);

  if (clauses.length === 0) {
    throw new ValidationError('Provide at least one of: query, mimeType, modifiedAfter, rawQuery');
  }
  if (!raw || !TRASHED_WORD.test(raw)) clauses.push('trashed = false');
  return clauses.join(' and ');
}
