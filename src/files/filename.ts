export const MAX_NAME_BYTES = 255;

// Path separators, NUL and other C0/DEL control characters.
// eslint-disable-next-line no-control-regex
const UNSAFE_CHARS = /[/\\\u0000-\u001f\u007f]/g;

/** Makes an untrusted Drive name safe to use as a single local path segment. */
export function sanitizeFileName(name: string, fileId: string): string {
  const cleaned = name
    .replace(UNSAFE_CHARS, '_')
    .replace(/^[\s.]+/, '')
    .trim();
  return cleaned === '' ? `file-${fileId}` : cleaned;
}

export function ensureExtension(name: string, extension: string | undefined): string {
  if (!extension) return name;
  const dotted = `.${extension}`;
  return name.toLowerCase().endsWith(dotted.toLowerCase()) ? name : `${name}${dotted}`;
}

const MAX_EXT_LENGTH = 16;

function splitExtension(name: string): { base: string; ext: string } {
  const dot = name.lastIndexOf('.');
  // A very long "extension" is treated as part of the base so truncation can shorten it.
  return dot > 0 && name.length - dot <= MAX_EXT_LENGTH
    ? { base: name.slice(0, dot), ext: name.slice(dot) }
    : { base: name, ext: '' };
}

/** `name` for index 0, otherwise `base (index).ext`; truncates the base to fit 255 bytes. */
export function candidateName(name: string, index: number): string {
  const { base, ext } = splitExtension(name);
  const suffix = index === 0 ? '' : ` (${index})`;
  const chars = Array.from(base);
  while (chars.length > 1 && Buffer.byteLength(chars.join('') + suffix + ext) > MAX_NAME_BYTES) {
    chars.pop();
  }
  return chars.join('') + suffix + ext;
}
