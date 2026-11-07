import type { Modifier } from './types.js';

/** Max code points per line of third-party text (spec §8.4). */
export const MAX_LINE = 300;
const MAX_BLANK_RUN = 3;

/** C0 (except tab/LF), DEL, C1, bidi marks/overrides/isolates, zero-width chars and BOMs. */
function stripped(cp: number): boolean {
  return (
    (cp < 0x20 && cp !== 0x09 && cp !== 0x0a) ||
    (cp >= 0x7f && cp <= 0x9f) ||
    cp === 0x061c ||
    (cp >= 0x200b && cp <= 0x200f) ||
    cp === 0xfeff ||
    (cp >= 0x202a && cp <= 0x202e) ||
    (cp >= 0x2066 && cp <= 0x2069)
  );
}

/** Cuts a line to `max` code points (never splits a surrogate pair), ending in `…`. */
export function cutLine(line: string, max: number = MAX_LINE): string {
  if (line.length <= max) return line;
  const points = [...line];
  return points.length <= max ? line : `${points.slice(0, max - 1).join('')}…`;
}

/** Third-party text made safe to show to Claude (spec §8.4). */
export function sanitizeText(text: string): string {
  const normalized = text.replace(/\r\n?|[\u2028\u2029]/g, '\n');
  const kept = [...normalized]
    .filter((ch) => !stripped(ch.codePointAt(0) ?? 0))
    .join('')
    .replace(/</g, '‹')
    .replace(/>/g, '›');
  const out: string[] = [];
  let blanks = 0;
  for (const line of kept.split('\n')) {
    if (line.trim() === '') {
      blanks += 1;
      if (blanks > MAX_BLANK_RUN) continue;
    } else {
      blanks = 0;
    }
    out.push(cutLine(line));
  }
  return out.join('\n');
}

/** One trimmed line (names, authors). */
export function sanitizeLine(text: string): string {
  return sanitizeText(text.replace(/[\r\n\t\u2028\u2029]+/g, ' ')).trim();
}

export function sanitizeModifier(m: Modifier): Modifier {
  return {
    name: m.name === null ? null : sanitizeLine(m.name),
    email: m.email === null ? null : sanitizeLine(m.email),
    me: m.me,
  };
}
