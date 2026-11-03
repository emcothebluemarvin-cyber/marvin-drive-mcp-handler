import { describe, expect, it } from 'vitest';
import { MAX_NAME_BYTES, candidateName, ensureExtension, sanitizeFileName } from '../filename.js';

describe('sanitizeFileName', () => {
  it('neutralizes separators, control characters and leading dots', () => {
    expect(sanitizeFileName('../../.zshrc', 'id1')).toBe('_.._.zshrc');
    expect(sanitizeFileName('a/b\\c', 'id1')).toBe('a_b_c');
    expect(sanitizeFileName('bad\u0000name\n', 'id1')).toBe('bad_name_');
    expect(sanitizeFileName('  .hidden  ', 'id1')).toBe('hidden');
  });

  it('falls back to file-<id> for empty, "." and ".."', () => {
    expect(sanitizeFileName('', 'id1')).toBe('file-id1');
    expect(sanitizeFileName('.', 'id1')).toBe('file-id1');
    expect(sanitizeFileName('..', 'id1')).toBe('file-id1');
    expect(sanitizeFileName('   ', 'id1')).toBe('file-id1');
    expect(sanitizeFileName('. .', 'id1')).toBe('file-id1');
    expect(sanitizeFileName('.. ..', 'id1')).toBe('file-id1');
    expect(sanitizeFileName('  . .. ', 'id1')).toBe('file-id1');
  });
});

describe('ensureExtension', () => {
  it('appends the export extension unless already present', () => {
    expect(ensureExtension('Plan', 'docx')).toBe('Plan.docx');
    expect(ensureExtension('Plan.DOCX', 'docx')).toBe('Plan.DOCX');
    expect(ensureExtension('report.pdf', undefined)).toBe('report.pdf');
  });
});

describe('candidateName', () => {
  it('adds collision suffixes before the extension', () => {
    expect(candidateName('report.pdf', 0)).toBe('report.pdf');
    expect(candidateName('report.pdf', 2)).toBe('report (2).pdf');
    expect(candidateName('README', 1)).toBe('README (1)');
  });

  it('keeps the final name within 255 bytes, preserving extension and suffix', () => {
    const long = `${'é'.repeat(200)}.docx`; // 400 bytes of base
    const name = candidateName(long, 3);
    expect(Buffer.byteLength(name)).toBeLessThanOrEqual(MAX_NAME_BYTES);
    expect(name.endsWith(' (3).docx')).toBe(true);
  });

  it('also truncates names whose text after the last dot is very long', () => {
    const name = candidateName(`a.${'x'.repeat(300)}`, 1);
    expect(Buffer.byteLength(name)).toBeLessThanOrEqual(MAX_NAME_BYTES);
    expect(name.endsWith(' (1)')).toBe(true);
  });
});
