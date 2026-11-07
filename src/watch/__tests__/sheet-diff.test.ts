import { describe, expect, it } from 'vitest';
import { columnName, rangeOf, sheetDiff, sheetRef } from '../sheet-diff.js';

describe('sheet helpers', () => {
  it('names columns like Sheets', () => {
    expect([0, 1, 25, 26, 27, 51, 52, 701, 702].map(columnName)).toEqual([
      'A',
      'B',
      'Z',
      'AA',
      'AB',
      'AZ',
      'BA',
      'ZZ',
      'AAA',
    ]);
  });

  it('quotes titles only when needed for display, always for API ranges', () => {
    expect(sheetRef('Sheet1')).toBe('Sheet1');
    expect(sheetRef("Q4 plan's")).toBe("'Q4 plan''s'");
    expect(rangeOf('Sheet1')).toBe("'Sheet1'");
    expect(rangeOf("it's")).toBe("'it''s'");
  });
});

describe('sheetDiff', () => {
  it('lists changed cells with A1 addresses', () => {
    const d = sheetDiff(
      [{ title: 'Sheet1', rows: [['a', '120'], ['b']] }],
      [
        {
          title: 'Sheet1',
          rows: [
            ['a', '135'],
            ['b', 'new'],
          ],
        },
      ],
    );
    expect(d).toEqual({
      text: 'Sheet1!B1: "120" → "135"\nSheet1!B2: "" → "new"',
      changes: 2,
      truncated: false,
    });
  });

  it('reports added and removed tabs', () => {
    const d = sheetDiff([{ title: 'Old', rows: [['x']] }], [{ title: 'New tab', rows: [['y']] }]);
    expect(d.text).toBe('+ sheet "New tab"\n- sheet "Old"');
    expect(d.changes).toBe(2);
  });

  it('is empty when nothing changed', () => {
    const s = [{ title: 'S', rows: [['1', '2']] }];
    expect(sheetDiff(s, s)).toEqual({ text: '', changes: 0, truncated: false });
  });

  it('truncates and counts hidden cells', () => {
    const before = [{ title: 'S', rows: Array.from({ length: 100 }, () => ['0']) }];
    const after = [{ title: 'S', rows: Array.from({ length: 100 }, () => ['1']) }];
    const d = sheetDiff(before, after, 300);
    expect(d.truncated).toBe(true);
    expect(d.text.length).toBeLessThanOrEqual(300);
    expect(d.text).toMatch(/… \d+ more changed cells not shown$/);
    expect(d.changes).toBe(100);
  });
});

describe('sheetDiff review fixes', () => {
  it('caps an overlong cell line so later cells stay visible', () => {
    const long = 'x'.repeat(9000);
    const d = sheetDiff(
      [{ title: 'S', rows: [[long], ['1'], ['2']] }],
      [{ title: 'S', rows: [[`${long}y`], ['10'], ['20']] }],
    );
    expect(d.text).toContain('S!A2: "1" → "10"');
    expect(d.text).toContain('S!A3: "2" → "20"');
    expect(d.changes).toBe(3);
    for (const l of d.text.split('\n')) expect([...l].length).toBeLessThanOrEqual(300);
  });
});
