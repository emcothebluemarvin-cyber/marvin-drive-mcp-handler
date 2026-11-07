import { diffLines } from 'diff';
import { MAX_LINE, cutLine } from './sanitize.js';

/** Stored diff limit and pushed diff limit (spec §6). */
export const STORED_DIFF_CHARS = 8000;
export const PUSHED_DIFF_CHARS = 2000;
/** jsdiff gives up beyond this edit length (protects the poller from huge rewrites). */
export const MAX_EDIT_LENGTH = 2000;

export interface DiffResult {
  text: string;
  /** Number of + / - (or changed cell) lines before truncation. */
  changes: number;
  truncated: boolean;
}

interface Row {
  op: '+' | '-' | ' ';
  text: string;
}

/** Not context (two leading spaces) and not the hunk separator. */
export function isChangeLine(line: string): boolean {
  return line !== '…' && !line.startsWith('  ');
}

/**
 * Cuts `text` at a line boundary so that it plus the tail line fits `maxChars`. Callers cap
 * every line first (`cutLine`), so one overlong line cannot hide everything after it.
 */
export function truncateDiff(
  text: string,
  maxChars: number,
  tail: (remaining: number) => string,
): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false };
  const all = text.split('\n');
  const reserve = tail(all.length).length + 1;
  const kept: string[] = [];
  let used = 0;
  let i = 0;
  for (; i < all.length; i++) {
    const line = all[i] ?? '';
    const cost = line.length + (kept.length > 0 ? 1 : 0);
    if (used + cost > maxChars - reserve) break;
    kept.push(line);
    used += cost;
  }
  const remaining = all.slice(i).filter(isChangeLine).length;
  // Only context was cut: nothing worth stating is hidden.
  if (remaining === 0) {
    while (kept[kept.length - 1] === '…') kept.pop();
    return { text: kept.join('\n'), truncated: false };
  }
  kept.push(tail(remaining));
  return { text: kept.join('\n'), truncated: true };
}

/** LF line ends, no BOM, final newline (Docs text/plain exports use CRLF and a BOM). */
function normalize(text: string): string {
  const t = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  return t === '' || t.endsWith('\n') ? t : `${t}\n`;
}

function splitValue(value: string): string[] {
  const parts = value.split('\n');
  if (parts[parts.length - 1] === '') parts.pop();
  return parts;
}

/** Line diff with one line of context; null when the edit is too large to compute. */
export function textDiff(
  before: string,
  after: string,
  maxChars: number = STORED_DIFF_CHARS,
): DiffResult | null {
  const parts = diffLines(normalize(before), normalize(after), {
    maxEditLength: MAX_EDIT_LENGTH,
  });
  if (parts === undefined) return null;
  const rows: Row[] = [];
  for (const part of parts) {
    const op: Row['op'] = part.added ? '+' : part.removed ? '-' : ' ';
    for (const line of splitValue(part.value)) {
      rows.push({ op, text: cutLine(line, MAX_LINE - 2) });
    }
  }
  const keep = rows.map(() => false);
  rows.forEach((row, i) => {
    if (row.op === ' ') return;
    keep[i] = true;
    if (i > 0) keep[i - 1] = true;
    if (i + 1 < rows.length) keep[i + 1] = true;
  });
  const out: string[] = [];
  let skipped = false;
  rows.forEach((row, i) => {
    if (!keep[i]) {
      skipped = true;
      return;
    }
    if (skipped && out.length > 0) out.push('…');
    skipped = false;
    out.push(`${row.op} ${row.text}`);
  });
  const changes = rows.filter((r) => r.op !== ' ').length;
  const cut = truncateDiff(out.join('\n'), maxChars, (n) => `… ${n} more changed lines not shown`);
  return { text: cut.text, changes, truncated: cut.truncated };
}
