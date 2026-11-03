const SECRET_KEY =
  /^(access_token|refresh_token|id_token|client_secret|code|code_verifier|authorization|token|refreshToken|accessToken)$/i;
const MAX_DEPTH = 8;

const SECRET_IN_TEXT =
  /\b(token|access_token|refresh_token|id_token|code|client_secret)=[^&\s"']+/gi;
const BARE_GOOGLE_TOKEN = /\b(ya29\.[\w.-]+|1\/\/[\w.-]+)/g;
const JSON_SECRET_PAIR =
  /"(access_token|refresh_token|id_token|client_secret|code)"\s*:\s*"[^"]*"/gi;
const BEARER = /\bBearer\s+[A-Za-z0-9._~+/=-]+/g;

/** Removes `token=…`-style query values and bearer tokens from free text (e.g. error messages). */
export function scrubText(text: string): string {
  return text
    .replace(JSON_SECRET_PAIR, '"$1":"[REDACTED]"')
    .replace(SECRET_IN_TEXT, '$1=[REDACTED]')
    .replace(BEARER, 'Bearer [REDACTED]')
    .replace(BARE_GOOGLE_TOKEN, '[REDACTED]');
}

/** Deep-copies `value`, replacing secret-looking keys with "[REDACTED]" and scrubbing strings. */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) return '[MAX_DEPTH]';
  if (typeof value === 'string') return scrubText(value);
  if (value instanceof Error) return { name: value.name, message: scrubText(value.message) };
  if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1));
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value)) {
      out[key] = SECRET_KEY.test(key) ? '[REDACTED]' : redact(inner, depth + 1);
    }
    return out;
  }
  return value;
}

export type LogLevel = 'info' | 'warn' | 'error';

export interface Logger {
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}

/** Logger that writes JSON lines to stderr (stdout is reserved for MCP). */
export function createLogger(
  write: (line: string) => void = (line) => {
    process.stderr.write(line);
  },
): Logger {
  const log = (level: LogLevel, msg: string, meta?: Record<string, unknown>): void => {
    const entry = {
      ts: new Date().toISOString(),
      level,
      msg: scrubText(msg),
      ...(meta ? { meta: redact(meta) } : {}),
    };
    write(`${JSON.stringify(entry)}\n`);
  };
  return {
    info: (msg, meta) => log('info', msg, meta),
    warn: (msg, meta) => log('warn', msg, meta),
    error: (msg, meta) => log('error', msg, meta),
  };
}

export const logger: Logger = createLogger();
