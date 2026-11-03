# Content Processing (Sub-project 4) Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add 13 MCP tools that read Google Docs/Sheets/Slides as structured content and edit them in place, on the existing `marvin-drive` server.

**Architecture:** Extract `FileService`'s retry/error-mapping/audit plumbing into a shared `OperationRunner`; give `DriveContext` Docs/Sheets/Slides adapters built from the same OAuth client; add three content services (each: Drive pre-flight → API call → audit) plus pure formatters for Docs structure and Slides text; register tools in per-API MCP modules.

**Tech Stack:** TypeScript (strict), Node ≥ 22, `googleapis` (`docs_v1`, `sheets_v4`, `slides_v1` — already installed), `@modelcontextprotocol/sdk`, `zod` v4, Vitest.

**Spec:** `docs/superpowers/specs/2026-11-03-content-processing-design.md` — read it first.

---

## Ground rules (read before Task 1)

- Run everything from `/Users/emcomacpro/google-handler`.
- Quality gate after every task: `npm run check` (typecheck + eslint + prettier check + vitest). It must be fully green — and eslint must stay at **zero warnings** — before committing. The plan's code is not prettier-formatted: run `npx prettier --write <changed files>` before every `npm run check`.
- Imports use the `.js` suffix (ESM, NodeNext), e.g. `import { x } from './y.js';`.
- Test helpers live in `src/files/__tests__/fakes.ts`: `createFakeDrive`, `createRunner`, `createAudit`, `noSleep`, `silentLogger`, `httpError`, `ACCOUNT`.
- Fixtures already committed: `src/content/__tests__/fixtures/demo-doc.json` (Docs `documents.get` with `DOC_FIELDS`), `src/content/__tests__/fixtures/demo-slides.json` (Slides `presentations.get` with `SLIDE_FIELDS`), `tests/e2e/fixtures/deck.pptx`. Load JSON fixtures with `readFileSync` + `JSON.parse` (don't `import` JSON).
- Live-verified fact: a stale Docs `requiredRevisionId` returns HTTP 400 with message `The required revision ID '<id>' does not match the latest revision.` (reason `badRequest`).
- Commit messages: Conventional Commits, ending with the line `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Never push.
- **Declared refinements vs the spec** (all intentional):
  - `afterHeading` resets the paragraph style only when the inserted text forms its own paragraph (text ends with `\n`, or the heading is the last paragraph). Restyling text that merges into the next paragraph would turn that paragraph (possibly another heading) into normal text. The tool description says so.
  - `insertedAt` is the index where the insert happens; in the heading-is-last-paragraph case that is the position of the prepended `\n` (the caller's text starts one later).
  - `sheets_read_range` also returns `totalRows` (rows available before truncation).
  - Spec §4.3's `layout=` slide-header field and §4.3's `NotFoundError` for an unknown `objectId` are replaced as described in Tasks 11–12.
- **Naming refinement vs spec §3:** the operation kind is `'idempotent' | 'create' | 'mutate'` (spec wrote `read`). Same semantics: `idempotent` = retry rate limits + 5xx; `create`/`mutate` = retry rate limits only. Keeping `idempotent` means `FileService` call sites don't change (move/rename/delete are idempotent but not reads).

## File map

| File | Status | Responsibility |
|---|---|---|
| `src/errors.ts` | modify | `GoogleApi` type, `ConflictError`, `ApiDisabledError`, API-labelled `DriveApiError` |
| `src/files/drive-errors.ts` | modify | ErrorInfo reasons, `OperationKind`, `MapContext.kind/api/name`, disabled-API + revision-conflict mapping, cap/hints |
| `src/audit/audit-log.ts` | modify | widen `AuditOp` |
| `src/core/operation.ts` | create | `OperationRunner` (exec + audit), extracted from `FileService` |
| `src/files/file-service.ts` | modify | delegate `exec`/`recordAudit` to `OperationRunner` |
| `src/drive/docs-adapter.ts`, `sheets-adapter.ts`, `slides-adapter.ts` | create | thin googleapis wrappers |
| `src/drive/client-factory.ts` | modify | `DriveContext` gains `docs/sheets/slides`; `makeAdapters` |
| `src/core/google-file.ts` | create | `resolveGoogleFile` pre-flight (shortcut + type check) |
| `src/content/truncate.ts` | create | `sliceText` (surrogate-safe) |
| `src/content/content-service.ts` | create | base class: `resolve`, `run`, `requestKinds`, `Guard` |
| `src/content/docs-structure.ts` | create | Docs JSON → outline, headings, body end |
| `src/content/docs-service.ts` | create | `read`, `replaceText`, `insertText`, `batchUpdate` |
| `src/content/sheets-service.ts` | create | `info`, `readRange`, `writeRange`, `appendRows`, `batchUpdate` |
| `src/content/slides-text.ts` | create | Slides JSON → outline, `findElement`, `shapeText` |
| `src/content/slides-service.ts` | create | `read`, `replaceText`, `setText`, `batchUpdate` |
| `src/mcp/shared.ts` | create | `respond` + shared zod fields (moved from server.ts) |
| `src/mcp/drive-tools.ts` | create | the 12 existing tools, moved verbatim |
| `src/mcp/docs-tools.ts`, `sheets-tools.ts`, `slides-tools.ts` | create | new tools |
| `src/mcp/server.ts` | modify | compose tool groups; `TOOL_NAMES` (25) |
| `src/app.ts`, `src/cli/main.ts` | modify | wire content services |
| `tests/e2e/content.e2e.test.ts` | create | live E2E |
| `README.md`, `docs/FEATURES.md`, `docs/CHANGELOG.md`, `package.json`, `src/version.ts` | modify | docs + 0.2.0 |

---

## Chunk 1: Foundations (errors, OperationRunner, adapters, pre-flight)

### Task 1: New error classes

**Files:**
- Modify: `src/errors.ts`
- Test: `src/__tests__/errors.test.ts`

- [ ] **Step 1: Write the failing tests** — append to `src/__tests__/errors.test.ts` (add the new names to its existing import from `'../errors.js'`):

```ts
describe('content API errors', () => {
  it('ConflictError names the file and the re-read tool', () => {
    const e = new ConflictError('"Plan"', 'docs_read');
    expect(e.code).toBe('CONFLICT');
    expect(e.message).toBe(
      '"Plan" changed since it was read (or the revisionId expired); re-read it with docs_read and retry with the new revisionId.',
    );
  });

  it('ApiDisabledError names the API', () => {
    const e = new ApiDisabledError('sheets');
    expect(e.code).toBe('API_DISABLED');
    expect(e.message).toBe(
      'The Google Sheets API is not enabled for this OAuth project. Enable it in Cloud Console → APIs & Services, then retry.',
    );
  });

  it('DriveApiError keeps the Drive prefix by default and labels other APIs', () => {
    expect(new DriveApiError(400, 'bad').message).toBe('Drive API error (400): bad');
    expect(new DriveApiError(400, 'bad', { api: 'drive' }).message).toBe('Drive API error (400): bad');
    expect(new DriveApiError(400, 'bad', { api: 'slides' }).message).toBe(
      'Google Slides API error (400): bad',
    );
  });
});
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run src/__tests__/errors.test.ts` → FAIL (`ConflictError` is not exported).

- [ ] **Step 3: Implement** in `src/errors.ts`. Add near the top (after `AppError`):

```ts
export type GoogleApi = 'drive' | 'docs' | 'sheets' | 'slides';

export const API_LABEL: Record<GoogleApi, string> = {
  drive: 'Drive',
  docs: 'Docs',
  sheets: 'Sheets',
  slides: 'Slides',
};
```

Add before `DriveApiError`:

```ts
export class ConflictError extends AppError {
  readonly code = 'CONFLICT';

  constructor(fileLabel: string, rereadTool: string, options?: ErrorOptions) {
    super(
      `${fileLabel} changed since it was read (or the revisionId expired); re-read it with ${rereadTool} and retry with the new revisionId.`,
      options,
    );
  }
}

export class ApiDisabledError extends AppError {
  readonly code = 'API_DISABLED';

  constructor(api: GoogleApi, options?: ErrorOptions) {
    super(
      `The Google ${API_LABEL[api]} API is not enabled for this OAuth project. Enable it in Cloud Console → APIs & Services, then retry.`,
      options,
    );
  }
}
```

Replace the `DriveApiError` constructor:

```ts
  constructor(
    readonly status: number | undefined,
    detail: string,
    options?: ErrorOptions & { api?: GoogleApi },
  ) {
    const api = options?.api ?? 'drive';
    const label = api === 'drive' ? 'Drive API error' : `Google ${API_LABEL[api]} API error`;
    super(`${label}${status === undefined ? '' : ` (${status})`}: ${detail}`, options);
  }
```

- [ ] **Step 4: Verify** — `npx vitest run src/__tests__/errors.test.ts` → PASS; then `npm run check` → green.

- [ ] **Step 5: Commit**

```bash
git add src/errors.ts src/__tests__/errors.test.ts
git commit -m "feat(core): ConflictError, ApiDisabledError and API-labelled DriveApiError"
```

### Task 2: Error mapping for content APIs

**Files:**
- Modify: `src/files/drive-errors.ts`
- Test: `src/files/__tests__/drive-errors.test.ts`

- [ ] **Step 1: Update existing test context** — in `src/files/__tests__/drive-errors.test.ts`:
  - change `const ctx = { target: 'file-1', alias: 'emco', logger: silent };` to `const ctx = { target: 'file-1', alias: 'emco', logger: silent, kind: 'idempotent' as const };`
  - change `{ ...ctx, createOp: true }` (in "adds a duplicate hint for failed creates") to `{ ...ctx, kind: 'create' as const }`.

- [ ] **Step 2: Write the failing tests** — append (add `ApiDisabledError`, `ConflictError` to the existing `'../../errors.js'` import — `DriveApiError` is already imported — and `isRevisionMismatch` to the `'../drive-errors.js'` import):

```ts
const errorInfo = (status: number, reason: string, message: string): Error =>
  Object.assign(new Error(message), {
    status,
    response: {
      status,
      data: {
        error: {
          code: status,
          message,
          status: 'PERMISSION_DENIED',
          details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason }],
        },
      },
    },
  });

const withMessage = (status: number, reason: string, message: string): Error =>
  Object.assign(new Error(message), { status, errors: [{ reason }] });

const MISMATCH = "The required revision ID 'abc' does not match the latest revision.";

describe('content API error mapping', () => {
  it('reads ErrorInfo reasons from the newer error format', () => {
    expect(reasonOf(errorInfo(403, 'SERVICE_DISABLED', 'x'))).toBe('SERVICE_DISABLED');
  });

  it('maps a disabled API before the 403 permission branch', () => {
    const disabled = mapDriveError(
      errorInfo(403, 'SERVICE_DISABLED', 'Google Docs API has not been used in project 1 before or it is disabled.'),
      { ...ctx, api: 'docs' },
    );
    expect(disabled).toBeInstanceOf(ApiDisabledError);
    expect(disabled.message).toContain('Google Docs API');
    expect(mapDriveError(gaxios(403, 'accessNotConfigured'), ctx)).toBeInstanceOf(ApiDisabledError);
    const byMessage = mapDriveError(
      withMessage(403, 'forbidden', 'Google Sheets API has not been used in project 9 before or it is disabled.'),
      { ...ctx, api: 'sheets' },
    );
    expect(byMessage).toBeInstanceOf(ApiDisabledError);
    expect(mapDriveError(withMessage(403, 'forbidden', 'nope'), ctx).constructor.name).toBe(
      'PermissionDeniedError',
    );
  });

  it('maps a revision mismatch to ConflictError for docs and slides only', () => {
    expect(isRevisionMismatch(withMessage(400, 'badRequest', MISMATCH))).toBe(true);
    expect(isRevisionMismatch(withMessage(400, 'badRequest', 'Invalid range'))).toBe(false);
    const docs = mapDriveError(withMessage(400, 'badRequest', MISMATCH), {
      ...ctx,
      kind: 'mutate',
      api: 'docs',
      name: 'Plan',
    });
    expect(docs).toBeInstanceOf(ConflictError);
    expect(docs.message).toContain('"Plan" changed since it was read');
    expect(docs.message).toContain('docs_read');
    const slides = mapDriveError(withMessage(400, 'badRequest', MISMATCH), { ...ctx, api: 'slides' });
    expect(slides.message).toContain('file-1 changed');
    expect(slides.message).toContain('slides_read');
    expect(mapDriveError(withMessage(400, 'badRequest', MISMATCH), ctx)).toBeInstanceOf(DriveApiError);
  });

  it('labels non-Drive errors and keeps up to 500 chars of their message', () => {
    const long = 'x'.repeat(450);
    const sheets = mapDriveError(withMessage(400, 'badRequest', long), { ...ctx, api: 'sheets' });
    expect(sheets.message).toBe(`Google Sheets API error (400): ${long}`);
    const drive = mapDriveError(withMessage(400, 'badRequest', long), ctx);
    expect(drive.message).toBe(`Drive API error (400): ${'x'.repeat(200)}`);
  });

  it('warns that a failed edit may still have been applied', () => {
    expect(mapDriveError(gaxios(503), { ...ctx, kind: 'mutate' }).message).toMatch(
      /may have been applied anyway; re-read the file before retrying/,
    );
    expect(mapDriveError(gaxios(503), ctx).message).not.toMatch(/applied|duplicate/);
  });
});
```

- [ ] **Step 3: Run to verify failure** — `npx vitest run src/files/__tests__/drive-errors.test.ts` → FAIL.

- [ ] **Step 4: Implement** in `src/files/drive-errors.ts`:

Imports: add `ApiDisabledError`, `ConflictError`, `type GoogleApi` to the `'../errors.js'` import.

Replace `reasonOf` with the version below and add the helpers:

```ts
/** The `error` object of a Google JSON error body (parsed if the body is a string). */
function bodyError(err: unknown): Loose | undefined {
  let data: unknown = asObject(asObject(err)?.response)?.data;
  if (typeof data === 'string') {
    try {
      data = JSON.parse(data);
    } catch {
      return undefined; // non-JSON body: no structured error available
    }
  }
  return asObject(asObject(data)?.error);
}

/** `reason` of the first google.rpc.ErrorInfo entry (newer error format used by Docs/Sheets/Slides). */
function errorInfoReason(details: unknown): string | undefined {
  if (!Array.isArray(details)) return undefined;
  for (const item of details) {
    const d = asObject(item);
    if (d?.['@type'] === 'type.googleapis.com/google.rpc.ErrorInfo' && typeof d.reason === 'string') {
      return d.reason;
    }
  }
  return undefined;
}

function messageOf(err: unknown): string {
  const parts: string[] = [];
  if (err instanceof Error) parts.push(err.message);
  const bodyMessage = bodyError(err)?.message;
  if (typeof bodyMessage === 'string') parts.push(bodyMessage);
  return parts.join(' ');
}

export function reasonOf(err: unknown): string | undefined {
  const e = asObject(err);
  if (!e) return undefined;
  const direct = firstReason(e.errors);
  if (direct) return direct;

  const body = bodyError(err);
  const fromBody = firstReason(body?.errors) ?? errorInfoReason(body?.details);
  if (fromBody) return fromBody;

  if (typeof e.message === 'string' && /too large to be exported/i.test(e.message)) {
    return 'exportSizeLimitExceeded';
  }
  return undefined;
}

const API_DISABLED_REASONS = new Set(['accessNotConfigured', 'SERVICE_DISABLED']);
const API_DISABLED_MESSAGE = /API has not been used in project|API .* is disabled/;
const REVISION_MISMATCH = /required revision ID .* does not match/i;

function isApiDisabled(err: unknown, status: number | undefined, reason: string | undefined): boolean {
  if (status !== 403) return false;
  if (reason && API_DISABLED_REASONS.has(reason)) return true;
  if (errorInfoReason(bodyError(err)?.details) === 'SERVICE_DISABLED') return true;
  return API_DISABLED_MESSAGE.test(messageOf(err));
}

/** HTTP 400 from a Docs/Slides writeControl.requiredRevisionId mismatch (or expired revision). */
export function isRevisionMismatch(err: unknown): boolean {
  return statusOf(err) === 400 && REVISION_MISMATCH.test(messageOf(err));
}
```

Replace `MapContext` and `mapDriveError`:

```ts
/** idempotent: safe to repeat; create: may duplicate; mutate: an in-place edit that may not be repeated. */
export type OperationKind = 'idempotent' | 'create' | 'mutate';

export interface MapContext {
  /** File/folder id the call targeted (for messages); undefined → "root". */
  target: string | undefined;
  alias: string;
  logger: Logger;
  kind: OperationKind;
  /** Which Google API produced the error (default "drive"). */
  api?: GoogleApi;
  /** Human file name, when known, for messages. */
  name?: string;
}

const FIVE_XX_HINT: Record<OperationKind, string> = {
  idempotent: '',
  create: '. The item may have been created anyway; check for a duplicate before retrying.',
  mutate: '. The change may have been applied anyway; re-read the file before retrying.',
};

