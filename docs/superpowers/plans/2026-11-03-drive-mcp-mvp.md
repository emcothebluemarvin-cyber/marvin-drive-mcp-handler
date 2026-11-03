# Marvin Drive MCP Handler — MVP Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a local TypeScript CLI + stdio MCP server (`marvin-drive`) that lets Claude Code manage files in multiple Google Drive accounts through the user's own OAuth Desktop client.

**Architecture:** Layered. `config` (paths, client secret, account registry) → `auth` (Keychain token store, loopback+PKCE login, AuthService) → `drive` (thin googleapis adapter + per-account client factory with stale-token recovery) → `files` (FileService: all business logic, pure helpers for queries/exports/filenames/errors/retry) → entry points `mcp` (12 tools) and `cli` (commander). Every unit is tested against fakes; only the googleapis adapter is covered by the opt-in E2E test.

**Tech Stack:** Node ≥ 22.12 (dev on 24), TypeScript ~6.0 strict (ESM, NodeNext), `@modelcontextprotocol/sdk` 1.32, `googleapis` 189 (re-exports google-auth-library as `Auth`), `zod` 4, `@napi-rs/keyring` 2, `mime-types` 3, `commander` 15, `open` 11; Vitest 5, ESLint 10 + typescript-eslint 8, Prettier 3.

**Spec:** `docs/superpowers/specs/2026-11-03-drive-mcp-mvp-design.md` (read it first).

**Global rules for every task**
- TDD: write the failing test, run it, implement, run it, commit. Never proceed with failing tests.
- All relative imports end in `.js` (NodeNext ESM), even though source files are `.ts`.
- Never write to stdout from library code — stdout belongs to the MCP protocol. Use `logger` (stderr).
- No `any`. Use `unknown` + narrowing.
- Before every commit run `npx prettier --write <files you changed>` so `npm run format:check` stays green; code in this plan is not guaranteed to be Prettier-formatted.
- Commit messages: Conventional Commits, ending with the trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Repo-local git identity is already set (`emcothebluemarvin <emcothebluemarvin@gmail.com>`). Do not change it.
- Do not push; the human pushes after review.

---

## File structure

```
package.json, tsconfig.json, tsconfig.build.json, eslint.config.js,
.prettierrc.json, .prettierignore, vitest.config.ts, vitest.e2e.config.ts
src/
  version.ts                       VERSION constant
  errors.ts                        AppError hierarchy + hasErrorCode()
  logger.ts                        stderr JSON logger with secret redaction
  config/
    paths.ts                       resolvePaths(env)
    client-secret.ts               loadClientSecret(file)
    account-registry.ts            AccountRegistry (accounts.json), defaultAlias()
  auth/
    token-store.ts                 TokenStore interface + InMemoryTokenStore
    keychain-token-store.ts        KeychainTokenStore (@napi-rs/keyring)
    oauth-errors.ts                isInvalidGrant()
    login-flow.ts                  runLoginFlow(): loopback + PKCE + id_token verify
    auth-service.ts                AuthService: add/relogin/remove/default/authorize/status
  drive/
    drive-adapter.ts               DriveAdapter interface + createDriveAdapter(googleapis)
    client-factory.ts              DriveRunner interface + DriveClientFactory
  files/
    query.ts                       escapeQueryValue, buildListQuery, buildSearchQuery
    export-formats.ts              EXPORT_FORMATS, resolveExport()
    filename.ts                    sanitizeFileName, ensureExtension, candidateName
    destination.ts                 resolveDestination, assertInside, writeUnique
    drive-errors.ts                statusOf, reasonOf, isRateLimit, mapDriveError
    retry.ts                       withRetry()
    upload-mime.ts                 uploadMimeType, googleTargetMime
    file-service.ts                FileService (all 11 file operations)
  audit/
    audit-log.ts                   AuditSink interface + FileAuditLog (JSONL)
  mcp/
    server.ts                      createMcpServer(): 12 tools
  app.ts                           buildApp(): composition root
  cli/
    main.ts                        commander CLI entry (bin)
  **/__tests__/*.test.ts           unit/integration tests next to modules
tests/e2e/drive.e2e.test.ts        opt-in live Drive test
README.md, docs/CHANGELOG.md, docs/FEATURES.md
```

---

## Chunk 1: Scaffold, errors, logger, config

### Task 1: Project scaffold

**Files:**
- Create: `package.json`, `tsconfig.json`, `tsconfig.build.json`, `eslint.config.js`, `.prettierrc.json`, `.prettierignore`, `vitest.config.ts`, `vitest.e2e.config.ts`, `src/version.ts`

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "marvin-drive-mcp-handler",
  "version": "0.1.0",
  "private": true,
  "description": "Multi-account Google Drive MCP server and CLI for Claude Code",
  "type": "module",
  "bin": {
    "marvin-drive": "dist/cli/main.js"
  },
  "engines": {
    "node": ">=22.12"
  },
  "scripts": {
    "build": "tsc -p tsconfig.build.json",
    "typecheck": "tsc --noEmit",
    "lint": "eslint .",
    "format": "prettier --write .",
    "format:check": "prettier --check .",
    "test": "vitest run",
    "test:watch": "vitest",
    "test:e2e": "vitest run --config vitest.e2e.config.ts",
    "check": "npm run typecheck && npm run lint && npm run format:check && npm test"
  }
}
```

- [ ] **Step 2: Install dependencies**

Run:
```bash
npm install @modelcontextprotocol/sdk@^1.32.2 googleapis@^189.0.0 zod@^4.6.7 @napi-rs/keyring@^2.1.2 mime-types@^3.0.2 commander@^15.0.0 open@^11.0.4
npm install -D typescript@~6.0.3 @types/node@^24 @types/mime-types@^3.0.1 vitest@^5.1.0 eslint@^10.14.0 @eslint/js@^10.0.1 typescript-eslint@^8.72.1 prettier@^3.9.10 eslint-config-prettier@^10.1.8
```
Expected: both commands finish without `ERESOLVE` errors. (typescript-eslint 8.72 supports TS `<6.1.0`; do **not** install TypeScript 7.)

- [ ] **Step 3: Create `tsconfig.json`** (type-checks everything, emits nothing)

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "lib": ["ES2023"],
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "types": ["node"],
    "rootDir": ".",
    "outDir": "dist",
    "noEmit": true,
    "strict": true,
    "strictNullChecks": true,
    "strictFunctionTypes": true,
    "strictBindCallApply": true,
    "strictPropertyInitialization": true,
    "noImplicitAny": true,
    "noImplicitReturns": true,
    "noImplicitThis": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noFallthroughCasesInSwitch": true,
    "forceConsistentCasingInFileNames": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true
  },
  "include": ["src", "tests", "vitest.config.ts", "vitest.e2e.config.ts"]
}
```

- [ ] **Step 4: Create `tsconfig.build.json`**

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "noEmit": false,
    "rootDir": "src",
    "outDir": "dist"
  },
  "include": ["src"],
  "exclude": ["src/**/__tests__/**"]
}
```

- [ ] **Step 5: Create `eslint.config.js`**

```js
import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import prettier from 'eslint-config-prettier';
import tseslint from 'typescript-eslint';

export default defineConfig(
  { ignores: ['dist/', 'coverage/', 'node_modules/'] },
  js.configs.recommended,
  tseslint.configs.recommended,
  prettier,
  {
    rules: {
      '@typescript-eslint/explicit-function-return-type': 'warn',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      'no-console': 'warn',
    },
  },
  {
    files: ['**/__tests__/**', 'tests/**'],
    rules: { '@typescript-eslint/explicit-function-return-type': 'off' },
  },
);
```

- [ ] **Step 6: Create Prettier files**

`.prettierrc.json`:
```json
{
  "singleQuote": true,
  "printWidth": 100,
  "trailingComma": "all"
}
```

`.prettierignore`:
```
dist
coverage
node_modules
docs
package-lock.json
```

- [ ] **Step 7: Create Vitest configs**

`vitest.config.ts`:
```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/__tests__/**/*.test.ts'],
    environment: 'node',
  },
});
```

`vitest.e2e.config.ts`:
```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/e2e/**/*.e2e.test.ts'],
    environment: 'node',
    testTimeout: 120_000,
  },
});
```

- [ ] **Step 8: Create `src/version.ts`**

```ts
export const VERSION = '0.1.0';
```

- [ ] **Step 9: Verify tooling runs**

Run: `npm run typecheck && npm run lint && npx vitest run --passWithNoTests`
Expected: all three exit 0 (no tests found is OK at this point).

- [ ] **Step 10: Commit**

```bash
git add package.json package-lock.json tsconfig.json tsconfig.build.json eslint.config.js .prettierrc.json .prettierignore vitest.config.ts vitest.e2e.config.ts src/version.ts
git commit -m "chore: scaffold TypeScript project with lint, format and test tooling

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Error hierarchy

**Files:**
- Create: `src/errors.ts`
- Test: `src/__tests__/errors.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import {
  AppError,
  DriveApiError,
  ExportTooLargeError,
  NotFoundError,
  ReauthRequiredError,
  ValidationError,
  hasErrorCode,
} from '../errors.js';

describe('errors', () => {
  it('carries code, name and message', () => {
    const err = new ReauthRequiredError('emco');
    expect(err).toBeInstanceOf(AppError);
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe('REAUTH_REQUIRED');
    expect(err.name).toBe('ReauthRequiredError');
    expect(err.alias).toBe('emco');
    expect(err.message).toBe('Session for "emco" expired. Run: marvin-drive auth login emco');
  });

  it('formats file-specific messages', () => {
    expect(new NotFoundError('abc').message).toBe('File not found: abc');
    expect(new ExportTooLargeError('https://x/y').message).toContain('open https://x/y');
    expect(new ExportTooLargeError(null).message).not.toContain('open');
    expect(new DriveApiError(500, 'boom').message).toBe('Drive API error (500): boom');
    expect(new DriveApiError(undefined, 'boom').message).toBe('Drive API error: boom');
  });

  it('keeps the cause', () => {
    const cause = new Error('root');
    expect(new ValidationError('bad', { cause }).cause).toBe(cause);
  });

  it('detects Node error codes', () => {
    expect(hasErrorCode(Object.assign(new Error('x'), { code: 'ENOENT' }), 'ENOENT')).toBe(true);
    expect(hasErrorCode(new Error('x'), 'ENOENT')).toBe(false);
    expect(hasErrorCode('ENOENT', 'ENOENT')).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/__tests__/errors.test.ts`
Expected: FAIL — cannot resolve `../errors.js`.

- [ ] **Step 3: Implement `src/errors.ts`**

```ts
export abstract class AppError extends Error {
  abstract readonly code: string;

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

export class ValidationError extends AppError {
  readonly code = 'VALIDATION_ERROR';
}

export class ConfigError extends AppError {
  readonly code = 'CONFIG_ERROR';
}

export class AuthFlowError extends AppError {
  readonly code = 'AUTH_FLOW_ERROR';
}

export class AccountNotFoundError extends AppError {
  readonly code = 'ACCOUNT_NOT_FOUND';
}

export class ReauthRequiredError extends AppError {
  readonly code = 'REAUTH_REQUIRED';

  constructor(
    readonly alias: string,
    options?: ErrorOptions,
  ) {
    super(`Session for "${alias}" expired. Run: marvin-drive auth login ${alias}`, options);
  }
}

export class NotFoundError extends AppError {
  readonly code = 'NOT_FOUND';

  constructor(
    readonly fileId: string,
    options?: ErrorOptions,
  ) {
    super(`File not found: ${fileId}`, options);
  }
}

export class PermissionDeniedError extends AppError {
  readonly code = 'PERMISSION_DENIED';

  constructor(target: string, options?: ErrorOptions) {
    super(`No permission for ${target}`, options);
  }
}

export class RateLimitError extends AppError {
  readonly code = 'RATE_LIMITED';

  constructor(options?: ErrorOptions) {
    super('Google Drive rate limit exceeded; try again shortly', options);
  }
}

export class ExportTooLargeError extends AppError {
  readonly code = 'EXPORT_TOO_LARGE';

  constructor(webViewLink: string | null, options?: ErrorOptions) {
    const tail = webViewLink ? ` or open ${webViewLink}` : '';
    super(`Export exceeds Drive's 10 MB limit; try exportFormat "pdf"${tail}`, options);
  }
}

export class QuotaExceededError extends AppError {
  readonly code = 'QUOTA_EXCEEDED';

  constructor(alias: string, options?: ErrorOptions) {
    super(`Drive storage is full for "${alias}"`, options);
  }
}

export class AbusiveFileError extends AppError {
  readonly code = 'ABUSIVE_FILE';

  constructor(fileId: string, options?: ErrorOptions) {
    super(`Google flagged ${fileId} as abusive; download blocked`, options);
  }
}

export class UnsupportedTypeError extends AppError {
  readonly code = 'UNSUPPORTED_TYPE';

  constructor(mimeType: string, options?: ErrorOptions) {
    super(`Cannot download files of type ${mimeType}`, options);
  }
}

export class DriveApiError extends AppError {
  readonly code = 'DRIVE_API_ERROR';

  constructor(
    readonly status: number | undefined,
    detail: string,
    options?: ErrorOptions,
  ) {
    super(`Drive API error${status === undefined ? '' : ` (${status})`}: ${detail}`, options);
  }
}

/** True when `err` is an object whose `code` property equals `code` (Node fs errors). */
export function hasErrorCode(err: unknown, code: string): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === code;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/__tests__/errors.test.ts && npm run typecheck`
Expected: PASS, typecheck exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/errors.ts src/__tests__/errors.test.ts
git commit -m "feat(core): add application error hierarchy

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Logger with secret redaction

**Files:**
- Create: `src/logger.ts`
- Test: `src/__tests__/logger.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import { createLogger, redact } from '../logger.js';

describe('redact', () => {
  it('masks secret keys at any depth', () => {
    const out = redact({
      refresh_token: 'rt',
      nested: { access_token: 'at', Authorization: 'Bearer x', keep: 1 },
      list: [{ client_secret: 's' }],
    });
    expect(out).toEqual({
      refresh_token: '[REDACTED]',
      nested: { access_token: '[REDACTED]', Authorization: '[REDACTED]', keep: 1 },
      list: [{ client_secret: '[REDACTED]' }],
    });
  });

  it('reduces errors to name and message', () => {
    expect(redact(new TypeError('bad'))).toEqual({ name: 'TypeError', message: 'bad' });
  });

  it('scrubs tokens embedded in strings and error messages', () => {
    const err = new Error('POST https://oauth2.googleapis.com/revoke?token=1//abc.def failed');
    expect(redact(err)).toEqual({
      name: 'Error',
      message: 'POST https://oauth2.googleapis.com/revoke?token=[REDACTED] failed',
    });
    expect(redact({ note: 'Authorization: Bearer ya29.xyz' })).toEqual({
      note: 'Authorization: Bearer [REDACTED]',
    });
  });
});

