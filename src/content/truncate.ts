export const DEFAULT_MAX_CHARS = 50_000;

export interface TextSlice {
  content: string;
  /** Length of the full text in UTF-16 code units (JS string length). */
  totalChars: number;
  offset: number;
  truncated: boolean;
  nextOffset?: number;
}

const isHigh = (code: number): boolean => code >= 0xd800 && code <= 0xdbff;
const isLow = (code: number): boolean => code >= 0xdc00 && code <= 0xdfff;

/** Cut to at most `max` UTF-16 units (plus an ellipsis) without splitting a surrogate pair. */
export function clip(s: string, max: number): string {
  if (s.length <= max) return s;
  const end = isHigh(s.charCodeAt(max - 1)) ? max - 1 : max;
  return `${s.slice(0, end)}…`;
}

/** Slices `text` for paging without ever splitting a surrogate pair (e.g. emoji). */
export function sliceText(text: string, offset: number, maxChars: number): TextSlice {
  const total = text.length;
  let start = Math.min(Math.max(0, Math.trunc(Number.isFinite(offset) ? offset : 0)), total);
  if (
    start > 0 &&
    start < total &&
    isLow(text.charCodeAt(start)) &&
    isHigh(text.charCodeAt(start - 1))
  ) {
    start -= 1;
  }
  let end = Math.min(
    start + Math.max(1, Math.trunc(Number.isFinite(maxChars) ? maxChars : DEFAULT_MAX_CHARS)),
    total,
  );
  if (end < total && isHigh(text.charCodeAt(end - 1))) end -= 1;
  if (end === start && start < total) end = Math.min(start + 2, total); // always make progress
  const truncated = end < total;
  return {
    content: text.slice(start, end),
    totalChars: total,
    offset: start,
    truncated,
    ...(truncated ? { nextOffset: end } : {}),
  };
}
