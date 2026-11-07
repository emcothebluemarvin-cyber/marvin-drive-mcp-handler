import type { Modifier } from './types.js';

/** Max code points per line of third-party text (spec §8.4). */
export const MAX_LINE = 300;
const MAX_BLANK_RUN = 3;

/** C0 (except tab/LF), DEL, C1, and bidi marks/overrides/isolates. */
function stripped(cp: number): boolean {
  return (
    (cp < 0x20 && cp !== 0x09 && cp !== 0x0a) ||
    (cp >= 0x7f && cp <= 0x9f) ||
    cp === 0x200e ||
    cp === 0x200f ||
    (cp >= 0x202a && cp <= 0x202e) ||
    (cp >= 0x2066 && cp <= 0x2069)
  );
}

function cutLine(line: string): string {
  const points = [...line];
  return points.length <= MAX_LINE ? line : `${points.slice(0, MAX_LINE - 1).join('')}…`;
}

/** Third-party text made safe to show to Claude (spec §8.4). */
export function sanitizeText(text: string): string {
  const normalized = text.replace(/\r\n?/g, '\n');
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
  return sanitizeText(text.replace(/[\r\n\t]+/g, ' ')).trim();
}

export function sanitizeModifier(m: Modifier): Modifier {
  return {
    name: m.name === null ? null : sanitizeLine(m.name),
    email: m.email === null ? null : sanitizeLine(m.email),
    me: m.me,
  };
}
