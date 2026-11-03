import { describe, expect, it } from 'vitest';
import { ValidationError } from '../../errors.js';
import { buildListQuery, buildSearchQuery, escapeQueryValue } from '../query.js';

describe('escapeQueryValue', () => {
  it('escapes backslashes first, then single quotes', () => {
    expect(escapeQueryValue("O'Brien")).toBe("O\\'Brien");
    expect(escapeQueryValue('a\\b')).toBe('a\\\\b');
    expect(escapeQueryValue("\\'")).toBe("\\\\\\'");
  });
});

describe('buildListQuery', () => {
  it('lists non-trashed children by default', () => {
    expect(buildListQuery('root', false)).toBe("'root' in parents and trashed = false");
  });
  it('includes trashed items on request and escapes the id', () => {
    expect(buildListQuery("x'y", true)).toBe("'x\\'y' in parents");
  });
});

describe('buildSearchQuery', () => {
  it('builds name/fullText search and excludes trash', () => {
    expect(buildSearchQuery({ query: 'budget' })).toBe(
      "(name contains 'budget' or fullText contains 'budget') and trashed = false",
    );
  });

  it('ANDs all clauses and normalizes modifiedAfter', () => {
    expect(
      buildSearchQuery({
        query: "it's",
        mimeType: 'application/pdf',
        modifiedAfter: '2026-01-01',
        rawQuery: "'abc' in parents",
      }),
    ).toBe(
      "(name contains 'it\\'s' or fullText contains 'it\\'s') and mimeType = 'application/pdf' and modifiedTime > '2026-01-01T00:00:00.000Z' and ('abc' in parents) and trashed = false",
    );
  });

  it('leaves trash handling to rawQuery when it mentions trashed', () => {
    expect(buildSearchQuery({ rawQuery: 'trashed = true' })).toBe('(trashed = true)');
    expect(buildSearchQuery({ rawQuery: 'Trashed=true' })).toBe('(Trashed=true)');
  });

  it('requires at least one criterion and a valid date', () => {
    expect(() => buildSearchQuery({})).toThrow(ValidationError);
    expect(() => buildSearchQuery({ query: '  ' })).toThrow(ValidationError);
    expect(() => buildSearchQuery({ modifiedAfter: 'yesterday' })).toThrow(/ISO 8601/);
    expect(() => buildSearchQuery({ modifiedAfter: '2026/01/01' })).toThrow(/ISO 8601/);
    expect(buildSearchQuery({ modifiedAfter: '2026-01-01T10:00:00Z' })).toContain(
      "modifiedTime > '2026-01-01T10:00:00.000Z'",
    );
  });
});
