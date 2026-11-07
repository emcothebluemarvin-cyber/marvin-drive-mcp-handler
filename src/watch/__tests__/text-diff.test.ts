import { describe, expect, it } from 'vitest';
import { STORED_DIFF_CHARS, isChangeLine, textDiff, truncateDiff } from '../text-diff.js';

const lines = (...xs: string[]): string => `${xs.join('\n')}\n`;

describe('textDiff', () => {
  it('shows a replaced line with one line of context', () => {
    const d = textDiff(lines('a', 'b', 'c', 'd', 'e'), lines('a', 'b', 'X', 'd', 'e'));
    expect(d).toEqual({ text: '  b\n- c\n+ X\n  d', changes: 2, truncated: false });
  });

  it('separates distant hunks with an ellipsis', () => {
    const before = lines('1', '2', '3', '4', '5', '6', '7', '8');
    const after = lines('1', 'two', '3', '4', '5', '6', 'seven', '8');
    expect(textDiff(before, after)?.text).toBe('  1\n- 2\n+ two\n  3\n…\n  6\n- 7\n+ seven\n  8');
  });

  it('treats a missing final newline as the same line', () => {
    expect(textDiff('a\nb', 'a\nb\n')).toEqual({ text: '', changes: 0, truncated: false });
  });

  it('ignores CRLF vs LF and a leading BOM', () => {
    expect(textDiff('\uFEFFa\r\nb\r\n', 'a\nb\n')).toEqual({
      text: '',
      changes: 0,
      truncated: false,
    });
  });

  it('diffs against empty text (added file)', () => {
    expect(textDiff('', 'x\ny')).toEqual({ text: '+ x\n+ y', changes: 2, truncated: false });
  });

  it('truncates to the limit and says how many changes are hidden', () => {
    const before = lines(...Array.from({ length: 200 }, (_, i) => `line ${i}`));
    const after = lines(...Array.from({ length: 200 }, (_, i) => `LINE ${i}`));
    const d = textDiff(before, after, 500);
    expect(d?.truncated).toBe(true);
    expect(d?.text.length).toBeLessThanOrEqual(500);
    expect(d?.text).toMatch(/… \d+ more changed lines not shown$/);
    expect(d?.changes).toBe(400);
  });

  it('returns null when the texts differ too much to compare', () => {
    const before = lines(...Array.from({ length: 1500 }, (_, i) => `a${i}`));
    const after = lines(...Array.from({ length: 1500 }, (_, i) => `b${i}`));
    expect(textDiff(before, after)).toBeNull();
  });

  it('uses the stored limit by default', () => {
    expect(STORED_DIFF_CHARS).toBe(8000);
  });
});

describe('truncateDiff', () => {
  it('keeps short text unchanged', () => {
    expect(truncateDiff('+ a', 100, (n) => `${n} more`)).toEqual({ text: '+ a', truncated: false });
  });

  it('counts hidden change lines only', () => {
    const text = ['+ aaaa', '  ctx', '- bbbb', '…', '+ cccc'].join('\n');
    const out = truncateDiff(text, 20, (n) => `+${n}`);
    expect(out).toEqual({ text: '+ aaaa\n  ctx\n+2', truncated: true });
  });

  it('classifies change lines', () => {
    expect(isChangeLine('+ x')).toBe(true);
    expect(isChangeLine('Sheet1!A1: "1" → "2"')).toBe(true);
    expect(isChangeLine('  ctx')).toBe(false);
    expect(isChangeLine('…')).toBe(false);
  });
});