/** Converts a raw googleapis/gaxios error into a safe AppError (MVP spec §9, content spec §5). */
export function mapDriveError(err: unknown, ctx: MapContext): AppError {
  if (err instanceof AppError) return err;
  const status = statusOf(err);
  const reason = reasonOf(err);
  const api = ctx.api ?? 'drive';
  const target = ctx.target ?? 'root';

  if (status === 404) return new NotFoundError(target, { cause: err });
  if (isRateLimit(status, reason)) return new RateLimitError({ cause: err });
  if (isApiDisabled(err, status, reason)) return new ApiDisabledError(api, { cause: err });
  if ((api === 'docs' || api === 'slides') && isRevisionMismatch(err)) {
    const label = ctx.name ? `"${ctx.name}"` : target;
    return new ConflictError(label, `${api}_read`, { cause: err });
  }
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

  const cap = api === 'drive' ? 200 : 500;
  const detail = err instanceof Error ? scrubText(err.message).slice(0, cap) : 'Unknown error';
  ctx.logger.error('Google API call failed', { api, status, reason, target, error: err });
  const hint = status !== undefined && status >= 500 ? FIVE_XX_HINT[ctx.kind] : '';
  return new DriveApiError(status, `${detail}${hint}`, { cause: err, api });
}
```

Then fix the single caller in `src/files/file-service.ts` `exec`: replace `createOp: retryClass === 'create',` with `kind: retryClass,` (Task 3 moves this code; this keeps the build green now).

- [ ] **Step 5: Verify** — `npx vitest run src/files/__tests__/drive-errors.test.ts` → PASS. `npm run check` → green (all 205 existing tests still pass; the log message text change is not asserted anywhere — if a test asserts `'Drive API call failed'`, update that string).

- [ ] **Step 6: Commit**

```bash
git add src/files/drive-errors.ts src/files/__tests__/drive-errors.test.ts src/files/file-service.ts
git commit -m "feat(core): map disabled APIs and revision conflicts; per-kind 5xx hints"
```

### Task 3: Extract OperationRunner and widen AuditOp

**Files:**
- Create: `src/core/operation.ts`
- Create: `src/core/__tests__/operation.test.ts`
- Modify: `src/files/file-service.ts`, `src/audit/audit-log.ts`

- [ ] **Step 1: Widen `AuditOp`** in `src/audit/audit-log.ts`:

```ts
export type AuditOp =
  | 'upload'
  | 'create_folder'
  | 'move'
  | 'rename'
  | 'copy'
  | 'delete'
  | 'restore'
  | 'docs_replace_text'
  | 'docs_insert_text'
  | 'docs_batch_update'
  | 'sheets_write_range'
  | 'sheets_append_rows'
  | 'sheets_batch_update'
  | 'slides_replace_text'
  | 'slides_set_text'
  | 'slides_batch_update';
```

- [ ] **Step 2: Write the failing test** — `src/core/__tests__/operation.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { ConflictError, DriveApiError, ReauthRequiredError } from '../../errors.js';
import {
  createAudit,
  createFakeDrive,
  createRunner,
  httpError,
  noSleep,
  silentLogger,
} from '../../files/__tests__/fakes.js';
import { OperationRunner } from '../operation.js';

function setup(): {
  ops: OperationRunner;
  audit: ReturnType<typeof createAudit>;
  logger: ReturnType<typeof silentLogger>;
} {
  const audit = createAudit();
  const logger = silentLogger();
  const ops = new OperationRunner({
    runner: createRunner(createFakeDrive()),
    audit,
    retry: noSleep,
    logger,
  });
  return { ops, audit, logger };
}

describe('OperationRunner', () => {
  it('retries 5xx for idempotent operations', async () => {
    const { ops } = setup();
    let calls = 0;
    const result = await ops.exec(undefined, 'idempotent', 'f1', async () => {
      calls += 1;
      if (calls === 1) throw httpError(503);
      return 'ok';
    });
    expect(result).toBe('ok');
    expect(calls).toBe(2);
  });

  it('never retries 5xx for mutations and adds the re-read hint', async () => {
    const { ops } = setup();
    let calls = 0;
    const err = await ops
      .exec(undefined, 'mutate', 'f1', async () => {
        calls += 1;
        throw httpError(500);
      })
      .catch((e: unknown) => e);
    expect(calls).toBe(1);
    expect(err).toBeInstanceOf(DriveApiError);
    expect((err as Error).message).toMatch(/re-read the file/);
  });

  it('passes api and name into error mapping', async () => {
    const { ops } = setup();
    const err = await ops
      .exec(
        undefined,
        'mutate',
        'd1',
        async () => {
          throw httpError(
            400,
            'badRequest',
            "The required revision ID 'r' does not match the latest revision.",
          );
        },
        { api: 'docs', name: 'Plan' },
      )
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConflictError);
    expect((err as Error).message).toContain('"Plan"');
  });

  it('lets invalid_grant through untouched for the runner to handle', async () => {
    const { ops } = setup();
    const grant = Object.assign(new Error('invalid_grant'), {
      response: { data: { error: 'invalid_grant' } },
    });
    const err = await ops
      .exec(undefined, 'idempotent', 'f1', async () => {
        throw grant;
      })
      .catch((e: unknown) => e);
    expect(err).toBe(grant);
    expect(err).not.toBeInstanceOf(ReauthRequiredError);
  });

  it('records audit entries and swallows audit failures', async () => {
    const { ops, audit, logger } = setup();
    await ops.exec(undefined, 'mutate', 'f1', (ctx) =>
      ops.audit(ctx, 'docs_replace_text', { id: 'f1', name: 'Plan' }, { occurrencesChanged: 2 }),
    );
    expect(audit.entries).toEqual([
      {
        account: 'emco',
        op: 'docs_replace_text',
        fileId: 'f1',
        name: 'Plan',
        details: { occurrencesChanged: 2 },
      },
    ]);
    audit.record = async () => {
      throw new Error('disk full');
    };
    await ops.exec(undefined, 'mutate', 'f1', (ctx) => ops.audit(ctx, 'docs_replace_text', { id: 'f1' }, {}));
    expect(logger.warn).toHaveBeenCalled();
  });
});
```

Check `src/auth/oauth-errors.ts` `isInvalidGrant` before running: if it detects `invalid_grant` differently from the `grant` object above, shape the `grant` object to match what `isInvalidGrant` accepts (look at its existing tests in `src/auth/__tests__/`).

- [ ] **Step 3: Run to verify failure** — `npx vitest run src/core/__tests__/operation.test.ts` → FAIL (module not found).

- [ ] **Step 4: Implement** `src/core/operation.ts` (the body is `FileService.exec` / `recordAudit` moved here):

```ts
import type { AuditOp, AuditSink } from '../audit/audit-log.js';
import { isInvalidGrant } from '../auth/oauth-errors.js';
import type { DriveContext, DriveRunner } from '../drive/client-factory.js';
import type { GoogleApi } from '../errors.js';
import { mapDriveError, type OperationKind } from '../files/drive-errors.js';
import { withRetry, type RetryOptions } from '../files/retry.js';
import { logger as defaultLogger, type Logger } from '../logger.js';

export interface OperationDeps {
  runner: DriveRunner;
  audit: AuditSink;
  retry?: RetryOptions;
  logger?: Logger;
}

/** Extra context for error messages: which API, and the file's human name. */
export interface OperationMeta {
  api?: GoogleApi;
  name?: string;
}

/** Shared plumbing for every service: account resolution, retry, error mapping, audit. */
export class OperationRunner {
  readonly log: Logger;

  constructor(private readonly deps: OperationDeps) {
    this.log = deps.logger ?? defaultLogger;
  }

  /** Runs `operation` for an account with retry + error mapping (invalid_grant passes through). */
  exec<T>(
    account: string | undefined,
    kind: OperationKind,
    target: string | undefined,
    operation: (ctx: DriveContext, attempt: number) => Promise<T>,
    meta: OperationMeta = {},
  ): Promise<T> {
    const retryClass = kind === 'idempotent' ? 'idempotent' : 'create';
    return this.deps.runner.run(account, async (ctx) => {
      try {
        return await withRetry((attempt) => operation(ctx, attempt), retryClass, this.deps.retry);
      } catch (err) {
        if (isInvalidGrant(err)) throw err;
        throw mapDriveError(err, {
          target,
          alias: ctx.account.alias,
          logger: this.log,
          kind,
          ...(meta.api ? { api: meta.api } : {}),
          ...(meta.name ? { name: meta.name } : {}),
        });
      }
    });
  }