describe('createLogger', () => {
  it('writes one redacted JSON line per call', () => {
    const lines: string[] = [];
    const log = createLogger((line) => lines.push(line));
    log.warn('hello', { code: 'secret-code', alias: 'emco' });
    expect(lines).toHaveLength(1);
    expect(lines[0]?.endsWith('\n')).toBe(true);
    const entry = JSON.parse(lines[0] ?? '') as Record<string, unknown>;
    expect(entry).toMatchObject({
      level: 'warn',
      msg: 'hello',
      meta: { code: '[REDACTED]', alias: 'emco' },
    });
    expect(typeof entry.ts).toBe('string');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/__tests__/logger.test.ts`
Expected: FAIL — cannot resolve `../logger.js`.

- [ ] **Step 3: Implement `src/logger.ts`**

```ts
const SECRET_KEY =
  /^(access_token|refresh_token|id_token|client_secret|code|code_verifier|authorization|token|refreshToken|accessToken)$/i;
const MAX_DEPTH = 8;

const SECRET_IN_TEXT = /\b(token|access_token|refresh_token|id_token|code|client_secret)=[^&\s"']+/gi;
const BEARER = /\bBearer\s+[A-Za-z0-9._~+/=-]+/g;

/** Removes `token=…`-style query values and bearer tokens from free text (e.g. error messages). */
export function scrubText(text: string): string {
  return text.replace(SECRET_IN_TEXT, '$1=[REDACTED]').replace(BEARER, 'Bearer [REDACTED]');
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
      msg,
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/__tests__/logger.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/logger.ts src/__tests__/logger.test.ts
git commit -m "feat(core): add stderr JSON logger with secret redaction

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Paths and client secret loading

**Files:**
- Create: `src/config/paths.ts`, `src/config/client-secret.ts`
- Test: `src/config/__tests__/paths.test.ts`, `src/config/__tests__/client-secret.test.ts`

- [ ] **Step 1: Write the failing tests**

`src/config/__tests__/paths.test.ts`:
```ts
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolvePaths } from '../paths.js';

describe('resolvePaths', () => {
  it('defaults to ~/.config/google-handler and ~/Downloads/marvin-drive', () => {
    const p = resolvePaths({});
    const dir = path.join(os.homedir(), '.config', 'google-handler');
    expect(p).toEqual({
      configDir: dir,
      clientSecret: path.join(dir, 'client_secret.json'),
      accounts: path.join(dir, 'accounts.json'),
      audit: path.join(dir, 'audit.jsonl'),
      downloadsDir: path.join(os.homedir(), 'Downloads', 'marvin-drive'),
    });
  });

  it('honours MARVIN_DRIVE_CONFIG_DIR', () => {
    const p = resolvePaths({ MARVIN_DRIVE_CONFIG_DIR: '/tmp/x' });
    expect(p.configDir).toBe('/tmp/x');
    expect(p.accounts).toBe('/tmp/x/accounts.json');
  });
});
```

`src/config/__tests__/client-secret.test.ts`:
```ts
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { ConfigError } from '../../errors.js';
import { loadClientSecret } from '../client-secret.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'marvin-secret-'));
});

describe('loadClientSecret', () => {
  it('reads the Google installed-client format', async () => {
    const file = path.join(dir, 'client_secret.json');
    await writeFile(
      file,
      JSON.stringify({
        installed: { client_id: '123-abc.apps.googleusercontent.com', client_secret: 'GOCSPX-x' },
      }),
    );
    await expect(loadClientSecret(file)).resolves.toEqual({
      clientId: '123-abc.apps.googleusercontent.com',
      clientSecret: 'GOCSPX-x',
    });
  });

  it('names the expected path when the file is missing', async () => {
    const file = path.join(dir, 'missing.json');
    await expect(loadClientSecret(file)).rejects.toThrow(ConfigError);
    await expect(loadClientSecret(file)).rejects.toThrow(file);
  });

  it('rejects invalid JSON and wrong shapes', async () => {
    const bad = path.join(dir, 'bad.json');
    await writeFile(bad, 'not json');
    await expect(loadClientSecret(bad)).rejects.toThrow(/not valid JSON/);
    await writeFile(bad, JSON.stringify({ web: {} }));
    await expect(loadClientSecret(bad)).rejects.toThrow(/Desktop client format/);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/config`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement `src/config/paths.ts`**

```ts
import os from 'node:os';
import path from 'node:path';

export interface Paths {
  configDir: string;
  clientSecret: string;
  accounts: string;
  audit: string;
  downloadsDir: string;
}

export function resolvePaths(env: NodeJS.ProcessEnv = process.env): Paths {
  const configDir =
    env.MARVIN_DRIVE_CONFIG_DIR ?? path.join(os.homedir(), '.config', 'google-handler');
  return {
    configDir,
    clientSecret: path.join(configDir, 'client_secret.json'),
    accounts: path.join(configDir, 'accounts.json'),
    audit: path.join(configDir, 'audit.jsonl'),
    downloadsDir: path.join(os.homedir(), 'Downloads', 'marvin-drive'),
  };
}
```

- [ ] **Step 4: Implement `src/config/client-secret.ts`**

```ts
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { ConfigError } from '../errors.js';

const clientSecretSchema = z.object({
  installed: z.object({
    client_id: z.string().endsWith('.apps.googleusercontent.com'),
    client_secret: z.string().min(1),
  }),
});

export interface ClientCredentials {
  clientId: string;
  clientSecret: string;
}

export async function loadClientSecret(file: string): Promise<ClientCredentials> {
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch (err) {
    throw new ConfigError(
      `OAuth client file not found at ${file}. Save the Google Cloud "Desktop app" client JSON there (chmod 600).`,
      { cause: err },
    );
  }

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    throw new ConfigError(`${file} is not valid JSON (expected Google "installed" client format).`, {
      cause: err,
    });
  }

  const parsed = clientSecretSchema.safeParse(json);
  if (!parsed.success) {
    throw new ConfigError(
      `${file} must contain {"installed": {"client_id": "...", "client_secret": "..."}} (Google Desktop client format).`,
    );
  }
  return {
    clientId: parsed.data.installed.client_id,
    clientSecret: parsed.data.installed.client_secret,
  };
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/config && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/config
git commit -m "feat(config): resolve config paths and load OAuth client secret

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Account registry (`accounts.json`)

**Files:**
- Create: `src/config/account-registry.ts`
- Test: `src/config/__tests__/account-registry.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { mkdtemp, stat, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { AccountNotFoundError, ConfigError, ValidationError } from '../../errors.js';
import { AccountRegistry, defaultAlias } from '../account-registry.js';

let file: string;
let registry: AccountRegistry;
const NOW = new Date('2026-11-03T10:00:00.000Z');

beforeEach(async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'marvin-reg-'));
  file = path.join(dir, 'nested', 'accounts.json');
  registry = new AccountRegistry(file);
});

describe('defaultAlias', () => {
  it('derives a valid alias from the email local part', () => {
    expect(defaultAlias('emcothebluemarvin@gmail.com')).toBe('emcothebluemarvin');
    expect(defaultAlias('John.Doe+x@ex.com')).toBe('john-doe-x');
    expect(defaultAlias('___@ex.com')).toBe('account');
    expect(defaultAlias(`${'a'.repeat(40)}@ex.com`)).toHaveLength(32);
  });
});

describe('AccountRegistry', () => {
  it('starts empty when the file does not exist', async () => {
    await expect(registry.read()).resolves.toEqual({ default: null, accounts: [] });
  });

  it('adds accounts, makes the first one default, writes 0600', async () => {
    await registry.add({ alias: 'emco', email: 'Emco@Example.com' }, NOW);
    await registry.add({ alias: 'work', email: 'work@example.com' }, NOW);
    const data = await registry.read();
    expect(data.default).toBe('emco');
    expect(data.accounts).toEqual([
      { alias: 'emco', email: 'emco@example.com', addedAt: NOW.toISOString() },
      { alias: 'work', email: 'work@example.com', addedAt: NOW.toISOString() },
    ]);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
  });

  it('rejects invalid aliases, duplicate emails and duplicate aliases', async () => {
    await registry.add({ alias: 'emco', email: 'emco@example.com' }, NOW);
    await expect(registry.add({ alias: 'Bad Alias', email: 'x@example.com' })).rejects.toThrow(
      ValidationError,
    );
    await expect(registry.add({ alias: 'other', email: 'EMCO@example.com' })).rejects.toThrow(
      /already registered as "emco"/,
    );
    await expect(registry.add({ alias: 'emco', email: 'new@example.com' })).rejects.toThrow(
      /Alias "emco" is already used/,
    );
  });

  it('resolves by alias, email, default, or single account', async () => {
    await expect(registry.resolve()).rejects.toThrow(/No accounts registered/);
    await registry.add({ alias: 'emco', email: 'emco@example.com' }, NOW);
    await expect(registry.resolve()).resolves.toMatchObject({ alias: 'emco' });
    await registry.add({ alias: 'work', email: 'work@example.com' }, NOW);
    await expect(registry.resolve('work')).resolves.toMatchObject({ alias: 'work' });
    await expect(registry.resolve('WORK@example.com')).resolves.toMatchObject({ alias: 'work' });
    await expect(registry.resolve('nope')).rejects.toThrow(AccountNotFoundError);
    await expect(registry.resolve('nope')).rejects.toThrow(/emco \(emco@example.com\)/);
  });

  it('errors when several accounts exist and no default is set', async () => {
    const twoFile = path.join(path.dirname(path.dirname(file)), 'two.json');
    await writeFile(
      twoFile,
      JSON.stringify({
        default: null,
        accounts: [
          { alias: 'a', email: 'a@x.com', addedAt: NOW.toISOString() },
          { alias: 'b', email: 'b@x.com', addedAt: NOW.toISOString() },
        ],
      }),
    );
    await expect(new AccountRegistry(twoFile).resolve()).rejects.toThrow(/No default account/);
  });

  it('removes accounts and reassigns the default', async () => {
    await registry.add({ alias: 'emco', email: 'emco@example.com' }, NOW);
    await registry.add({ alias: 'work', email: 'work@example.com' }, NOW);
    const removed = await registry.remove('emco');
    expect(removed.alias).toBe('emco');
    expect((await registry.read()).default).toBe('work');
    await registry.remove('work@example.com');
    expect(await registry.read()).toEqual({ default: null, accounts: [] });
  });

  it('sets the default account', async () => {
    await registry.add({ alias: 'emco', email: 'emco@example.com' }, NOW);
    await registry.add({ alias: 'work', email: 'work@example.com' }, NOW);
    await registry.setDefault('work');
    expect((await registry.read()).default).toBe('work');
  });

  it('re-reads the file when another process changes it (mtime)', async () => {
    await registry.add({ alias: 'emco', email: 'emco@example.com' }, NOW);
    await registry.read(); // populate cache
    const data = {
      default: 'work',
      accounts: [
        { alias: 'emco', email: 'emco@example.com', addedAt: NOW.toISOString() },
        { alias: 'work', email: 'work@example.com', addedAt: NOW.toISOString() },
      ],
    };
    await writeFile(file, JSON.stringify(data));
    const later = new Date(Date.now() + 5_000);
    await utimes(file, later, later);
    expect((await registry.read()).default).toBe('work');
  });

  it('reports a corrupted file as ConfigError', async () => {
    await registry.add({ alias: 'emco', email: 'emco@example.com' }, NOW);
    await writeFile(file, '{"default": 5}');
    const later = new Date(Date.now() + 10_000);
    await utimes(file, later, later);
    await expect(registry.read()).rejects.toThrow(ConfigError);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/config/__tests__/account-registry.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/config/account-registry.ts`**

```ts
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { AccountNotFoundError, ConfigError, ValidationError, hasErrorCode } from '../errors.js';

export const ALIAS_PATTERN = /^[a-z0-9-]{1,32}$/;

export interface AccountRecord {
  alias: string;
  email: string;
  addedAt: string;
}

export interface RegistryData {
  default: string | null;
  accounts: AccountRecord[];
}

const registrySchema = z.object({
  default: z.string().nullable(),
  accounts: z.array(
    z.object({
      alias: z.string().regex(ALIAS_PATTERN),
      email: z.string().includes('@'),
      addedAt: z.string(),
    }),
  ),
});

/** Alias derived from the email's local part, e.g. "john.doe@x" → "john-doe". */
export function defaultAlias(email: string): string {
  const local = (email.split('@')[0] ?? '').toLowerCase();
  const alias = local
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 32)
    .replace(/-$/, '');
  return alias === '' ? 'account' : alias;
}

function describeAccounts(accounts: AccountRecord[]): string {
  return accounts.length === 0
    ? 'none — run: marvin-drive auth add'
    : accounts.map((a) => `${a.alias} (${a.email})`).join(', ');
}

export class AccountRegistry {
  private cache: { mtimeMs: number; data: RegistryData } | null = null;

  constructor(private readonly file: string) {}

  async read(): Promise<RegistryData> {
    let mtimeMs: number;
    try {
      mtimeMs = (await stat(this.file)).mtimeMs;
    } catch (err) {
      if (hasErrorCode(err, 'ENOENT')) {
        this.cache = null;
        return { default: null, accounts: [] };
      }
      throw err;
    }
    if (this.cache && this.cache.mtimeMs === mtimeMs) return structuredClone(this.cache.data);

    let json: unknown;
    try {
      json = JSON.parse(await readFile(this.file, 'utf8'));
    } catch (err) {
      throw new ConfigError(`${this.file} is not valid JSON; fix or delete it.`, { cause: err });
    }
    const parsed = registrySchema.safeParse(json);
    if (!parsed.success) {
      throw new ConfigError(`${this.file} is corrupted; fix or delete it and re-add accounts.`);
    }
    this.cache = { mtimeMs, data: parsed.data };
    return structuredClone(parsed.data);
  }

  async find(ref: string): Promise<AccountRecord | undefined> {
    const needle = ref.trim().toLowerCase();
    const { accounts } = await this.read();
    return accounts.find((a) => a.alias === needle || a.email === needle);
  }

  /** Account by alias/email; without `ref`: the default, or the only account. */
  async resolve(ref?: string): Promise<AccountRecord> {
    const data = await this.read();
    if (ref !== undefined) {
      const found = await this.find(ref);
      if (!found) {
        throw new AccountNotFoundError(
          `Unknown account "${ref}". Registered: ${describeAccounts(data.accounts)}`,
        );
      }
      return found;
    }
    const byDefault = data.accounts.find((a) => a.alias === data.default);
    if (byDefault) return byDefault;
    if (data.accounts.length === 1 && data.accounts[0]) return data.accounts[0];
    if (data.accounts.length === 0) {
      throw new AccountNotFoundError('No accounts registered. Run: marvin-drive auth add');
    }
    throw new AccountNotFoundError(
      `No default account. Pass "account" or run: marvin-drive auth default <alias>. Registered: ${describeAccounts(data.accounts)}`,
    );
  }

  async add(input: { alias: string; email: string }, now: Date = new Date()): Promise<AccountRecord> {
    const alias = input.alias.trim().toLowerCase();
    const email = input.email.trim().toLowerCase();
    if (!ALIAS_PATTERN.test(alias)) {
      throw new ValidationError(`Alias must match ${ALIAS_PATTERN.source} (got "${input.alias}")`);
    }
    const data = await this.read();
    const sameEmail = data.accounts.find((a) => a.email === email);
    if (sameEmail) {
      throw new ValidationError(
        `${email} is already registered as "${sameEmail.alias}"; use: marvin-drive auth login ${sameEmail.alias}`,
      );
    }
    const sameAlias = data.accounts.find((a) => a.alias === alias);
    if (sameAlias) {
      throw new ValidationError(
        `Alias "${alias}" is already used by ${sameAlias.email}; pass --alias <name>`,
      );
    }
    const record: AccountRecord = { alias, email, addedAt: now.toISOString() };
    data.accounts.push(record);
    data.default ??= alias;
    await this.write(data);
    return record;
  }

  async remove(ref: string): Promise<AccountRecord> {
    const record = await this.resolve(ref);
    const data = await this.read();
    data.accounts = data.accounts.filter((a) => a.alias !== record.alias);
    if (data.default === record.alias) data.default = data.accounts[0]?.alias ?? null;
    await this.write(data);
    return record;
  }

  async setDefault(ref: string): Promise<AccountRecord> {
    const record = await this.resolve(ref);
    const data = await this.read();
    data.default = record.alias;
    await this.write(data);
    return record;
  }

  private async write(data: RegistryData): Promise<void> {
    await mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${process.pid}.tmp`;
    await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
    await rename(tmp, this.file);
    this.cache = null;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/config && npm run typecheck && npm run lint`
Expected: PASS, no lint errors.

- [ ] **Step 5: Commit**

```bash
git add src/config
git commit -m "feat(config): add account registry with alias resolution and mtime cache

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Chunk 2: Authentication

### Task 6: Token stores

**Files:**
- Create: `src/auth/token-store.ts`, `src/auth/keychain-token-store.ts`
- Test: `src/auth/__tests__/token-store.test.ts`

`@napi-rs/keyring` 2.x exposes a synchronous `Entry(service, username)` with `setPassword(pw): void`, `getPassword(): string | null`, `deletePassword(): boolean` (verified in its `index.d.ts`). On macOS it stores generic passwords in the login Keychain.

- [ ] **Step 1: Write the failing test**

```ts
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { KeychainTokenStore } from '../keychain-token-store.js';
import { InMemoryTokenStore, type TokenStore } from '../token-store.js';

async function exercise(store: TokenStore, email: string): Promise<void> {
  await expect(store.get(email)).resolves.toBeNull();
  await store.set(email, 'rt-1');
  await expect(store.get(email)).resolves.toBe('rt-1');
  await store.set(email, 'rt-2');
  await expect(store.get(email)).resolves.toBe('rt-2');
  await store.delete(email);
  await expect(store.get(email)).resolves.toBeNull();
  await expect(store.delete(email)).resolves.toBeUndefined(); // idempotent
}

describe('InMemoryTokenStore', () => {
  it('stores, replaces and deletes tokens', async () => {
    await exercise(new InMemoryTokenStore(), 'a@example.com');
  });
});

describe.runIf(process.env.MARVIN_KEYCHAIN_TEST === '1')('KeychainTokenStore (real Keychain)', () => {
  it('stores, replaces and deletes tokens', async () => {
    const store = new KeychainTokenStore('marvin-drive-test');
    await exercise(store, `test-${randomUUID()}@example.com`);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/auth/__tests__/token-store.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement `src/auth/token-store.ts`**

```ts
/** Persists one refresh token per account email. */
export interface TokenStore {
  get(email: string): Promise<string | null>;
  set(email: string, refreshToken: string): Promise<void>;
  delete(email: string): Promise<void>;
}

export class InMemoryTokenStore implements TokenStore {
  private readonly tokens = new Map<string, string>();

  async get(email: string): Promise<string | null> {
    return this.tokens.get(email) ?? null;
  }

  async set(email: string, refreshToken: string): Promise<void> {
    this.tokens.set(email, refreshToken);
  }

  async delete(email: string): Promise<void> {
    this.tokens.delete(email);
  }
}
```

- [ ] **Step 4: Implement `src/auth/keychain-token-store.ts`**

```ts
import { Entry } from '@napi-rs/keyring';
import type { TokenStore } from './token-store.js';

export const KEYCHAIN_SERVICE = 'marvin-drive';

/** macOS Keychain (service "marvin-drive", account = email). */
export class KeychainTokenStore implements TokenStore {
  constructor(private readonly service: string = KEYCHAIN_SERVICE) {}

  async get(email: string): Promise<string | null> {
    return new Entry(this.service, email).getPassword() ?? null;
  }

  async set(email: string, refreshToken: string): Promise<void> {
    new Entry(this.service, email).setPassword(refreshToken);
  }

  async delete(email: string): Promise<void> {
    // deletePassword() returns false when nothing was stored; that is fine.
    new Entry(this.service, email).deletePassword();
  }
}
```

- [ ] **Step 5: Run tests**

Run: `npx vitest run src/auth/__tests__/token-store.test.ts && npm run typecheck`
Expected: PASS (Keychain suite skipped).

Then run the real Keychain suite once (macOS may show a Keychain access prompt — click "Always Allow"):

Run: `MARVIN_KEYCHAIN_TEST=1 npx vitest run src/auth/__tests__/token-store.test.ts`
Expected: PASS, 2 tests. If `getPassword()` throws on a missing entry instead of returning `null` on this platform, wrap the call: catch errors whose message matches `/no (matching )?entry/i` and return `null`; rethrow anything else. Re-run.

- [ ] **Step 6: Commit**

```bash
git add src/auth/token-store.ts src/auth/keychain-token-store.ts src/auth/__tests__/token-store.test.ts
git commit -m "feat(auth): add token store interface with in-memory and Keychain implementations

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: `invalid_grant` detection

**Files:**
- Create: `src/auth/oauth-errors.ts`
- Test: `src/auth/__tests__/oauth-errors.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import { isInvalidGrant } from '../oauth-errors.js';

describe('isInvalidGrant', () => {
  it('detects gaxios-style token endpoint errors', () => {
    const err = Object.assign(new Error('Request failed'), {
      response: { data: { error: 'invalid_grant', error_description: 'Token has been expired' } },
    });
    expect(isInvalidGrant(err)).toBe(true);
  });

  it('detects the message form', () => {
    expect(isInvalidGrant(new Error('invalid_grant'))).toBe(true);
  });

  it('ignores other errors', () => {
    expect(isInvalidGrant(new Error('ECONNRESET'))).toBe(false);
    expect(isInvalidGrant(Object.assign(new Error('x'), { response: { data: 'oops' } }))).toBe(false);
    expect(isInvalidGrant(null)).toBe(false);
    expect(isInvalidGrant('invalid_grant')).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/auth/__tests__/oauth-errors.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/auth/oauth-errors.ts`**

```ts
/** True when Google rejected the refresh token (expired, revoked, or Testing-mode 7-day limit). */
export function isInvalidGrant(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const { message, response } = err as { message?: unknown; response?: { data?: unknown } };
  const data = response?.data;
  if (typeof data === 'object' && data !== null && (data as { error?: unknown }).error === 'invalid_grant') {
    return true;
  }
  return typeof message === 'string' && message.includes('invalid_grant');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/auth/__tests__/oauth-errors.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/auth/oauth-errors.ts src/auth/__tests__/oauth-errors.test.ts
git commit -m "feat(auth): detect invalid_grant errors

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Loopback + PKCE login flow

**Files:**
- Create: `src/auth/login-flow.ts`
- Test: `src/auth/__tests__/login-flow.test.ts`

Background: `googleapis` re-exports google-auth-library as `Auth`. `Auth.OAuth2Client` provides `generateCodeVerifierAsync()`, `generateAuthUrl(opts)`, `getToken({ code, codeVerifier })`, `verifyIdToken({ idToken, audience })`. We depend on a narrow `OAuthFlowClient` interface so tests can inject a fake; the real `OAuth2Client` satisfies it structurally.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it, vi } from 'vitest';
import type { Auth } from 'googleapis';
import { AuthFlowError } from '../../errors.js';
import { OAUTH_SCOPES, runLoginFlow, type OAuthFlowClient } from '../login-flow.js';

interface Harness {
  client: OAuthFlowClient;
  create: (redirectUri: string) => OAuthFlowClient;
  urlOpts: () => Auth.GenerateAuthUrlOpts | undefined;
  redirect: () => string;
}

function harness(overrides: Partial<OAuthFlowClient> = {}): Harness {
  let urlOpts: Auth.GenerateAuthUrlOpts | undefined;
  let redirect = '';
  const client: OAuthFlowClient = {
    generateCodeVerifierAsync: async () => ({ codeVerifier: 'verifier', codeChallenge: 'challenge' }),
    generateAuthUrl: (opts) => {
      urlOpts = opts;
      return `https://accounts.example/auth?state=${String(opts.state)}`;
    },
    getToken: vi.fn(async () => ({ tokens: { refresh_token: 'rt-1', id_token: 'id-token' } })),
    verifyIdToken: vi.fn(async () => ({
      getPayload: () => ({ email: 'User@Example.com', email_verified: true }),
    })),
    ...overrides,
  };
  return {
    client,
    create: (redirectUri) => {
      redirect = redirectUri;
      return client;
    },
    urlOpts: () => urlOpts,
    redirect: () => redirect,
  };
}

/** Simulates the browser hitting our loopback server after Google consent. */
function browser(h: Harness, query: (state: string) => string): (url: string) => Promise<void> {
  return async (url) => {
    const state = new URL(url).searchParams.get('state') ?? '';
    await (await fetch(`${h.redirect()}/?${query(state)}`)).text();
  };
}

const base = { clientId: 'cid.apps.googleusercontent.com', clientSecret: 'secret', print: () => {} };

describe('runLoginFlow', () => {
  it('completes the PKCE flow and returns the verified email and refresh token', async () => {
    const h = harness();
    const result = await runLoginFlow({
      ...base,
      loginHint: 'user@example.com',
      createClient: h.create,
      openUrl: browser(h, (state) => `code=abc&state=${state}`),
    });
    expect(result).toEqual({ email: 'user@example.com', refreshToken: 'rt-1' });
    expect(h.redirect()).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(h.urlOpts()).toMatchObject({
      access_type: 'offline',
      prompt: 'consent',
      scope: [...OAUTH_SCOPES],
      code_challenge: 'challenge',
      code_challenge_method: 'S256',
      login_hint: 'user@example.com',
    });
    expect(h.client.getToken).toHaveBeenCalledWith({ code: 'abc', codeVerifier: 'verifier' });
    expect(h.client.verifyIdToken).toHaveBeenCalledWith({
      idToken: 'id-token',
      audience: base.clientId,
    });
  });

  it('rejects a state mismatch', async () => {
    const h = harness();
    await expect(
      runLoginFlow({ ...base, createClient: h.create, openUrl: browser(h, () => 'code=abc&state=evil') }),
    ).rejects.toThrow(/state mismatch/);
  });

  it('reports access_denied', async () => {
    const h = harness();
    await expect(
      runLoginFlow({
        ...base,
        createClient: h.create,
        openUrl: browser(h, (state) => `error=access_denied&state=${state}`),
      }),
    ).rejects.toThrow(/Access was denied/);
  });

  it('times out when no callback arrives', async () => {
    const h = harness();
    await expect(
      runLoginFlow({ ...base, createClient: h.create, openUrl: async () => {}, timeoutMs: 50 }),
    ).rejects.toThrow(AuthFlowError);
  });

  it('rejects unverified emails and missing refresh tokens', async () => {
    const unverified = harness({
      verifyIdToken: async () => ({ getPayload: () => ({ email: 'a@b.c', email_verified: false }) }),
    });
    await expect(
      runLoginFlow({
        ...base,
        createClient: unverified.create,
        openUrl: browser(unverified, (s) => `code=abc&state=${s}`),
      }),
    ).rejects.toThrow(/unverified/);

    const noRefresh = harness({ getToken: async () => ({ tokens: { id_token: 'id-token' } }) });
    await expect(
      runLoginFlow({
        ...base,
        createClient: noRefresh.create,
        openUrl: browser(noRefresh, (s) => `code=abc&state=${s}`),
      }),
    ).rejects.toThrow(/refresh token/);
  });

  it('prints the auth URL so the user can open it manually', async () => {
    const h = harness();
    const print = vi.fn();
    await runLoginFlow({
      ...base,
      print,
      createClient: h.create,
      openUrl: browser(h, (s) => `code=abc&state=${s}`),
    });
    expect(print).toHaveBeenCalledWith(expect.stringContaining('https://accounts.example/auth'));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/auth/__tests__/login-flow.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/auth/login-flow.ts`**

```ts
import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Auth } from 'googleapis';
import { AuthFlowError } from '../errors.js';

export const OAUTH_SCOPES = ['https://www.googleapis.com/auth/drive', 'openid', 'email'] as const;
const DEFAULT_TIMEOUT_MS = 120_000;

/** The subset of Auth.OAuth2Client used by the login flow (injectable for tests). */
export interface OAuthFlowClient {
  generateCodeVerifierAsync(): Promise<{ codeVerifier: string; codeChallenge?: string }>;
  generateAuthUrl(opts: Auth.GenerateAuthUrlOpts): string;
  getToken(opts: {
    code: string;
    codeVerifier?: string;
  }): Promise<{ tokens: { refresh_token?: string | null; id_token?: string | null } }>;
  verifyIdToken(opts: {
    idToken: string;
    audience: string;
  }): Promise<{ getPayload(): { email?: string; email_verified?: boolean } | undefined }>;
}

export interface LoginFlowOptions {
  clientId: string;
  clientSecret: string;
  loginHint?: string;
  openUrl: (url: string) => Promise<void>;
  print: (message: string) => void;
  timeoutMs?: number;
  createClient?: (redirectUri: string) => OAuthFlowClient;
}

export interface LoginResult {
  email: string;
  refreshToken: string;
}

const PAGE = (text: string): string =>
  `<!doctype html><meta charset="utf-8"><title>Marvin Drive</title><p>${text}</p>`;

function waitForCode(server: Server, state: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new AuthFlowError(`Login timed out after ${Math.round(timeoutMs / 1000)} s`));
    }, timeoutMs);
    timer.unref();

    server.on('request', (req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (url.pathname !== '/') {
        res.writeHead(404).end();
        return;
      }
      const reply = (status: number, text: string): void => {
        res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' }).end(PAGE(text));
      };
      const fail = (message: string): void => {
        reply(400, 'Login failed. Close this tab and check the terminal.');
        clearTimeout(timer);
        reject(new AuthFlowError(message));
      };

      const params = url.searchParams;
      if (params.get('state') !== state) return fail('OAuth state mismatch; login aborted');
      const error = params.get('error');
      if (error) {
        return fail(
          error === 'access_denied'
            ? 'Access was denied in the browser'
            : `Google returned an error: ${error}`,
        );
      }
      const code = params.get('code');
      if (!code) return fail('Callback did not include an authorization code');

      reply(200, 'Login complete. You can close this tab.');
      clearTimeout(timer);
      resolve(code);
    });
  });
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  return (server.address() as AddressInfo).port;
}

export async function runLoginFlow(opts: LoginFlowOptions): Promise<LoginResult> {
  const state = randomBytes(16).toString('hex');
  const server = createServer();
  const port = await listen(server);
  try {
    const redirectUri = `http://127.0.0.1:${port}`;
    const client: OAuthFlowClient =
      opts.createClient?.(redirectUri) ??
      new Auth.OAuth2Client({
        clientId: opts.clientId,
        clientSecret: opts.clientSecret,
        redirectUri,
      });

    const { codeVerifier, codeChallenge } = await client.generateCodeVerifierAsync();
    const codePromise = waitForCode(server, state, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    codePromise.catch(() => undefined); // awaited below; prevents an unhandled rejection if we throw first

    const authUrl = client.generateAuthUrl({
      access_type: 'offline',
      prompt: 'consent',
      scope: [...OAUTH_SCOPES],
      state,
      code_challenge: codeChallenge,
      code_challenge_method: Auth.CodeChallengeMethod.S256,
      ...(opts.loginHint ? { login_hint: opts.loginHint } : {}),
    });
    opts.print(`Opening the browser for Google sign-in. If it does not open, visit:\n${authUrl}`);
    opts.openUrl(authUrl).catch(() => {
      opts.print('Could not open a browser automatically; use the URL above.');
    });

    const code = await codePromise;
    const { tokens } = await client.getToken({ code, codeVerifier });
    if (!tokens.id_token) throw new AuthFlowError('Google did not return an id_token');

    const ticket = await client.verifyIdToken({ idToken: tokens.id_token, audience: opts.clientId });
    const payload = ticket.getPayload();
    if (!payload?.email || payload.email_verified !== true) {
      throw new AuthFlowError('Google account email is missing or unverified');
    }
    if (!tokens.refresh_token) {
      throw new AuthFlowError(
        'Google did not return a refresh token. Remove the app at https://myaccount.google.com/permissions and retry.',
      );
    }
    return { email: payload.email.toLowerCase(), refreshToken: tokens.refresh_token };
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/auth/__tests__/login-flow.test.ts && npm run typecheck`
Expected: PASS. If typecheck reports that `Auth.OAuth2Client` is not assignable to `OAuthFlowClient`, read the exact mismatch, then adjust only the `OAuthFlowClient` member types to match `node_modules/google-auth-library/build/src/auth/oauth2client.d.ts` (e.g. `getPayload()` return type) — do not use `any` or casts.

- [ ] **Step 5: Commit**

```bash
git add src/auth/login-flow.ts src/auth/__tests__/login-flow.test.ts
git commit -m "feat(auth): add loopback PKCE login flow with id_token verification

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: AuthService

**Files:**
- Create: `src/auth/auth-service.ts`
- Test: `src/auth/__tests__/auth-service.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Auth } from 'googleapis';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AccountRegistry } from '../../config/account-registry.js';
import { AuthFlowError, ReauthRequiredError, ValidationError } from '../../errors.js';
import { createLogger } from '../../logger.js';
import { AuthService, type AuthServiceDeps } from '../auth-service.js';
import type { LoginResult } from '../login-flow.js';
import { InMemoryTokenStore } from '../token-store.js';

const CREDS = { clientId: 'cid.apps.googleusercontent.com', clientSecret: 'secret' };
const invalidGrant = (): Error =>
  Object.assign(new Error('invalid_grant'), { response: { data: { error: 'invalid_grant' } } });

let registry: AccountRegistry;
let tokens: InMemoryTokenStore;
let login: ReturnType<typeof vi.fn<AuthServiceDeps['login']>>;
let service: AuthService;

beforeEach(async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'marvin-auth-'));
  registry = new AccountRegistry(path.join(dir, 'accounts.json'));
  tokens = new InMemoryTokenStore();
  login = vi.fn<AuthServiceDeps['login']>();
  service = new AuthService({
    registry,
    tokens,
    loadCredentials: async () => CREDS,
    login,
    newClient: (creds) =>
      new Auth.OAuth2Client({ clientId: creds.clientId, clientSecret: creds.clientSecret }),
    logger: createLogger(() => {}),
  });
});

const signIn = (email: string, refreshToken = `rt-${email}`): LoginResult => ({ email, refreshToken });

describe('AuthService.addAccount', () => {
  it('registers the account, stores the token, first account is default', async () => {
    login.mockResolvedValueOnce(signIn('emco@example.com', 'rt-1'));
    const record = await service.addAccount();
    expect(record).toMatchObject({ alias: 'emco', email: 'emco@example.com' });
    expect(await tokens.get('emco@example.com')).toBe('rt-1');
    expect((await registry.read()).default).toBe('emco');
    expect(login).toHaveBeenCalledWith({ credentials: CREDS });
  });

  it('checks an explicit alias before opening the browser', async () => {
    login.mockResolvedValueOnce(signIn('emco@example.com'));
    await service.addAccount('emco');
    await expect(service.addAccount('emco')).rejects.toThrow(ValidationError);
    await expect(service.addAccount('Not Valid')).rejects.toThrow(ValidationError);
    expect(login).toHaveBeenCalledTimes(1);
  });

  it('keeps the existing token when the email is already registered', async () => {
    login.mockResolvedValueOnce(signIn('emco@example.com', 'rt-old'));
    await service.addAccount();
    login.mockResolvedValueOnce(signIn('emco@example.com', 'rt-new'));
    await expect(service.addAccount('second')).rejects.toThrow(/already registered/);
    expect(await tokens.get('emco@example.com')).toBe('rt-old');
  });
});

describe('AuthService.relogin', () => {
  beforeEach(async () => {
    login.mockResolvedValueOnce(signIn('emco@example.com', 'rt-old'));
    await service.addAccount();
  });

  it('replaces the token and passes a login hint', async () => {
    login.mockResolvedValueOnce(signIn('emco@example.com', 'rt-new'));
    await service.relogin('emco');
    expect(login).toHaveBeenLastCalledWith({ credentials: CREDS, loginHint: 'emco@example.com' });
    expect(await tokens.get('emco@example.com')).toBe('rt-new');
  });

  it('refuses a different Google account and saves nothing', async () => {
    login.mockResolvedValueOnce(signIn('other@example.com', 'rt-other'));
    await expect(service.relogin('emco')).rejects.toThrow(AuthFlowError);
    expect(await tokens.get('emco@example.com')).toBe('rt-old');
    expect(await tokens.get('other@example.com')).toBeNull();
  });
});

describe('AuthService.removeAccount', () => {
  it('removes registry entry and token, revokes best effort', async () => {
    login.mockResolvedValueOnce(signIn('emco@example.com', 'rt-1'));
    await service.addAccount();
    const revoke = vi
      .spyOn(Auth.OAuth2Client.prototype, 'revokeToken')
      .mockRejectedValueOnce(new Error('network down'));
    await expect(service.removeAccount('emco')).resolves.toMatchObject({ alias: 'emco' });
    expect(revoke).toHaveBeenCalledWith('rt-1');
    expect(await tokens.get('emco@example.com')).toBeNull();
    expect((await registry.read()).accounts).toEqual([]);
    revoke.mockRestore();
  });
});

describe('AuthService.authorize', () => {
  it('throws ReauthRequiredError when no token is stored', async () => {
    await registry.add({ alias: 'emco', email: 'emco@example.com' });
    await expect(service.authorize('emco')).rejects.toThrow(ReauthRequiredError);
  });

  it('returns a client with the refresh token and persists rotated tokens', async () => {
    login.mockResolvedValueOnce(signIn('emco@example.com', 'rt-1'));
    await service.addAccount();
    const { client, refreshToken, account } = await service.authorize();
    expect(refreshToken).toBe('rt-1');
    expect(account.alias).toBe('emco');
    expect(client.credentials.refresh_token).toBe('rt-1');
    client.emit('tokens', { refresh_token: 'rt-2' });
    await vi.waitFor(async () => expect(await tokens.get('emco@example.com')).toBe('rt-2'));
  });
});

describe('AuthService.status', () => {
  beforeEach(async () => {
    login.mockResolvedValueOnce(signIn('emco@example.com', 'rt-1'));
    await service.addAccount();
    await registry.add({ alias: 'notoken', email: 'notoken@example.com' });
  });

  it('reports token presence without network calls by default', async () => {
    await expect(service.status()).resolves.toEqual([
      { alias: 'emco', email: 'emco@example.com', isDefault: true, status: 'ok' },
      { alias: 'notoken', email: 'notoken@example.com', isDefault: false, status: 'reauth_required' },
    ]);
  });

  it('remembers accounts flagged during this process', async () => {
    service.markReauthRequired('emco@example.com');
    expect((await service.status())[0]?.status).toBe('reauth_required');
    service.markHealthy('emco@example.com');
    expect((await service.status())[0]?.status).toBe('ok');
  });

  it('verify=true performs a live refresh', async () => {
    const spy = vi
      .spyOn(Auth.OAuth2Client.prototype, 'getAccessToken')
      .mockRejectedValueOnce(invalidGrant());
    expect((await service.status(true))[0]?.status).toBe('reauth_required');
    spy.mockImplementationOnce(async () => ({ token: 'at', res: null }));
    expect((await service.status(true))[0]?.status).toBe('ok');
    spy.mockRestore();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/auth/__tests__/auth-service.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/auth/auth-service.ts`**

```ts
import { Auth } from 'googleapis';
import {
  ALIAS_PATTERN,
  defaultAlias,
  type AccountRecord,
  type AccountRegistry,
} from '../config/account-registry.js';
import type { ClientCredentials } from '../config/client-secret.js';
import { AuthFlowError, ReauthRequiredError, ValidationError } from '../errors.js';
import { logger as defaultLogger, type Logger } from '../logger.js';
import type { LoginResult } from './login-flow.js';
import { isInvalidGrant } from './oauth-errors.js';
import type { TokenStore } from './token-store.js';

export type AccountStatus = 'ok' | 'reauth_required';

export interface AccountStatusEntry {
  alias: string;
  email: string;
  isDefault: boolean;
  status: AccountStatus;
}

export interface AuthorizedClient {
  account: AccountRecord;
  client: Auth.OAuth2Client;
  refreshToken: string;
}

export interface AuthServiceDeps {
  registry: AccountRegistry;
  tokens: TokenStore;
  loadCredentials: () => Promise<ClientCredentials>;
  login: (opts: { credentials: ClientCredentials; loginHint?: string }) => Promise<LoginResult>;
  newClient?: (credentials: ClientCredentials) => Auth.OAuth2Client;
  logger?: Logger;
}

export class AuthService {
  private readonly reauthNeeded = new Set<string>();
  private readonly log: Logger;
  private readonly newClient: (credentials: ClientCredentials) => Auth.OAuth2Client;

  constructor(private readonly deps: AuthServiceDeps) {
    this.log = deps.logger ?? defaultLogger;
    this.newClient =
      deps.newClient ??
      ((c) => new Auth.OAuth2Client({ clientId: c.clientId, clientSecret: c.clientSecret }));
  }

  async addAccount(alias?: string): Promise<AccountRecord> {
    if (alias !== undefined) {
      const normalized = alias.trim().toLowerCase();
      if (!ALIAS_PATTERN.test(normalized)) {
        throw new ValidationError(`Alias must match ${ALIAS_PATTERN.source} (got "${alias}")`);
      }
      const taken = await this.deps.registry.find(normalized);
      if (taken) throw new ValidationError(`Alias "${normalized}" is already used by ${taken.email}`);
    }
    const credentials = await this.deps.loadCredentials();
    const result = await this.deps.login({ credentials });
    const record = await this.deps.registry.add({
      alias: alias ?? defaultAlias(result.email),
      email: result.email,
    });
    try {
      await this.deps.tokens.set(record.email, result.refreshToken);
    } catch (err) {
      await this.deps.registry.remove(record.alias);
      throw err;
    }
    this.reauthNeeded.delete(record.email);
    return record;
  }

  async relogin(ref: string): Promise<AccountRecord> {
    const record = await this.deps.registry.resolve(ref);
    const credentials = await this.deps.loadCredentials();
    const result = await this.deps.login({ credentials, loginHint: record.email });
    if (result.email !== record.email) {
      throw new AuthFlowError(
        `Signed in as ${result.email}, but "${record.alias}" is ${record.email}. Nothing was saved.`,
      );
    }
    await this.deps.tokens.set(record.email, result.refreshToken);
    this.reauthNeeded.delete(record.email);
    return record;
  }

  async removeAccount(ref: string): Promise<AccountRecord> {
    const record = await this.deps.registry.resolve(ref);
    const token = await this.deps.tokens.get(record.email);
    await this.deps.registry.remove(record.alias);
    await this.deps.tokens.delete(record.email);
    this.reauthNeeded.delete(record.email);
    if (token) {
      try {
        const credentials = await this.deps.loadCredentials();
        await this.newClient(credentials).revokeToken(token);
      } catch (err) {
        this.log.warn('Token revocation failed; account was removed locally', {
          alias: record.alias,
          error: err,
        });
      }
    }
    return record;
  }

  setDefault(ref: string): Promise<AccountRecord> {
    return this.deps.registry.setDefault(ref);
  }

  resolveAccount(ref?: string): Promise<AccountRecord> {
    return this.deps.registry.resolve(ref);
  }

  readRefreshToken(email: string): Promise<string | null> {
    return this.deps.tokens.get(email);
  }

  markReauthRequired(email: string): void {
    this.reauthNeeded.add(email);
  }

  markHealthy(email: string): void {
    this.reauthNeeded.delete(email);
  }

  async authorize(ref?: string): Promise<AuthorizedClient> {
    const account = await this.deps.registry.resolve(ref);
    const refreshToken = await this.deps.tokens.get(account.email);
    if (!refreshToken) {
      this.reauthNeeded.add(account.email);
      throw new ReauthRequiredError(account.alias);
    }
    const client = this.newClient(await this.deps.loadCredentials());
    client.setCredentials({ refresh_token: refreshToken });
    client.on('tokens', (fresh) => {
      if (fresh.refresh_token && fresh.refresh_token !== refreshToken) {
        this.deps.tokens.set(account.email, fresh.refresh_token).catch((err: unknown) => {
          this.log.warn('Failed to persist rotated refresh token', { alias: account.alias, error: err });
        });
      }
    });
    return { account, client, refreshToken };
  }

  async status(verify = false): Promise<AccountStatusEntry[]> {
    const data = await this.deps.registry.read();
    return Promise.all(
      data.accounts.map(async (a) => ({
        alias: a.alias,
        email: a.email,
        isDefault: data.default === a.alias,
        status: await this.checkStatus(a, verify),
      })),
    );
  }

  private async checkStatus(account: AccountRecord, verify: boolean): Promise<AccountStatus> {
    const token = await this.deps.tokens.get(account.email);
    if (!token) return 'reauth_required';
    if (!verify) return this.reauthNeeded.has(account.email) ? 'reauth_required' : 'ok';
    try {
      const { client } = await this.authorize(account.alias);
      await client.getAccessToken();
      this.reauthNeeded.delete(account.email);
      return 'ok';
    } catch (err) {
      if (isInvalidGrant(err) || err instanceof ReauthRequiredError) {
        this.reauthNeeded.add(account.email);
        return 'reauth_required';
      }
      throw err;
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/auth && npm run typecheck && npm run lint`
Expected: PASS. Note: `getAccessToken()` on a fresh client with only a refresh token triggers a refresh, so the prototype spy in the verify test intercepts it before any network call.

- [ ] **Step 5: Commit**

```bash
git add src/auth/auth-service.ts src/auth/__tests__/auth-service.test.ts
git commit -m "feat(auth): add AuthService for multi-account login, removal and status

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Chunk 3: Drive access layer

### Task 10: Drive adapter (thin googleapis wrapper)

**Files:**
- Create: `src/drive/drive-adapter.ts`

This is the only module that talks to `googleapis` Drive methods. It is intentionally logic-free so that FileService can be tested against a fake `DriveAdapter`. It has no unit test; it is covered by `npm run typecheck` here and by the E2E test in Task 24.

- [ ] **Step 1: Implement `src/drive/drive-adapter.ts`**

```ts
import { Readable } from 'node:stream';
import type { ReadableStream as NodeWebReadableStream } from 'node:stream/web';
import { google, type Auth, type drive_v3 } from 'googleapis';

export type DriveFile = drive_v3.Schema$File;
export type DriveFileList = drive_v3.Schema$FileList;

export interface ListParams {
  q: string;
  pageSize: number;
  pageToken?: string;
  fields: string;
}

/** Narrow, test-friendly view of the Drive v3 API used by FileService. */
export interface DriveAdapter {
  getFile(fileId: string, fields: string): Promise<DriveFile>;
  listFiles(params: ListParams): Promise<DriveFileList>;
  downloadMedia(fileId: string): Promise<Readable>;
  exportMedia(fileId: string, mimeType: string): Promise<Readable>;
  /** GET an `exportLinks` URL with the account's bearer token (10 MB export-limit fallback). */
  fetchExportLink(url: string): Promise<Readable>;
  createFile(params: {
    requestBody: DriveFile;
    media?: { mimeType: string; body: Readable };
    fields: string;
  }): Promise<DriveFile>;
  updateFile(params: {
    fileId: string;
    requestBody?: DriveFile;
    addParents?: string;
    removeParents?: string;
    fields: string;
  }): Promise<DriveFile>;
  copyFile(params: { fileId: string; requestBody: DriveFile; fields: string }): Promise<DriveFile>;
  deleteFile(fileId: string): Promise<void>;
}

export function createDriveAdapter(auth: Auth.OAuth2Client): DriveAdapter {
  const drive = google.drive({ version: 'v3', auth });
  const allDrives = { supportsAllDrives: true } as const;

  return {
    async getFile(fileId, fields) {
      return (await drive.files.get({ fileId, fields, ...allDrives })).data;
    },

    async listFiles({ q, pageSize, pageToken, fields }) {
      const res = await drive.files.list({
        q,
        pageSize,
        pageToken,
        fields,
        includeItemsFromAllDrives: true,
        ...allDrives,
      });
      return res.data;
    },

    async downloadMedia(fileId) {
      const res = await drive.files.get(
        { fileId, alt: 'media', ...allDrives },
        { responseType: 'stream' },
      );
      return res.data;
    },

    async exportMedia(fileId, mimeType) {
      // files.export has no supportsAllDrives parameter in the Drive v3 API — this is intentional.
      const res = await drive.files.export({ fileId, mimeType }, { responseType: 'stream' });
      return res.data;
    },

    async fetchExportLink(url) {
      // Only ever send the bearer token to Google hosts.
      const { hostname, protocol } = new URL(url);
      if (protocol !== 'https:' || !/(^|\.)(google\.com|googleapis\.com)$/.test(hostname)) {
        throw new Error(`Refusing to send credentials to ${hostname}`);
      }
      const { token } = await auth.getAccessToken();
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${token ?? ''}` },
        signal: AbortSignal.timeout(5 * 60_000),
      });
      if (!res.ok || !res.body) {
        await res.body?.cancel();
        throw Object.assign(new Error(`Export link request failed with ${res.status}`), {
          status: res.status,
        });
      }
      return Readable.fromWeb(res.body as NodeWebReadableStream<Uint8Array>);
    },

    async createFile({ requestBody, media, fields }) {
      const res = await drive.files.create({ requestBody, media, fields, ...allDrives });
      return res.data;
    },

    async updateFile({ fileId, requestBody, addParents, removeParents, fields }) {
      const res = await drive.files.update({
        fileId,
        requestBody,
        addParents,
        removeParents,
        fields,
        ...allDrives,
      });
      return res.data;
    },

    async copyFile({ fileId, requestBody, fields }) {
      const res = await drive.files.copy({ fileId, requestBody, fields, ...allDrives });
      return res.data;
    },

    async deleteFile(fileId) {
      await drive.files.delete({ fileId, ...allDrives });
    },
  };
}
```

- [ ] **Step 2: Type-check**

Run: `npm run typecheck && npm run lint`
Expected: exit 0. If `res.data` for the stream calls is typed as something other than `Readable`, keep the overload with `{ responseType: 'stream' }` (googleapis declares `GaxiosPromise<Readable>` for `StreamMethodOptions`) and fix the import, not the type. If the `as NodeWebReadableStream<Uint8Array>` cast is rejected, use `as unknown as NodeWebReadableStream<Uint8Array>` — this is the known DOM-vs-`node:stream/web` typing gap, not a runtime difference.

- [ ] **Step 3: Commit**

```bash
git add src/drive/drive-adapter.ts
git commit -m "feat(drive): add thin googleapis Drive adapter

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: DriveClientFactory with stale-token recovery

**Files:**
- Create: `src/drive/client-factory.ts`
- Test: `src/drive/__tests__/client-factory.test.ts`

Behaviour (spec §8 "Long-running server"): adapters are cached per account and keyed by the refresh token. On `invalid_grant`, re-read the token store once; if the token changed (user ran `auth login` in another shell), rebuild and retry once; otherwise mark the account and throw `ReauthRequiredError`.

- [ ] **Step 1: Write the failing test**

```ts
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Auth } from 'googleapis';
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { AuthService } from '../../auth/auth-service.js';
import { InMemoryTokenStore } from '../../auth/token-store.js';
import { AccountRegistry } from '../../config/account-registry.js';
import { ReauthRequiredError } from '../../errors.js';
import { createLogger } from '../../logger.js';
import { DriveClientFactory, type DriveContext } from '../client-factory.js';
import type { DriveAdapter } from '../drive-adapter.js';

const invalidGrant = (): Error =>
  Object.assign(new Error('invalid_grant'), { response: { data: { error: 'invalid_grant' } } });

let tokens: InMemoryTokenStore;
let auth: AuthService;
let makeAdapter: Mock<(client: Auth.OAuth2Client) => DriveAdapter>;
let factory: DriveClientFactory;

beforeEach(async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'marvin-factory-'));
  const registry = new AccountRegistry(path.join(dir, 'accounts.json'));
  await registry.add({ alias: 'emco', email: 'emco@example.com' });
  tokens = new InMemoryTokenStore();
  await tokens.set('emco@example.com', 'rt-1');
  auth = new AuthService({
    registry,
    tokens,
    loadCredentials: async () => ({ clientId: 'cid.apps.googleusercontent.com', clientSecret: 's' }),
    login: async () => {
      throw new Error('not used');
    },
    logger: createLogger(() => {}),
  });
  let n = 0;
  makeAdapter = vi.fn((_client: Auth.OAuth2Client) => ({ id: ++n }) as unknown as DriveAdapter);
  factory = new DriveClientFactory(auth, makeAdapter);
});

const adapterId = (ctx: DriveContext): number => (ctx.drive as unknown as { id: number }).id;

describe('DriveClientFactory', () => {
  it('caches one adapter per account while the token is unchanged', async () => {
    const a = await factory.run(undefined, async (ctx) => adapterId(ctx));
    const b = await factory.run('emco', async (ctx) => adapterId(ctx));
    expect(a).toBe(1);
    expect(b).toBe(1);
    expect(makeAdapter).toHaveBeenCalledTimes(1);
  });

  it('rebuilds when the stored token changes between calls', async () => {
    await factory.run(undefined, async (ctx) => adapterId(ctx));
    await tokens.set('emco@example.com', 'rt-2');
    expect(await factory.run(undefined, async (ctx) => adapterId(ctx))).toBe(2);
  });

  it('throws ReauthRequiredError and flags the account when the token is dead', async () => {
    await expect(
      factory.run(undefined, async () => {
        throw invalidGrant();
      }),
    ).rejects.toThrow(ReauthRequiredError);
    expect((await auth.status())[0]?.status).toBe('reauth_required');
  });

  it('retries once with a token refreshed by another process', async () => {
    const seen: number[] = [];
    const result = await factory.run(undefined, async (ctx) => {
      seen.push(adapterId(ctx));
      if (seen.length === 1) {
        await tokens.set('emco@example.com', 'rt-new'); // simulates `auth login` elsewhere
        throw invalidGrant();
      }
      return 'ok';
    });
    expect(result).toBe('ok');
    expect(seen).toEqual([1, 2]);
  });

  it('marks the account healthy again after a successful call', async () => {
    auth.markReauthRequired('emco@example.com');
    await factory.run(undefined, async () => 'ok');
    expect((await auth.status())[0]?.status).toBe('ok');
  });

  it('passes other errors through unchanged', async () => {
    const boom = new Error('boom');
    await expect(
      factory.run(undefined, async () => {
        throw boom;
      }),
    ).rejects.toBe(boom);
  });

  it('throws ReauthRequiredError when no token is stored', async () => {
    await tokens.delete('emco@example.com');
    await expect(factory.run(undefined, async () => 'x')).rejects.toThrow(ReauthRequiredError);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/drive`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/drive/client-factory.ts`**

```ts
import type { Auth } from 'googleapis';
import type { AuthService } from '../auth/auth-service.js';
import { isInvalidGrant } from '../auth/oauth-errors.js';
import type { AccountRecord } from '../config/account-registry.js';
import { ReauthRequiredError } from '../errors.js';
import { createDriveAdapter, type DriveAdapter } from './drive-adapter.js';

export interface DriveContext {
  account: AccountRecord;
  drive: DriveAdapter;
}

/**
 * Runs `fn` with an authorized Drive adapter for the given account (alias/email/default).
 * `fn` may run twice (stale-token retry), so it must open streams/resources inside itself.
 */
export interface DriveRunner {
  run<T>(accountRef: string | undefined, fn: (ctx: DriveContext) => Promise<T>): Promise<T>;
}

interface CachedContext extends DriveContext {
  refreshToken: string;
}

export class DriveClientFactory implements DriveRunner {
  private readonly cache = new Map<string, CachedContext>();

  constructor(
    private readonly auth: AuthService,
    private readonly makeAdapter: (client: Auth.OAuth2Client) => DriveAdapter = createDriveAdapter,
  ) {}

  async run<T>(accountRef: string | undefined, fn: (ctx: DriveContext) => Promise<T>): Promise<T> {
    const ctx = await this.context(accountRef);
    try {
      const result = await fn(ctx);
      this.auth.markHealthy(ctx.account.email);
      return result;
    } catch (err) {
      if (!isInvalidGrant(err)) throw err;
      let lastErr: unknown = err;
      this.cache.delete(ctx.account.email);
      const latest = await this.auth.readRefreshToken(ctx.account.email);
      if (latest && latest !== ctx.refreshToken) {
        const retryCtx = await this.context(ctx.account.alias);
        try {
          const result = await fn(retryCtx);
          this.auth.markHealthy(ctx.account.email);
          return result;
        } catch (retryErr) {
          if (!isInvalidGrant(retryErr)) throw retryErr;
          lastErr = retryErr;
          this.cache.delete(ctx.account.email);
        }
      }
      this.auth.markReauthRequired(ctx.account.email);
      throw new ReauthRequiredError(ctx.account.alias, { cause: lastErr });
    }
  }

  private async context(accountRef: string | undefined): Promise<CachedContext> {
    const account = await this.auth.resolveAccount(accountRef);
    const token = await this.auth.readRefreshToken(account.email);
    if (!token) {
      this.cache.delete(account.email);
      this.auth.markReauthRequired(account.email);
      throw new ReauthRequiredError(account.alias);
    }
    const cached = this.cache.get(account.email);
    if (cached && cached.refreshToken === token) return cached;

    const { client, refreshToken } = await this.auth.authorize(account.alias);
    const fresh: CachedContext = { account, drive: this.makeAdapter(client), refreshToken };
    this.cache.set(account.email, fresh);
    return fresh;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/drive && npm run typecheck && npm run lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/drive/client-factory.ts src/drive/__tests__/client-factory.test.ts
git commit -m "feat(drive): add per-account client factory with stale-token recovery

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Chunk 4: Pure file helpers (queries, exports, filenames)

### Task 12: Drive query builders

**Files:**
- Create: `src/files/query.ts`
- Test: `src/files/__tests__/query.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import { ValidationError } from '../../errors.js';
import { buildListQuery, buildSearchQuery, escapeQueryValue } from '../query.js';

describe('escapeQueryValue', () => {
  it('escapes backslashes first, then single quotes', () => {
    expect(escapeQueryValue("O'Brien")).toBe("O\\'Brien");
    expect(escapeQueryValue('a\\b')).toBe('a\\\\b');
    expect(escapeQueryValue("\\'")).toBe("\\\\\\'");
  });
});

describe('buildListQuery', () => {
  it('lists non-trashed children by default', () => {
    expect(buildListQuery('root', false)).toBe("'root' in parents and trashed = false");
  });
  it('includes trashed items on request and escapes the id', () => {
    expect(buildListQuery("x'y", true)).toBe("'x\\'y' in parents");
  });
});

describe('buildSearchQuery', () => {
  it('builds name/fullText search and excludes trash', () => {
    expect(buildSearchQuery({ query: 'budget' })).toBe(
      "(name contains 'budget' or fullText contains 'budget') and trashed = false",
    );
  });

  it('ANDs all clauses and normalizes modifiedAfter', () => {
    expect(
      buildSearchQuery({
        query: "it's",
        mimeType: 'application/pdf',
        modifiedAfter: '2026-01-01',
        rawQuery: "'abc' in parents",
      }),
    ).toBe(
      "(name contains 'it\\'s' or fullText contains 'it\\'s') and mimeType = 'application/pdf' and modifiedTime > '2026-01-01T00:00:00.000Z' and ('abc' in parents) and trashed = false",
    );
  });

  it('leaves trash handling to rawQuery when it mentions trashed', () => {
    expect(buildSearchQuery({ rawQuery: 'trashed = true' })).toBe('(trashed = true)');
    expect(buildSearchQuery({ rawQuery: 'Trashed=true' })).toBe('(Trashed=true)');
  });

  it('requires at least one criterion and a valid date', () => {
    expect(() => buildSearchQuery({})).toThrow(ValidationError);
    expect(() => buildSearchQuery({ query: '  ' })).toThrow(ValidationError);
    expect(() => buildSearchQuery({ modifiedAfter: 'yesterday' })).toThrow(/ISO 8601/);
    expect(() => buildSearchQuery({ modifiedAfter: '2026/01/01' })).toThrow(/ISO 8601/);
    expect(buildSearchQuery({ modifiedAfter: '2026-01-01T10:00:00Z' })).toContain(
      "modifiedTime > '2026-01-01T10:00:00.000Z'",
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/files/__tests__/query.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/files/query.ts`**

```ts
import { ValidationError } from '../errors.js';

/** Escapes a value for use inside single quotes in a Drive `q` string. */
export function escapeQueryValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

export function buildListQuery(folderId: string, includeTrashed: boolean): string {
  const base = `'${escapeQueryValue(folderId)}' in parents`;
  return includeTrashed ? base : `${base} and trashed = false`;
}

export interface SearchCriteria {
  query?: string;
  mimeType?: string;
  modifiedAfter?: string;
  rawQuery?: string;
}

const TRASHED_WORD = /\btrashed\b/i;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}(T[\d:.]+(Z|[+-]\d{2}:?\d{2})?)?$/;

export function buildSearchQuery(criteria: SearchCriteria): string {
  const clauses: string[] = [];
  const text = criteria.query?.trim();
  if (text) {
    const v = escapeQueryValue(text);
    clauses.push(`(name contains '${v}' or fullText contains '${v}')`);
  }
  const mimeType = criteria.mimeType?.trim();
  if (mimeType) clauses.push(`mimeType = '${escapeQueryValue(mimeType)}'`);
  if (criteria.modifiedAfter !== undefined) {
    const time = ISO_DATE.test(criteria.modifiedAfter) ? Date.parse(criteria.modifiedAfter) : NaN;
    if (Number.isNaN(time)) {
      throw new ValidationError(`modifiedAfter must be an ISO 8601 date (got "${criteria.modifiedAfter}")`);
    }
    clauses.push(`modifiedTime > '${new Date(time).toISOString()}'`);
  }
  const raw = criteria.rawQuery?.trim();
  if (raw) clauses.push(`(${raw})`);

  if (clauses.length === 0) {
    throw new ValidationError('Provide at least one of: query, mimeType, modifiedAfter, rawQuery');
  }
  if (!raw || !TRASHED_WORD.test(raw)) clauses.push('trashed = false');
  return clauses.join(' and ');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/files/__tests__/query.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/files/query.ts src/files/__tests__/query.test.ts
git commit -m "feat(files): add escaped Drive query builders

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 13: Export format rules

**Files:**
- Create: `src/files/export-formats.ts`
- Test: `src/files/__tests__/export-formats.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import { UnsupportedTypeError, ValidationError } from '../../errors.js';
import { GOOGLE_MIME, resolveExport } from '../export-formats.js';

describe('resolveExport', () => {
  it('returns null for binary files', () => {
    expect(resolveExport('application/pdf')).toBeNull();
  });

  it('uses per-type defaults', () => {
    expect(resolveExport(GOOGLE_MIME.document)).toEqual({
      format: 'docx',
      extension: 'docx',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    });
    expect(resolveExport(GOOGLE_MIME.spreadsheet)?.format).toBe('xlsx');
    expect(resolveExport(GOOGLE_MIME.presentation)?.format).toBe('pptx');
    expect(resolveExport(GOOGLE_MIME.drawing)?.format).toBe('png');
  });

  it('accepts allowed overrides', () => {
    expect(resolveExport(GOOGLE_MIME.document, 'md')?.mimeType).toBe('text/markdown');
    expect(resolveExport(GOOGLE_MIME.spreadsheet, 'csv')?.mimeType).toBe('text/csv');
    expect(resolveExport(GOOGLE_MIME.presentation, 'txt')?.mimeType).toBe('text/plain');
  });

  it('rejects disallowed combinations with the allowed list', () => {
    expect(() => resolveExport(GOOGLE_MIME.spreadsheet, 'md')).toThrow(ValidationError);
    expect(() => resolveExport(GOOGLE_MIME.spreadsheet, 'md')).toThrow(/xlsx, pdf, csv, ods/);
    expect(() => resolveExport(GOOGLE_MIME.drawing, 'txt')).toThrow(ValidationError);
  });

  it('rejects exportFormat on binary files', () => {
    expect(() => resolveExport('image/png', 'pdf')).toThrow(/only applies to Google/);
  });

  it('rejects non-exportable Google types', () => {
    expect(() => resolveExport(GOOGLE_MIME.folder)).toThrow(UnsupportedTypeError);
    expect(() => resolveExport('application/vnd.google-apps.form')).toThrow(UnsupportedTypeError);
    expect(() => resolveExport('application/vnd.google-apps.site')).toThrow(UnsupportedTypeError);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/files/__tests__/export-formats.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/files/export-formats.ts`**

```ts
import { UnsupportedTypeError, ValidationError } from '../errors.js';

const G = 'application/vnd.google-apps.';

export const GOOGLE_MIME = {
  document: `${G}document`,
  spreadsheet: `${G}spreadsheet`,
  presentation: `${G}presentation`,
  drawing: `${G}drawing`,
  folder: `${G}folder`,
  shortcut: `${G}shortcut`,
} as const;

export const EXPORT_FORMATS = [
  'docx',
  'xlsx',
  'pptx',
  'pdf',
  'md',
  'txt',
  'odt',
  'ods',
  'odp',
  'html',
  'csv',
  'png',
  'svg',
  'jpg',
] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

const FORMAT_MIME: Record<ExportFormat, string> = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  pdf: 'application/pdf',
  md: 'text/markdown',
  txt: 'text/plain',
  odt: 'application/vnd.oasis.opendocument.text',
  ods: 'application/x-vnd.oasis.opendocument.spreadsheet',
  odp: 'application/vnd.oasis.opendocument.presentation',
  html: 'text/html',
  csv: 'text/csv',
  png: 'image/png',
  svg: 'image/svg+xml',
  jpg: 'image/jpeg',
};

interface ExportRule {
  label: string;
  defaultFormat: ExportFormat;
  allowed: readonly ExportFormat[];
}

const RULES: Record<string, ExportRule> = {
  [GOOGLE_MIME.document]: {
    label: 'Google Docs',
    defaultFormat: 'docx',
    allowed: ['docx', 'pdf', 'md', 'txt', 'odt', 'html'],
  },
  [GOOGLE_MIME.spreadsheet]: {
    label: 'Google Sheets',
    defaultFormat: 'xlsx',
    allowed: ['xlsx', 'pdf', 'csv', 'ods'],
  },
  [GOOGLE_MIME.presentation]: {
    label: 'Google Slides',
    defaultFormat: 'pptx',
    allowed: ['pptx', 'pdf', 'txt', 'odp'],
  },
  [GOOGLE_MIME.drawing]: {
    label: 'Google Drawings',
    defaultFormat: 'png',
    allowed: ['png', 'pdf', 'svg', 'jpg'],
  },
};

export interface ExportPlan {
  format: ExportFormat;
  extension: string;
  mimeType: string;
}

export function isGoogleNative(mimeType: string): boolean {
  return mimeType.startsWith(G);
}

/** Export plan for a Google-native file, or `null` for binary files (download as-is). */
export function resolveExport(sourceMimeType: string, requested?: ExportFormat): ExportPlan | null {
  if (!isGoogleNative(sourceMimeType)) {
    if (requested !== undefined) {
      throw new ValidationError(
        'exportFormat only applies to Google Docs, Sheets, Slides and Drawings; omit it for other files',
      );
    }
    return null;
  }
  const rule = RULES[sourceMimeType];
  if (!rule) throw new UnsupportedTypeError(sourceMimeType);
  const format = requested ?? rule.defaultFormat;
  if (!rule.allowed.includes(format)) {
    throw new ValidationError(
      `${rule.label} cannot be exported as "${format}". Allowed: ${rule.allowed.join(', ')}`,
    );
  }
  return { format, extension: format, mimeType: FORMAT_MIME[format] };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/files/__tests__/export-formats.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/files/export-formats.ts src/files/__tests__/export-formats.test.ts
git commit -m "feat(files): add Google-native export format rules

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 14: Filename sanitization and safe destination writing

**Files:**
- Create: `src/files/filename.ts`, `src/files/destination.ts`
- Test: `src/files/__tests__/filename.test.ts`, `src/files/__tests__/destination.test.ts`

Security note (spec §6 step 6): Drive names are untrusted. A shared file named `../../.zshrc` must never escape the download directory.

- [ ] **Step 1: Write the failing tests**

`src/files/__tests__/filename.test.ts`:
```ts
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
```

`src/files/__tests__/destination.test.ts`:
```ts
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { beforeEach, describe, expect, it } from 'vitest';
import { ValidationError } from '../../errors.js';
import { assertInside, resolveDestination, writeUnique } from '../destination.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'marvin-dest-'));
});

describe('resolveDestination', () => {
  const base = { driveName: 'Plan', fileId: 'f1', extension: 'docx' };

  it('uses the default directory when destPath is omitted', async () => {
    await expect(resolveDestination({ ...base, defaultDir: dir })).resolves.toEqual({
      dir,
      name: 'Plan.docx',
    });
  });

  it('treats an existing directory or a trailing slash as a directory', async () => {
    await expect(
      resolveDestination({ ...base, defaultDir: '/unused', destPath: dir }),
    ).resolves.toEqual({ dir, name: 'Plan.docx' });
    const fresh = path.join(dir, 'new-folder');
    await expect(
      resolveDestination({ ...base, defaultDir: '/unused', destPath: `${fresh}/` }),
    ).resolves.toEqual({ dir: fresh, name: 'Plan.docx' });
  });

  it('treats any other destPath as the full target file path', async () => {
    const target = path.join(dir, 'custom.bin');
    await expect(
      resolveDestination({ ...base, defaultDir: '/unused', destPath: target }),
    ).resolves.toEqual({ dir, name: 'custom.bin' });
  });

  it('expands ~ to the home directory', async () => {
    const res = await resolveDestination({ ...base, defaultDir: '/unused', destPath: '~/x.txt' });
    expect(res).toEqual({ dir: os.homedir(), name: 'x.txt' });
  });

  it('sanitizes hostile Drive names so they stay inside the directory', async () => {
    const res = await resolveDestination({
      driveName: '../../.zshrc',
      fileId: 'f1',
      defaultDir: dir,
    });
    expect(res).toEqual({ dir, name: '_.._.zshrc' });
  });
});

describe('assertInside', () => {
  it('rejects paths that escape the directory', () => {
    expect(() => assertInside(dir, path.join(dir, '..', 'evil'))).toThrow(ValidationError);
    expect(() => assertInside(dir, dir)).toThrow(ValidationError);
    expect(() => assertInside(dir, path.join(dir, 'ok.txt'))).not.toThrow();
    expect(() => assertInside(dir, path.join(dir, '..notes'))).not.toThrow();
  });
});

describe('writeUnique', () => {
  it('writes the stream, creating missing directories', async () => {
    const target = { dir: path.join(dir, 'a', 'b'), name: 'hello.txt' };
    const res = await writeUnique(target, async () => Readable.from(['hello']));
    expect(res).toEqual({ path: path.join(dir, 'a', 'b', 'hello.txt'), size: 5 });
    expect(await readFile(res.path, 'utf8')).toBe('hello');
  });

  it('never overwrites: picks the next free suffix', async () => {
    await writeFile(path.join(dir, 'report.pdf'), 'old');
    await writeFile(path.join(dir, 'report (1).pdf.part'), 'in progress elsewhere');
    const res = await writeUnique({ dir, name: 'report.pdf' }, async () => Readable.from(['new']));
    expect(path.basename(res.path)).toBe('report (2).pdf');
    expect(await readFile(path.join(dir, 'report.pdf'), 'utf8')).toBe('old');
  });

  it('removes the partial file when the stream fails', async () => {
    const failing = (): Readable =>
      new Readable({
        read() {
          this.destroy(new Error('network reset'));
        },
      });
    await expect(writeUnique({ dir, name: 'x.bin' }, async () => failing())).rejects.toThrow(
      'network reset',
    );
    expect(await readdir(dir)).toEqual([]);
  });

  it('removes the reservation when opening the source fails', async () => {
    await expect(
      writeUnique({ dir, name: 'x.bin' }, async () => {
        throw new Error('403');
      }),
    ).rejects.toThrow('403');
    expect(await readdir(dir)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/files/__tests__/filename.test.ts src/files/__tests__/destination.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement `src/files/filename.ts`**

```ts
export const MAX_NAME_BYTES = 255;

// Path separators, NUL and other C0/DEL control characters.
// eslint-disable-next-line no-control-regex
const UNSAFE_CHARS = /[/\\\u0000-\u001f\u007f]/g;

/** Makes an untrusted Drive name safe to use as a single local path segment. */
export function sanitizeFileName(name: string, fileId: string): string {
  const cleaned = name.replace(UNSAFE_CHARS, '_').replace(/^[\s.]+/, '').trim();
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
```

Note: `'bad\u0000name\n'` → `'bad_name_'`: the trailing `\n` becomes `_` before `trim()` runs, so it survives — this is intended. Leading whitespace and dots are stripped together (`/^[\s.]+/`), so inputs like `'. .'` cannot survive as `.`/`..`.

- [ ] **Step 4: Implement `src/files/destination.ts`**

```ts
import { createWriteStream } from 'node:fs';
import { mkdir, open, rename, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { ValidationError, hasErrorCode } from '../errors.js';
import { candidateName, ensureExtension, sanitizeFileName } from './filename.js';

export interface DestinationInput {
  destPath?: string;
  defaultDir: string;
  driveName: string;
  fileId: string;
  extension?: string;
}

export interface Destination {
  dir: string;
  name: string;
}

export interface WrittenFile {
  path: string;
  size: number;
}

const MAX_COLLISIONS = 1000;

function expandHome(p: string): string {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

async function isDirectory(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory();
  } catch (err) {
    if (hasErrorCode(err, 'ENOENT')) return false;
    throw err;
  }
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch (err) {
    if (hasErrorCode(err, 'ENOENT')) return false;
    throw err;
  }
}

/** Spec §6 download rule 6: where a download goes and under which (sanitized) name. */
export async function resolveDestination(input: DestinationInput): Promise<Destination> {
  const generated = ensureExtension(sanitizeFileName(input.driveName, input.fileId), input.extension);
  if (input.destPath === undefined || input.destPath.trim() === '') {
    return { dir: path.resolve(input.defaultDir), name: generated };
  }
  const resolved = path.resolve(expandHome(input.destPath));
  if (input.destPath.endsWith('/') || (await isDirectory(resolved))) {
    return { dir: resolved, name: generated };
  }
  return { dir: path.dirname(resolved), name: path.basename(resolved) };
}

/** Throws unless `target` is strictly inside `dir`. */
export function assertInside(dir: string, target: string): void {
  const rel = path.relative(path.resolve(dir), path.resolve(target));
  if (rel === '' || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    throw new ValidationError(`Refusing to write outside ${dir}`);
  }
}

async function reserve(dest: Destination): Promise<{ finalPath: string; partPath: string }> {
  for (let i = 0; i < MAX_COLLISIONS; i++) {
    const finalPath = path.join(dest.dir, candidateName(dest.name, i));
    assertInside(dest.dir, finalPath);
    if (await exists(finalPath)) continue;
    const partPath = `${finalPath}.part`;
    try {
      const handle = await open(partPath, 'wx', 0o644);
      await handle.close();
      return { finalPath, partPath };
    } catch (err) {
      if (hasErrorCode(err, 'EEXIST')) continue;
      throw err;
    }
  }
  throw new ValidationError(`Too many files named like "${dest.name}" in ${dest.dir}`);
}

/**
 * Reserves a non-colliding `<name>.part` (exclusive create), streams `openSource()` into it,
 * then renames to the final name. Never overwrites; removes the partial file on failure.
 */
export async function writeUnique(
  dest: Destination,
  openSource: () => Promise<Readable>,
): Promise<WrittenFile> {
  await mkdir(dest.dir, { recursive: true });
  const { finalPath, partPath } = await reserve(dest);
  try {
    const source = await openSource();
    await pipeline(source, createWriteStream(partPath));
    await rename(partPath, finalPath);
    return { path: finalPath, size: (await stat(finalPath)).size };
  } catch (err) {
    await rm(partPath, { force: true });
    throw err;
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/files/__tests__/filename.test.ts src/files/__tests__/destination.test.ts && npm run typecheck && npm run lint`
Expected: PASS. (On macOS `os.tmpdir()` may be a symlink under `/var/folders`; `path.resolve` does not follow symlinks, so the `dir` equality assertions hold.)

- [ ] **Step 6: Commit**

```bash
git add src/files/filename.ts src/files/destination.ts src/files/__tests__/filename.test.ts src/files/__tests__/destination.test.ts
git commit -m "feat(files): sanitize Drive names and write downloads without overwriting

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Chunk 5: Error mapping, retry, upload MIME, audit

### Task 15: Drive error classification and retry

**Files:**
- Create: `src/files/drive-errors.ts`, `src/files/retry.ts`
- Test: `src/files/__tests__/drive-errors.test.ts`, `src/files/__tests__/retry.test.ts`

Gaxios errors expose `status` (and `response.status`), and Drive's error body at `response.data.error.errors[0].reason` (sometimes as a JSON string for stream requests). googleapis also copies `errors` onto the error object. Classify 403s by `reason`, never by status alone.

- [ ] **Step 1: Write the failing tests**

`src/files/__tests__/drive-errors.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import {
  AbusiveFileError,
  DriveApiError,
  ExportTooLargeError,
  NotFoundError,
  PermissionDeniedError,
  QuotaExceededError,
  RateLimitError,
  ValidationError,
} from '../../errors.js';
import { createLogger } from '../../logger.js';
import { isRateLimit, mapDriveError, reasonOf, statusOf } from '../drive-errors.js';

const gaxios = (status: number, reason?: string, asString = false): Error => {
  const body = { error: { code: status, message: 'x', errors: reason ? [{ reason }] : [] } };
  return Object.assign(new Error(`HTTP ${status}`), {
    status,
    response: { status, data: asString ? JSON.stringify(body) : body },
  });
};
const silent = createLogger(() => {});
const ctx = { target: 'file-1', alias: 'emco', logger: silent };

describe('statusOf / reasonOf', () => {
  it('reads gaxios shapes', () => {
    expect(statusOf(gaxios(404))).toBe(404);
    expect(statusOf(Object.assign(new Error('x'), { response: { status: 502 } }))).toBe(502);
    expect(statusOf(Object.assign(new Error('x'), { code: 429 }))).toBe(429);
    expect(statusOf(new Error('x'))).toBeUndefined();
    expect(reasonOf(gaxios(403, 'storageQuotaExceeded'))).toBe('storageQuotaExceeded');
    expect(reasonOf(gaxios(403, 'rateLimitExceeded', true))).toBe('rateLimitExceeded');
    expect(reasonOf(Object.assign(new Error('x'), { errors: [{ reason: 'forbidden' }] }))).toBe(
      'forbidden',
    );
    expect(reasonOf(new Error('x'))).toBeUndefined();
  });

  it('recognizes the export size limit by message as a fallback', () => {
    expect(reasonOf(new Error('This file is too large to be exported.'))).toBe(
      'exportSizeLimitExceeded',
    );
  });
});

describe('isRateLimit', () => {
  it('covers 429 and 403 rate-limit reasons only', () => {
    expect(isRateLimit(429, undefined)).toBe(true);
    expect(isRateLimit(403, 'userRateLimitExceeded')).toBe(true);
    expect(isRateLimit(403, 'rateLimitExceeded')).toBe(true);
    expect(isRateLimit(403, 'forbidden')).toBe(false);
  });
});

describe('mapDriveError', () => {
  it('maps statuses and 403 reasons to specific errors', () => {
    expect(mapDriveError(gaxios(404), ctx)).toBeInstanceOf(NotFoundError);
    expect(mapDriveError(gaxios(429), ctx)).toBeInstanceOf(RateLimitError);
    expect(mapDriveError(gaxios(403, 'userRateLimitExceeded'), ctx)).toBeInstanceOf(RateLimitError);
    expect(mapDriveError(gaxios(403, 'storageQuotaExceeded'), ctx)).toBeInstanceOf(
      QuotaExceededError,
    );
    expect(mapDriveError(gaxios(403, 'cannotDownloadAbusiveFile'), ctx)).toBeInstanceOf(
      AbusiveFileError,
    );
    expect(mapDriveError(gaxios(403, 'exportSizeLimitExceeded'), ctx)).toBeInstanceOf(
      ExportTooLargeError,
    );
    expect(mapDriveError(gaxios(403, 'insufficientFilePermissions'), ctx)).toBeInstanceOf(
      PermissionDeniedError,
    );
    expect(mapDriveError(gaxios(403), ctx)).toBeInstanceOf(PermissionDeniedError);
  });

  it('wraps other failures in DriveApiError with a safe message', () => {
    const mapped = mapDriveError(gaxios(500), ctx);
    expect(mapped).toBeInstanceOf(DriveApiError);
    expect(mapped.message).toBe('Drive API error (500): HTTP 500');
  });

  it('adds a duplicate hint for failed creates', () => {
    expect(mapDriveError(gaxios(503), { ...ctx, createOp: true }).message).toMatch(/duplicate/);
  });

  it('passes AppErrors through unchanged', () => {
    const own = new ValidationError('mine');
    expect(mapDriveError(own, ctx)).toBe(own);
  });
});
```

`src/files/__tests__/retry.test.ts`:
```ts
import { describe, expect, it, vi } from 'vitest';
import { withRetry } from '../retry.js';

const http = (status: number, reason?: string): Error =>
  Object.assign(new Error(`HTTP ${status}`), { status, ...(reason ? { errors: [{ reason }] } : {}) });

function flaky<T>(failures: Error[], value: T): (attempt: number) => Promise<T> {
  return async (attempt) => {
    const failure = failures[attempt];
    if (failure) throw failure;
    return value;
  };
}

describe('withRetry', () => {
  it('retries rate limits and 5xx for idempotent calls with exponential backoff', async () => {
    const sleep = vi.fn(async (_ms: number) => {});
    const result = await withRetry(flaky([http(429), http(503), http(403, 'rateLimitExceeded')], 'ok'), 'idempotent', {
      sleep,
      random: () => 0,
      baseDelayMs: 100,
    });
    expect(result).toBe('ok');
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([100, 200, 400]);
  });

  it('gives up after 3 retries', async () => {
    const err = http(500);
    await expect(
      withRetry(flaky([err, err, err, err], 'never'), 'idempotent', { sleep: async () => {} }),
    ).rejects.toBe(err);
  });

  it('retries creates only on rate limits', async () => {
    await expect(
      withRetry(flaky([http(429)], 'created'), 'create', { sleep: async () => {} }),
    ).resolves.toBe('created');
    const serverError = http(500);
    const fn = vi.fn(flaky([serverError], 'created'));
    await expect(withRetry(fn, 'create', { sleep: async () => {} })).rejects.toBe(serverError);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('does not retry client errors', async () => {
    const fn = vi.fn(flaky([http(404)], 'x'));
    await expect(withRetry(fn, 'idempotent', { sleep: async () => {} })).rejects.toThrow('HTTP 404');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('passes the attempt number to the operation', async () => {
    const attempts: number[] = [];
    await withRetry(
      async (attempt) => {
        attempts.push(attempt);
        if (attempt === 0) throw http(502);
        return 'ok';
      },
      'idempotent',
      { sleep: async () => {} },
    );
    expect(attempts).toEqual([0, 1]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/files/__tests__/drive-errors.test.ts src/files/__tests__/retry.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement `src/files/drive-errors.ts`**

```ts
import {
  AbusiveFileError,
  AppError,
  DriveApiError,
  ExportTooLargeError,
  NotFoundError,
  PermissionDeniedError,
  QuotaExceededError,
  RateLimitError,
} from '../errors.js';
import type { Logger } from '../logger.js';

type Loose = Record<string, unknown>;

function asObject(value: unknown): Loose | undefined {
  return typeof value === 'object' && value !== null ? (value as Loose) : undefined;
}

export function statusOf(err: unknown): number | undefined {
  const e = asObject(err);
  if (!e) return undefined;
  if (typeof e.status === 'number') return e.status;
  const responseStatus = asObject(e.response)?.status;
  if (typeof responseStatus === 'number') return responseStatus;
  return typeof e.code === 'number' ? e.code : undefined;
}

function firstReason(errors: unknown): string | undefined {
  if (!Array.isArray(errors)) return undefined;
  const reason = asObject(errors[0])?.reason;
  return typeof reason === 'string' ? reason : undefined;
}

export function reasonOf(err: unknown): string | undefined {
  const e = asObject(err);
  if (!e) return undefined;
  const direct = firstReason(e.errors);
  if (direct) return direct;

  let data: unknown = asObject(e.response)?.data;
  if (typeof data === 'string') {
    try {
      data = JSON.parse(data);
    } catch {
      data = undefined; // non-JSON body: no structured reason available
    }
  }
  const fromBody = firstReason(asObject(asObject(data)?.error)?.errors);
  if (fromBody) return fromBody;

  if (typeof e.message === 'string' && /too large to be exported/i.test(e.message)) {
    return 'exportSizeLimitExceeded';
  }
  return undefined;
}

export function isRateLimit(status: number | undefined, reason: string | undefined): boolean {
  return (
    status === 429 ||
    (status === 403 && (reason === 'rateLimitExceeded' || reason === 'userRateLimitExceeded'))
  );
}

export interface MapContext {
  /** File/folder id the call targeted (for messages); undefined → "root". */
  target: string | undefined;
  alias: string;
  logger: Logger;
  /** True for non-idempotent creates: a 5xx may still have created the item. */
  createOp?: boolean;
}

/** Converts a raw googleapis/gaxios error into a safe AppError (spec §9). */
export function mapDriveError(err: unknown, ctx: MapContext): AppError {
  if (err instanceof AppError) return err;
  const status = statusOf(err);
  const reason = reasonOf(err);
  const target = ctx.target ?? 'root';

  if (status === 404) return new NotFoundError(target, { cause: err });
  if (isRateLimit(status, reason)) return new RateLimitError({ cause: err });
  if (status === 403 || reason === 'exportSizeLimitExceeded') {
    switch (reason) {
      case 'storageQuotaExceeded':
        return new QuotaExceededError(ctx.alias, { cause: err });
      case 'cannotDownloadAbusiveFile':
        return new AbusiveFileError(target, { cause: err });
      case 'exportSizeLimitExceeded':
        return new ExportTooLargeError(null, { cause: err });
      default:
        return new PermissionDeniedError(target, { cause: err });
    }
  }

  const detail = err instanceof Error ? err.message.slice(0, 200) : 'Unknown error';
  ctx.logger.error('Drive API call failed', { status, reason, target, error: err });
  const hint =
    ctx.createOp && status !== undefined && status >= 500
      ? '. The item may have been created anyway; check for a duplicate before retrying.'
      : '';
  return new DriveApiError(status, `${detail}${hint}`, { cause: err });
}
```

- [ ] **Step 4: Implement `src/files/retry.ts`**

```ts
import { isRateLimit, reasonOf, statusOf } from './drive-errors.js';

/** idempotent: safe to repeat; create: repeating could make a duplicate. */
export type RetryClass = 'idempotent' | 'create';

export interface RetryOptions {
  retries?: number;
  baseDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

function retryKind(err: unknown): 'rate-limit' | 'server' | null {
  const status = statusOf(err);
  if (isRateLimit(status, reasonOf(err))) return 'rate-limit';
  if (status !== undefined && status >= 500) return 'server';
  return null;
}

/** Spec §9 retry policy: exponential backoff + jitter, max `retries` (default 3) retries. */
export async function withRetry<T>(
  operation: (attempt: number) => Promise<T>,
  retryClass: RetryClass,
  options: RetryOptions = {},
): Promise<T> {
  const retries = options.retries ?? 3;
  const base = options.baseDelayMs ?? 500;
  const sleep = options.sleep ?? defaultSleep;
  const random = options.random ?? Math.random;

  for (let attempt = 0; ; attempt++) {
    try {
      return await operation(attempt);
    } catch (err) {
      const kind = retryKind(err);
      const retryable = kind === 'rate-limit' || (kind === 'server' && retryClass === 'idempotent');
      if (!retryable || attempt >= retries) throw err;
      await sleep(base * 2 ** attempt + random() * base);
    }
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/files/__tests__/drive-errors.test.ts src/files/__tests__/retry.test.ts && npm run typecheck && npm run lint`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/files/drive-errors.ts src/files/retry.ts src/files/__tests__/drive-errors.test.ts src/files/__tests__/retry.test.ts
git commit -m "feat(files): classify Drive errors by reason and add retry policy

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 16: Upload MIME detection and conversion targets

**Files:**
- Create: `src/files/upload-mime.ts`
- Test: `src/files/__tests__/upload-mime.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import { ValidationError } from '../../errors.js';
import { GOOGLE_MIME } from '../export-formats.js';
import { googleTargetMime, uploadMimeType } from '../upload-mime.js';

describe('uploadMimeType', () => {
  it('detects by extension and falls back to octet-stream', () => {
    expect(uploadMimeType('/x/report.pdf')).toBe('application/pdf');
    expect(uploadMimeType('/x/notes.txt')).toBe('text/plain');
    expect(uploadMimeType('/x/blob')).toBe('application/octet-stream');
  });
});

describe('googleTargetMime', () => {
  it('maps office/text formats to Google types', () => {
    expect(googleTargetMime('a.docx')).toBe(GOOGLE_MIME.document);
    expect(googleTargetMime('a.MD')).toBe(GOOGLE_MIME.document);
    expect(googleTargetMime('a.csv')).toBe(GOOGLE_MIME.spreadsheet);
    expect(googleTargetMime('a.xlsx')).toBe(GOOGLE_MIME.spreadsheet);
    expect(googleTargetMime('a.pptx')).toBe(GOOGLE_MIME.presentation);
  });

  it('rejects unsupported conversions', () => {
    expect(() => googleTargetMime('a.zip')).toThrow(ValidationError);
    expect(() => googleTargetMime('README')).toThrow(/files without an extension/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/files/__tests__/upload-mime.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/files/upload-mime.ts`**

```ts
import path from 'node:path';
import { lookup } from 'mime-types';
import { ValidationError } from '../errors.js';
import { GOOGLE_MIME } from './export-formats.js';

const CONVERSIONS: Record<string, string> = {
  '.doc': GOOGLE_MIME.document,
  '.docx': GOOGLE_MIME.document,
  '.odt': GOOGLE_MIME.document,
  '.rtf': GOOGLE_MIME.document,
  '.txt': GOOGLE_MIME.document,
  '.html': GOOGLE_MIME.document,
  '.htm': GOOGLE_MIME.document,
  '.md': GOOGLE_MIME.document,
  '.xls': GOOGLE_MIME.spreadsheet,
  '.xlsx': GOOGLE_MIME.spreadsheet,
  '.ods': GOOGLE_MIME.spreadsheet,
  '.csv': GOOGLE_MIME.spreadsheet,
  '.tsv': GOOGLE_MIME.spreadsheet,
  '.ppt': GOOGLE_MIME.presentation,
  '.pptx': GOOGLE_MIME.presentation,
  '.odp': GOOGLE_MIME.presentation,
};

export function uploadMimeType(localPath: string): string {
  return lookup(localPath) || 'application/octet-stream';
}

/** Google-native target type for `convertToGoogle: true` uploads. */
export function googleTargetMime(localPath: string): string {
  const ext = path.extname(localPath).toLowerCase();
  const target = CONVERSIONS[ext];
  if (!target) {
    throw new ValidationError(
      `convertToGoogle is not supported for ${ext ? `"${ext}"` : 'files without an extension'}. Supported: ${Object.keys(CONVERSIONS).join(', ')}`,
    );
  }
  return target;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/files/__tests__/upload-mime.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/files/upload-mime.ts src/files/__tests__/upload-mime.test.ts
git commit -m "feat(files): detect upload MIME types and Google conversion targets

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 17: Audit log

**Files:**
- Create: `src/audit/audit-log.ts`
- Test: `src/audit/__tests__/audit-log.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { FileAuditLog } from '../audit-log.js';

describe('FileAuditLog', () => {
  it('appends one JSON line per entry with a timestamp, file mode 0600', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'marvin-audit-'));
    const file = path.join(dir, 'sub', 'audit.jsonl');
    const log = new FileAuditLog(file, () => new Date('2026-11-03T12:00:00.000Z'));
    await log.record({ account: 'emco', op: 'rename', fileId: 'f1', name: 'b', details: { oldName: 'a', newName: 'b' } });
    await log.record({ account: 'emco', op: 'restore', fileId: 'f2', details: {} });

    const lines = (await readFile(file, 'utf8')).trim().split('\n');
    expect(lines.map((l) => JSON.parse(l) as unknown)).toEqual([
      { ts: '2026-11-03T12:00:00.000Z', account: 'emco', op: 'rename', fileId: 'f1', name: 'b', details: { oldName: 'a', newName: 'b' } },
      { ts: '2026-11-03T12:00:00.000Z', account: 'emco', op: 'restore', fileId: 'f2', details: {} },
    ]);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/audit`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/audit/audit-log.ts`**

```ts
import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

export type AuditOp = 'upload' | 'create_folder' | 'move' | 'rename' | 'copy' | 'delete' | 'restore';

export interface AuditEntry {
  ts: string;
  /** Account alias. */
  account: string;
  op: AuditOp;
  fileId: string;
  name?: string;
  details: Record<string, unknown>;
}

export interface AuditSink {
  record(entry: Omit<AuditEntry, 'ts'>): Promise<void>;
}

/** Append-only JSONL audit trail (spec §4, §5). */
export class FileAuditLog implements AuditSink {
  constructor(
    private readonly file: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async record(entry: Omit<AuditEntry, 'ts'>): Promise<void> {
    await mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const line: AuditEntry = { ts: this.now().toISOString(), ...entry };
    await appendFile(this.file, `${JSON.stringify(line)}\n`, { mode: 0o600 });
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/audit && npm run typecheck && npx prettier --write src/audit`
Expected: PASS (Prettier reflows the long test lines).

- [ ] **Step 5: Commit**

```bash
git add src/audit
git commit -m "feat(audit): add append-only JSONL audit log

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Chunk 6: FileService — reads and mutations

### Task 18: FileService — shared test fakes and read operations

**Files:**
- Create: `src/files/file-service.ts`, `src/files/__tests__/fakes.ts`
- Test: `src/files/__tests__/file-service.read.test.ts`

- [ ] **Step 1: Create the shared fakes `src/files/__tests__/fakes.ts`**

```ts
import { vi, type Mock } from 'vitest';
import type { AuditEntry, AuditSink } from '../../audit/audit-log.js';
import type { AccountRecord } from '../../config/account-registry.js';
import type { DriveContext, DriveRunner } from '../../drive/client-factory.js';
import type { DriveAdapter } from '../../drive/drive-adapter.js';
import { createLogger, type Logger } from '../../logger.js';
import type { RetryOptions } from '../retry.js';

export const ACCOUNT: AccountRecord = {
  alias: 'emco',
  email: 'emco@example.com',
  addedAt: '2026-11-03T00:00:00.000Z',
};

export type FakeDrive = { [K in keyof DriveAdapter]: Mock<DriveAdapter[K]> };

function strict<K extends keyof DriveAdapter>(name: K): Mock<DriveAdapter[K]> {
  const impl = (() => Promise.reject(new Error(`unexpected call: ${name}`))) as unknown as DriveAdapter[K];
  return vi.fn(impl);
}

/** Every method rejects until a test stubs it — unexpected calls fail loudly. */
export function createFakeDrive(): FakeDrive {
  return {
    getFile: strict('getFile'),
    listFiles: strict('listFiles'),
    downloadMedia: strict('downloadMedia'),
    exportMedia: strict('exportMedia'),
    fetchExportLink: strict('fetchExportLink'),
    createFile: strict('createFile'),
    updateFile: strict('updateFile'),
    copyFile: strict('copyFile'),
    deleteFile: strict('deleteFile'),
  };
}

export function createRunner(drive: DriveAdapter): DriveRunner & { refs: Array<string | undefined> } {
  const refs: Array<string | undefined> = [];
  return {
    refs,
    run<T>(ref: string | undefined, fn: (ctx: DriveContext) => Promise<T>): Promise<T> {
      refs.push(ref);
      return fn({ account: ACCOUNT, drive });
    },
  };
}

export function createAudit(): AuditSink & { entries: Array<Omit<AuditEntry, 'ts'>> } {
  const entries: Array<Omit<AuditEntry, 'ts'>> = [];
  return {
    entries,
    async record(entry) {
      entries.push(entry);
    },
  };
}

export const noSleep: RetryOptions = { sleep: async () => {}, random: () => 0 };

export const silentLogger = (): Logger & { warn: Mock } => {
  const base = createLogger(() => {});
  return { ...base, warn: vi.fn() };
};

export function httpError(status: number, reason?: string, message = `HTTP ${status}`): Error {
  return Object.assign(new Error(message), {
    status,
    ...(reason ? { errors: [{ reason }] } : {}),
  });
}
```

- [ ] **Step 2: Write the failing test `src/files/__tests__/file-service.read.test.ts`**

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { NotFoundError, ValidationError } from '../../errors.js';
import { FILE_FIELDS, FileService, LIST_FIELDS } from '../file-service.js';
import {
  createAudit,
  createFakeDrive,
  createRunner,
  httpError,
  noSleep,
  silentLogger,
  type FakeDrive,
} from './fakes.js';

let drive: FakeDrive;
let runner: ReturnType<typeof createRunner>;
let service: FileService;

beforeEach(() => {
  drive = createFakeDrive();
  runner = createRunner(drive);
  service = new FileService({
    runner,
    audit: createAudit(),
    downloadsDir: '/tmp/unused',
    retry: noSleep,
    logger: silentLogger(),
  });
});

describe('FileService.list', () => {
  it('lists root children, excluding trash, with defaults', async () => {
    drive.listFiles.mockResolvedValueOnce({
      files: [{ id: 'a', name: 'A', mimeType: 'text/plain', size: '12', modifiedTime: 't', parents: ['root'] }],
      nextPageToken: 'next',
    });
    const res = await service.list({});
    expect(drive.listFiles).toHaveBeenCalledWith({
      q: "'root' in parents and trashed = false",
      pageSize: 50,
      fields: LIST_FIELDS,
    });
    expect(res).toEqual({
      files: [{ id: 'a', name: 'A', mimeType: 'text/plain', size: 12, modifiedTime: 't', parents: ['root'] }],
      nextPageToken: 'next',
    });
    expect(runner.refs).toEqual([undefined]);
  });

  it('passes account, folder, page token, trash flag and clamps pageSize', async () => {
    drive.listFiles.mockResolvedValueOnce({ files: [] });
    const res = await service.list({
      account: 'work',
      folderId: 'f1',
      pageSize: 999,
      pageToken: 'p2',
      includeTrashed: true,
    });
    expect(drive.listFiles).toHaveBeenCalledWith({
      q: "'f1' in parents",
      pageSize: 200,
      pageToken: 'p2',
      fields: LIST_FIELDS,
    });
    expect(res).toEqual({ files: [] });
    expect(runner.refs).toEqual(['work']);
  });

  it('retries transient failures', async () => {
    drive.listFiles.mockRejectedValueOnce(httpError(503)).mockResolvedValueOnce({ files: [] });
    await expect(service.list({})).resolves.toEqual({ files: [] });
    expect(drive.listFiles).toHaveBeenCalledTimes(2);
  });
});

describe('FileService.search', () => {
  it('builds the query and validates input before calling Drive', async () => {
    drive.listFiles.mockResolvedValueOnce({ files: [] });
    await service.search({ query: 'budget', pageSize: 10 });
    expect(drive.listFiles).toHaveBeenCalledWith({
      q: "(name contains 'budget' or fullText contains 'budget') and trashed = false",
      pageSize: 10,
      fields: LIST_FIELDS,
    });
    await expect(service.search({})).rejects.toThrow(ValidationError);
    expect(drive.listFiles).toHaveBeenCalledTimes(1);
  });
});

describe('FileService.getMetadata', () => {
  it('requests the standard field set', async () => {
    drive.getFile.mockResolvedValueOnce({ id: 'f1', name: 'x' });
    await expect(service.getMetadata({ fileId: 'f1' })).resolves.toEqual({ id: 'f1', name: 'x' });
    expect(drive.getFile).toHaveBeenCalledWith('f1', FILE_FIELDS);
  });

  it('maps 404 to NotFoundError', async () => {
    drive.getFile.mockRejectedValueOnce(httpError(404));
    await expect(service.getMetadata({ fileId: 'gone' })).rejects.toThrow(NotFoundError);
  });

  it('lets invalid_grant through untouched so the runner can recover', async () => {
    const grant = Object.assign(new Error('invalid_grant'), {
      response: { data: { error: 'invalid_grant' } },
    });
    drive.getFile.mockRejectedValueOnce(grant);
    await expect(service.getMetadata({ fileId: 'f1' })).rejects.toBe(grant);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run src/files/__tests__/file-service.read.test.ts`
Expected: FAIL — `../file-service.js` not found.

- [ ] **Step 4: Implement the read half of `src/files/file-service.ts`**

```ts
import type { AuditOp, AuditSink } from '../audit/audit-log.js';
import { isInvalidGrant } from '../auth/oauth-errors.js';
import type { DriveContext, DriveRunner } from '../drive/client-factory.js';
import type { DriveFile, DriveFileList } from '../drive/drive-adapter.js';
import { logger as defaultLogger, type Logger } from '../logger.js';
import { mapDriveError } from './drive-errors.js';
import { buildListQuery, buildSearchQuery, type SearchCriteria } from './query.js';
import { withRetry, type RetryClass, type RetryOptions } from './retry.js';

export const SUMMARY_FIELDS = 'id, name, mimeType, size, modifiedTime, parents';
export const LIST_FIELDS = `nextPageToken, files(${SUMMARY_FIELDS})`;
export const FILE_FIELDS =
  'id, name, mimeType, size, createdTime, modifiedTime, parents, owners(emailAddress, displayName), webViewLink, trashed, shortcutDetails';

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

export interface FileSummary {
  id: string;
  name: string;
  mimeType: string;
  size?: number;
  modifiedTime?: string;
  parents?: string[];
}

export interface ListResult {
  files: FileSummary[];
  nextPageToken?: string;
}

export interface FileServiceDeps {
  runner: DriveRunner;
  audit: AuditSink;
  downloadsDir: string;
  retry?: RetryOptions;
  logger?: Logger;
}

interface AccountInput {
  account?: string;
}

export interface ListInput extends AccountInput {
  folderId?: string;
  pageSize?: number;
  pageToken?: string;
  includeTrashed?: boolean;
}

export interface SearchInput extends AccountInput, SearchCriteria {
  pageSize?: number;
  pageToken?: string;
}

export interface FileRef extends AccountInput {
  fileId: string;
}

export function toSummary(file: DriveFile): FileSummary {
  return {
    id: file.id ?? '',
    name: file.name ?? '',
    mimeType: file.mimeType ?? '',
    ...(file.size ? { size: Number(file.size) } : {}),
    ...(file.modifiedTime ? { modifiedTime: file.modifiedTime } : {}),
    ...(file.parents ? { parents: file.parents } : {}),
  };
}

function toListResult(list: DriveFileList): ListResult {
  return {
    files: (list.files ?? []).map(toSummary),
    ...(list.nextPageToken ? { nextPageToken: list.nextPageToken } : {}),
  };
}

function clampPageSize(pageSize: number | undefined): number {
  return Math.min(Math.max(Math.trunc(pageSize ?? DEFAULT_PAGE_SIZE), 1), MAX_PAGE_SIZE);
}

export class FileService {
  protected readonly log: Logger;

  constructor(protected readonly deps: FileServiceDeps) {
    this.log = deps.logger ?? defaultLogger;
  }

  list(input: ListInput): Promise<ListResult> {
    const q = buildListQuery(input.folderId ?? 'root', input.includeTrashed ?? false);
    return this.exec(input.account, 'idempotent', input.folderId, async (ctx) =>
      toListResult(
        await ctx.drive.listFiles({
          q,
          pageSize: clampPageSize(input.pageSize),
          ...(input.pageToken ? { pageToken: input.pageToken } : {}),
          fields: LIST_FIELDS,
        }),
      ),
    );
  }

  async search(input: SearchInput): Promise<ListResult> {
    const q = buildSearchQuery(input);
    return this.exec(input.account, 'idempotent', undefined, async (ctx) =>
      toListResult(
        await ctx.drive.listFiles({
          q,
          pageSize: clampPageSize(input.pageSize),
          ...(input.pageToken ? { pageToken: input.pageToken } : {}),
          fields: LIST_FIELDS,
        }),
      ),
    );
  }

  getMetadata(input: FileRef): Promise<DriveFile> {
    return this.exec(input.account, 'idempotent', input.fileId, (ctx) =>
      ctx.drive.getFile(input.fileId, FILE_FIELDS),
    );
  }

  /** Runs `operation` for an account with retry + error mapping (invalid_grant passes through). */
  protected exec<T>(
    account: string | undefined,
    retryClass: RetryClass,
    target: string | undefined,
    operation: (ctx: DriveContext, attempt: number) => Promise<T>,
  ): Promise<T> {
    return this.deps.runner.run(account, async (ctx) => {
      try {
        return await withRetry((attempt) => operation(ctx, attempt), retryClass, this.deps.retry);
      } catch (err) {
        if (isInvalidGrant(err)) throw err;
        throw mapDriveError(err, {
          target,
          alias: ctx.account.alias,
          logger: this.log,
          createOp: retryClass === 'create',
        });
      }
    });
  }

  /** Writes an audit entry; failures are logged, never thrown (the Drive change already happened). */
  protected async recordAudit(
    ctx: DriveContext,
    op: AuditOp,
    file: { id?: string | null; name?: string | null },
    details: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.deps.audit.record({
        account: ctx.account.alias,
        op,
        fileId: file.id ?? '',
        ...(file.name ? { name: file.name } : {}),
        details,
      });
    } catch (err) {
      this.log.warn('Audit log write failed', { op, fileId: file.id, error: err });
    }
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run src/files/__tests__/file-service.read.test.ts && npm run typecheck && npx prettier --write src/files && npm run lint`
Expected: PASS. (`recordAudit` is unused until Task 19; `protected` members do not trigger `noUnusedLocals`.)

- [ ] **Step 6: Commit**

```bash
git add src/files/file-service.ts src/files/__tests__/fakes.ts src/files/__tests__/file-service.read.test.ts
git commit -m "feat(files): add FileService list, search and metadata

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 19: FileService — folder, move, rename, copy, delete, restore

**Files:**
- Modify: `src/files/file-service.ts` (add methods inside `class FileService`, imports at top)
- Test: `src/files/__tests__/file-service.mutations.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { DriveApiError, ValidationError } from '../../errors.js';
import { GOOGLE_MIME } from '../export-formats.js';
import { FileService, SUMMARY_FIELDS } from '../file-service.js';
import {
  createAudit,
  createFakeDrive,
  createRunner,
  httpError,
  noSleep,
  silentLogger,
  type FakeDrive,
} from './fakes.js';

let drive: FakeDrive;
let audit: ReturnType<typeof createAudit>;
let log: ReturnType<typeof silentLogger>;
let service: FileService;

beforeEach(() => {
  drive = createFakeDrive();
  audit = createAudit();
  log = silentLogger();
  service = new FileService({
    runner: createRunner(drive),
    audit,
    downloadsDir: '/tmp/unused',
    retry: noSleep,
    logger: log,
  });
});

describe('createFolder', () => {
  it('creates under root by default and audits', async () => {
    drive.createFile.mockResolvedValueOnce({ id: 'd1', name: 'New', mimeType: GOOGLE_MIME.folder, parents: ['root'] });
    const res = await service.createFolder({ name: 'New' });
    expect(drive.createFile).toHaveBeenCalledWith({
      requestBody: { name: 'New', mimeType: GOOGLE_MIME.folder, parents: ['root'] },
      fields: SUMMARY_FIELDS,
    });
    expect(res).toMatchObject({ id: 'd1', name: 'New' });
    expect(audit.entries).toEqual([
      { account: 'emco', op: 'create_folder', fileId: 'd1', name: 'New', details: { parentId: 'root' } },
    ]);
  });

  it('does not retry on 5xx and hints at duplicates', async () => {
    drive.createFile.mockRejectedValueOnce(httpError(500));
    await expect(service.createFolder({ name: 'X' })).rejects.toThrow(/duplicate/);
    expect(drive.createFile).toHaveBeenCalledTimes(1);
  });
});

describe('move', () => {
  it('adds the new parent and removes all old ones', async () => {
    drive.getFile.mockResolvedValueOnce({ id: 'f1', parents: ['p1', 'p2'] });
    drive.updateFile.mockResolvedValueOnce({ id: 'f1', name: 'F', parents: ['n1'] });
    const res = await service.move({ fileId: 'f1', newParentId: 'n1' });
    expect(drive.getFile).toHaveBeenCalledWith('f1', 'id, parents');
    expect(drive.updateFile).toHaveBeenCalledWith({
      fileId: 'f1',
      addParents: 'n1',
      removeParents: 'p1,p2',
      fields: SUMMARY_FIELDS,
    });
    expect(res.parents).toEqual(['n1']);
    expect(audit.entries[0]).toMatchObject({ op: 'move', details: { oldParents: ['p1', 'p2'], newParentId: 'n1' } });
  });

  it('only removes other parents when already in the target', async () => {
    drive.getFile.mockResolvedValueOnce({ id: 'f1', parents: ['n1', 'p2'] });
    drive.updateFile.mockResolvedValueOnce({ id: 'f1', parents: ['n1'] });
    await service.move({ fileId: 'f1', newParentId: 'n1' });
    expect(drive.updateFile).toHaveBeenCalledWith({ fileId: 'f1', removeParents: 'p2', fields: SUMMARY_FIELDS });
  });

  it('is a no-op when the file is already only in the target', async () => {
    drive.getFile
      .mockResolvedValueOnce({ id: 'f1', parents: ['n1'] })
      .mockResolvedValueOnce({ id: 'f1', name: 'F', parents: ['n1'] });
    await service.move({ fileId: 'f1', newParentId: 'n1' });
    expect(drive.updateFile).not.toHaveBeenCalled();
  });

  it('re-reads parents before retrying after a 5xx', async () => {
    drive.getFile
      .mockResolvedValueOnce({ id: 'f1', parents: ['p1'] })
      .mockResolvedValueOnce({ id: 'f1', parents: ['n1'] }) // first update actually succeeded
      .mockResolvedValueOnce({ id: 'f1', name: 'F', parents: ['n1'] });
    drive.updateFile.mockRejectedValueOnce(httpError(502));
    await service.move({ fileId: 'f1', newParentId: 'n1' });
    expect(drive.updateFile).toHaveBeenCalledTimes(1);
    expect(audit.entries[0]).toMatchObject({ details: { oldParents: ['p1'], newParentId: 'n1' } });
  });
});

describe('rename', () => {
  it('renames and audits old and new names', async () => {
    drive.getFile.mockResolvedValueOnce({ id: 'f1', name: 'old.txt' });
    drive.updateFile.mockResolvedValueOnce({ id: 'f1', name: 'new.txt' });
    await service.rename({ fileId: 'f1', newName: 'new.txt' });
    expect(drive.updateFile).toHaveBeenCalledWith({ fileId: 'f1', requestBody: { name: 'new.txt' }, fields: SUMMARY_FIELDS });
    expect(audit.entries[0]).toMatchObject({ op: 'rename', details: { oldName: 'old.txt', newName: 'new.txt' } });
  });

  it('keeps the original name in the audit entry after a retry', async () => {
    drive.getFile.mockResolvedValueOnce({ id: 'f1', name: 'old.txt' });
    drive.updateFile
      .mockRejectedValueOnce(httpError(503))
      .mockResolvedValueOnce({ id: 'f1', name: 'new.txt' });
    await service.rename({ fileId: 'f1', newName: 'new.txt' });
    expect(drive.getFile).toHaveBeenCalledTimes(1);
    expect(audit.entries[0]).toMatchObject({ details: { oldName: 'old.txt', newName: 'new.txt' } });
  });
});

describe('copy', () => {
  it('copies with optional name and parent', async () => {
    drive.getFile.mockResolvedValueOnce({ id: 'f1', mimeType: 'text/plain' });
    drive.copyFile.mockResolvedValueOnce({ id: 'c1', name: 'copy' });
    await service.copy({ fileId: 'f1', parentId: 'p9', name: 'copy' });
    expect(drive.copyFile).toHaveBeenCalledWith({ fileId: 'f1', requestBody: { name: 'copy', parents: ['p9'] }, fields: SUMMARY_FIELDS });
    expect(audit.entries[0]).toMatchObject({ op: 'copy', fileId: 'c1', details: { sourceId: 'f1', parentId: 'p9' } });
  });

  it('rejects folders', async () => {
    drive.getFile.mockResolvedValueOnce({ id: 'd1', mimeType: GOOGLE_MIME.folder });
    await expect(service.copy({ fileId: 'd1' })).rejects.toThrow(ValidationError);
    expect(drive.copyFile).not.toHaveBeenCalled();
  });

  it('retries a failed pre-read but not a failed copy', async () => {
    drive.getFile
      .mockRejectedValueOnce(httpError(503))
      .mockResolvedValueOnce({ id: 'f1', mimeType: 'text/plain' });
    drive.copyFile.mockRejectedValueOnce(httpError(500));
    await expect(service.copy({ fileId: 'f1' })).rejects.toThrow(/duplicate/);
    expect(drive.getFile).toHaveBeenCalledTimes(2);
    expect(drive.copyFile).toHaveBeenCalledTimes(1);
  });
});

describe('delete', () => {
  it('moves to trash by default', async () => {
    drive.updateFile.mockResolvedValueOnce({ id: 'f1', name: 'F' });
    await expect(service.delete({ fileId: 'f1' })).resolves.toEqual({ fileId: 'f1', name: 'F', permanent: false });
    expect(drive.updateFile).toHaveBeenCalledWith({ fileId: 'f1', requestBody: { trashed: true }, fields: 'id, name' });
    expect(drive.deleteFile).not.toHaveBeenCalled();
    expect(audit.entries[0]).toMatchObject({ op: 'delete', details: { permanent: false } });
  });

  it('permanent delete fetches the name first for the audit entry', async () => {
    drive.getFile.mockResolvedValueOnce({ id: 'f1', name: 'F' });
    drive.deleteFile.mockResolvedValueOnce(undefined);
    await expect(service.delete({ fileId: 'f1', permanent: true })).resolves.toEqual({ fileId: 'f1', name: 'F', permanent: true });
    expect(audit.entries[0]).toMatchObject({ op: 'delete', name: 'F', details: { permanent: true } });
  });

  it('treats a 404 on retry of a permanent delete as success', async () => {
    drive.getFile.mockResolvedValueOnce({ id: 'f1', name: 'F' });
    drive.deleteFile.mockRejectedValueOnce(httpError(500)).mockRejectedValueOnce(httpError(404));
    await expect(service.delete({ fileId: 'f1', permanent: true })).resolves.toMatchObject({ permanent: true });
    expect(drive.getFile).toHaveBeenCalledTimes(1);
  });

  it('reports a 404 on the first attempt as not found', async () => {
    drive.getFile.mockRejectedValueOnce(httpError(404));
    await expect(service.delete({ fileId: 'nope', permanent: true })).rejects.toThrow(/File not found/);
  });
});

describe('restore', () => {
  it('untrashes and audits', async () => {
    drive.updateFile.mockResolvedValueOnce({ id: 'f1', name: 'F' });
    await service.restore({ fileId: 'f1' });
    expect(drive.updateFile).toHaveBeenCalledWith({ fileId: 'f1', requestBody: { trashed: false }, fields: SUMMARY_FIELDS });
    expect(audit.entries[0]).toMatchObject({ op: 'restore', details: {} });
  });
});

describe('audit failures', () => {
  it('still succeeds and logs a warning', async () => {
    const failing = new FileService({
      runner: createRunner(drive),
      audit: { record: async () => { throw new Error('disk full'); } },
      downloadsDir: '/tmp/unused',
      retry: noSleep,
      logger: log,
    });
    drive.updateFile.mockResolvedValueOnce({ id: 'f1', name: 'F' });
    await expect(failing.restore({ fileId: 'f1' })).resolves.toMatchObject({ id: 'f1' });
    expect(log.warn).toHaveBeenCalledWith('Audit log write failed', expect.anything());
  });
});

describe('error mapping on mutations', () => {
  it('wraps unknown failures', async () => {
    drive.updateFile.mockRejectedValueOnce(httpError(400, 'badRequest'));
    await expect(service.restore({ fileId: 'f1' })).rejects.toThrow(DriveApiError);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/files/__tests__/file-service.mutations.test.ts`
Expected: FAIL — `service.createFolder is not a function` (and similar).

- [ ] **Step 3: Add imports and methods to `src/files/file-service.ts`**

Add to the imports at the top:
```ts
import { ValidationError } from '../errors.js';
import { GOOGLE_MIME } from './export-formats.js';
import { statusOf } from './drive-errors.js';
```
(Merge `statusOf` into the existing `./drive-errors.js` import line instead of adding a second line.)

Add these input types after `FileRef`:
```ts
export interface CreateFolderInput extends AccountInput {
  name: string;
  parentId?: string;
}

export interface MoveInput extends FileRef {
  newParentId: string;
}

export interface RenameInput extends FileRef {
  newName: string;
}

export interface CopyInput extends FileRef {
  parentId?: string;
  name?: string;
}

export interface DeleteInput extends FileRef {
  permanent?: boolean;
}

export interface DeleteResult {
  fileId: string;
  name?: string;
  permanent: boolean;
}
```

Add these methods inside `class FileService`, after `getMetadata`:
```ts
  createFolder(input: CreateFolderInput): Promise<FileSummary> {
    const parentId = input.parentId ?? 'root';
    return this.exec(input.account, 'create', input.parentId, async (ctx) => {
      const folder = await ctx.drive.createFile({
        requestBody: { name: input.name, mimeType: GOOGLE_MIME.folder, parents: [parentId] },
        fields: SUMMARY_FIELDS,
      });
      await this.recordAudit(ctx, 'create_folder', folder, { parentId });
      return toSummary(folder);
    });
  }

  move(input: MoveInput): Promise<FileSummary> {
    let originalParents: string[] | undefined; // first read only — used for the audit entry
    return this.exec(input.account, 'idempotent', input.fileId, async (ctx) => {
      // Re-read on every attempt: a "failed" earlier attempt may have succeeded.
      const current = await ctx.drive.getFile(input.fileId, 'id, parents');
      const oldParents = current.parents ?? [];
      originalParents ??= oldParents;
      const alreadyThere = oldParents.includes(input.newParentId);
      const toRemove = oldParents.filter((p) => p !== input.newParentId);

      const moved =
        alreadyThere && toRemove.length === 0
          ? await ctx.drive.getFile(input.fileId, SUMMARY_FIELDS)
          : await ctx.drive.updateFile({
              fileId: input.fileId,
              ...(alreadyThere ? {} : { addParents: input.newParentId }),
              ...(toRemove.length > 0 ? { removeParents: toRemove.join(',') } : {}),
              fields: SUMMARY_FIELDS,
            });
      await this.recordAudit(ctx, 'move', moved, {
        oldParents: originalParents,
        newParentId: input.newParentId,
      });
      return toSummary(moved);
    });
  }

  rename(input: RenameInput): Promise<FileSummary> {
    let originalName: string | null | undefined; // first read only — used for the audit entry
    return this.exec(input.account, 'idempotent', input.fileId, async (ctx) => {
      if (originalName === undefined) {
        originalName = (await ctx.drive.getFile(input.fileId, 'id, name')).name ?? null;
      }
      const renamed = await ctx.drive.updateFile({
        fileId: input.fileId,
        requestBody: { name: input.newName },
        fields: SUMMARY_FIELDS,
      });
      await this.recordAudit(ctx, 'rename', renamed, {
        oldName: originalName,
        newName: input.newName,
      });
      return toSummary(renamed);
    });
  }

  async copy(input: CopyInput): Promise<FileSummary> {
    // Pre-read is idempotent (retried on 5xx); only the copy itself is a non-idempotent create.
    const source = await this.exec(input.account, 'idempotent', input.fileId, (ctx) =>
      ctx.drive.getFile(input.fileId, 'id, mimeType'),
    );
    if (source.mimeType === GOOGLE_MIME.folder) {
      throw new ValidationError('Google Drive cannot copy folders');
    }
    return this.exec(input.account, 'create', input.fileId, async (ctx) => {
      const copied = await ctx.drive.copyFile({
        fileId: input.fileId,
        requestBody: {
          ...(input.name ? { name: input.name } : {}),
          ...(input.parentId ? { parents: [input.parentId] } : {}),
        },
        fields: SUMMARY_FIELDS,
      });
      await this.recordAudit(ctx, 'copy', copied, {
        sourceId: input.fileId,
        parentId: input.parentId ?? null,
      });
      return toSummary(copied);
    });
  }

  delete(input: DeleteInput): Promise<DeleteResult> {
    const permanent = input.permanent ?? false;
    if (!permanent) {
      return this.exec(input.account, 'idempotent', input.fileId, async (ctx) => {
        const trashed = await ctx.drive.updateFile({
          fileId: input.fileId,
          requestBody: { trashed: true },
          fields: 'id, name',
        });
        await this.recordAudit(ctx, 'delete', trashed, { permanent });
        return { fileId: input.fileId, ...(trashed.name ? { name: trashed.name } : {}), permanent };
      });
    }

    let name: string | undefined;
    return this.exec(input.account, 'idempotent', input.fileId, async (ctx, attempt) => {
      if (name === undefined) {
        name = (await ctx.drive.getFile(input.fileId, 'id, name')).name ?? '';
      }
      try {
        await ctx.drive.deleteFile(input.fileId);
      } catch (err) {
        // A 404 on a retry means the previous attempt deleted it.
        if (!(attempt > 0 && statusOf(err) === 404)) throw err;
      }
      await this.recordAudit(ctx, 'delete', { id: input.fileId, name }, { permanent });
      return { fileId: input.fileId, ...(name ? { name } : {}), permanent };
    });
  }

  restore(input: FileRef): Promise<FileSummary> {
    return this.exec(input.account, 'idempotent', input.fileId, async (ctx) => {
      const restored = await ctx.drive.updateFile({
        fileId: input.fileId,
        requestBody: { trashed: false },
        fields: SUMMARY_FIELDS,
      });
      await this.recordAudit(ctx, 'restore', restored, {});
      return toSummary(restored);
    });
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx prettier --write src/files && npx vitest run src/files && npm run typecheck && npm run lint`
Expected: PASS (read + mutation suites).

- [ ] **Step 5: Commit**

```bash
git add src/files/file-service.ts src/files/__tests__/file-service.mutations.test.ts
git commit -m "feat(files): add folder, move, rename, copy, delete and restore with audit

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Chunk 7: FileService — upload and download

### Task 20: FileService — upload

**Files:**
- Modify: `src/files/file-service.ts`
- Test: `src/files/__tests__/file-service.upload.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { beforeEach, describe, expect, it } from 'vitest';
import { ValidationError } from '../../errors.js';
import { GOOGLE_MIME } from '../export-formats.js';
import { FileService, SUMMARY_FIELDS } from '../file-service.js';
import {
  createAudit,
  createFakeDrive,
  createRunner,
  httpError,
  noSleep,
  silentLogger,
  type FakeDrive,
} from './fakes.js';

let dir: string;
let drive: FakeDrive;
let audit: ReturnType<typeof createAudit>;
let service: FileService;

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'marvin-upload-'));
  drive = createFakeDrive();
  audit = createAudit();
  service = new FileService({
    runner: createRunner(drive),
    audit,
    downloadsDir: dir,
    retry: noSleep,
    logger: silentLogger(),
  });
});

describe('upload', () => {
  it('streams the file with its detected MIME type and audits', async () => {
    const local = path.join(dir, 'notes.txt');
    await writeFile(local, 'hello');
    drive.createFile.mockResolvedValueOnce({ id: 'u1', name: 'notes.txt', mimeType: 'text/plain' });

    const res = await service.upload({ localPath: local, parentId: 'p1' });

    expect(res).toMatchObject({ id: 'u1', name: 'notes.txt' });
    const call = drive.createFile.mock.calls[0]?.[0];
    expect(call?.requestBody).toEqual({ name: 'notes.txt', parents: ['p1'] });
    expect(call?.fields).toBe(SUMMARY_FIELDS);
    expect(call?.media?.mimeType).toBe('text/plain');
    expect(call?.media?.body).toBeInstanceOf(Readable);
    expect(audit.entries[0]).toEqual({
      account: 'emco',
      op: 'upload',
      fileId: 'u1',
      name: 'notes.txt',
      details: { localPath: local, parentId: 'p1', size: 5, converted: false },
    });
  });

  it('converts to a Google type and honours a custom name', async () => {
    const local = path.join(dir, 'sheet.csv');
    await writeFile(local, 'a,b');
    drive.createFile.mockResolvedValueOnce({ id: 'u2', name: 'Budget' });
    await service.upload({ localPath: local, name: 'Budget', convertToGoogle: true });
    expect(drive.createFile.mock.calls[0]?.[0].requestBody).toEqual({
      name: 'Budget',
      parents: ['root'],
      mimeType: GOOGLE_MIME.spreadsheet,
    });
  });

  it('validates the local path and conversion before calling Drive', async () => {
    await expect(service.upload({ localPath: path.join(dir, 'missing.txt') })).rejects.toThrow(ValidationError);
    await expect(service.upload({ localPath: dir })).rejects.toThrow(/not a regular file/);
    const zip = path.join(dir, 'a.zip');
    await writeFile(zip, 'x');
    await expect(service.upload({ localPath: zip, convertToGoogle: true })).rejects.toThrow(ValidationError);
    expect(drive.createFile).not.toHaveBeenCalled();
  });

  it('retries rate limits with a fresh stream but never 5xx', async () => {
    const local = path.join(dir, 'a.txt');
    await writeFile(local, 'x');
    drive.createFile.mockRejectedValueOnce(httpError(429)).mockResolvedValueOnce({ id: 'u3' });
    await service.upload({ localPath: local });
    const [first, second] = drive.createFile.mock.calls.map((c) => c[0].media?.body);
    expect(first).not.toBe(second);

    drive.createFile.mockReset();
    drive.createFile.mockRejectedValueOnce(httpError(503));
    await expect(service.upload({ localPath: local })).rejects.toThrow(/duplicate/);
    expect(drive.createFile).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/files/__tests__/file-service.upload.test.ts`
Expected: FAIL — `service.upload is not a function`.

- [ ] **Step 3: Add `upload` to `src/files/file-service.ts`**

Add imports at the top:
```ts
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { googleTargetMime, uploadMimeType } from './upload-mime.js';
```

Add the input type after `DeleteResult`:
```ts
export interface UploadInput extends AccountInput {
  localPath: string;
  parentId?: string;
  name?: string;
  convertToGoogle?: boolean;
}
```

Add the method inside `class FileService`, after `restore`:
```ts
  async upload(input: UploadInput): Promise<FileSummary> {
    const localPath = path.resolve(input.localPath);
    let size: number;
    try {
      const info = await stat(localPath);
      if (!info.isFile()) throw new ValidationError(`${localPath} is not a regular file`);
      size = info.size;
    } catch (err) {
      if (err instanceof ValidationError) throw err;
      throw new ValidationError(`Cannot read ${localPath}`, { cause: err });
    }

    const convert = input.convertToGoogle ?? false;
    const parentId = input.parentId ?? 'root';
    const requestBody = {
      name: input.name ?? path.basename(localPath),
      parents: [parentId],
      ...(convert ? { mimeType: googleTargetMime(localPath) } : {}),
    };
    const mimeType = uploadMimeType(localPath);

    return this.exec(input.account, 'create', input.parentId, async (ctx) => {
      // Streaming multipart for all sizes (spec §6). A new stream per attempt.
      const body = createReadStream(localPath);
      let uploaded: DriveFile;
      try {
        uploaded = await ctx.drive.createFile({
          requestBody,
          media: { mimeType, body },
          fields: SUMMARY_FIELDS,
        });
      } catch (err) {
        body.destroy();
        throw err;
      }
      await this.recordAudit(ctx, 'upload', uploaded, {
        localPath,
        parentId,
        size,
        converted: convert,
      });
      return toSummary(uploaded);
    });
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx prettier --write src/files && npx vitest run src/files && npm run typecheck && npm run lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/files/file-service.ts src/files/__tests__/file-service.upload.test.ts
git commit -m "feat(files): add streaming upload with optional Google conversion

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 21: FileService — download

**Files:**
- Modify: `src/files/file-service.ts`
- Test: `src/files/__tests__/file-service.download.test.ts`

Implements spec §6 "Download rules" 1–7: shortcut resolution, unsupported types, binary vs export, format validation, 10 MB export fallback via `exportLinks`, safe destination + no overwrite + `.part` cleanup.

- [ ] **Step 1: Write the failing test**

```ts
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { beforeEach, describe, expect, it } from 'vitest';
import { ExportTooLargeError, UnsupportedTypeError, ValidationError } from '../../errors.js';
import { GOOGLE_MIME } from '../export-formats.js';
import { FileService } from '../file-service.js';
import {
  createAudit,
  createFakeDrive,
  createRunner,
  httpError,
  noSleep,
  silentLogger,
  type FakeDrive,
} from './fakes.js';

const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

let dir: string;
let drive: FakeDrive;
let service: FileService;

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'marvin-download-'));
  drive = createFakeDrive();
  service = new FileService({
    runner: createRunner(drive),
    audit: createAudit(),
    downloadsDir: dir,
    retry: noSleep,
    logger: silentLogger(),
  });
});

const stream = (text: string): Readable => Readable.from([text]);

describe('download', () => {
  it('downloads binary files as-is into the default directory', async () => {
    drive.getFile.mockResolvedValueOnce({ id: 'f1', name: 'report.pdf', mimeType: 'application/pdf' });
    drive.downloadMedia.mockResolvedValueOnce(stream('PDF'));
    const res = await service.download({ fileId: 'f1' });
    expect(res).toEqual({ path: path.join(dir, 'report.pdf'), size: 3, mimeType: 'application/pdf', exportFormat: null });
    expect(await readFile(res.path, 'utf8')).toBe('PDF');
  });

  it('exports Google Docs with the default format and extension', async () => {
    drive.getFile.mockResolvedValueOnce({ id: 'd1', name: 'Plan', mimeType: GOOGLE_MIME.document });
    drive.exportMedia.mockResolvedValueOnce(stream('DOCX'));
    const res = await service.download({ fileId: 'd1' });
    expect(drive.exportMedia).toHaveBeenCalledWith('d1', DOCX);
    expect(res).toMatchObject({ path: path.join(dir, 'Plan.docx'), exportFormat: 'docx' });
  });

  it('honours exportFormat and rejects invalid combinations without writing', async () => {
    drive.getFile.mockResolvedValue({ id: 'd1', name: 'Plan', mimeType: GOOGLE_MIME.document });
    drive.exportMedia.mockResolvedValueOnce(stream('# md'));
    const res = await service.download({ fileId: 'd1', exportFormat: 'md' });
    expect(drive.exportMedia).toHaveBeenCalledWith('d1', 'text/markdown');
    expect(path.basename(res.path)).toBe('Plan.md');

    drive.getFile.mockResolvedValue({ id: 's1', name: 'Sheet', mimeType: GOOGLE_MIME.spreadsheet });
    await expect(service.download({ fileId: 's1', exportFormat: 'md' })).rejects.toThrow(ValidationError);
    expect(await readdir(dir)).toEqual(['Plan.md']);
  });

  it('resolves shortcuts to their target', async () => {
    drive.getFile
      .mockResolvedValueOnce({ id: 's1', name: 'link', mimeType: GOOGLE_MIME.shortcut, shortcutDetails: { targetId: 't1' } })
      .mockResolvedValueOnce({ id: 't1', name: 'target.txt', mimeType: 'text/plain' });
    drive.downloadMedia.mockResolvedValueOnce(stream('T'));
    const res = await service.download({ fileId: 's1' });
    expect(drive.downloadMedia).toHaveBeenCalledWith('t1');
    expect(path.basename(res.path)).toBe('target.txt');
  });

  it('rejects folders and other non-exportable Google types', async () => {
    drive.getFile.mockResolvedValueOnce({ id: 'd1', name: 'Folder', mimeType: GOOGLE_MIME.folder });
    await expect(service.download({ fileId: 'd1' })).rejects.toThrow(UnsupportedTypeError);
  });

  it('never overwrites existing files', async () => {
    await writeFile(path.join(dir, 'report.pdf'), 'old');
    drive.getFile.mockResolvedValueOnce({ id: 'f1', name: 'report.pdf', mimeType: 'application/pdf' });
    drive.downloadMedia.mockResolvedValueOnce(stream('new'));
    const res = await service.download({ fileId: 'f1' });
    expect(path.basename(res.path)).toBe('report (1).pdf');
    expect(await readFile(path.join(dir, 'report.pdf'), 'utf8')).toBe('old');
  });

  it('keeps hostile names inside the destination directory', async () => {
    drive.getFile.mockResolvedValueOnce({ id: 'x1', name: '../../.zshrc', mimeType: 'text/plain' });
    drive.downloadMedia.mockResolvedValueOnce(stream('evil'));
    const res = await service.download({ fileId: 'x1' });
    expect(path.dirname(res.path)).toBe(dir);
    expect(path.basename(res.path)).toBe('_.._.zshrc');
  });

  it('writes to an explicit full file path', async () => {
    drive.getFile.mockResolvedValueOnce({ id: 'f1', name: 'report.pdf', mimeType: 'application/pdf' });
    drive.downloadMedia.mockResolvedValueOnce(stream('PDF'));
    const target = path.join(dir, 'sub', 'custom.pdf');
    const res = await service.download({ fileId: 'f1', destPath: target });
    expect(res.path).toBe(target);
  });

  it('falls back to exportLinks when the export exceeds 10 MB', async () => {
    drive.getFile.mockResolvedValueOnce({
      id: 'd1',
      name: 'Big',
      mimeType: GOOGLE_MIME.document,
      webViewLink: 'https://docs/d1',
      exportLinks: { [DOCX]: 'https://export/d1.docx' },
    });
    drive.exportMedia.mockRejectedValueOnce(httpError(403, 'exportSizeLimitExceeded'));
    drive.fetchExportLink.mockResolvedValueOnce(stream('BIG'));
    const res = await service.download({ fileId: 'd1' });
    expect(drive.fetchExportLink).toHaveBeenCalledWith('https://export/d1.docx');
    expect(await readFile(res.path, 'utf8')).toBe('BIG');
  });

  it('reports ExportTooLargeError with the web link when the fallback fails', async () => {
    drive.getFile.mockResolvedValueOnce({
      id: 'd1',
      name: 'Big',
      mimeType: GOOGLE_MIME.document,
      webViewLink: 'https://docs/d1',
      exportLinks: { [DOCX]: 'https://export/d1.docx' },
    });
    drive.exportMedia.mockRejectedValueOnce(httpError(403, 'exportSizeLimitExceeded'));
    drive.fetchExportLink.mockRejectedValueOnce(httpError(403));
    const err = await service.download({ fileId: 'd1' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ExportTooLargeError);
    expect((err as Error).message).toContain('https://docs/d1');
    expect(await readdir(dir)).toEqual([]);
  });

  it('cleans up the partial file when the stream breaks', async () => {
    drive.getFile.mockResolvedValueOnce({ id: 'f1', name: 'big.bin', mimeType: 'application/octet-stream' });
    drive.downloadMedia.mockResolvedValueOnce(
      new Readable({
        read() {
          this.destroy(new Error('socket hang up'));
        },
      }),
    );
    await expect(service.download({ fileId: 'f1' })).rejects.toThrow(/socket hang up/);
    expect(await readdir(dir)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/files/__tests__/file-service.download.test.ts`
Expected: FAIL — `service.download is not a function`.

- [ ] **Step 3: Add `download` to `src/files/file-service.ts`**

Update imports at the top:
- add `import type { Readable } from 'node:stream';`
- extend the errors import: `import { ExportTooLargeError, NotFoundError, ValidationError } from '../errors.js';`
- extend the export-formats import: `import { GOOGLE_MIME, resolveExport, type ExportFormat, type ExportPlan } from './export-formats.js';`
- extend the drive-errors import: `import { mapDriveError, reasonOf, statusOf } from './drive-errors.js';`
- add `import { resolveDestination, writeUnique } from './destination.js';`

Add after the other field constants:
```ts
const DOWNLOAD_FIELDS = 'id, name, mimeType, size, webViewLink, shortcutDetails, exportLinks';
```

Add types after `UploadInput`:
```ts
export interface DownloadInput extends FileRef {
  destPath?: string;
  exportFormat?: ExportFormat;
}

export interface DownloadResult {
  path: string;
  size: number;
  mimeType: string;
  exportFormat: ExportFormat | null;
}
```

Add inside `class FileService`, after `upload`:
```ts
  download(input: DownloadInput): Promise<DownloadResult> {
    return this.exec(input.account, 'idempotent', input.fileId, async (ctx) => {
      let file = await ctx.drive.getFile(input.fileId, DOWNLOAD_FIELDS);
      if (file.mimeType === GOOGLE_MIME.shortcut) {
        const targetId = file.shortcutDetails?.targetId;
        if (!targetId) throw new NotFoundError(input.fileId);
        file = await ctx.drive.getFile(targetId, DOWNLOAD_FIELDS);
      }
      const fileId = file.id ?? input.fileId;
      const mimeType = file.mimeType ?? 'application/octet-stream';
      const plan = resolveExport(mimeType, input.exportFormat);

      const destination = await resolveDestination({
        ...(input.destPath !== undefined ? { destPath: input.destPath } : {}),
        defaultDir: this.deps.downloadsDir,
        driveName: file.name ?? '',
        fileId,
        ...(plan ? { extension: plan.extension } : {}),
      });
      const written = await writeUnique(destination, () =>
        plan ? this.openExport(ctx, fileId, plan, file) : ctx.drive.downloadMedia(fileId),
      );
      return { path: written.path, size: written.size, mimeType, exportFormat: plan?.format ?? null };
    });
  }

  private async openExport(
    ctx: DriveContext,
    fileId: string,
    plan: ExportPlan,
    file: DriveFile,
  ): Promise<Readable> {
    try {
      return await ctx.drive.exportMedia(fileId, plan.mimeType);
    } catch (err) {
      if (reasonOf(err) !== 'exportSizeLimitExceeded') throw err;
      const link = file.exportLinks?.[plan.mimeType];
      if (link) {
        try {
          return await ctx.drive.fetchExportLink(link);
        } catch (fallbackErr) {
          this.log.warn('exportLinks fallback failed', { fileId, error: fallbackErr });
        }
      }
      throw new ExportTooLargeError(file.webViewLink ?? null, { cause: err });
    }
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx prettier --write src/files && npx vitest run src/files && npm run typecheck && npm run lint`
Expected: PASS for all FileService suites.

- [ ] **Step 5: Commit**

```bash
git add src/files/file-service.ts src/files/__tests__/file-service.download.test.ts
git commit -m "feat(files): add download with export rules, size fallback and safe paths

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Chunk 8: MCP server, CLI, docs and live verification

### Task 22: MCP server (12 tools)

**Files:**
- Create: `src/mcp/server.ts`
- Test: `src/mcp/__tests__/server.test.ts`

MCP SDK 1.32 API: `new McpServer({ name, version })`, `server.registerTool(name, { description, inputSchema: <zod raw shape> }, handler)`. The handler returns `{ content: [{ type: 'text', text }], isError?: boolean }`. Errors are returned as tool results with `isError: true` (spec §6), never thrown. Tests use `InMemoryTransport.createLinkedPair()` and the SDK `Client`.

- [ ] **Step 1: Write the failing test**

```ts
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { beforeEach, describe, expect, it } from 'vitest';
import type { AccountStatusEntry } from '../../auth/auth-service.js';
import { ReauthRequiredError } from '../../errors.js';
import { FileService } from '../../files/file-service.js';
import {
  createAudit,
  createFakeDrive,
  createRunner,
  noSleep,
  silentLogger,
  type FakeDrive,
} from '../../files/__tests__/fakes.js';
import { TOOL_NAMES, createMcpServer } from '../server.js';

let drive: FakeDrive;
let client: Client;
let statuses: AccountStatusEntry[];
let verifyArgs: boolean[];

async function connect(files: FileService): Promise<Client> {
  const server = createMcpServer({
    files,
    auth: {
      status: async (verify?: boolean) => {
        verifyArgs.push(verify ?? false);
        return statuses;
      },
    },
    version: '0.0.0-test',
    logger: silentLogger(),
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const c = new Client({ name: 'test', version: '0.0.0' });
  await c.connect(clientTransport);
  return c;
}

function textOf(result: unknown): string {
  const content = (result as { content: Array<{ type: string; text?: string }> }).content;
  return content[0]?.text ?? '';
}

beforeEach(async () => {
  drive = createFakeDrive();
  statuses = [{ alias: 'emco', email: 'emco@example.com', isDefault: true, status: 'ok' }];
  verifyArgs = [];
  const files = new FileService({
    runner: createRunner(drive),
    audit: createAudit(),
    downloadsDir: '/tmp/unused',
    retry: noSleep,
    logger: silentLogger(),
  });
  client = await connect(files);
});

describe('MCP server', () => {
  it('exposes the 12 tools from the spec', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...TOOL_NAMES].sort());
    expect(TOOL_NAMES).toHaveLength(12);
    const list = tools.find((t) => t.name === 'drive_list');
    expect(list?.inputSchema.properties).toHaveProperty('account');
    expect(list?.inputSchema.properties).toHaveProperty('folderId');
  });

  it('returns JSON text for successful calls', async () => {
    drive.listFiles.mockResolvedValueOnce({ files: [{ id: 'a', name: 'A', mimeType: 'text/plain' }] });
    const res = await client.callTool({ name: 'drive_list', arguments: { folderId: 'root' } });
    expect(res.isError).toBeFalsy();
    expect(JSON.parse(textOf(res))).toEqual({ files: [{ id: 'a', name: 'A', mimeType: 'text/plain' }] });
  });

  it('lists accounts and forwards verify', async () => {
    const res = await client.callTool({ name: 'drive_list_accounts', arguments: { verify: true } });
    expect(JSON.parse(textOf(res))).toEqual(statuses);
    expect(verifyArgs).toEqual([true]);
  });

  it('returns AppError messages as isError results', async () => {
    const files = new FileService({
      runner: {
        run: async () => {
          throw new ReauthRequiredError('emco');
        },
      },
      audit: createAudit(),
      downloadsDir: '/tmp/unused',
      logger: silentLogger(),
    });
    const c = await connect(files);
    const res = await c.callTool({ name: 'drive_get_metadata', arguments: { fileId: 'f1' } });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toBe('Session for "emco" expired. Run: marvin-drive auth login emco');
  });

  it('hides unexpected error details', async () => {
    const server = createMcpServer({
      files: new FileService({
        runner: createRunner(drive),
        audit: createAudit(),
        downloadsDir: '/tmp/unused',
        logger: silentLogger(),
      }),
      auth: {
        status: async () => {
          throw new TypeError('secret internal detail');
        },
      },
      version: '0.0.0-test',
      logger: silentLogger(),
    });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    const c = new Client({ name: 'test', version: '0.0.0' });
    await c.connect(ct);
    const res = await c.callTool({ name: 'drive_list_accounts', arguments: {} });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toBe('Unexpected internal error; see the server log (stderr).');
  });

  it('rejects arguments that violate the schema', async () => {
    const outcome = await client
      .callTool({ name: 'drive_list', arguments: { pageSize: 500 } })
      .then((res) => ({ isError: res.isError === true }))
      .catch(() => ({ isError: true }));
    expect(outcome.isError).toBe(true);
    expect(drive.listFiles).not.toHaveBeenCalled();
  });
});
```


- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/mcp`
Expected: FAIL — `../server.js` not found.

- [ ] **Step 3: Implement `src/mcp/server.ts`**

```ts
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { AuthService } from '../auth/auth-service.js';
import { AppError } from '../errors.js';
import { EXPORT_FORMATS } from '../files/export-formats.js';
import type { FileService } from '../files/file-service.js';
import { logger as defaultLogger, type Logger } from '../logger.js';

export const TOOL_NAMES = [
  'drive_list_accounts',
  'drive_list',
  'drive_search',
  'drive_get_metadata',
  'drive_download',
  'drive_upload',
  'drive_create_folder',
  'drive_move',
  'drive_rename',
  'drive_copy',
  'drive_delete',
  'drive_restore',
] as const;

export interface McpDeps {
  files: FileService;
  auth: Pick<AuthService, 'status'>;
  version: string;
  logger?: Logger;
}

const account = z
  .string()
  .min(1)
  .optional()
  .describe('Account alias or email. Omit to use the default account.');
const fileId = z.string().min(1).describe('Google Drive file or folder ID');
const pageSize = z.number().int().min(1).max(200).optional().describe('Results per page (default 50)');
const pageToken = z.string().min(1).optional().describe('nextPageToken from a previous call');

async function respond(log: Logger, run: () => Promise<unknown>): Promise<CallToolResult> {
  try {
    const data = await run();
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
  } catch (err) {
    if (err instanceof AppError) {
      return { content: [{ type: 'text', text: err.message }], isError: true };
    }
    log.error('Unexpected tool failure', { error: err });
    return {
      content: [{ type: 'text', text: 'Unexpected internal error; see the server log (stderr).' }],
      isError: true,
    };
  }
}

export function createMcpServer(deps: McpDeps): McpServer {
  const log = deps.logger ?? defaultLogger;
  const { files } = deps;
  const server = new McpServer({ name: 'marvin-drive', version: deps.version });

  server.registerTool(
    'drive_list_accounts',
    {
      description:
        'List registered Google accounts, the default, and token status (ok / reauth_required). verify=true does a live token refresh.',
      inputSchema: { verify: z.boolean().optional() },
    },
    async ({ verify }) => respond(log, () => deps.auth.status(verify ?? false)),
  );

  server.registerTool(
    'drive_list',
    {
      description: 'List files in a folder (default: My Drive root). Excludes trash unless includeTrashed.',
      inputSchema: {
        account,
        folderId: z.string().min(1).optional().describe('Folder ID (default "root")'),
        pageSize,
        pageToken,
        includeTrashed: z.boolean().optional(),
      },
    },
    async (args) => respond(log, () => files.list(args)),
  );

  server.registerTool(
    'drive_search',
    {
      description:
        'Search files. query matches names and full text; rawQuery is raw Drive query syntax (ANDed). Excludes trash unless rawQuery mentions "trashed".',
      inputSchema: {
        account,
        query: z.string().optional(),
        mimeType: z.string().optional(),
        modifiedAfter: z.string().optional().describe('ISO 8601 date or datetime'),
        rawQuery: z.string().optional(),
        pageSize,
        pageToken,
      },
    },
    async (args) => respond(log, () => files.search(args)),
  );

  server.registerTool(
    'drive_get_metadata',
    {
      description: 'Get metadata for a file: owners, parents, size, link, trashed.',
      inputSchema: { account, fileId },
    },
    async (args) => respond(log, () => files.getMetadata(args)),
  );

  server.registerTool(
    'drive_download',
    {
      description:
        'Download a file to local disk and return its path. Google Docs/Sheets/Slides/Drawings are exported (defaults docx/xlsx/pptx/png). Never overwrites.',
      inputSchema: {
        account,
        fileId,
        destPath: z
          .string()
          .min(1)
          .optional()
          .describe(
            'Absolute directory (existing or ending with "/") or absolute file path; ~ allowed. Default ~/Downloads/marvin-drive/',
          ),
        exportFormat: z.enum(EXPORT_FORMATS).optional(),
      },
    },
    async (args) => respond(log, () => files.download(args)),
  );

  server.registerTool(
    'drive_upload',
    {
      description: 'Upload a local file. convertToGoogle turns office/text/csv files into Google Docs/Sheets/Slides.',
      inputSchema: {
        account,
        localPath: z.string().min(1).describe('Absolute local file path (~ is not expanded)'),
        parentId: z.string().min(1).optional().describe('Destination folder ID (default root)'),
        name: z.string().min(1).optional(),
        convertToGoogle: z.boolean().optional(),
      },
    },
    async (args) => respond(log, () => files.upload(args)),
  );

  server.registerTool(
    'drive_create_folder',
    {
      description: 'Create a folder (default parent: root).',
      inputSchema: { account, name: z.string().min(1), parentId: z.string().min(1).optional() },
    },
    async (args) => respond(log, () => files.createFolder(args)),
  );

  server.registerTool(
    'drive_move',
    {
      description: 'Move a file or folder into newParentId (removes it from all other parents).',
      inputSchema: { account, fileId, newParentId: z.string().min(1) },
    },
    async (args) => respond(log, () => files.move(args)),
  );

  server.registerTool(
    'drive_rename',
    {
      description: 'Rename a file or folder.',
      inputSchema: { account, fileId, newName: z.string().min(1) },
    },
    async (args) => respond(log, () => files.rename(args)),
  );

  server.registerTool(
    'drive_copy',
    {
      description: 'Copy a file (folders cannot be copied).',
      inputSchema: {
        account,
        fileId,
        parentId: z.string().min(1).optional(),
        name: z.string().min(1).optional(),
      },
    },
    async (args) => respond(log, () => files.copy(args)),
  );

  server.registerTool(
    'drive_delete',
    {
      description:
        'Delete a file or folder. Default moves it to trash (restorable for 30 days); permanent=true deletes forever.',
      inputSchema: { account, fileId, permanent: z.boolean().optional() },
    },
    async (args) => respond(log, () => files.delete(args)),
  );

  server.registerTool(
    'drive_restore',
    {
      description: 'Restore a file or folder from trash.',
      inputSchema: { account, fileId },
    },
    async (args) => respond(log, () => files.restore(args)),
  );

  return server;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx prettier --write src/mcp && npx vitest run src/mcp && npm run typecheck && npm run lint`
Expected: PASS. If typecheck rejects `files.list(args)` because zod-inferred optional props are `T | undefined`, that is fine under this tsconfig (`exactOptionalPropertyTypes` is off) — if it still fails, read the error; do not add casts to `any`.

- [ ] **Step 5: Commit**

```bash
git add src/mcp
git commit -m "feat(mcp): expose 12 Drive tools over MCP with isError results

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 23: Composition root and CLI

**Files:**
- Create: `src/app.ts`, `src/cli/main.ts`, `src/cli/format.ts`
- Test: `src/cli/__tests__/format.test.ts`

The CLI wiring itself is verified by a build + smoke run (Step 6); the only logic (table formatting) is unit-tested.

- [ ] **Step 1: Write the failing test `src/cli/__tests__/format.test.ts`**

```ts
import { describe, expect, it } from 'vitest';
import { formatAccounts } from '../format.js';

describe('formatAccounts', () => {
  it('marks the default and shows status', () => {
    expect(
      formatAccounts([
        { alias: 'emco', email: 'emco@example.com', isDefault: true, status: 'ok' },
        { alias: 'work', email: 'work@example.com', isDefault: false, status: 'reauth_required' },
      ]),
    ).toBe(
      [
        '* emco                 emco@example.com                     ok',
        '  work                 work@example.com                     reauth_required',
      ].join('\n'),
    );
  });

  it('explains how to add the first account', () => {
    expect(formatAccounts([])).toBe('No accounts. Run: marvin-drive auth add');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/cli`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/cli/format.ts`**

```ts
import type { AccountStatusEntry } from '../auth/auth-service.js';

export function formatAccounts(entries: AccountStatusEntry[]): string {
  if (entries.length === 0) return 'No accounts. Run: marvin-drive auth add';
  return entries
    .map((e) => `${e.isDefault ? '*' : ' '} ${e.alias.padEnd(20)} ${e.email.padEnd(36)} ${e.status}`)
    .join('\n');
}
```

Run: `npx vitest run src/cli`
Expected: PASS.

- [ ] **Step 4: Implement `src/app.ts`**

```ts
import open from 'open';
import { AuthService } from './auth/auth-service.js';
import { KeychainTokenStore } from './auth/keychain-token-store.js';
import { runLoginFlow } from './auth/login-flow.js';
import { FileAuditLog } from './audit/audit-log.js';
import { AccountRegistry } from './config/account-registry.js';
import { loadClientSecret } from './config/client-secret.js';
import { resolvePaths, type Paths } from './config/paths.js';
import { DriveClientFactory } from './drive/client-factory.js';
import { FileService } from './files/file-service.js';

export interface App {
  paths: Paths;
  auth: AuthService;
  files: FileService;
}

/** Composition root: wires real implementations together. */
export function buildApp(env: NodeJS.ProcessEnv = process.env): App {
  const paths = resolvePaths(env);
  const auth = new AuthService({
    registry: new AccountRegistry(paths.accounts),
    tokens: new KeychainTokenStore(),
    loadCredentials: () => loadClientSecret(paths.clientSecret),
    login: ({ credentials, loginHint }) =>
      runLoginFlow({
        clientId: credentials.clientId,
        clientSecret: credentials.clientSecret,
        ...(loginHint ? { loginHint } : {}),
        openUrl: async (url) => {
          await open(url);
        },
        print: (message) => {
          process.stderr.write(`${message}\n`);
        },
      }),
  });
  const files = new FileService({
    runner: new DriveClientFactory(auth),
    audit: new FileAuditLog(paths.audit),
    downloadsDir: paths.downloadsDir,
  });
  return { paths, auth, files };
}
```

- [ ] **Step 5: Implement `src/cli/main.ts`**

```ts
#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { Command } from 'commander';
import { buildApp } from '../app.js';
import { createMcpServer } from '../mcp/server.js';
import { VERSION } from '../version.js';
import { formatAccounts } from './format.js';

const TESTING_MODE_HINT =
  'Note: while the OAuth app is in Testing mode, the Google account must be listed under Audience → Test users, and the login expires every 7 days.';

function out(line: string): void {
  process.stdout.write(`${line}\n`);
}

const program = new Command()
  .name('marvin-drive')
  .description('Multi-account Google Drive MCP server and CLI')
  .version(VERSION);

const auth = program.command('auth').description('Manage Google accounts');

auth
  .command('add')
  .description('Sign in with a Google account and register it')
  .option('--alias <alias>', 'short name for the account (default: email local part)')
  .action(async (opts: { alias?: string }) => {
    process.stderr.write(`${TESTING_MODE_HINT}\n`);
    const record = await buildApp().auth.addAccount(opts.alias);
    out(`Added ${record.alias} (${record.email})`);
  });

auth
  .command('login')
  .description('Sign in again for an existing account (expired session)')
  .argument('<account>', 'alias or email')
  .action(async (ref: string) => {
    process.stderr.write(`${TESTING_MODE_HINT}\n`);
    const record = await buildApp().auth.relogin(ref);
    out(`Signed in again: ${record.alias} (${record.email})`);
  });

auth
  .command('list')
  .description('List accounts and token status')
  .option('--verify', 'perform a live token refresh per account')
  .action(async (opts: { verify?: boolean }) => {
    out(formatAccounts(await buildApp().auth.status(opts.verify ?? false)));
  });

auth
  .command('remove')
  .description('Remove an account and revoke its token')
  .argument('<account>', 'alias or email')
  .action(async (ref: string) => {
    const record = await buildApp().auth.removeAccount(ref);
    out(`Removed ${record.alias} (${record.email})`);
  });

auth
  .command('default')
  .description('Set the default account')
  .argument('<account>', 'alias or email')
  .action(async (ref: string) => {
    const record = await buildApp().auth.setDefault(ref);
    out(`Default account: ${record.alias} (${record.email})`);
  });

program
  .command('serve')
  .description('Run the MCP server on stdio (used by Claude Code)')
  .action(async () => {
    const app = buildApp();
    const server = createMcpServer({ files: app.files, auth: app.auth, version: VERSION });
    await server.connect(new StdioServerTransport());
  });

program.parseAsync().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
});
```

- [ ] **Step 6: Build and smoke-test the CLI**

Run:
```bash
npm run build && chmod +x dist/cli/main.js
node dist/cli/main.js --help
MARVIN_DRIVE_CONFIG_DIR="$(mktemp -d)" node dist/cli/main.js auth list
MARVIN_DRIVE_CONFIG_DIR="$(mktemp -d)" node dist/cli/main.js auth add; echo "exit=$?"
```
Expected:
- `--help` lists `auth` and `serve`.
- `auth list` prints `No accounts. Run: marvin-drive auth add` (empty temp config dir).
- The last command prints the Testing-mode note, then `OAuth client file not found at /…/client_secret.json …` and `exit=1` (empty config dir → clear ConfigError, no browser opened).

Then the MCP handshake over stdio:
```bash
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}' | node dist/cli/main.js serve | head -c 300; echo
```
Expected: a JSON-RPC response containing `"serverInfo":{"name":"marvin-drive"` on stdout (and nothing else on stdout).

- [ ] **Step 7: Run the full check and commit**

Run: `npx prettier --write src && npm run check`
Expected: typecheck, lint, format check and all tests pass.

```bash
git add src/app.ts src/cli
git commit -m "feat(cli): add marvin-drive CLI with auth commands and MCP serve

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 24: Docs, real login, Claude Code registration, E2E

**Files:**
- Create: `README.md`, `docs/CHANGELOG.md`, `tests/e2e/drive.e2e.test.ts`
- Modify: `docs/FEATURES.md`

- [ ] **Step 1: Write `tests/e2e/drive.e2e.test.ts`**

```ts
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';

const account = process.env.MARVIN_E2E_ACCOUNT;

describe.runIf(account)('Drive E2E (live)', () => {
  it('folder → upload → move → rename → search → download → export → trash → restore → delete', async () => {
    const { files } = buildApp();
    const root = await files.createFolder({ account, name: `marvin-e2e-${Date.now()}` });
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'marvin-e2e-'));
    try {
      const sub = await files.createFolder({ account, name: 'sub', parentId: root.id });
      const local = path.join(tmp, 'hello.txt');
      await writeFile(local, 'hello drive');

      const up = await files.upload({ account, localPath: local, parentId: root.id });
      const moved = await files.move({ account, fileId: up.id, newParentId: sub.id });
      expect(moved.parents).toEqual([sub.id]);

      const renamed = await files.rename({ account, fileId: up.id, newName: 'renamed.txt' });
      expect(renamed.name).toBe('renamed.txt');

      const found = await files.search({ account, rawQuery: `'${sub.id}' in parents` });
      expect(found.files.map((f) => f.id)).toContain(up.id);

      const dl = await files.download({ account, fileId: up.id, destPath: `${tmp}/` });
      expect(await readFile(dl.path, 'utf8')).toBe('hello drive');

      const doc = await files.upload({
        account,
        localPath: local,
        parentId: root.id,
        name: 'as-doc',
        convertToGoogle: true,
      });
      const md = await files.download({ account, fileId: doc.id, destPath: `${tmp}/`, exportFormat: 'md' });
      expect(path.extname(md.path)).toBe('.md');
      expect(await readFile(md.path, 'utf8')).toContain('hello drive');

      await files.delete({ account, fileId: up.id });
      expect((await files.getMetadata({ account, fileId: up.id })).trashed).toBe(true);
      await files.restore({ account, fileId: up.id });
      expect((await files.getMetadata({ account, fileId: up.id })).trashed).toBe(false);
    } finally {
      await files.delete({ account, fileId: root.id, permanent: true });
      await rm(tmp, { recursive: true, force: true });
    }
  });
});
```

Run: `npm run typecheck && npx vitest run --config vitest.e2e.config.ts`
Expected: typecheck passes; the E2E suite is skipped (no `MARVIN_E2E_ACCOUNT`).

- [ ] **Step 2: Write `README.md`**

````markdown
# Marvin Drive MCP Handler

Local MCP server + CLI that lets Claude Code manage files in one or more Google Drive accounts through your own Google OAuth client.

## Requirements

- macOS (tokens are stored in the login Keychain), Node.js ≥ 22.12
- A Google Cloud project with **Google Drive API** enabled and an OAuth client of type **Desktop app**
- While the OAuth app is in **Testing** mode: every account must be listed under *Google Auth Platform → Audience → Test users*, and logins expire after 7 days (re-run `auth login`)

## Setup

```bash
npm install
npm run build
mkdir -p ~/.config/google-handler && chmod 700 ~/.config/google-handler
# Save the Desktop client JSON as ~/.config/google-handler/client_secret.json (chmod 600)
npm link            # puts `marvin-drive` on PATH (optional; otherwise use `node dist/cli/main.js`)
marvin-drive auth add --alias emco
```

Error messages refer to `marvin-drive …`; without `npm link`, run the same command as `node dist/cli/main.js …`.

## Register with Claude Code

```bash
claude mcp add marvin-drive --scope user -- node "$PWD/dist/cli/main.js" serve
```

## CLI

| Command | Purpose |
|---|---|
| `marvin-drive auth add [--alias a]` | Browser login, register account (first = default) |
| `marvin-drive auth login <alias>` | Re-login an expired account |
| `marvin-drive auth list [--verify]` | Accounts and token status |
| `marvin-drive auth remove <alias>` | Remove account, delete + revoke token |
| `marvin-drive auth default <alias>` | Set the default account |
| `marvin-drive serve` | MCP server on stdio |

## MCP tools

All tools accept an optional `account` (alias or email).

| Tool | Purpose |
|---|---|
| `drive_list_accounts` | Accounts, default, token status (`verify` for a live check) |
| `drive_list` | Folder contents (default root), paginated |
| `drive_search` | Name/full-text search, mimeType, modifiedAfter, raw Drive query |
| `drive_get_metadata` | Owners, parents, size, link, trashed |
| `drive_download` | Download / export (Docs→docx, Sheets→xlsx, Slides→pptx; `md`, `pdf`, `csv`… on request). Never overwrites |
| `drive_upload` | Upload a local file, optionally converting to Google format |
| `drive_create_folder`, `drive_move`, `drive_rename`, `drive_copy` | Organize files |
| `drive_delete` | Trash by default; `permanent: true` deletes forever |
| `drive_restore` | Restore from trash |

## Files

| Path | Content |
|---|---|
| `~/.config/google-handler/client_secret.json` | OAuth client (never commit) |
| `~/.config/google-handler/accounts.json` | Aliases and emails (no secrets) |
| `~/.config/google-handler/audit.jsonl` | Every mutating operation |
| Keychain service `marvin-drive` | Refresh tokens |
| `~/Downloads/marvin-drive/` | Default download folder |

## Development

```bash
npm run check                                   # typecheck, lint, format, unit + integration tests
MARVIN_KEYCHAIN_TEST=1 npx vitest run src/auth  # real Keychain round-trip
MARVIN_E2E_ACCOUNT=emco npm run test:e2e        # live Drive test (creates and deletes a temp folder)
```
````

- [ ] **Step 3: Write `docs/CHANGELOG.md`**

```markdown
# Changelog

## 0.1.0 — 2026-11-03

### Added
- Multi-account Google OAuth (loopback + PKCE) with Keychain token storage and automatic recovery after re-login.
- File operations: list, search, metadata, download/export, upload, create folder, move, rename, copy, delete (trash/permanent), restore.
- MCP server with 12 tools; `marvin-drive` CLI for account management.
- JSONL audit log for all mutating operations.
```

- [ ] **Step 4: Update `docs/FEATURES.md`**

(The upload line already reads `upload (streaming multipart; resumable deferred)` and "Later" lists resumable upload.) Mark every MVP item in sections 1–3 as `✅` except "Claude Code registration docs", which becomes `✅` after Step 6 succeeds.

- [ ] **Step 5: Human step — real login (needs the user at the browser)**

Ask the user whether to run `npm link` (it installs a global `marvin-drive` symlink); run it only on a yes.
Ask the user to run (in this session: `! node dist/cli/main.js auth add --alias emco`), sign in with `emcothebluemarvin@gmail.com`, and accept the "unverified app" warning (*Advanced → Go to Marvin Drive Handler*).
Then run: `node dist/cli/main.js auth list --verify`
Expected: one line starting with `*`, showing alias `emco`, email `emcothebluemarvin@gmail.com` and status `ok` (columns are space-padded).

- [ ] **Step 6: Live E2E and Claude Code registration**

Run: `MARVIN_E2E_ACCOUNT=emco npm run test:e2e`
Expected: 1 test passes; the temporary `marvin-e2e-*` folder no longer exists in Drive afterwards.

If the `md` export assertion fails because Drive returned a different MIME/extension, record the actual behaviour, adjust `FORMAT_MIME.md` only if Drive rejected `text/markdown`, and re-run.

Ask the user before running (it changes their user-scope Claude Code config):
`claude mcp add marvin-drive --scope user -- node /Users/emcomacpro/google-handler/dist/cli/main.js serve`
Then `claude mcp list` should show `marvin-drive` as connected.

- [ ] **Step 7: Final check and commit**

Run: `npx prettier --write README.md tests && npm run check`
Expected: all green.

```bash
git add README.md docs/CHANGELOG.md docs/FEATURES.md tests/e2e
git commit -m "docs: add README, changelog and live E2E test

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
