import { STORED_DIFF_CHARS, truncateDiff, type DiffResult } from './text-diff.js';
import type { SheetSnapshot } from './types.js';

/** 0 → A, 25 → Z, 26 → AA. */
export function columnName(index: number): string {
  let n = index + 1;
  let name = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    name = String.fromCharCode(65 + rem) + name;
    n = Math.floor((n - 1) / 26);
  }
  return name;
}

function quoted(title: string): string {
  return `'${title.replace(/'/g, "''")}'`;
}

/** Display form of a sheet title in an address (quoted only when needed). */
export function sheetRef(title: string): string {
  return /^[A-Za-z0-9_]+$/.test(title) ? title : quoted(title);
}

/** API range for a whole sheet (always quoted, so titles like "A1" stay unambiguous). */
export function rangeOf(title: string): string {
  return quoted(title);
}

function cellLines(before: SheetSnapshot, after: SheetSnapshot): string[] {
  const lines: string[] = [];
  const rows = Math.max(before.rows.length, after.rows.length);
  for (let r = 0; r < rows; r++) {
    const a = before.rows[r] ?? [];
    const b = after.rows[r] ?? [];
    const cols = Math.max(a.length, b.length);
    for (let c = 0; c < cols; c++) {
      const old = a[c] ?? '';
      const now = b[c] ?? '';
      if (old !== now) {
        lines.push(
          `${sheetRef(after.title)}!${columnName(c)}${r + 1}: ${JSON.stringify(old)} → ${JSON.stringify(now)}`,
        );
      }
    }
  }
  return lines;
}

/** Cell diff per sheet title, plus added/removed tabs (spec §6). */
export function sheetDiff(
  before: SheetSnapshot[],
  after: SheetSnapshot[],
  maxChars: number = STORED_DIFF_CHARS,
): DiffResult {
  const old = new Map(before.map((s) => [s.title, s]));
  const lines: string[] = [];
  for (const sheet of after) {
    const prev = old.get(sheet.title);
    if (prev === undefined) lines.push(`+ sheet ${JSON.stringify(sheet.title)}`);
    else lines.push(...cellLines(prev, sheet));
  }
  const titles = new Set(after.map((s) => s.title));
  for (const sheet of before) {
    if (!titles.has(sheet.title)) lines.push(`- sheet ${JSON.stringify(sheet.title)}`);
  }
  const cut = truncateDiff(
    lines.join('\n'),
    maxChars,
    (n) => `… ${n} more changed cells not shown`,
  );
  return { text: cut.text, changes: lines.length, truncated: cut.truncated };
}