  /** Writes an audit entry; failures are logged, never thrown (the change already happened). */
  async audit(
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

- [ ] **Step 5: Make `FileService` delegate** — in `src/files/file-service.ts`:
  - Add `import { OperationRunner } from '../core/operation.js';`
  - Add a field `private readonly ops: OperationRunner;` and in the constructor, after `this.log = ...`, add `this.ops = new OperationRunner(deps);` (`FileServiceDeps` is a structural superset of `OperationDeps`, so no constructor/test changes).
  - Replace the bodies of `exec` and `recordAudit` (keep their signatures and the `protected` modifier) with:

```ts
  protected exec<T>(
    account: string | undefined,
    retryClass: RetryClass,
    target: string | undefined,
    operation: (ctx: DriveContext, attempt: number) => Promise<T>,
  ): Promise<T> {
    return this.ops.exec(account, retryClass, target, operation);
  }

  protected recordAudit(
    ctx: DriveContext,
    op: AuditOp,
    file: { id?: string | null; name?: string | null },
    details: Record<string, unknown>,
  ): Promise<void> {
    return this.ops.audit(ctx, op, file, details);
  }
```

  - Remove now-unused imports (`isInvalidGrant`, `mapDriveError`, `withRetry`) — eslint/tsc will flag them. Keep `retryKind`, `reasonOf`, `RetryOptions`, `RetryClass` if still used.

- [ ] **Step 6: Verify** — `npm run check` → green; test count = previous + 5 new; no existing test edited in this task.

- [ ] **Step 7: Commit**

```bash
git add src/core src/files/file-service.ts src/audit/audit-log.ts
git commit -m "refactor(core): extract OperationRunner from FileService; widen AuditOp for content edits"
```

### Task 4: Docs/Sheets/Slides adapters on DriveContext

**Files:**
- Create: `src/drive/docs-adapter.ts`, `src/drive/sheets-adapter.ts`, `src/drive/slides-adapter.ts`
- Modify: `src/drive/client-factory.ts`, `src/drive/__tests__/client-factory.test.ts`, `src/files/__tests__/fakes.ts`
- Test: `src/drive/__tests__/content-adapters.test.ts`

- [ ] **Step 1: Write the adapters.**

`src/drive/docs-adapter.ts`:

```ts
import { google, type Auth, type docs_v1 } from 'googleapis';

export type DocsDocument = docs_v1.Schema$Document;
export type DocsRequest = docs_v1.Schema$Request;
export type DocsBatchResponse = docs_v1.Schema$BatchUpdateDocumentResponse;

/** Narrow, test-friendly view of the Docs v1 API. */
export interface DocsAdapter {
  getDocument(documentId: string, fields: string): Promise<DocsDocument>;
  batchUpdate(
    documentId: string,
    requests: DocsRequest[],
    requiredRevisionId?: string,
  ): Promise<DocsBatchResponse>;
}

export function createDocsAdapter(auth: Auth.OAuth2Client): DocsAdapter {
  const docs = google.docs({ version: 'v1', auth, retry: false });
  const adapter: DocsAdapter = {
    async getDocument(documentId, fields) {
      return (await docs.documents.get({ documentId, fields })).data;
    },
    async batchUpdate(documentId, requests, requiredRevisionId) {
      const res = await docs.documents.batchUpdate({
        documentId,
        requestBody: {
          requests,
          ...(requiredRevisionId ? { writeControl: { requiredRevisionId } } : {}),
        },
      });
      return res.data;
    },
  };
  return adapter;
}
```

`src/drive/slides-adapter.ts`:

```ts
import { google, type Auth, type slides_v1 } from 'googleapis';

export type SlidesPresentation = slides_v1.Schema$Presentation;
export type SlidesPageElement = slides_v1.Schema$PageElement;
export type SlidesTextContent = slides_v1.Schema$TextContent;
export type SlidesRequest = slides_v1.Schema$Request;
export type SlidesBatchResponse = slides_v1.Schema$BatchUpdatePresentationResponse;

/** Narrow, test-friendly view of the Slides v1 API. */
export interface SlidesAdapter {
  getPresentation(presentationId: string, fields: string): Promise<SlidesPresentation>;
  batchUpdate(
    presentationId: string,
    requests: SlidesRequest[],
    requiredRevisionId?: string,
  ): Promise<SlidesBatchResponse>;
}

export function createSlidesAdapter(auth: Auth.OAuth2Client): SlidesAdapter {
  const slides = google.slides({ version: 'v1', auth, retry: false });
  const adapter: SlidesAdapter = {
    async getPresentation(presentationId, fields) {
      return (await slides.presentations.get({ presentationId, fields })).data;
    },
    async batchUpdate(presentationId, requests, requiredRevisionId) {
      const res = await slides.presentations.batchUpdate({
        presentationId,
        requestBody: {
          requests,
          ...(requiredRevisionId ? { writeControl: { requiredRevisionId } } : {}),
        },
      });
      return res.data;
    },
  };
  return adapter;
}
```

`src/drive/sheets-adapter.ts`:

```ts
import { google, type Auth, type sheets_v4 } from 'googleapis';

export type Spreadsheet = sheets_v4.Schema$Spreadsheet;
export type SheetsValueRange = sheets_v4.Schema$ValueRange;
export type SheetsUpdateResponse = sheets_v4.Schema$UpdateValuesResponse;
export type SheetsAppendResponse = sheets_v4.Schema$AppendValuesResponse;
export type SheetsRequest = sheets_v4.Schema$Request;
export type SheetsBatchResponse = sheets_v4.Schema$BatchUpdateSpreadsheetResponse;
export type ValueRender = 'FORMATTED_VALUE' | 'UNFORMATTED_VALUE' | 'FORMULA';
export type ValueInput = 'USER_ENTERED' | 'RAW';
export type CellValue = string | number | boolean;

/** Narrow, test-friendly view of the Sheets v4 API. */
export interface SheetsAdapter {
  getSpreadsheet(spreadsheetId: string, fields: string): Promise<Spreadsheet>;
  getValues(spreadsheetId: string, range: string, render: ValueRender): Promise<SheetsValueRange>;
  updateValues(
    spreadsheetId: string,
    range: string,
    values: CellValue[][],
    input: ValueInput,
  ): Promise<SheetsUpdateResponse>;
  appendValues(
    spreadsheetId: string,
    range: string,
    values: CellValue[][],
    input: ValueInput,
  ): Promise<SheetsAppendResponse>;
  batchUpdate(spreadsheetId: string, requests: SheetsRequest[]): Promise<SheetsBatchResponse>;
}

export function createSheetsAdapter(auth: Auth.OAuth2Client): SheetsAdapter {
  const sheets = google.sheets({ version: 'v4', auth, retry: false });
  const adapter: SheetsAdapter = {
    async getSpreadsheet(spreadsheetId, fields) {
      return (await sheets.spreadsheets.get({ spreadsheetId, fields })).data;
    },
    async getValues(spreadsheetId, range, render) {
      return (
        await sheets.spreadsheets.values.get({ spreadsheetId, range, valueRenderOption: render })
      ).data;
    },
    async updateValues(spreadsheetId, range, values, input) {
      const res = await sheets.spreadsheets.values.update({
        spreadsheetId,
        range,
        valueInputOption: input,
        requestBody: { values },
      });
      return res.data;
    },
    async appendValues(spreadsheetId, range, values, input) {
      const res = await sheets.spreadsheets.values.append({
        spreadsheetId,
        range,
        valueInputOption: input,
        insertDataOption: 'INSERT_ROWS',
        requestBody: { values },
      });
      return res.data;
    },
    async batchUpdate(spreadsheetId, requests) {
      return (await sheets.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests } }))
        .data;
    },
  };
  return adapter;
}
```

(The typed `const adapter: X = {…}; return adapter;` pattern mirrors `drive-adapter.ts` and keeps eslint's `explicit-function-return-type` at zero warnings.) If `tsc` rejects `retry: false` in an options object, mirror `DRIVE_CLIENT_OPTIONS` in `drive-adapter.ts` (`{ version: 'v1', retry: false } as const` spread with `auth`).

- [ ] **Step 2: Write the adapter smoke test** — `src/drive/__tests__/content-adapters.test.ts` (verifies the request shape sent to googleapis without network, by stubbing the transporter):

```ts
import { google } from 'googleapis';
import { describe, expect, it } from 'vitest';
import { createDocsAdapter } from '../docs-adapter.js';
import { createSheetsAdapter } from '../sheets-adapter.js';
import { createSlidesAdapter } from '../slides-adapter.js';

interface Captured {
  url: string;
  method?: string;
  data?: unknown;
  params?: Record<string, unknown>;
}

function fakeAuth(captured: Captured[]): InstanceType<typeof google.auth.OAuth2> {
  const auth = new google.auth.OAuth2();
  auth.setCredentials({ access_token: 'test-token' });
  auth.request = (async (opts: Captured) => {
    captured.push(opts);
    return { data: { ok: true }, status: 200, headers: {}, config: opts, statusText: 'OK' };
  }) as unknown as typeof auth.request;
  return auth;
}

describe('content adapters', () => {
  it('docs batchUpdate sends writeControl only when a revision is given', async () => {
    const captured: Captured[] = [];
    const docs = createDocsAdapter(fakeAuth(captured));
    await docs.batchUpdate('d1', [{ insertText: { text: 'x', location: { index: 1 } } }], 'rev1');
    await docs.batchUpdate('d1', [{ insertText: { text: 'x', location: { index: 1 } } }]);
    expect(captured[0]?.url).toContain('/v1/documents/d1:batchUpdate');
    expect(captured[0]?.data).toEqual({
      requests: [{ insertText: { text: 'x', location: { index: 1 } } }],
      writeControl: { requiredRevisionId: 'rev1' },
    });
    expect(captured[1]?.data).not.toHaveProperty('writeControl');
  });

  it('sheets append inserts rows with the chosen input option', async () => {
    const captured: Captured[] = [];
    const sheets = createSheetsAdapter(fakeAuth(captured));
    await sheets.appendValues('s1', 'Tab', [['a', 1]], 'USER_ENTERED');
    expect(captured[0]?.url).toContain('/v4/spreadsheets/s1/values/Tab:append');
    expect(captured[0]?.params).toMatchObject({
      valueInputOption: 'USER_ENTERED',
      insertDataOption: 'INSERT_ROWS',
    });
    expect(captured[0]?.data).toEqual({ values: [['a', 1]] });
  });

  it('slides get passes the field mask', async () => {
    const captured: Captured[] = [];
    const slides = createSlidesAdapter(fakeAuth(captured));
    await slides.getPresentation('p1', 'revisionId');
    expect(captured[0]?.url).toContain('/v1/presentations/p1');
    expect(captured[0]?.params).toMatchObject({ fields: 'revisionId' });
  });
});
```

If googleapis routes requests through a different method than `auth.request` in this version (check how `src/drive/__tests__/drive-adapter.test.ts`, if present, stubs requests and copy that approach), adapt `fakeAuth` accordingly — the assertions stay the same.

- [ ] **Step 3: Run** — `npx vitest run src/drive/__tests__/content-adapters.test.ts` → PASS (adapters were written in Step 1; this task is wiring, the test is the verification).

- [ ] **Step 4: Extend `DriveContext`** in `src/drive/client-factory.ts`:

```ts
import { createDocsAdapter, type DocsAdapter } from './docs-adapter.js';
import { createDriveAdapter, type DriveAdapter } from './drive-adapter.js';
import { createSheetsAdapter, type SheetsAdapter } from './sheets-adapter.js';
import { createSlidesAdapter, type SlidesAdapter } from './slides-adapter.js';

export interface GoogleAdapters {
  drive: DriveAdapter;
  docs: DocsAdapter;
  sheets: SheetsAdapter;
  slides: SlidesAdapter;
}

export interface DriveContext extends GoogleAdapters {
  account: AccountRecord;
}

export function createGoogleAdapters(client: Auth.OAuth2Client): GoogleAdapters {
  return {
    drive: createDriveAdapter(client),
    docs: createDocsAdapter(client),
    sheets: createSheetsAdapter(client),
    slides: createSlidesAdapter(client),
  };
}
```

Constructor parameter becomes `private readonly makeAdapters: (client: Auth.OAuth2Client) => GoogleAdapters = createGoogleAdapters,` and in `context()` build `const fresh: CachedContext = { account, ...this.makeAdapters(client), refreshToken };`. Remove the now-unused `createDriveAdapter`/`DriveAdapter` value import if tsc flags it (keep the type import used by `GoogleAdapters`).

- [ ] **Step 5: Update `client-factory.test.ts`** construction only:
  - type: `let makeAdapter: Mock<(client: Auth.OAuth2Client) => GoogleAdapters>;` (import `type GoogleAdapters` from `'../client-factory.js'`; drop the unused `DriveAdapter` import if flagged)
  - factory: `makeAdapter = vi.fn((_client: Auth.OAuth2Client) => ({ drive: { id: ++n } }) as unknown as GoogleAdapters);`
  - `adapterId` keeps reading `ctx.drive`.

- [ ] **Step 6: Extend fakes** in `src/files/__tests__/fakes.ts`:

```ts
import type { DocsAdapter } from '../../drive/docs-adapter.js';
import type { SheetsAdapter } from '../../drive/sheets-adapter.js';
import type { SlidesAdapter } from '../../drive/slides-adapter.js';

type FakeOf<T> = { [K in keyof T]: Mock<Extract<T[K], (...args: never[]) => unknown>> };
// If `Mock<...>` rejects these generics in this Vitest version, mirror the existing
// `FakeDrive` pattern exactly: `{ [K in keyof DocsAdapter]: Mock<DocsAdapter[K]> }`.
export type FakeDocs = FakeOf<DocsAdapter>;
export type FakeSheets = FakeOf<SheetsAdapter>;
export type FakeSlides = FakeOf<SlidesAdapter>;

function strictFn<F extends (...args: never[]) => unknown>(name: string): Mock<F> {
  return vi.fn((() => Promise.reject(new Error(`unexpected call: ${name}`))) as unknown as F);
}

export function createFakeDocs(): FakeDocs {
  return {
    getDocument: strictFn<DocsAdapter['getDocument']>('getDocument'),
    batchUpdate: strictFn<DocsAdapter['batchUpdate']>('docs.batchUpdate'),
  };
}

export function createFakeSheets(): FakeSheets {
  return {
    getSpreadsheet: strictFn<SheetsAdapter['getSpreadsheet']>('getSpreadsheet'),
    getValues: strictFn<SheetsAdapter['getValues']>('getValues'),
    updateValues: strictFn<SheetsAdapter['updateValues']>('updateValues'),
    appendValues: strictFn<SheetsAdapter['appendValues']>('appendValues'),
    batchUpdate: strictFn<SheetsAdapter['batchUpdate']>('sheets.batchUpdate'),
  };
}

export function createFakeSlides(): FakeSlides {
  return {
    getPresentation: strictFn<SlidesAdapter['getPresentation']>('getPresentation'),
    batchUpdate: strictFn<SlidesAdapter['batchUpdate']>('slides.batchUpdate'),
  };
}
```

Change `createRunner`:

```ts
export function createRunner(
  drive: DriveAdapter,
  content: Partial<Pick<DriveContext, 'docs' | 'sheets' | 'slides'>> = {},
): DriveRunner & { refs: Array<string | undefined> } {
  const refs: Array<string | undefined> = [];
  const ctx: DriveContext = {
    account: ACCOUNT,
    drive,
    docs: content.docs ?? createFakeDocs(),
    sheets: content.sheets ?? createFakeSheets(),
    slides: content.slides ?? createFakeSlides(),
  };
  return {
    refs,
    run<T>(ref: string | undefined, fn: (c: DriveContext) => Promise<T>): Promise<T> {
      refs.push(ref);
      return fn(ctx);
    },
  };
}
```

Also add a helper used by all content tests:

```ts
/** Stubs Drive pre-flight getFile for a Google file of the given MIME type. */
export function stubFile(drive: FakeDrive, id: string, mimeType: string, name = 'Demo'): void {
  drive.getFile.mockResolvedValueOnce({ id, name, mimeType });
}
```

- [ ] **Step 7: Verify** — `npm run check` → green.

- [ ] **Step 8: Commit**

```bash
git add src/drive src/files/__tests__/fakes.ts
git commit -m "feat(drive): Docs, Sheets and Slides adapters on DriveContext"
```

### Task 5: Pre-flight, truncation and content-service base

**Files:**
- Create: `src/core/google-file.ts`, `src/content/truncate.ts`, `src/content/content-service.ts`
- Test: `src/core/__tests__/google-file.test.ts`, `src/content/__tests__/truncate.test.ts`

- [ ] **Step 1: Write failing tests.**

`src/core/__tests__/google-file.test.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { NotFoundError, ValidationError } from '../../errors.js';
import { GOOGLE_MIME } from '../../files/export-formats.js';
import { createFakeDrive, type FakeDrive } from '../../files/__tests__/fakes.js';
import { resolveGoogleFile } from '../google-file.js';

let drive: FakeDrive;
beforeEach(() => {
  drive = createFakeDrive();
});

describe('resolveGoogleFile', () => {
  it('returns id and name for the expected type', async () => {
    drive.getFile.mockResolvedValueOnce({ id: 'd1', name: 'Plan', mimeType: GOOGLE_MIME.document });
    await expect(resolveGoogleFile(drive, 'd1', 'docs')).resolves.toEqual({ id: 'd1', name: 'Plan' });
    expect(drive.getFile).toHaveBeenCalledWith('d1', 'id, name, mimeType, shortcutDetails');
  });

  it('follows shortcuts to their target', async () => {
    drive.getFile
      .mockResolvedValueOnce({ id: 's1', mimeType: GOOGLE_MIME.shortcut, shortcutDetails: { targetId: 't1' } })
      .mockResolvedValueOnce({ id: 't1', name: 'Budget', mimeType: GOOGLE_MIME.spreadsheet });
    await expect(resolveGoogleFile(drive, 's1', 'sheets')).resolves.toEqual({ id: 't1', name: 'Budget' });
  });

  it('rejects a shortcut without a target', async () => {
    drive.getFile.mockResolvedValueOnce({ id: 's1', mimeType: GOOGLE_MIME.shortcut });
    await expect(resolveGoogleFile(drive, 's1', 'docs')).rejects.toBeInstanceOf(NotFoundError);
  });

  it('names the right tool family for another Google type', async () => {
    drive.getFile.mockResolvedValueOnce({ id: 'x', name: 'Budget', mimeType: GOOGLE_MIME.spreadsheet });
    const err = await resolveGoogleFile(drive, 'x', 'docs').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ValidationError);
    expect((err as Error).message).toBe('"Budget" is a Google Sheets file; use the sheets_* tools.');
  });

  it('explains non-Google files', async () => {
    drive.getFile.mockResolvedValueOnce({ id: 'x', name: 'a.pdf', mimeType: 'application/pdf' });
    await expect(resolveGoogleFile(drive, 'x', 'slides')).rejects.toThrow(
      '"a.pdf" is not a Google Slides file (type: application/pdf).',
    );
  });
});
```

`src/content/__tests__/truncate.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { sliceText } from '../truncate.js';

describe('sliceText', () => {
  it('returns everything when it fits', () => {
    expect(sliceText('hello', 0, 10)).toEqual({ content: 'hello', totalChars: 5, offset: 0, truncated: false });
  });

  it('pages with nextOffset', () => {
    const first = sliceText('abcdef', 0, 4);
    expect(first).toEqual({ content: 'abcd', totalChars: 6, offset: 0, truncated: true, nextOffset: 4 });
    expect(sliceText('abcdef', 4, 4)).toEqual({ content: 'ef', totalChars: 6, offset: 4, truncated: false });
  });

  it('never splits a surrogate pair at the end', () => {
    const text = 'ab😀cd'; // 😀 occupies indexes 2-3
    const r = sliceText(text, 0, 3);
    expect(r.content).toBe('ab');
    expect(r.nextOffset).toBe(2);
    expect(sliceText(text, 2, 3).content).toBe('😀c');
  });

  it('moves a start offset that lands inside a pair back to the pair start', () => {
    expect(sliceText('ab😀cd', 3, 10)).toMatchObject({ content: '😀cd', offset: 2 });
  });

  it('always makes progress', () => {
    expect(sliceText('😀', 0, 1)).toMatchObject({ content: '😀', truncated: false });
  });

  it('clamps out-of-range offsets', () => {
    expect(sliceText('abc', 99, 10)).toEqual({ content: '', totalChars: 3, offset: 3, truncated: false });
  });
});
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run src/core/__tests__/google-file.test.ts src/content/__tests__/truncate.test.ts` → FAIL.

- [ ] **Step 3: Implement.**

`src/core/google-file.ts`:

```ts
import type { DriveAdapter } from '../drive/drive-adapter.js';
import { API_LABEL, NotFoundError, ValidationError } from '../errors.js';
import { GOOGLE_MIME } from '../files/export-formats.js';

export type GoogleKind = 'docs' | 'sheets' | 'slides';

export interface ResolvedFile {
  id: string;
  name: string;
}

const KIND_MIME: Record<GoogleKind, string> = {
  docs: GOOGLE_MIME.document,
  sheets: GOOGLE_MIME.spreadsheet,
  slides: GOOGLE_MIME.presentation,
};

const MIME_KIND = new Map<string, GoogleKind>(
  (Object.entries(KIND_MIME) as Array<[GoogleKind, string]>).map(([kind, mime]) => [mime, kind]),
);

const PREFLIGHT_FIELDS = 'id, name, mimeType, shortcutDetails';

/** Content-tool pre-flight: resolves shortcuts and checks the file is the expected Google type. */
export async function resolveGoogleFile(
  drive: DriveAdapter,
  fileId: string,
  kind: GoogleKind,
): Promise<ResolvedFile> {
  let file = await drive.getFile(fileId, PREFLIGHT_FIELDS);
  if (file.mimeType === GOOGLE_MIME.shortcut) {
    const targetId = file.shortcutDetails?.targetId;
    if (!targetId) throw new NotFoundError(fileId);
    file = await drive.getFile(targetId, PREFLIGHT_FIELDS);
  }
  const name = file.name ?? fileId;
  if (file.mimeType !== KIND_MIME[kind]) {
    const actual = file.mimeType ? MIME_KIND.get(file.mimeType) : undefined;
    throw new ValidationError(
      actual
        ? `"${name}" is a Google ${API_LABEL[actual]} file; use the ${actual}_* tools.`
        : `"${name}" is not a Google ${API_LABEL[kind]} file (type: ${file.mimeType ?? 'unknown'}).`,
    );
  }
  return { id: file.id ?? fileId, name };
}
```

`src/content/truncate.ts`:

```ts
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

/** Slices `text` for paging without ever splitting a surrogate pair (e.g. emoji). */
export function sliceText(text: string, offset: number, maxChars: number): TextSlice {
  const total = text.length;
  let start = Math.min(Math.max(0, Math.trunc(offset)), total);
  if (start > 0 && start < total && isLow(text.charCodeAt(start)) && isHigh(text.charCodeAt(start - 1))) {
    start -= 1;
  }
  let end = Math.min(start + Math.max(1, Math.trunc(maxChars)), total);
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
```

`src/content/content-service.ts`:

```ts
import { resolveGoogleFile, type GoogleKind, type ResolvedFile } from '../core/google-file.js';
import { OperationRunner, type OperationDeps } from '../core/operation.js';
import type { DriveContext } from '../drive/client-factory.js';
import type { OperationKind } from '../files/drive-errors.js';

/** How an edit was protected against concurrent changes (audit detail). */
export type Guard = 'caller' | 'implicit' | false;

export interface AccountInput {
  account?: string;
}

export interface ContentFileRef extends AccountInput {
  fileId: string;
}

/** First key of each raw API request, deduped — audit detail for *_batch_update. */
export function requestKinds(requests: ReadonlyArray<Record<string, unknown>>): string[] {
  return [...new Set(requests.map((r) => Object.keys(r)[0] ?? 'unknown'))];
}

/** Base for Docs/Sheets/Slides services: Drive pre-flight, then API calls with api/name-aware errors. */
export abstract class ContentService {
  protected readonly ops: OperationRunner;
  protected abstract readonly api: GoogleKind;

  constructor(deps: OperationDeps) {
    this.ops = new OperationRunner(deps);
  }

  protected resolve(account: string | undefined, fileId: string): Promise<ResolvedFile> {
    return this.ops.exec(account, 'idempotent', fileId, (ctx) =>
      resolveGoogleFile(ctx.drive, fileId, this.api),
    );
  }

  protected run<T>(
    account: string | undefined,
    file: ResolvedFile,
    kind: OperationKind,
    fn: (ctx: DriveContext) => Promise<T>,
  ): Promise<T> {
    return this.ops.exec(account, kind, file.id, (ctx) => fn(ctx), {
      api: this.api,
      name: file.name,
    });
  }
}
```

- [ ] **Step 4: Verify** — both test files PASS; `npm run check` → green.

- [ ] **Step 5: Commit**

```bash
git add src/core src/content
git commit -m "feat(content): Google-file pre-flight, surrogate-safe paging, content service base"
```

---

## Chunk 2: Docs

### Task 6: Docs structure formatter

**Files:**
- Create: `src/content/docs-structure.ts`
- Test: `src/content/__tests__/docs-structure.test.ts`

- [ ] **Step 1: Write the failing test:**

```ts
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { DocsDocument } from '../../drive/docs-adapter.js';
import { bodyEndIndex, docOutline, headings } from '../docs-structure.js';

const demo = JSON.parse(
  readFileSync(new URL('./fixtures/demo-doc.json', import.meta.url), 'utf8'),
) as DocsDocument;

describe('docOutline', () => {
  it('renders indexed lines for the demo document', () => {
    const lines = docOutline(demo).split('\n');
    expect(lines[0]).toBe('[0-1] SECTION_BREAK');
    expect(lines[1]).toBe('[1-35] HEADING_1 "marvin-drive — Proje Genel Bakışı"');
    expect(lines).toContain('[162-168] HEADING_2 "Durum"');
    expect(lines).toContain('[403-867] TABLE 8x2');
    expect(lines).toContain('  (0,0) [406-413] NORMAL_TEXT "Katman"');
    expect(lines.at(-1)).toMatch(/^\[1927-2042\] NORMAL_TEXT "Bu belge/);
  });

  it('caps long paragraph text at 200 chars', () => {
    const long = 'x'.repeat(250);
    const doc: DocsDocument = {
      body: {
        content: [
          { startIndex: 1, endIndex: 252, paragraph: { elements: [{ textRun: { content: `${long}\n` } }] } },
        ],
      },
    };
    expect(docOutline(doc)).toBe(`[1-252] NORMAL_TEXT "${'x'.repeat(200)}…"`);
  });
});

describe('headings / bodyEndIndex', () => {
  it('lists top-level headings with ranges and finds the body end', () => {
    const hs = headings(demo);
    expect(hs[0]).toEqual({ text: 'marvin-drive — Proje Genel Bakışı', startIndex: 1, endIndex: 35 });
    expect(hs.map((h) => h.text)).toContain('Durum');
    expect(bodyEndIndex(demo)).toBe(2042);
  });

  it('ignores headings inside tables', () => {
    const doc: DocsDocument = {
      body: {
        content: [
          {
            startIndex: 1,
            endIndex: 20,
            table: {
              rows: 1,
              columns: 1,
              tableRows: [
                {
                  tableCells: [
                    {
                      content: [
                        {
                          startIndex: 3,
                          endIndex: 8,
                          paragraph: {
                            paragraphStyle: { namedStyleType: 'HEADING_1' },
                            elements: [{ textRun: { content: 'Cell\n' } }],
                          },
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          },
        ],
      },
    };
    expect(headings(doc)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run** → FAIL (module missing).

- [ ] **Step 3: Implement** `src/content/docs-structure.ts`:

```ts
import type { docs_v1 } from 'googleapis';
import type { DocsDocument } from '../drive/docs-adapter.js';

type StructuralElement = docs_v1.Schema$StructuralElement;
type Paragraph = docs_v1.Schema$Paragraph;

/** Field mask for documents.get used by structure reads and index computation. */
const PARAGRAPH_FIELDS = 'paragraph(paragraphStyle(namedStyleType),elements(textRun(content)))';
export const DOC_FIELDS = `documentId,title,revisionId,body(content(startIndex,endIndex,${PARAGRAPH_FIELDS},table(rows,columns,tableRows(tableCells(content(startIndex,endIndex,${PARAGRAPH_FIELDS})))),sectionBreak(sectionStyle(sectionType)),tableOfContents(content(startIndex))))`;

const MAX_TEXT = 200;
const HEADING_STYLES = new Set([
  'TITLE',
  'SUBTITLE',
  'HEADING_1',
  'HEADING_2',
  'HEADING_3',
  'HEADING_4',
  'HEADING_5',
  'HEADING_6',
]);

export interface HeadingRef {
  text: string;
  startIndex: number;
  endIndex: number;
}

export function paragraphText(p: Paragraph): string {
  return (p.elements ?? []).map((e) => e.textRun?.content ?? '').join('');
}

function quote(text: string): string {
  const s = text.replace(/\n$/, '');
  return JSON.stringify(s.length > MAX_TEXT ? `${s.slice(0, MAX_TEXT)}…` : s);
}

function walk(content: StructuralElement[], depth: number, prefix: string, lines: string[]): void {
  const pad = '  '.repeat(depth);
  for (const el of content) {
    const range = `[${el.startIndex ?? 0}-${el.endIndex ?? 0}]`;
    if (el.paragraph) {
      const style = el.paragraph.paragraphStyle?.namedStyleType ?? 'NORMAL_TEXT';
      lines.push(`${pad}${prefix}${range} ${style} ${quote(paragraphText(el.paragraph))}`);
    } else if (el.table) {
      lines.push(`${pad}${prefix}${range} TABLE ${el.table.rows ?? 0}x${el.table.columns ?? 0}`);
      (el.table.tableRows ?? []).forEach((row, r) => {
        (row.tableCells ?? []).forEach((cell, c) => {
          walk(cell.content ?? [], depth + 1, `(${r},${c}) `, lines);
        });
      });
    } else if (el.sectionBreak) {
      lines.push(`${pad}${prefix}${range} SECTION_BREAK`);
    } else if (el.tableOfContents) {
      lines.push(`${pad}${prefix}${range} TABLE_OF_CONTENTS`);
    }
  }
}

/** One line per structural element with its [start-end) index range — input for docs_batch_update. */
export function docOutline(doc: DocsDocument): string {
  const lines: string[] = [];
  walk(doc.body?.content ?? [], 0, '', lines);
  return lines.join('\n');
}

/** Top-level heading paragraphs (headings inside tables are ignored). */
export function headings(doc: DocsDocument): HeadingRef[] {
  const out: HeadingRef[] = [];
  for (const el of doc.body?.content ?? []) {
    const style = el.paragraph?.paragraphStyle?.namedStyleType;
    if (!el.paragraph || !style || !HEADING_STYLES.has(style)) continue;
    out.push({
      text: paragraphText(el.paragraph).trim(),
      startIndex: el.startIndex ?? 0,
      endIndex: el.endIndex ?? 0,
    });
  }
  return out;
}

/** endIndex of the last body element (the body always ends with a paragraph). */
export function bodyEndIndex(doc: DocsDocument): number {
  const content = doc.body?.content ?? [];
  return content.at(-1)?.endIndex ?? 1;
}
```

- [ ] **Step 4: Verify** → PASS. If a golden line differs from the fixture (e.g. an index), print `docOutline(demo)` once and correct the **test expectation only after confirming the fixture data matches** (fixture is the source of truth). `npm run check` → green.

- [ ] **Step 5: Commit** — `git add src/content && git commit -m "feat(content): Docs structure outline, headings and body end"`

### Task 7: DocsService.read

**Files:**
- Create: `src/content/docs-service.ts`
- Test: `src/content/__tests__/docs-service.test.ts`

- [ ] **Step 1: Write the failing test** (this file grows in Tasks 8–9; keep the shared setup at the top):

```ts
import { Readable } from 'node:stream';
import { beforeEach, describe, expect, it } from 'vitest';
import { ValidationError } from '../../errors.js';
import { GOOGLE_MIME } from '../../files/export-formats.js';
import {
  createAudit,
  createFakeDocs,
  createFakeDrive,
  createRunner,
  httpError,
  noSleep,
  silentLogger,
  stubFile,
  type FakeDocs,
  type FakeDrive,
} from '../../files/__tests__/fakes.js';
import { DocsService } from '../docs-service.js';
import { DOC_FIELDS } from '../docs-structure.js';

let drive: FakeDrive;
let docs: FakeDocs;
let audit: ReturnType<typeof createAudit>;
let service: DocsService;

beforeEach(() => {
  drive = createFakeDrive();
  docs = createFakeDocs();
  audit = createAudit();
  service = new DocsService({
    runner: createRunner(drive, { docs }),
    audit,
    retry: noSleep,
    logger: silentLogger(),
  });
});

const doc = (): void => stubFile(drive, 'd1', GOOGLE_MIME.document, 'Plan');

describe('DocsService.read', () => {
  it('reads the revision before exporting Markdown', async () => {
    doc();
    const order: string[] = [];
    docs.getDocument.mockImplementationOnce(async () => {
      order.push('revision');
      return { revisionId: 'r1' };
    });
    drive.exportMedia.mockImplementationOnce(async () => {
      order.push('export');
      return Readable.from([Buffer.from('# Plan\n\nHello')]);
    });
    const res = await service.read({ fileId: 'd1' });
    expect(order).toEqual(['revision', 'export']);
    expect(docs.getDocument).toHaveBeenCalledWith('d1', 'revisionId');
    expect(drive.exportMedia).toHaveBeenCalledWith('d1', 'text/markdown');
    expect(res).toEqual({
      fileId: 'd1',
      name: 'Plan',
      revisionId: 'r1',
      format: 'markdown',
      content: '# Plan\n\nHello',
      totalChars: 13,
      offset: 0,
      truncated: false,
    });
  });

  it('returns the indexed structure', async () => {
    doc();
    docs.getDocument.mockResolvedValueOnce({
      revisionId: 'r2',
      body: {
        content: [
          { startIndex: 1, endIndex: 6, paragraph: { elements: [{ textRun: { content: 'Hey!\n' } }] } },
        ],
      },
    });
    const res = await service.read({ fileId: 'd1', format: 'structure' });
    expect(docs.getDocument).toHaveBeenCalledWith('d1', DOC_FIELDS);
    expect(res.content).toBe('[1-6] NORMAL_TEXT "Hey!"');
    expect(res.revisionId).toBe('r2');
  });

  it('pages long content', async () => {
    doc();
    docs.getDocument.mockResolvedValueOnce({ revisionId: 'r1' });
    drive.exportMedia.mockResolvedValueOnce(Readable.from([Buffer.from('a'.repeat(1500))]));
    const res = await service.read({ fileId: 'd1', maxChars: 1000 });
    expect(res).toMatchObject({ truncated: true, nextOffset: 1000, totalChars: 1500 });
    expect(res.content).toHaveLength(1000);
  });

  it('retries a 5xx read', async () => {
    doc();
    docs.getDocument.mockRejectedValueOnce(httpError(503)).mockResolvedValueOnce({ revisionId: 'r1' });
    drive.exportMedia.mockResolvedValueOnce(Readable.from([Buffer.from('x')]));
    await expect(service.read({ fileId: 'd1' })).resolves.toMatchObject({ content: 'x' });
  });

  it('rejects other file types before calling Docs', async () => {
    stubFile(drive, 's1', GOOGLE_MIME.spreadsheet, 'Budget');
    await expect(service.read({ fileId: 's1' })).rejects.toBeInstanceOf(ValidationError);
    expect(docs.getDocument).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run** → FAIL.

- [ ] **Step 3: Implement** `src/content/docs-service.ts` (read only for now):

```ts
import type { Readable } from 'node:stream';
import { ContentService, type ContentFileRef } from './content-service.js';
import { DOC_FIELDS, docOutline } from './docs-structure.js';
import { DEFAULT_MAX_CHARS, sliceText, type TextSlice } from './truncate.js';

export type DocsReadFormat = 'markdown' | 'structure';

export interface DocsReadInput extends ContentFileRef {
  format?: DocsReadFormat;
  maxChars?: number;
  offset?: number;
}

export interface DocsReadResult extends TextSlice {
  fileId: string;
  name: string;
  revisionId: string;
  format: DocsReadFormat;
}

async function readAll(stream: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
  return Buffer.concat(chunks).toString('utf8');
}

export class DocsService extends ContentService {
  protected readonly api = 'docs' as const;

  async read(input: DocsReadInput): Promise<DocsReadResult> {
    const file = await this.resolve(input.account, input.fileId);
    const format = input.format ?? 'markdown';
    return this.run(input.account, file, 'idempotent', async (ctx) => {
      let revisionId: string;
      let text: string;
      if (format === 'markdown') {
        // Revision first: it is never newer than the exported content (spec §4.1).
        revisionId = (await ctx.docs.getDocument(file.id, 'revisionId')).revisionId ?? '';
        text = await readAll(await ctx.drive.exportMedia(file.id, 'text/markdown'));
      } else {
        const doc = await ctx.docs.getDocument(file.id, DOC_FIELDS);
        revisionId = doc.revisionId ?? '';
        text = docOutline(doc);
      }
      return {
        fileId: file.id,
        name: file.name,
        revisionId,
        format,
        ...sliceText(text, input.offset ?? 0, input.maxChars ?? DEFAULT_MAX_CHARS),
      };
    });
  }
}
```

Note: the retry wraps the whole callback, so a 5xx on the export re-runs both calls — correct for an idempotent read.

- [ ] **Step 4: Verify** → PASS; `npm run check` → green.

- [ ] **Step 5: Commit** — `git add src/content && git commit -m "feat(content): docs read as Markdown or indexed structure"`

### Task 8: DocsService.replaceText and insertText

**Files:**
- Modify: `src/content/docs-service.ts`
- Test: `src/content/__tests__/docs-service.test.ts`

- [ ] **Step 1: Write the failing tests** — append:

```ts
const END_DOC = {
  revisionId: 'r5',
  body: {
    content: [
      { endIndex: 1, sectionBreak: {} },
      {
        startIndex: 1,
        endIndex: 7,
        paragraph: { paragraphStyle: { namedStyleType: 'HEADING_1' }, elements: [{ textRun: { content: 'Goals\n' } }] },
      },
      {
        startIndex: 7,
        endIndex: 12,
        paragraph: { paragraphStyle: { namedStyleType: 'NORMAL_TEXT' }, elements: [{ textRun: { content: 'Ship\n' } }] },
      },
      {
        startIndex: 12,
        endIndex: 18,
        paragraph: { paragraphStyle: { namedStyleType: 'HEADING_2' }, elements: [{ textRun: { content: 'Later\n' } }] },
      },
    ],
  },
};

describe('DocsService.replaceText', () => {
  it('replaces all occurrences, returns the new revision and audits counts only', async () => {
    doc();
    docs.batchUpdate.mockResolvedValueOnce({
      replies: [{ replaceAllText: { occurrencesChanged: 3 } }],
      writeControl: { requiredRevisionId: 'r9' },
    });
    const res = await service.replaceText({ fileId: 'd1', find: 'a', replace: 'b', requiredRevisionId: 'r8' });
    expect(docs.batchUpdate).toHaveBeenCalledWith(
      'd1',
      [{ replaceAllText: { containsText: { text: 'a', matchCase: true }, replaceText: 'b' } }],
      'r8',
    );
    expect(res).toEqual({ occurrencesChanged: 3, revisionId: 'r9' });
    expect(audit.entries[0]).toEqual({
      account: 'emco',
      op: 'docs_replace_text',
      fileId: 'd1',
      name: 'Plan',
      details: { occurrencesChanged: 3, matchCase: true, guarded: 'caller' },
    });
    expect(JSON.stringify(audit.entries)).not.toContain('"b"');
  });

  it('reports 0 when Docs omits occurrencesChanged', async () => {
    doc();
    docs.batchUpdate.mockResolvedValueOnce({ replies: [{ replaceAllText: {} }] });
    await expect(
      service.replaceText({ fileId: 'd1', find: 'zz', replace: 'y', matchCase: false }),
    ).resolves.toEqual({ occurrencesChanged: 0, revisionId: null });
    expect(audit.entries[0]?.details).toMatchObject({ guarded: false, matchCase: false });
  });

  it('never retries a 5xx edit', async () => {
    doc();
    docs.batchUpdate.mockRejectedValueOnce(httpError(500));
    await expect(service.replaceText({ fileId: 'd1', find: 'a', replace: 'b' })).rejects.toThrow(
      /re-read the file/,
    );
    expect(docs.batchUpdate).toHaveBeenCalledTimes(1);
  });
});

describe('DocsService.insertText', () => {
  it('inserts at the end under the implicit read guard', async () => {
    doc();
    docs.getDocument.mockResolvedValueOnce(END_DOC);
    docs.batchUpdate.mockResolvedValueOnce({ writeControl: { requiredRevisionId: 'r6' } });
    const res = await service.insertText({ fileId: 'd1', text: '\nMore', position: { at: 'end' } });
    expect(docs.getDocument).toHaveBeenCalledWith('d1', DOC_FIELDS);
    expect(docs.batchUpdate).toHaveBeenCalledWith('d1', [{ insertText: { location: { index: 17 }, text: '\nMore' } }], 'r5');
    expect(res).toEqual({ insertedAt: 17, revisionId: 'r6' });
    expect(audit.entries[0]?.details).toEqual({ position: 'end', insertedAt: 17, chars: 5, guarded: 'implicit' });
  });

  it('prefers the caller revision over the implicit one', async () => {
    doc();
    docs.getDocument.mockResolvedValueOnce(END_DOC);
    docs.batchUpdate.mockResolvedValueOnce({});
    await service.insertText({ fileId: 'd1', text: 'x', position: { at: 'end' }, requiredRevisionId: 'mine' });
    expect(docs.batchUpdate.mock.calls[0]?.[2]).toBe('mine');
    expect(audit.entries[0]?.details).toMatchObject({ guarded: 'caller' });
  });

  it('inserts after a heading and normalizes the new paragraph style', async () => {
    doc();
    docs.getDocument.mockResolvedValueOnce(END_DOC);
    docs.batchUpdate.mockResolvedValueOnce({});
    await service.insertText({ fileId: 'd1', text: 'First\n', position: { at: 'afterHeading', heading: 'Goals' } });
    expect(docs.batchUpdate.mock.calls[0]?.[1]).toEqual([
      { insertText: { location: { index: 7 }, text: 'First\n' } },
      {
        updateParagraphStyle: {
          range: { startIndex: 7, endIndex: 13 },
          paragraphStyle: { namedStyleType: 'NORMAL_TEXT' },
          fields: 'namedStyleType',
        },
      },
    ]);
  });

  it('does not restyle when the text merges into the next paragraph', async () => {
    doc();
    docs.getDocument.mockResolvedValueOnce(END_DOC);
    docs.batchUpdate.mockResolvedValueOnce({});
    await service.insertText({ fileId: 'd1', text: 'Pre: ', position: { at: 'afterHeading', heading: 'Goals' } });
    expect(docs.batchUpdate.mock.calls[0]?.[1]).toEqual([
      { insertText: { location: { index: 7 }, text: 'Pre: ' } },
    ]);
  });

  it('handles a heading that is the last paragraph', async () => {
    doc();
    docs.getDocument.mockResolvedValueOnce(END_DOC);
    docs.batchUpdate.mockResolvedValueOnce({});
    await service.insertText({ fileId: 'd1', text: 'Soon', position: { at: 'afterHeading', heading: 'Later' } });
    expect(docs.batchUpdate.mock.calls[0]?.[1]).toEqual([
      { insertText: { location: { index: 17 }, text: '\nSoon' } },
      {
        updateParagraphStyle: {
          range: { startIndex: 18, endIndex: 23 },
          paragraphStyle: { namedStyleType: 'NORMAL_TEXT' },
          fields: 'namedStyleType',
        },
      },
    ]);
  });

  it('lists available headings when the heading is missing', async () => {
    doc();
    docs.getDocument.mockResolvedValueOnce(END_DOC);
    await expect(
      service.insertText({ fileId: 'd1', text: 'x', position: { at: 'afterHeading', heading: 'Nope' } }),
    ).rejects.toThrow('Heading "Nope" not found in "Plan". Available headings: "Goals", "Later"');
    expect(docs.batchUpdate).not.toHaveBeenCalled();
  });

  it('inserts at an explicit index without reading', async () => {
    doc();
    docs.batchUpdate.mockResolvedValueOnce({});
    await service.insertText({ fileId: 'd1', text: 'x', position: { at: 'index', index: 5 } });
    expect(docs.getDocument).not.toHaveBeenCalled();
    expect(docs.batchUpdate).toHaveBeenCalledWith('d1', [{ insertText: { location: { index: 5 }, text: 'x' } }], undefined);
    expect(audit.entries[0]?.details).toMatchObject({ guarded: false });
  });
});
```

- [ ] **Step 2: Run** → FAIL.

- [ ] **Step 3: Implement** — add to `src/content/docs-service.ts`:

Imports: `ValidationError` from `'../errors.js'`; `type DocsRequest` from `'../drive/docs-adapter.js'`; `bodyEndIndex, headings` from `'./docs-structure.js'`; `type Guard` from `'./content-service.js'`.

```ts
export interface DocsReplaceInput extends ContentFileRef {
  find: string;
  replace: string;
  matchCase?: boolean;
  requiredRevisionId?: string;
}

export type InsertPosition =
  | { at: 'end' }
  | { at: 'afterHeading'; heading: string }
  | { at: 'index'; index: number };

export interface DocsInsertInput extends ContentFileRef {
  text: string;
  position: InsertPosition;
  requiredRevisionId?: string;
}

export interface DocsEditResult {
  revisionId: string | null;
}

interface InsertPlan {
  index: number;
  text: string;
  /** Range to reset to NORMAL_TEXT, when the insert forms its own paragraph after a heading. */
  restyle?: { startIndex: number; endIndex: number };
  revisionId?: string;
}
```

Methods inside `DocsService`:

```ts
  async replaceText(input: DocsReplaceInput): Promise<DocsEditResult & { occurrencesChanged: number }> {
    const file = await this.resolve(input.account, input.fileId);
    const matchCase = input.matchCase ?? true;
    return this.run(input.account, file, 'mutate', async (ctx) => {
      const res = await ctx.docs.batchUpdate(
        file.id,
        [{ replaceAllText: { containsText: { text: input.find, matchCase }, replaceText: input.replace } }],
        input.requiredRevisionId,
      );
      const occurrencesChanged = res.replies?.[0]?.replaceAllText?.occurrencesChanged ?? 0;
      const guarded: Guard = input.requiredRevisionId ? 'caller' : false;
      await this.ops.audit(ctx, 'docs_replace_text', file, { occurrencesChanged, matchCase, guarded });
      return { occurrencesChanged, revisionId: res.writeControl?.requiredRevisionId ?? null };
    });
  }

  async insertText(input: DocsInsertInput): Promise<DocsEditResult & { insertedAt: number }> {
    const file = await this.resolve(input.account, input.fileId);
    const plan = await this.planInsert(input, file);
    const revision = input.requiredRevisionId ?? plan.revisionId;
    const guarded: Guard = input.requiredRevisionId ? 'caller' : plan.revisionId ? 'implicit' : false;
    const requests: DocsRequest[] = [{ insertText: { location: { index: plan.index }, text: plan.text } }];
    if (plan.restyle) {
      requests.push({
        updateParagraphStyle: {
          range: plan.restyle,
          paragraphStyle: { namedStyleType: 'NORMAL_TEXT' },
          fields: 'namedStyleType',
        },
      });
    }
    return this.run(input.account, file, 'mutate', async (ctx) => {
      const res = await ctx.docs.batchUpdate(file.id, requests, revision);
      await this.ops.audit(ctx, 'docs_insert_text', file, {
        position: input.position.at,
        insertedAt: plan.index,
        chars: input.text.length,
        guarded,
      });
      return { insertedAt: plan.index, revisionId: res.writeControl?.requiredRevisionId ?? null };
    });
  }

  private async planInsert(input: DocsInsertInput, file: { id: string; name: string }): Promise<InsertPlan> {
    const pos = input.position;
    if (pos.at === 'index') return { index: pos.index, text: input.text };

    const doc = await this.run(input.account, file, 'idempotent', (ctx) =>
      ctx.docs.getDocument(file.id, DOC_FIELDS),
    );
    const revisionId = doc.revisionId ?? undefined;
    const end = bodyEndIndex(doc);
    const base = revisionId ? { revisionId } : {};
    if (pos.at === 'end') return { index: end - 1, text: input.text, ...base };

    const all = headings(doc);
    const heading = all.find((h) => h.text === pos.heading);
    if (!heading) {
      const names = all.slice(0, 20).map((h) => JSON.stringify(h.text)).join(', ') || '(none)';
      throw new ValidationError(
        `Heading "${pos.heading}" not found in "${file.name}". Available headings: ${names}`,
      );
    }
    if (heading.endIndex >= end) {
      // Heading is the last paragraph: insert before its final newline, starting a new paragraph.
      const index = end - 1;
      const text = `\n${input.text}`;
      // +1 also covers the original final newline, so a trailing empty paragraph left by a
      // caller's "\n" is not left in heading style.
      return { index, text, restyle: { startIndex: index + 1, endIndex: index + text.length + 1 }, ...base };
    }
    const index = heading.endIndex;
    // Only text ending in "\n" forms its own paragraph; otherwise it merges into the next one,
    // whose style must not be touched.
    const restyle = input.text.endsWith('\n')
      ? { startIndex: index, endIndex: index + input.text.length }
      : undefined;
    return { index, text: input.text, ...(restyle ? { restyle } : {}), ...base };
  }
```

- [ ] **Step 4: Verify** → PASS; `npm run check` → green.

- [ ] **Step 5: Commit** — `git add src/content && git commit -m "feat(content): docs replace and insert text with implicit revision guard"`

### Task 9: DocsService.batchUpdate

**Files:** Modify `src/content/docs-service.ts`; test in `src/content/__tests__/docs-service.test.ts`.

- [ ] **Step 1: Failing test** — append:

```ts
describe('DocsService.batchUpdate', () => {
  it('sends raw requests under the required revision and audits request kinds', async () => {
    doc();
    docs.batchUpdate.mockResolvedValueOnce({ replies: [{}, {}], writeControl: { requiredRevisionId: 'r2' } });
    const requests = [
      { insertText: { location: { index: 1 }, text: 'A' } },
      { updateTextStyle: { range: { startIndex: 1, endIndex: 2 }, textStyle: { bold: true }, fields: 'bold' } },
      { insertText: { location: { index: 2 }, text: 'B' } },
    ];
    const res = await service.batchUpdate({ fileId: 'd1', requests, requiredRevisionId: 'r1' });
    expect(docs.batchUpdate).toHaveBeenCalledWith('d1', requests, 'r1');
    expect(res).toEqual({ replies: [{}, {}], revisionId: 'r2' });
    expect(audit.entries[0]?.details).toEqual({
      requestCount: 3,
      requestKinds: ['insertText', 'updateTextStyle'],
      guarded: 'caller',
    });
  });
});
```

- [ ] **Step 2: Run** → FAIL.

- [ ] **Step 3: Implement** — add import `requestKinds` from `'./content-service.js'`, then:

```ts
export interface DocsBatchInput extends ContentFileRef {
  requests: Array<Record<string, unknown>>;
  requiredRevisionId: string;
}

  async batchUpdate(input: DocsBatchInput): Promise<DocsEditResult & { replies: unknown[] }> {
    const file = await this.resolve(input.account, input.fileId);
    return this.run(input.account, file, 'mutate', async (ctx) => {
      const res = await ctx.docs.batchUpdate(
        file.id,
        input.requests as DocsRequest[],
        input.requiredRevisionId,
      );
      await this.ops.audit(ctx, 'docs_batch_update', file, {
        requestCount: input.requests.length,
        requestKinds: requestKinds(input.requests),
        guarded: 'caller',
      });
      return { replies: res.replies ?? [], revisionId: res.writeControl?.requiredRevisionId ?? null };
    });
  }
```

- [ ] **Step 4: Verify** → PASS; `npm run check` → green.

- [ ] **Step 5: Commit** — `git add src/content && git commit -m "feat(content): docs batch update (advanced, revision-guarded)"`

---

## Chunk 3: Sheets and Slides

### Task 10: SheetsService

**Files:**
- Create: `src/content/sheets-service.ts`
- Test: `src/content/__tests__/sheets-service.test.ts`

- [ ] **Step 1: Failing tests:**

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { ValidationError } from '../../errors.js';
import { GOOGLE_MIME } from '../../files/export-formats.js';
import {
  createAudit,
  createFakeDrive,
  createFakeSheets,
  createRunner,
  httpError,
  noSleep,
  silentLogger,
  stubFile,
  type FakeDrive,
  type FakeSheets,
} from '../../files/__tests__/fakes.js';
import { SheetsService } from '../sheets-service.js';

let drive: FakeDrive;
let sheets: FakeSheets;
let audit: ReturnType<typeof createAudit>;
let service: SheetsService;

beforeEach(() => {
  drive = createFakeDrive();
  sheets = createFakeSheets();
  audit = createAudit();
  service = new SheetsService({ runner: createRunner(drive, { sheets }), audit, retry: noSleep, logger: silentLogger() });
});

const sheet = (): void => stubFile(drive, 's1', GOOGLE_MIME.spreadsheet, 'Budget');

describe('SheetsService', () => {
  it('info lists tabs', async () => {
    sheet();
    sheets.getSpreadsheet.mockResolvedValueOnce({
      properties: { title: 'Budget', locale: 'tr_TR', timeZone: 'Europe/Istanbul' },
      sheets: [
        { properties: { sheetId: 0, title: 'Modüller', index: 0, gridProperties: { rowCount: 1000, columnCount: 26 } } },
        { properties: { sheetId: 7, title: 'Hidden', index: 1, hidden: true, gridProperties: { rowCount: 5, columnCount: 2 } } },
      ],
    });
    await expect(service.info({ fileId: 's1' })).resolves.toEqual({
      fileId: 's1',
      name: 'Budget',
      locale: 'tr_TR',
      timeZone: 'Europe/Istanbul',
      sheets: [
        { sheetId: 0, title: 'Modüller', index: 0, rowCount: 1000, columnCount: 26, hidden: false },
        { sheetId: 7, title: 'Hidden', index: 1, rowCount: 5, columnCount: 2, hidden: true },
      ],
    });
  });

  it('readRange maps render options and truncates whole rows', async () => {
    sheet();
    sheets.getValues.mockResolvedValueOnce({ range: 'A!A1:C3', values: [['a', 'b', 'c'], ['d', 'e', 'f'], ['g']] });
    const res = await service.readRange({ fileId: 's1', range: 'A!A1:C3', render: 'formula', maxCells: 5 });
    expect(sheets.getValues).toHaveBeenCalledWith('s1', 'A!A1:C3', 'FORMULA');
    expect(res).toEqual({ range: 'A!A1:C3', values: [['a', 'b', 'c']], rowCount: 1, totalRows: 3, truncated: true });
  });

  it('readRange returns at least one row and handles empty ranges', async () => {
    sheet();
    sheets.getValues.mockResolvedValueOnce({ range: 'A!A1', values: [['a', 'b', 'c']] });
    await expect(service.readRange({ fileId: 's1', range: 'A!A1', maxCells: 1 })).resolves.toMatchObject({
      rowCount: 1,
      truncated: false,
    });
    sheet();
    sheets.getValues.mockResolvedValueOnce({ range: 'A!Z9' });
    await expect(service.readRange({ fileId: 's1', range: 'A!Z9' })).resolves.toEqual({
      range: 'A!Z9',
      values: [],
      rowCount: 0,
      totalRows: 0,
      truncated: false,
    });
    expect(sheets.getValues.mock.calls[1]?.[2]).toBe('FORMATTED_VALUE');
  });

  it('writeRange clears null cells and audits counts only', async () => {
    sheet();
    sheets.updateValues.mockResolvedValueOnce({ updatedRange: 'A!A1:B1', updatedRows: 1, updatedColumns: 2, updatedCells: 2 });
    const res = await service.writeRange({ fileId: 's1', range: 'A!A1:B1', values: [['=1+1', null]] });
    expect(sheets.updateValues).toHaveBeenCalledWith('s1', 'A!A1:B1', [['=1+1', '']], 'USER_ENTERED');
    expect(res).toEqual({ updatedRange: 'A!A1:B1', updatedRows: 1, updatedColumns: 2, updatedCells: 2 });
    expect(audit.entries[0]).toMatchObject({
      op: 'sheets_write_range',
      details: { updatedRange: 'A!A1:B1', updatedCells: 2, input: 'user_entered' },
    });
    expect(JSON.stringify(audit.entries)).not.toContain('=1+1');
  });

  it('rejects more than 10 000 cells before calling Sheets', async () => {
    sheet();
    const values = Array.from({ length: 101 }, () => Array.from({ length: 100 }, () => 1));
    await expect(service.writeRange({ fileId: 's1', range: 'A', values })).rejects.toBeInstanceOf(ValidationError);
    expect(sheets.updateValues).not.toHaveBeenCalled();
  });

  it('appendRows uses RAW when asked and never retries 5xx', async () => {
    sheet();
    sheets.appendValues.mockResolvedValueOnce({ updates: { updatedRange: 'A!A4:B4', updatedRows: 1, updatedCells: 2 } });
    await expect(service.appendRows({ fileId: 's1', range: 'A', values: [['x', 2]], input: 'raw' })).resolves.toEqual({
      updatedRange: 'A!A4:B4',
      updatedRows: 1,
      updatedCells: 2,
    });
    expect(sheets.appendValues).toHaveBeenCalledWith('s1', 'A', [['x', 2]], 'RAW');
    sheet();
    sheets.appendValues.mockRejectedValueOnce(httpError(502));
    await expect(service.appendRows({ fileId: 's1', range: 'A', values: [['x']] })).rejects.toThrow(/re-read/);
    expect(sheets.appendValues).toHaveBeenCalledTimes(2);
  });

  it('batchUpdate passes requests through and audits kinds', async () => {
    sheet();
    sheets.batchUpdate.mockResolvedValueOnce({ replies: [{ addSheet: { properties: { sheetId: 9 } } }] });
    const requests = [{ addSheet: { properties: { title: 'New' } } }];
    await expect(service.batchUpdate({ fileId: 's1', requests })).resolves.toEqual({
      replies: [{ addSheet: { properties: { sheetId: 9 } } }],
    });
    expect(audit.entries[0]?.details).toEqual({ requestCount: 1, requestKinds: ['addSheet'], guarded: false });
  });
});
```

- [ ] **Step 2: Run** → FAIL.

- [ ] **Step 3: Implement** `src/content/sheets-service.ts`:

```ts
import type { CellValue, SheetsRequest, ValueInput, ValueRender } from '../drive/sheets-adapter.js';
import { ValidationError } from '../errors.js';
import { ContentService, requestKinds, type ContentFileRef } from './content-service.js';

const INFO_FIELDS =
  'spreadsheetId,properties(title,locale,timeZone),sheets(properties(sheetId,title,index,hidden,gridProperties(rowCount,columnCount)))';

export const DEFAULT_MAX_CELLS = 5_000;
export const MAX_WRITE_CELLS = 10_000;

export type RenderOption = 'formatted' | 'unformatted' | 'formula';
export type InputOption = 'user_entered' | 'raw';
export type WriteCell = CellValue | null;

const RENDER: Record<RenderOption, ValueRender> = {
  formatted: 'FORMATTED_VALUE',
  unformatted: 'UNFORMATTED_VALUE',
  formula: 'FORMULA',
};

const INPUT: Record<InputOption, ValueInput> = { user_entered: 'USER_ENTERED', raw: 'RAW' };

export interface SheetTab {
  sheetId: number;
  title: string;
  index: number;
  rowCount: number;
  columnCount: number;
  hidden: boolean;
}

export interface SheetsInfo {
  fileId: string;
  name: string;
  locale: string | null;
  timeZone: string | null;
  sheets: SheetTab[];
}

export interface ReadRangeInput extends ContentFileRef {
  range: string;
  render?: RenderOption;
  maxCells?: number;
}

export interface ReadRangeResult {
  range: string;
  values: unknown[][];
  rowCount: number;
  totalRows: number;
  truncated: boolean;
}

export interface WriteRangeInput extends ContentFileRef {
  range: string;
  values: WriteCell[][];
  input?: InputOption;
}

export interface SheetsBatchInput extends ContentFileRef {
  requests: Array<Record<string, unknown>>;
}

/** null → "" (the Sheets API skips nulls, leaving the old value); enforces the write cap. */
function toApiValues(values: WriteCell[][]): CellValue[][] {
  const cells = values.reduce((n, row) => n + row.length, 0);
  if (cells === 0) throw new ValidationError('values must contain at least one cell');
  if (cells > MAX_WRITE_CELLS) {
    throw new ValidationError(`Too many cells (${cells}); write at most ${MAX_WRITE_CELLS} per call`);
  }
  return values.map((row) => row.map((v) => (v === null ? '' : v)));
}

export class SheetsService extends ContentService {
  protected readonly api = 'sheets' as const;

  async info(input: ContentFileRef): Promise<SheetsInfo> {
    const file = await this.resolve(input.account, input.fileId);
    return this.run(input.account, file, 'idempotent', async (ctx) => {
      const s = await ctx.sheets.getSpreadsheet(file.id, INFO_FIELDS);
      return {
        fileId: file.id,
        name: s.properties?.title ?? file.name,
        locale: s.properties?.locale ?? null,
        timeZone: s.properties?.timeZone ?? null,
        sheets: (s.sheets ?? []).map((sh) => ({
          sheetId: sh.properties?.sheetId ?? 0,
          title: sh.properties?.title ?? '',
          index: sh.properties?.index ?? 0,
          rowCount: sh.properties?.gridProperties?.rowCount ?? 0,
          columnCount: sh.properties?.gridProperties?.columnCount ?? 0,
          hidden: sh.properties?.hidden ?? false,
        })),
      };
    });
  }

  async readRange(input: ReadRangeInput): Promise<ReadRangeResult> {
    const file = await this.resolve(input.account, input.fileId);
    const max = input.maxCells ?? DEFAULT_MAX_CELLS;
    return this.run(input.account, file, 'idempotent', async (ctx) => {
      const res = await ctx.sheets.getValues(file.id, input.range, RENDER[input.render ?? 'formatted']);
      const all = (res.values ?? []) as unknown[][];
      const values: unknown[][] = [];
      let cells = 0;
      for (const row of all) {
        if (values.length > 0 && cells + row.length > max) break;
        values.push(row);
        cells += row.length;
      }
      return {
        range: res.range ?? input.range,
        values,
        rowCount: values.length,
        totalRows: all.length,
        truncated: values.length < all.length,
      };
    });
  }

  async writeRange(input: WriteRangeInput): Promise<{
    updatedRange: string | null;
    updatedRows: number;
    updatedColumns: number;
    updatedCells: number;
  }> {
    const file = await this.resolve(input.account, input.fileId);
    const values = toApiValues(input.values);
    const inputOption = input.input ?? 'user_entered';
    return this.run(input.account, file, 'mutate', async (ctx) => {
      const res = await ctx.sheets.updateValues(file.id, input.range, values, INPUT[inputOption]);
      const result = {
        updatedRange: res.updatedRange ?? null,
        updatedRows: res.updatedRows ?? 0,
        updatedColumns: res.updatedColumns ?? 0,
        updatedCells: res.updatedCells ?? 0,
      };
      await this.ops.audit(ctx, 'sheets_write_range', file, {
        updatedRange: result.updatedRange,
        updatedCells: result.updatedCells,
        input: inputOption,
      });
      return result;
    });
  }

  async appendRows(input: WriteRangeInput): Promise<{
    updatedRange: string | null;
    updatedRows: number;
    updatedCells: number;
  }> {
    const file = await this.resolve(input.account, input.fileId);
    const values = toApiValues(input.values);
    const inputOption = input.input ?? 'user_entered';
    return this.run(input.account, file, 'mutate', async (ctx) => {
      const res = await ctx.sheets.appendValues(file.id, input.range, values, INPUT[inputOption]);
      const result = {
        updatedRange: res.updates?.updatedRange ?? null,
        updatedRows: res.updates?.updatedRows ?? 0,
        updatedCells: res.updates?.updatedCells ?? 0,
      };
      await this.ops.audit(ctx, 'sheets_append_rows', file, {
        updatedRange: result.updatedRange,
        updatedCells: result.updatedCells,
        input: inputOption,
      });
      return result;
    });
  }

  async batchUpdate(input: SheetsBatchInput): Promise<{ replies: unknown[] }> {
    const file = await this.resolve(input.account, input.fileId);
    return this.run(input.account, file, 'mutate', async (ctx) => {
      const res = await ctx.sheets.batchUpdate(file.id, input.requests as SheetsRequest[]);
      await this.ops.audit(ctx, 'sheets_batch_update', file, {
        requestCount: input.requests.length,
        requestKinds: requestKinds(input.requests),
        guarded: false, // the Sheets API has no revision guard
      });
      return { replies: res.replies ?? [] };
    });
  }
}
```

(Sheets has no revision guard: `sheets_batch_update` audits `guarded: false`; write/append details follow spec §6's Sheets row, which has no `guarded`.)

- [ ] **Step 4: Verify** → PASS; `npm run check` → green.

- [ ] **Step 5: Commit** — `git add src/content && git commit -m "feat(content): sheets info, read/write/append ranges and batch update"`

### Task 11: Slides text formatter

**Files:**
- Create: `src/content/slides-text.ts`
- Test: `src/content/__tests__/slides-text.test.ts`

Spec deviation (deliberate): the slide header omits `layout=…` — the layout's display name needs an extra `layouts` fetch, and the field mask stays small. Header is `## Slide N · id=<objectId>`.

- [ ] **Step 1: Failing test:**

```ts
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { SlidesPresentation } from '../../drive/slides-adapter.js';
import { findElement, shapeText, slidesOutline } from '../slides-text.js';

const demo = JSON.parse(
  readFileSync(new URL('./fixtures/demo-slides.json', import.meta.url), 'utf8'),
) as SlidesPresentation;

describe('slidesOutline', () => {
  it('lists every slide and element of the demo deck', () => {
    const out = slidesOutline(demo);
    const lines = out.split('\n');
    expect(lines[0]).toBe('## Slide 1 · id=p1');
    expect(lines[1]).toBe('- shape p1_i2 (TEXT_BOX): "marvin-drive"');
    expect(lines[2]).toBe('- shape p1_i3 (RECTANGLE): (empty)');
    expect(out.match(/^## Slide /gm)).toHaveLength(6);
    expect(out).not.toContain('Notes:');
  });

  it('renders tables, images, placeholders and notes', () => {
    const p: SlidesPresentation = {
      slides: [
        {
          objectId: 's1',
          pageElements: [
            { objectId: 't', shape: { shapeType: 'TEXT_BOX', placeholder: { type: 'TITLE' }, text: { textElements: [{ textRun: { content: 'Hi\n' } }] } } },
            {
              objectId: 'tb',
              table: {
                rows: 1,
                columns: 2,
                tableRows: [{ tableCells: [{ text: { textElements: [{ textRun: { content: 'a\n' } }] } }, {}] }],
              },
            },
            { objectId: 'img', image: {} },
            { objectId: 'g', elementGroup: { children: [{ objectId: 'c1' }, { objectId: 'c2' }] } },
          ],
          slideProperties: {
            notesPage: {
              notesProperties: { speakerNotesObjectId: 'n' },
              pageElements: [{ objectId: 'n', shape: { text: { textElements: [{ textRun: { content: 'Say hi\n' } }] } } }],
            },
          },
        },
      ],
    };
    expect(slidesOutline(p)).toBe(
      [
        '## Slide 1 · id=s1',
        '- shape t (TITLE): "Hi"',
        '- table tb 1x2: | a |  |',
        '- image img',
        '- group g: c1, c2',
        'Notes: "Say hi"',
      ].join('\n'),
    );
  });
});

describe('findElement / shapeText', () => {
  it('finds top-level elements and reads their text', () => {
    const found = findElement(demo, 'p1_i2');
    expect(found?.slideId).toBe('p1');
    expect(shapeText(found?.element.shape?.text)).toBe('marvin-drive');
    expect(findElement(demo, 'nope')).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run** → FAIL.

- [ ] **Step 3: Implement** `src/content/slides-text.ts`:

```ts
import type {
  SlidesPageElement,
  SlidesPresentation,
  SlidesTextContent,
} from '../drive/slides-adapter.js';

const TEXT = 'text(textElements(textRun(content)))';
/** Field mask for presentations.get used by slides_read and slides_set_text. */
export const SLIDE_FIELDS = `presentationId,title,revisionId,slides(objectId,pageElements(objectId,shape(shapeType,placeholder(type),${TEXT}),table(rows,columns,tableRows(tableCells(${TEXT}))),image(contentUrl),line(lineType),elementGroup(children(objectId)),video(id),sheetsChart(spreadsheetId)),slideProperties(notesPage(notesProperties(speakerNotesObjectId),pageElements(objectId,shape(${TEXT})))))`;

const MAX_TEXT = 300;

/** Plain text of a shape/cell, without the trailing newline Slides always keeps. */
export function shapeText(text: SlidesTextContent | undefined): string {
  return (text?.textElements ?? [])
    .map((e) => e.textRun?.content ?? '')
    .join('')
    .replace(/\n$/, '');
}

function quote(s: string): string {
  return JSON.stringify(s.length > MAX_TEXT ? `${s.slice(0, MAX_TEXT)}…` : s);
}

export function elementKind(el: SlidesPageElement): string {
  if (el.shape) return 'shape';
  if (el.table) return 'table';
  if (el.image) return 'image';
  if (el.line) return 'line';
  if (el.video) return 'video';
  if (el.sheetsChart) return 'chart';
  if (el.elementGroup) return 'group';
  return 'element';
}

function describeElement(el: SlidesPageElement): string {
  const id = el.objectId ?? '?';
  if (el.shape) {
    const kind = el.shape.placeholder?.type ?? el.shape.shapeType ?? 'SHAPE';
    const text = shapeText(el.shape.text);
    return `- shape ${id} (${kind}): ${text ? quote(text) : '(empty)'}`;
  }
  if (el.table) {
    const rows = (el.table.tableRows ?? []).map(
      (row) => `| ${(row.tableCells ?? []).map((cell) => shapeText(cell.text)).join(' | ')} |`,
    );
    return `- table ${id} ${el.table.rows ?? 0}x${el.table.columns ?? 0}: ${rows.join(' / ')}`;
  }
  if (el.elementGroup) {
    const children = (el.elementGroup.children ?? []).map((c) => c.objectId ?? '?');
    return `- group ${id}: ${children.join(', ')}`;
  }
  return `- ${elementKind(el)} ${id}`;
}

/** One block per slide: element objectIds with their text, then speaker notes. */
export function slidesOutline(p: SlidesPresentation): string {
  const blocks = (p.slides ?? []).map((slide, i) => {
    const lines = [`## Slide ${i + 1} · id=${slide.objectId ?? '?'}`];
    for (const el of slide.pageElements ?? []) lines.push(describeElement(el));
    const notesPage = slide.slideProperties?.notesPage;
    const notesId = notesPage?.notesProperties?.speakerNotesObjectId;
    const notes = notesPage?.pageElements?.find((e) => e.objectId === notesId);
    const notesText = shapeText(notes?.shape?.text);
    if (notesText) lines.push(`Notes: ${quote(notesText)}`);
    return lines.join('\n');
  });
  return blocks.join('\n\n');
}

/** Top-level page element by objectId (group children are not searched). */
export function findElement(
  p: SlidesPresentation,
  objectId: string,
): { slideId: string; element: SlidesPageElement } | undefined {
  for (const slide of p.slides ?? []) {
    const element = (slide.pageElements ?? []).find((e) => e.objectId === objectId);
    if (element) return { slideId: slide.objectId ?? '', element };
  }
  return undefined;
}
```

- [ ] **Step 4: Verify** → PASS; `npm run check` → green.

- [ ] **Step 5: Commit** — `git add src/content && git commit -m "feat(content): Slides outline, element lookup and shape text"`

### Task 12: SlidesService

**Files:**
- Create: `src/content/slides-service.ts`
- Test: `src/content/__tests__/slides-service.test.ts`

Spec refinement (deliberate): a missing `objectId` in `slides_set_text` raises `ValidationError` (not `NotFoundError`, whose message says "File not found").

- [ ] **Step 1: Failing tests:**

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { ValidationError } from '../../errors.js';
import { GOOGLE_MIME } from '../../files/export-formats.js';
import {
  createAudit,
  createFakeDrive,
  createFakeSlides,
  createRunner,
  noSleep,
  silentLogger,
  stubFile,
  type FakeDrive,
  type FakeSlides,
} from '../../files/__tests__/fakes.js';
import { SlidesService } from '../slides-service.js';
import { SLIDE_FIELDS } from '../slides-text.js';

let drive: FakeDrive;
let slides: FakeSlides;
let audit: ReturnType<typeof createAudit>;
let service: SlidesService;

beforeEach(() => {
  drive = createFakeDrive();
  slides = createFakeSlides();
  audit = createAudit();
  service = new SlidesService({ runner: createRunner(drive, { slides }), audit, retry: noSleep, logger: silentLogger() });
});

const deck = (): void => stubFile(drive, 'p1', GOOGLE_MIME.presentation, 'Deck');

const PRESENTATION = {
  revisionId: 'rv1',
  slides: [
    {
      objectId: 's1',
      pageElements: [
        { objectId: 'full', shape: { shapeType: 'TEXT_BOX', text: { textElements: [{ textRun: { content: 'Old\n' } }] } } },
        { objectId: 'empty', shape: { shapeType: 'TEXT_BOX' } },
        { objectId: 'pic', image: {} },
      ],
    },
  ],
};

describe('SlidesService', () => {
  it('read returns the outline with revision and slide count', async () => {
    deck();
    slides.getPresentation.mockResolvedValueOnce(PRESENTATION);
    const res = await service.read({ fileId: 'p1' });
    expect(slides.getPresentation).toHaveBeenCalledWith('p1', SLIDE_FIELDS);
    expect(res).toMatchObject({ fileId: 'p1', name: 'Deck', revisionId: 'rv1', slideCount: 1, truncated: false });
    expect(res.content).toContain('- shape full (TEXT_BOX): "Old"');
  });

  it('replaceText scopes to slides and defaults missing counts to 0', async () => {
    deck();
    slides.batchUpdate.mockResolvedValueOnce({ replies: [{ replaceAllText: {} }], writeControl: { requiredRevisionId: 'rv2' } });
    await expect(
      service.replaceText({ fileId: 'p1', find: 'a', replace: 'b', slideIds: ['s1'] }),
    ).resolves.toEqual({ occurrencesChanged: 0, revisionId: 'rv2' });
    expect(slides.batchUpdate).toHaveBeenCalledWith(
      'p1',
      [{ replaceAllText: { containsText: { text: 'a', matchCase: true }, replaceText: 'b', pageObjectIds: ['s1'] } }],
      undefined,
    );
    expect(audit.entries[0]).toMatchObject({ op: 'slides_replace_text', details: { occurrencesChanged: 0, guarded: false } });
  });

  it('setText replaces existing text under the implicit guard', async () => {
    deck();
    slides.getPresentation.mockResolvedValueOnce(PRESENTATION);
    slides.batchUpdate.mockResolvedValueOnce({ writeControl: { requiredRevisionId: 'rv3' } });
    await expect(service.setText({ fileId: 'p1', objectId: 'full', text: 'New' })).resolves.toEqual({
      objectId: 'full',
      revisionId: 'rv3',
    });
    expect(slides.batchUpdate).toHaveBeenCalledWith(
      'p1',
      [
        { deleteText: { objectId: 'full', textRange: { type: 'ALL' } } },
        { insertText: { objectId: 'full', insertionIndex: 0, text: 'New' } },
      ],
      'rv1',
    );
    expect(audit.entries[0]?.details).toEqual({ objectId: 'full', chars: 3, guarded: 'implicit' });
  });

  it('setText skips deleteText on an empty shape and uses the caller revision', async () => {
    deck();
    slides.getPresentation.mockResolvedValueOnce(PRESENTATION);
    slides.batchUpdate.mockResolvedValueOnce({});
    await service.setText({ fileId: 'p1', objectId: 'empty', text: 'Fill', requiredRevisionId: 'mine' });
    expect(slides.batchUpdate).toHaveBeenCalledWith(
      'p1',
      [{ insertText: { objectId: 'empty', insertionIndex: 0, text: 'Fill' } }],
      'mine',
    );
  });

  it('setText with empty text only clears', async () => {
    deck();
    slides.getPresentation.mockResolvedValueOnce(PRESENTATION);
    slides.batchUpdate.mockResolvedValueOnce({});
    await service.setText({ fileId: 'p1', objectId: 'full', text: '' });
    expect(slides.batchUpdate.mock.calls[0]?.[1]).toEqual([
      { deleteText: { objectId: 'full', textRange: { type: 'ALL' } } },
    ]);
  });

  it('setText on an empty shape with empty text makes no API call', async () => {
    deck();
    slides.getPresentation.mockResolvedValueOnce(PRESENTATION);
    await expect(service.setText({ fileId: 'p1', objectId: 'empty', text: '' })).resolves.toEqual({
      objectId: 'empty',
      revisionId: 'rv1',
    });
    expect(slides.batchUpdate).not.toHaveBeenCalled();
  });

  it('setText rejects unknown ids and non-text elements', async () => {
    deck();
    slides.getPresentation.mockResolvedValueOnce(PRESENTATION);
    await expect(service.setText({ fileId: 'p1', objectId: 'zzz', text: 'x' })).rejects.toThrow(
      'No top-level page element "zzz" in "Deck"; run slides_read to list objectIds.',
    );
    deck();
    slides.getPresentation.mockResolvedValueOnce(PRESENTATION);
    const err = await service.setText({ fileId: 'p1', objectId: 'pic', text: 'x' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ValidationError);
    expect((err as Error).message).toBe('"pic" is an image, not a text shape; use slides_batch_update.');
  });

  it('batchUpdate sends raw requests under the required revision', async () => {
    deck();
    slides.batchUpdate.mockResolvedValueOnce({ replies: [{}], writeControl: { requiredRevisionId: 'rv9' } });
    const requests = [{ deleteObject: { objectId: 'pic' } }];
    await expect(service.batchUpdate({ fileId: 'p1', requests, requiredRevisionId: 'rv1' })).resolves.toEqual({
      replies: [{}],
      revisionId: 'rv9',
    });
    expect(audit.entries[0]?.details).toEqual({ requestCount: 1, requestKinds: ['deleteObject'], guarded: 'caller' });
  });
});
```

- [ ] **Step 2: Run** → FAIL.

- [ ] **Step 3: Implement** `src/content/slides-service.ts`:

```ts
import type { SlidesRequest } from '../drive/slides-adapter.js';
import { ValidationError } from '../errors.js';
import { ContentService, requestKinds, type ContentFileRef, type Guard } from './content-service.js';
import { SLIDE_FIELDS, elementKind, findElement, shapeText, slidesOutline } from './slides-text.js';
import { DEFAULT_MAX_CHARS, sliceText, type TextSlice } from './truncate.js';

export interface SlidesReadInput extends ContentFileRef {
  maxChars?: number;
  offset?: number;
}

export interface SlidesReadResult extends TextSlice {
  fileId: string;
  name: string;
  revisionId: string;
  slideCount: number;
}

export interface SlidesReplaceInput extends ContentFileRef {
  find: string;
  replace: string;
  matchCase?: boolean;
  slideIds?: string[];
  requiredRevisionId?: string;
}

export interface SlidesSetTextInput extends ContentFileRef {
  objectId: string;
  text: string;
  requiredRevisionId?: string;
}

export interface SlidesBatchInput extends ContentFileRef {
  requests: Array<Record<string, unknown>>;
  requiredRevisionId: string;
}

const ARTICLE: Record<string, string> = { image: 'an image' };

export class SlidesService extends ContentService {
  protected readonly api = 'slides' as const;

  async read(input: SlidesReadInput): Promise<SlidesReadResult> {
    const file = await this.resolve(input.account, input.fileId);
    return this.run(input.account, file, 'idempotent', async (ctx) => {
      const p = await ctx.slides.getPresentation(file.id, SLIDE_FIELDS);
      return {
        fileId: file.id,
        name: file.name,
        revisionId: p.revisionId ?? '',
        slideCount: p.slides?.length ?? 0,
        ...sliceText(slidesOutline(p), input.offset ?? 0, input.maxChars ?? DEFAULT_MAX_CHARS),
      };
    });
  }

  async replaceText(
    input: SlidesReplaceInput,
  ): Promise<{ occurrencesChanged: number; revisionId: string | null }> {
    const file = await this.resolve(input.account, input.fileId);
    const matchCase = input.matchCase ?? true;
    return this.run(input.account, file, 'mutate', async (ctx) => {
      const res = await ctx.slides.batchUpdate(
        file.id,
        [
          {
            replaceAllText: {
              containsText: { text: input.find, matchCase },
              replaceText: input.replace,
              ...(input.slideIds ? { pageObjectIds: input.slideIds } : {}),
            },
          },
        ],
        input.requiredRevisionId,
      );
      const occurrencesChanged = res.replies?.[0]?.replaceAllText?.occurrencesChanged ?? 0;
      const guarded: Guard = input.requiredRevisionId ? 'caller' : false;
      await this.ops.audit(ctx, 'slides_replace_text', file, { occurrencesChanged, matchCase, guarded });
      return { occurrencesChanged, revisionId: res.writeControl?.requiredRevisionId ?? null };
    });
  }

  async setText(input: SlidesSetTextInput): Promise<{ objectId: string; revisionId: string | null }> {
    const file = await this.resolve(input.account, input.fileId);
    const p = await this.run(input.account, file, 'idempotent', (ctx) =>
      ctx.slides.getPresentation(file.id, SLIDE_FIELDS),
    );
    const found = findElement(p, input.objectId);
    if (!found) {
      throw new ValidationError(
        `No top-level page element "${input.objectId}" in "${file.name}"; run slides_read to list objectIds.`,
      );
    }
    const shape = found.element.shape;
    if (!shape) {
      const kind = elementKind(found.element);
      throw new ValidationError(
        `"${input.objectId}" is ${ARTICLE[kind] ?? `a ${kind}`}, not a text shape; use slides_batch_update.`,
      );
    }
    const requests: SlidesRequest[] = [];
    // Slides rejects deleteText on a shape without text.
    if (shapeText(shape.text).length > 0) {
      requests.push({ deleteText: { objectId: input.objectId, textRange: { type: 'ALL' } } });
    }
    if (input.text.length > 0) {
      requests.push({ insertText: { objectId: input.objectId, insertionIndex: 0, text: input.text } });
    }
    if (requests.length === 0) return { objectId: input.objectId, revisionId: p.revisionId ?? null };

    const revision = input.requiredRevisionId ?? p.revisionId ?? undefined;
    const guarded: Guard = input.requiredRevisionId ? 'caller' : p.revisionId ? 'implicit' : false;
    return this.run(input.account, file, 'mutate', async (ctx) => {
      const res = await ctx.slides.batchUpdate(file.id, requests, revision);
      await this.ops.audit(ctx, 'slides_set_text', file, {
        objectId: input.objectId,
        chars: input.text.length,
        guarded,
      });
      return { objectId: input.objectId, revisionId: res.writeControl?.requiredRevisionId ?? null };
    });
  }

  async batchUpdate(input: SlidesBatchInput): Promise<{ replies: unknown[]; revisionId: string | null }> {
    const file = await this.resolve(input.account, input.fileId);
    return this.run(input.account, file, 'mutate', async (ctx) => {
      const res = await ctx.slides.batchUpdate(
        file.id,
        input.requests as SlidesRequest[],
        input.requiredRevisionId,
      );
      await this.ops.audit(ctx, 'slides_batch_update', file, {
        requestCount: input.requests.length,
        requestKinds: requestKinds(input.requests),
        guarded: 'caller',
      });
      return { replies: res.replies ?? [], revisionId: res.writeControl?.requiredRevisionId ?? null };
    });
  }
}
```

- [ ] **Step 4: Verify** → PASS; `npm run check` → green.

- [ ] **Step 5: Commit** — `git add src/content && git commit -m "feat(content): slides read, replace, set text and batch update"`

---

## Chunk 4: MCP tools, wiring, E2E, docs

### Task 13: Split the MCP server by tool group (no behaviour change)

**Files:**
- Create: `src/mcp/shared.ts`, `src/mcp/drive-tools.ts`
- Modify: `src/mcp/server.ts`

- [ ] **Step 1: Move code.**
  - `src/mcp/shared.ts`: move `respond`, `account`, `fileId`, `pageSize`, `pageToken` from `server.ts` and export them (same code).
  - `src/mcp/drive-tools.ts`: export `DRIVE_TOOL_NAMES` (the current 12-name `TOOL_NAMES` array, `as const`) and `registerDriveTools(server: McpServer, deps: { files: FileService; auth: Pick<AuthService, 'status'> }, log: Logger): void` containing the 12 `server.registerTool(...)` calls moved verbatim.
  - Imports — `shared.ts`: `CallToolResult` (`@modelcontextprotocol/sdk/types.js`), `z`, `AppError`, `type Logger`. `drive-tools.ts`: `type McpServer` (`@modelcontextprotocol/sdk/server/mcp.js`), `z`, `EXPORT_FORMATS`, `type FileService`, `type AuthService`, `type Logger`, and `respond, account, fileId, pageSize, pageToken` from `./shared.js`. `server.ts` then drops the imports it no longer uses.
  - `src/mcp/server.ts` keeps `McpDeps` and `createMcpServer`; `TOOL_NAMES = [...DRIVE_TOOL_NAMES] as const` for now; `createMcpServer` creates the server, calls `registerDriveTools(server, deps, log)`, returns it.

- [ ] **Step 2: Verify** — `npm run check` → green with **no test changes** (pure move).

- [ ] **Step 3: Commit** — `git add src/mcp && git commit -m "refactor(mcp): split server into shared helpers and drive tool group"`

### Task 14: Docs, Sheets and Slides MCP tools

**Files:**
- Create: `src/mcp/docs-tools.ts`, `src/mcp/sheets-tools.ts`, `src/mcp/slides-tools.ts`
- Modify: `src/mcp/server.ts`, `src/mcp/__tests__/server.test.ts`
- Test: `src/mcp/__tests__/content-tools.test.ts`

- [ ] **Step 1: Shared content fields** — add to `src/mcp/shared.ts`:

```ts
export const maxChars = z
  .number()
  .int()
  .min(1000)
  .max(200_000)
  .optional()
  .describe('Max characters returned (default 50000)');
export const offset = z
  .number()
  .int()
  .min(0)
  .optional()
  .describe('Start offset — pass nextOffset from the previous call (default 0)');
export const requiredRevisionId = z
  .string()
  .min(1)
  .describe('revisionId from the last read (or edit); the change is rejected if the file changed since');
export const rawRequests = z
  .array(z.record(z.string(), z.unknown()))
  .min(1)
  .max(200)
  .describe('Google API batchUpdate requests, sent verbatim');
export const contentFileId = z
  .string()
  .min(1)
  .describe('Google Drive file ID (a shortcut to the file also works)');
```

- [ ] **Step 2: `src/mcp/docs-tools.ts`:**

```ts
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { DocsService } from '../content/docs-service.js';
import type { Logger } from '../logger.js';
import { account, contentFileId, maxChars, offset, rawRequests, requiredRevisionId, respond } from './shared.js';

export const DOCS_TOOL_NAMES = [
  'docs_read',
  'docs_replace_text',
  'docs_insert_text',
  'docs_batch_update',
] as const;

const position = z.discriminatedUnion('at', [
  z.object({ at: z.literal('end') }),
  z.object({ at: z.literal('afterHeading'), heading: z.string().min(1) }),
  z.object({ at: z.literal('index'), index: z.number().int().min(1) }),
]);

export function registerDocsTools(server: McpServer, docs: DocsService, log: Logger): void {
  server.registerTool(
    'docs_read',
    {
      description:
        'Read a Google Doc. format "markdown" (default) returns the text as Markdown; "structure" returns one line per element with its [start-end) index range — use it to compute indexes for docs_batch_update. Returns revisionId for guarded edits. Long content is paged: pass nextOffset as offset. Structure covers the first tab only.',
      inputSchema: {
        account,
        fileId: contentFileId,
        format: z.enum(['markdown', 'structure']).optional(),
        maxChars,
        offset,
      },
    },
    async (args) => respond(log, () => docs.read(args)),
  );

  server.registerTool(
    'docs_replace_text',
    {
      description:
        'Replace every occurrence of `find` with `replace` in a Google Doc (first tab). Returns occurrencesChanged and the new revisionId.',
      inputSchema: {
        account,
        fileId: contentFileId,
        find: z.string().min(1),
        replace: z.string(),
        matchCase: z.boolean().optional().describe('Default true'),
        requiredRevisionId: requiredRevisionId.optional(),
      },
    },
    async (args) => respond(log, () => docs.replaceText(args)),
  );

  server.registerTool(
    'docs_insert_text',
    {
      description:
        'Insert plain text into a Google Doc (first tab). position: {at:"end"} appends (start text with "\\n" for a new paragraph); {at:"afterHeading",heading} inserts on the line after that heading (end text with "\\n" to make it its own paragraph, which is set to normal text style); {at:"index",index} inserts at a raw index from docs_read structure. Guarded by the read it does internally unless requiredRevisionId is given.',
      inputSchema: {
        account,
        fileId: contentFileId,
        text: z.string().min(1),
        position,
        requiredRevisionId: requiredRevisionId.optional(),
      },
    },
    async (args) => respond(log, () => docs.insertText(args)),
  );

  server.registerTool(
    'docs_batch_update',
    {
      description:
        'ADVANCED: send raw Google Docs API batchUpdate requests (formatting, tables, deletions…). Prefer docs_replace_text / docs_insert_text. Read with docs_read format "structure" first and pass its revisionId; requests apply to the first tab.',
      inputSchema: { account, fileId: contentFileId, requests: rawRequests, requiredRevisionId },
    },
    async (args) => respond(log, () => docs.batchUpdate(args)),
  );
}
```

- [ ] **Step 3: `src/mcp/sheets-tools.ts`:**

```ts
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { SheetsService } from '../content/sheets-service.js';
import type { Logger } from '../logger.js';
import { account, contentFileId, rawRequests, respond } from './shared.js';

export const SHEETS_TOOL_NAMES = [
  'sheets_info',
  'sheets_read_range',
  'sheets_write_range',
  'sheets_append_rows',
  'sheets_batch_update',
] as const;

const range = z.string().min(1).describe('A1 notation, e.g. "Sheet1!A1:C10" or a tab name');
const values = z
  .array(z.array(z.union([z.string(), z.number(), z.boolean(), z.null()])).min(1))
  .min(1)
  .describe('Rows of cells (max 10000 cells); null clears a cell');
const input = z
  .enum(['user_entered', 'raw'])
  .optional()
  .describe('user_entered (default): formulas and number parsing apply; raw: stored as-is');

export function registerSheetsTools(server: McpServer, sheets: SheetsService, log: Logger): void {
  server.registerTool(
    'sheets_info',
    {
      description: 'List the tabs of a Google Sheet (sheetId, title, size, hidden) plus locale and time zone.',
      inputSchema: { account, fileId: contentFileId },
    },
    async (args) => respond(log, () => sheets.info(args)),
  );

  server.registerTool(
    'sheets_read_range',
    {
      description:
        'Read cell values from a Google Sheet range. render: formatted (default, as displayed), unformatted, or formula. Truncates whole rows beyond maxCells.',
      inputSchema: {
        account,
        fileId: contentFileId,
        range,
        render: z.enum(['formatted', 'unformatted', 'formula']).optional(),
        maxCells: z.number().int().min(1).max(50_000).optional().describe('Default 5000'),
      },
    },
    async (args) => respond(log, () => sheets.readRange(args)),
  );

  server.registerTool(
    'sheets_write_range',
    {
      description: 'Write values into a Google Sheet range (overwrites existing cells).',
      inputSchema: { account, fileId: contentFileId, range, values, input },
    },
    async (args) => respond(log, () => sheets.writeRange(args)),
  );

  server.registerTool(
    'sheets_append_rows',
    {
      description:
        'Append rows after the last row of the table at `range` (usually a tab name); inserts new rows.',
      inputSchema: { account, fileId: contentFileId, range, values, input },
    },
    async (args) => respond(log, () => sheets.appendRows(args)),
  );

  server.registerTool(
    'sheets_batch_update',
    {
      description:
        'ADVANCED: send raw Google Sheets API batchUpdate requests (add/rename tabs, formatting, sorting…). Prefer the other sheets_* tools. No protection against concurrent edits exists in the Sheets API: target tabs by sheetId from sheets_info, never by position.',
      inputSchema: { account, fileId: contentFileId, requests: rawRequests },
    },
    async (args) => respond(log, () => sheets.batchUpdate(args)),
  );
}
```

- [ ] **Step 4: `src/mcp/slides-tools.ts`:**

```ts
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { SlidesService } from '../content/slides-service.js';
import type { Logger } from '../logger.js';
import { account, contentFileId, maxChars, offset, rawRequests, requiredRevisionId, respond } from './shared.js';

export const SLIDES_TOOL_NAMES = [
  'slides_read',
  'slides_replace_text',
  'slides_set_text',
  'slides_batch_update',
] as const;

export function registerSlidesTools(server: McpServer, slides: SlidesService, log: Logger): void {
  server.registerTool(
    'slides_read',
    {
      description:
        'Read a Google Slides deck: per slide, every element objectId with its text, tables, and speaker notes. Returns revisionId for guarded edits. Long decks are paged via nextOffset.',
      inputSchema: { account, fileId: contentFileId, maxChars, offset },
    },
    async (args) => respond(log, () => slides.read(args)),
  );

  server.registerTool(
    'slides_replace_text',
    {
      description:
        'Replace every occurrence of `find` with `replace` across the deck, or only on slideIds. Returns occurrencesChanged and the new revisionId.',
      inputSchema: {
        account,
        fileId: contentFileId,
        find: z.string().min(1),
        replace: z.string(),
        matchCase: z.boolean().optional().describe('Default true'),
        slideIds: z.array(z.string().min(1)).min(1).optional().describe('Slide objectIds from slides_read'),
        requiredRevisionId: requiredRevisionId.optional(),
      },
    },
    async (args) => respond(log, () => slides.replaceText(args)),
  );

  server.registerTool(
    'slides_set_text',
    {
      description:
        'Replace the whole text of one shape (objectId from slides_read). Empty text clears it. Tables, images and grouped elements need slides_batch_update. Guarded by the read it does internally unless requiredRevisionId is given.',
      inputSchema: {
        account,
        fileId: contentFileId,
        objectId: z.string().min(1),
        text: z.string(),
        requiredRevisionId: requiredRevisionId.optional(),
      },
    },
    async (args) => respond(log, () => slides.setText(args)),
  );

  server.registerTool(
    'slides_batch_update',
    {
      description:
        'ADVANCED: send raw Google Slides API batchUpdate requests (create slides/shapes, styling, deleting…). Prefer slides_replace_text / slides_set_text. Read with slides_read first and pass its revisionId.',
      inputSchema: { account, fileId: contentFileId, requests: rawRequests, requiredRevisionId },
    },
    async (args) => respond(log, () => slides.batchUpdate(args)),
  );
}
```

- [ ] **Step 5: Compose in `src/mcp/server.ts`:**

```ts
export const TOOL_NAMES = [
  ...DRIVE_TOOL_NAMES,
  ...DOCS_TOOL_NAMES,
  ...SHEETS_TOOL_NAMES,
  ...SLIDES_TOOL_NAMES,
] as const;

export interface McpDeps {
  files: FileService;
  docs: DocsService;
  sheets: SheetsService;
  slides: SlidesService;
  auth: Pick<AuthService, 'status'>;
  version: string;
  logger?: Logger;
}
```

and in `createMcpServer` after `registerDriveTools(...)`: `registerDocsTools(server, deps.docs, log); registerSheetsTools(server, deps.sheets, log); registerSlidesTools(server, deps.slides, log);`

- [ ] **Step 6: Update `server.test.ts`** construction:
  - import `DocsService`, `SheetsService`, `SlidesService`;
  - add a helper:

```ts
function contentServices(): Pick<McpDeps, 'docs' | 'sheets' | 'slides'> {
  const deps = { runner: createRunner(drive), audit: createAudit(), retry: noSleep, logger: silentLogger() };
  return { docs: new DocsService(deps), sheets: new SheetsService(deps), slides: new SlidesService(deps) };
}
```

  - spread `...contentServices()` into both `createMcpServer({...})` calls (import `type McpDeps` from `'../server.js'`);
  - change the tool-count test name to `'exposes the 25 tools from both specs'` and `toHaveLength(12)` → `toHaveLength(25)`.

- [ ] **Step 7: Write `src/mcp/__tests__/content-tools.test.ts`:**

```ts
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { beforeEach, describe, expect, it } from 'vitest';
import { DocsService } from '../../content/docs-service.js';
import { SheetsService } from '../../content/sheets-service.js';
import { SlidesService } from '../../content/slides-service.js';
import { FileService } from '../../files/file-service.js';
import { GOOGLE_MIME } from '../../files/export-formats.js';
import {
  createAudit,
  createFakeDocs,
  createFakeDrive,
  createFakeSheets,
  createFakeSlides,
  createRunner,
  httpError,
  noSleep,
  silentLogger,
  stubFile,
  type FakeDocs,
  type FakeDrive,
  type FakeSheets,
} from '../../files/__tests__/fakes.js';
import { createMcpServer } from '../server.js';

let drive: FakeDrive;
let docs: FakeDocs;
let sheets: FakeSheets;
let client: Client;

function textOf(result: unknown): string {
  return (result as { content: Array<{ text?: string }> }).content[0]?.text ?? '';
}

beforeEach(async () => {
  drive = createFakeDrive();
  docs = createFakeDocs();
  sheets = createFakeSheets();
  const deps = {
    runner: createRunner(drive, { docs, sheets, slides: createFakeSlides() }),
    audit: createAudit(),
    retry: noSleep,
    logger: silentLogger(),
  };
  const server = createMcpServer({
    files: new FileService({ ...deps, downloadsDir: '/tmp/unused' }),
    docs: new DocsService(deps),
    sheets: new SheetsService(deps),
    slides: new SlidesService(deps),
    auth: { status: async () => [] },
    version: '0.0.0-test',
    logger: silentLogger(),
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(clientTransport);
});

describe('content MCP tools', () => {
  it('requires requiredRevisionId for docs_batch_update', async () => {
    const res = await client.callTool({
      name: 'docs_batch_update',
      arguments: { fileId: 'd1', requests: [{ insertText: {} }] },
    });
    expect(res.isError).toBe(true);
    expect(docs.batchUpdate).not.toHaveBeenCalled();
  });

  it('runs docs_insert_text with a discriminated position', async () => {
    stubFile(drive, 'd1', GOOGLE_MIME.document, 'Plan');
    docs.batchUpdate.mockResolvedValueOnce({ writeControl: { requiredRevisionId: 'r2' } });
    const res = await client.callTool({
      name: 'docs_insert_text',
      arguments: { fileId: 'd1', text: 'x', position: { at: 'index', index: 3 } },
    });
    expect(res.isError).toBeFalsy();
    expect(JSON.parse(textOf(res))).toEqual({ insertedAt: 3, revisionId: 'r2' });
  });

  it('reports revision conflicts as a readable tool error', async () => {
    stubFile(drive, 'd1', GOOGLE_MIME.document, 'Plan');
    docs.batchUpdate.mockRejectedValueOnce(
      httpError(400, 'badRequest', "The required revision ID 'r1' does not match the latest revision."),
    );
    const res = await client.callTool({
      name: 'docs_replace_text',
      arguments: { fileId: 'd1', find: 'a', replace: 'b', requiredRevisionId: 'r1' },
    });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain('"Plan" changed since it was read');
  });

  it('reports a disabled API', async () => {
    stubFile(drive, 's1', GOOGLE_MIME.spreadsheet, 'Budget');
    sheets.getSpreadsheet.mockRejectedValueOnce(
      httpError(403, 'accessNotConfigured', 'Google Sheets API has not been used in project 1 before or it is disabled.'),
    );
    const res = await client.callTool({ name: 'sheets_info', arguments: { fileId: 's1' } });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain('The Google Sheets API is not enabled');
  });

  it('accepts null cells in sheets_write_range', async () => {
    stubFile(drive, 's1', GOOGLE_MIME.spreadsheet, 'Budget');
    sheets.updateValues.mockResolvedValueOnce({ updatedRange: 'A!A1:B1', updatedRows: 1, updatedColumns: 2, updatedCells: 2 });
    const res = await client.callTool({
      name: 'sheets_write_range',
      arguments: { fileId: 's1', range: 'A!A1:B1', values: [[1, null]] },
    });
    expect(res.isError).toBeFalsy();
    expect(sheets.updateValues).toHaveBeenCalledWith('s1', 'A!A1:B1', [[1, '']], 'USER_ENTERED');
  });
});
```

- [ ] **Step 8: Wire the app now** — `McpDeps` now requires `docs/sheets/slides`, so `src/cli/main.ts` no longer compiles. Do **Task 15 Steps 1–2** (`app.ts` + `main.ts`) now, then `npm run check` → green.

- [ ] **Step 9: Commit** — `git add src/mcp src/app.ts src/cli/main.ts && git commit -m "feat(mcp): docs, sheets and slides tools (25 total), wired into serve"`

### Task 15: Wire services into the app and CLI

**Files:** Modify `src/app.ts`, `src/cli/main.ts`. (Steps 1–2 were already done in Task 14 Step 8 — just confirm them, then continue at Step 3.)

- [ ] **Step 1: `src/app.ts`** — import the three services; extend `App` with `docs: DocsService; sheets: SheetsService; slides: SlidesService;`; in `buildApp` share one runner and audit sink:

```ts
  const runner = new DriveClientFactory(auth);
  const audit = new FileAuditLog(paths.audit);
  const files = new FileService({ runner, audit, downloadsDir: paths.downloadsDir });
  const docs = new DocsService({ runner, audit });
  const sheets = new SheetsService({ runner, audit });
  const slides = new SlidesService({ runner, audit });
  return { paths, auth, files, docs, sheets, slides };
```

- [ ] **Step 2: `src/cli/main.ts` serve:**

```ts
    const server = createMcpServer({
      files: app.files,
      docs: app.docs,
      sheets: app.sheets,
      slides: app.slides,
      auth: app.auth,
      version: VERSION,
    });
```

- [ ] **Step 3: Verify** — `npm run check` → green; `npm run build` succeeds.

- [ ] **Step 4: Smoke-test the real binary over stdio** (lists tools, no Google calls):

```bash
node --input-type=module -e "
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
const c = new Client({ name: 'smoke', version: '0' });
await c.connect(new StdioClientTransport({ command: 'node', args: ['dist/cli/main.js', 'serve'] }));
const { tools } = await c.listTools();
console.log(tools.length, tools.map((t) => t.name).filter((n) => !n.startsWith('drive_')).join(' '));
await c.close();
"
```

Expected: `25 docs_read docs_replace_text docs_insert_text docs_batch_update sheets_info sheets_read_range sheets_write_range sheets_append_rows sheets_batch_update slides_read slides_replace_text slides_set_text slides_batch_update`

- [ ] **Step 5:** nothing new to commit unless Step 3–4 required a fix; if so: `git add -A && git commit -m "fix(app): …"`.

### Task 16: Live E2E

**Files:** Create `tests/e2e/content.e2e.test.ts`.

- [ ] **Step 1: Write the test:**

```ts
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { ConflictError } from '../../src/errors.js';

const account = process.env.MARVIN_E2E_ACCOUNT;

describe.runIf(account)('Content E2E (live)', () => {
  it('reads and edits Docs, Sheets and Slides in place', async () => {
    const { files, docs, sheets, slides } = buildApp();
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'marvin-content-e2e-'));
    const root = await files.createFolder({ account, name: `marvin-content-e2e-${Date.now()}` });
    try {
      // Docs
      const md = path.join(tmp, 'plan.md');
      await writeFile(md, '# Plan\n\n## Goals\n\nShip it.\n');
      const doc = await files.upload({ account, localPath: md, parentId: root.id, convertToGoogle: true });
      const read1 = await docs.read({ account, fileId: doc.id });
      expect(read1.content).toContain('Ship it.');
      const rep = await docs.replaceText({
        account,
        fileId: doc.id,
        find: 'Ship it.',
        replace: 'Ship it today.',
        requiredRevisionId: read1.revisionId,
      });
      expect(rep.occurrencesChanged).toBe(1);
      await expect(
        docs.replaceText({ account, fileId: doc.id, find: 'Plan', replace: 'Plan', requiredRevisionId: read1.revisionId }),
      ).rejects.toBeInstanceOf(ConflictError);
      await docs.insertText({ account, fileId: doc.id, text: 'First goal\n', position: { at: 'afterHeading', heading: 'Goals' } });
      const outline = await docs.read({ account, fileId: doc.id, format: 'structure' });
      expect(outline.content).toMatch(/NORMAL_TEXT "First goal"/);
      await docs.batchUpdate({
        account,
        fileId: doc.id,
        requests: [{ insertText: { endOfSegmentLocation: {}, text: '\nThe end' } }],
        requiredRevisionId: outline.revisionId,
      });
      expect((await docs.read({ account, fileId: doc.id })).content).toContain('The end');

      // Sheets
      const csv = path.join(tmp, 'data.csv');
      await writeFile(csv, 'name,qty\napple,3\n');
      const sheet = await files.upload({ account, localPath: csv, parentId: root.id, convertToGoogle: true });
      const info = await sheets.info({ account, fileId: sheet.id });
      const tab = info.sheets[0]?.title ?? 'Sheet1';
      await sheets.writeRange({ account, fileId: sheet.id, range: `${tab}!C1:C2`, values: [['total'], ['=B2*2']] });
      await sheets.appendRows({ account, fileId: sheet.id, range: tab, values: [['pear', 5]] });
      const vals = await sheets.readRange({ account, fileId: sheet.id, range: `${tab}!A1:C3` });
      expect(vals.values).toEqual([
        ['name', 'qty', 'total'],
        ['apple', '3', '6'],
        ['pear', '5'],
      ]);
      await sheets.writeRange({ account, fileId: sheet.id, range: `${tab}!C1`, values: [[null]] });
      const cleared = await sheets.readRange({ account, fileId: sheet.id, range: `${tab}!C1` });
      expect(cleared.values).toEqual([]);

      // Slides
      const deck = await files.upload({
        account,
        localPath: path.resolve('tests/e2e/fixtures/deck.pptx'),
        parentId: root.id,
        convertToGoogle: true,
      });
      const s1 = await slides.read({ account, fileId: deck.id });
      expect(s1.slideCount).toBe(2);
      const helloId = /shape (\S+) \(TEXT_BOX\): "Hello slides"/.exec(s1.content)?.[1];
      expect(helloId).toBeTruthy();
      const set = await slides.setText({ account, fileId: deck.id, objectId: helloId ?? '', text: 'Hi there' });
      const r = await slides.replaceText({
        account,
        fileId: deck.id,
        find: 'Second',
        replace: '2nd',
        requiredRevisionId: set.revisionId ?? undefined,
      });
      expect(r.occurrencesChanged).toBe(1);
      const s2 = await slides.read({ account, fileId: deck.id });
      expect(s2.content).toContain('"Hi there"');
      expect(s2.content).toContain('2nd slide');
      const emptyId = /shape (\S+) \(TEXT_BOX\): \(empty\)/.exec(s2.content)?.[1];
      expect(emptyId).toBeTruthy();
      await slides.setText({ account, fileId: deck.id, objectId: emptyId ?? '', text: 'filled' });
      const s3 = await slides.read({ account, fileId: deck.id });
      expect(s3.content).toContain('"filled"');
      await slides.batchUpdate({
        account,
        fileId: deck.id,
        requests: [{ deleteObject: { objectId: emptyId } }],
        requiredRevisionId: s3.revisionId,
      });
      expect((await slides.read({ account, fileId: deck.id })).content).not.toContain('"filled"');
    } finally {
      await files.delete({ account, fileId: root.id, permanent: true });
      await rm(tmp, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run live** — `MARVIN_E2E_ACCOUNT=emco npm run test:e2e` → both E2E files PASS.
  If an assertion fails because Google's real behaviour differs from an assumption (e.g. formatted values of the CSV import, or how pptx empty text boxes convert), **investigate with the real response first** (log it), then fix the **service** if it is wrong, or the **test expectation** if Google's behaviour is legitimate — and note the finding in the commit message. Do not weaken assertions to make them pass without understanding why.

- [ ] **Step 3: Commit** — `git add tests/e2e && git commit -m "test(e2e): live content processing round trip"`

### Task 17: Documentation and version

**Files:** `README.md`, `docs/FEATURES.md`, `docs/CHANGELOG.md`, `package.json`, `src/version.ts`.

- [ ] **Step 1: README** — under `## MCP tools`, keep the Drive table and add three tables (Docs / Sheets / Slides) with one row per tool (name + one-line purpose from the tool descriptions). Add a short "Editing safely" paragraph: read tools return `revisionId`; Docs/Slides edits accept `requiredRevisionId` and fail with a re-read hint if the file changed; `*_batch_update` tools are advanced and require it (Docs/Slides); Sheets has no such guard. Run `npx prettier --write README.md`.

- [ ] **Step 2: FEATURES** — replace `- ⬜ 4. Content processing (Docs/Sheets/PDF)` with a `### 4. Content processing (spec: docs/superpowers/specs/2026-11-03-content-processing-design.md)` section listing ✅ Docs read/replace/insert/batch, ✅ Sheets info/read/write/append/batch, ✅ Slides read/replace/set text/batch, ✅ revision guards + conflict errors, ✅ disabled-API errors; keep ⬜ for sync, resumable upload, OAuth production.

- [ ] **Step 3: CHANGELOG** — add above 0.1.0:

```markdown
## 0.2.0 — 2026-11-03

### Added
- Content processing: 13 tools to read and edit Google Docs, Sheets and Slides in place (`docs_*`, `sheets_*`, `slides_*`), including advanced `*_batch_update` passthroughs.
- Revision-guarded edits for Docs and Slides with clear conflict errors; implicit guards for read-then-write tools.
- Clear errors when a Google API is not enabled for the OAuth project.

### Fixed
- `drive_upload` / `drive_copy` no longer report Drive's placeholder size for freshly created Google files.
```

- [ ] **Step 4: Version** — `"version": "0.2.0"` in `package.json` (and the root entry in `package-lock.json` via `npm install --package-lock-only`), `export const VERSION = '0.2.0';` in `src/version.ts`.

- [ ] **Step 5: Verify** — `npm run check` → green; `npm run build` → OK.

- [ ] **Step 6: Commit** — `git add -A && git commit -m "docs: content processing tools, changelog 0.2.0"`
