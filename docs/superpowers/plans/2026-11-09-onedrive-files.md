# OneDrive Sign-in and File Operations Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Microsoft account (personal or work/school) can be registered next to Google accounts, and the existing `drive_*` MCP tools work on that account's own OneDrive. The account decides the provider; the tool names do not change.

**Architecture:** `FileRouter` implements a new `FileProvider` interface and picks `FileService` (Google, unchanged) or `OneDriveFileService` from the account record. `OneDriveFileService` calls a `GraphClient` (bearer token only to graph.microsoft.com, `§7.2` retries, upload sessions, copy monitor) that gets tokens from `MicrosoftAuth`. `AuthService` stays the only entry point for the CLI and tools and dispatches to `MicrosoftAuth` through a `ProviderAuth` interface. Microsoft accounts are rejected on every Google-only path by `ProviderNotSupportedError`.

**Tech Stack:** TypeScript (strict, ESM/NodeNext), Node ≥ 22.12, global `fetch` for Graph and OAuth (no MSAL, no new dependencies), `@modelcontextprotocol/sdk` 1.32.2 form elicitation, `zod` v4, `commander`, Vitest.

---

**Spec (read first, authoritative):** `docs/superpowers/specs/2026-11-08-onedrive-files-design.md`.

Every code block below was compiled, linted, formatted and tested: the plan is derived from a working implementation, one commit per task, and each task's commit was replayed on its own to record the failure and pass quoted in its steps.

## Ground rules

- Branch `feat/onedrive`; never switch branches, **never push**.
- Created files appear in full. Changes to existing files are unified diffs against the state the previous task left; apply them with `git apply` or by hand. Apply tasks in order.
- After every task: `npx prettier --write <changed files>` then `npm run check` (typecheck, eslint with zero warnings, prettier, vitest). Starting point: **1011 passed, 6 skipped** (105 files). Never commit red.
- Google behaviour must not change. The only visible Google differences are the ones the spec asks for: the provider appears in `auth list` and `drive_list_accounts`, and tool descriptions are provider-neutral.
- No new npm dependencies (spec §2). No runtime `googleapis` import under `src/onedrive`, in `src/auth/microsoft-auth.ts` or in `src/auth/loopback.ts` (boundary test in Task 9).
- Imports use the `.js` suffix. Non-test code has explicit return types (`@typescript-eslint/explicit-function-return-type`); tests are exempt.
- Existing test helpers: `src/files/__tests__/fakes.ts` (`createAudit`, `createRunner`, `createFakeDrive`, `noSleep`, `silentLogger`), `src/__tests__/googleapis-imports.ts`. New helper: `src/onedrive/__tests__/fake-graph.ts` (Task 10).
- A test file for a module that does not exist yet fails with `Failed to load url ../x.js`; that is the expected red.
- No live Microsoft or Google calls in any task before Task 24, the final one, which needs the user's sign-in.

## Verified API facts (checked in `node_modules` and by tests, do not re-derive)

- `@modelcontextprotocol/sdk` 1.32.2: `Server.elicitInput(params, options?)`, `Server.getClientCapabilities()`. Form mode throws unless the client declared `elicitation.form`, and the default request timeout is 60 s, so the dialog passes `{ timeout: 600_000 }`.
- Node's `fetch` with a stream body, `duplex: 'half'` and an explicit `Content-Length` sends that length and no `Transfer-Encoding: chunked` (proved against a local server in Task 11; Graph requires the length on every fragment).
- `new URL()` normalizes `..` segments and backslashes, and strips tabs and newlines, so the `pageToken` check inspects both the raw token and the parsed path (`hasControlOrSpace`, `hasPathTrick`, Task 10).
- `encodeURIComponent` leaves `!` alone, so a drive ID such as `b!abc` needs an explicit `%21` form in the `pageToken` prefix check.

## Decisions where the spec leaves room (keep consistent)

1. **`root` in paths:** `root` maps to the documented `/me/drive/root` form. Request bodies and comparisons use the real ID from `GET /me/drive/root`, as §5 says.
2. **`remoteItem` by ID:** a `remoteItem` counts as not found on every path that takes an ID: the items of `getMetadata`, `download`, `rename`, `move`, `delete` and `copy`, the `list` folder, the `createFolder` and upload parents, the move target and the copy target. `assertOwnItem` reads the ID once and skips `root`. A name in the target folder that is held by a `remoteItem` is a `NameConflictError` with no choice offered, as for folders and packages.
3. **Retry class of each write:** `createUploadSession` is `idempotent` (a session writes nothing to the target); `POST .../restore`, the empty-file `PUT` and `POST .../copy` are `create`; `PATCH` and `DELETE` are `idempotent`.
4. **409:** every Graph 409 maps to `NameConflictError` (§5.1), whatever its code.
5. **Redirect errors in step two:** `readRedirectUrl` does not interpret `error=`, and `PendingLoginStore.peekProvider` (read-only) lets the message name the right provider while the entry stays unused, as it did for Google.
6. **Extra small units:** `src/auth/provider-auth.ts` (types, no `googleapis` cycle), `src/config/microsoft-client.ts` (mirrors `client-secret.ts`), `src/cli/auth-text.ts` (testable CLI text). `App.googleFiles` exists because `FileProvider.upload` can return `UploadCancelled`, which the Google live tests never handle.
7. **`SyncEnv.assertSupportedAccount`** is injected through `SyncServiceDeps` with a no-op default, so sync stays free of the registry; `buildApp` provides the real check.
8. **Copy monitor:** a monitor read that fails is treated as "ask again" until the 60 s limit; the copy itself is never repeated. A copy that reached `completed` is audited even if reading the new item then fails.
9. **Path safety:** `/`, `\`, `.` and `..` are refused in IDs and in names that go into a path, in `itemPath` / `childPath` and, for `rename`, before the first request (`encodeURIComponent('..')` stays `..`). `rename` and `delete` refuse the root folder.

## Known limitations

- **Lost final response on a new file.** If the response to the last fragment is lost and the session is gone, the upload restarts once. For a new file the restart gets a 409 from the file just uploaded, so the flow reaches §6 step 2 and asks about (or, without the dialog, refuses over) a file this upload created. Nothing is lost: the data is on OneDrive and the user decides. This case also leaves no audit record for the created file, because the upload never saw it succeed.
- **`pageToken` path check.** `%2f`, `%5c` and `%2e` (any case) and `.` or `..` segments are refused anywhere in the path, and control characters or whitespace anywhere in the token, because `new URL()` strips tabs and newlines. If Graph's `@odata.nextLink` for a search carries an encoded `/` or `\` from the query inside `search(q='...')`, paging that search fails with a clear `ValidationError`; the first page still works.

## File structure

| File | Status | Responsibility |
|---|---|---|
| `src/errors.ts` | Modify (T1) | New error classes |
| `src/config/account-registry.ts` | Modify (T2) | `provider`, `accountId`, `tokenKey`, `resolve` (strict), `resolveGoogleFirst` |
| `src/auth/pending-login.ts` | Modify (T3) | `provider` on entries, `peekProvider` |
| `src/config/microsoft-client.ts` | Create (T3) | Loads `microsoft-client.json`; error text holds the registration steps |
| `src/config/paths.ts` | Modify (T3) | `microsoftClient` path |
| `src/auth/auth-service.ts` | Modify (T4, T5, T6, T20, T21) | `tokenKey`, provider dispatch, `accountFor`, Microsoft rejection in `authorize` |
| `src/drive/client-factory.ts` | Modify (T4, T20) | `tokenKey`; rejects Microsoft accounts (check 1) |
| `src/auth/callback-page.ts` | Modify (T5) | Provider-neutral comment |
| `src/auth/login-flow.ts` | Modify (T5) | Google login only; uses `loopback.ts` |
| `src/auth/loopback.ts` | Create (T5) | Provider-neutral loopback helpers, `listenLocalhost`, redirect parsing |
| `src/auth/provider-auth.ts` | Create (T6) | `ProviderAuth` interface, `AccountStatus` |
| `src/cli/format.ts` | Modify (T6) | Provider column in `auth list` |
| `src/auth/microsoft-auth.ts` | Create (T7, T8) | Microsoft PKCE login, token refresh, status, local removal |
| `src/onedrive/graph-errors.ts` | Create (T9) | Graph error to `AppError` |
| `src/onedrive/graph-retry.ts` | Create (T9) | Graph retry rules |
| `src/onedrive/graph-client.ts` | Create (T10, T11, T12) | Authenticated requests, paging check, download, upload session, copy monitor |
| `src/files/file-provider.ts` | Create (T13) | `FileProvider` and the neutral input/result types |
| `src/files/file-service.ts` | Modify (T13) | Implements `FileProvider`; types moved out |
| `src/files/local-paths.ts` | Create (T13) | `resolveUploadPath`, shared by both providers |
| `src/onedrive/map-item.ts` | Create (T14) | `driveItem` to `FileSummary` / `OneDriveMetadata` / `ExistingFile` |
| `src/onedrive/onedrive-file-service.ts` | Create (T14, T15, T16) | The 11 file operations on Graph, audit records |
| `src/mcp/confirm-replace.ts` | Create (T17) | Elicitation dialog behind `ConfirmReplace` |
| `src/files/file-router.ts` | Create (T18) | Picks the provider from the account record |
| `src/app.ts` | Modify (T19, T20) | Composition root: Microsoft auth, `FileRouter`, sync guard, `googleFiles` |
| `src/mcp/drive-tools.ts` | Modify (T19) | Depends on `FileProvider`; provider-neutral text; passes `confirmReplace` |
| `src/mcp/server.ts` | Modify (T19) | `files: FileProvider` |
| `src/mcp/shared.ts` | Modify (T19) | Provider-neutral `fileId` description |
| `tests/e2e/content.e2e.test.ts` | Modify (T19) | Uses `googleFiles` |
| `tests/e2e/drive.e2e.test.ts` | Modify (T19) | Uses `googleFiles` |
| `tests/e2e/watch.e2e.test.ts` | Modify (T19) | Uses `googleFiles` |
| `src/sync/pair-admin.ts` | Modify (T20) | `assertSupportedAccount` before `writeMarker` (check 3) |
| `src/sync/sync-service.ts` | Modify (T20) | Takes `assertSupportedAccount` |
| `src/watch/google/provider.ts` | Modify (T20) | Rejects Microsoft accounts (check 2) |
| `src/cli/auth-text.ts` | Create (T21) | Testable CLI text and `--provider` parsing |
| `src/cli/program.ts` | Modify (T21) | `--provider`, provider-aware login output |
| `README.md` | Modify (T22) | OneDrive accounts, differences, registration |
| `docs/CHANGELOG.md` | Modify (T22) | Changelog |
| `docs/FEATURES.md` | Modify (T22) | Feature status |
| `tests/e2e/onedrive.e2e.test.ts` | Create (T23) | Live E2E |
| Unit tests under `src/**/__tests__/` | Create or modify | One file per unit; each task lists its own, `src/onedrive/__tests__/fake-graph.ts` is the shared fake |

## Task map

| Spec section | Tasks |
|---|---|
| §1 Goal | T19 (composition), T23 and T24 (live proof) |
| §2 Decisions | T7 (`common`, no MSAL), T14 (`/me/drive`, `remoteItem`), T15 (no permanent delete), T16 (conflicts) |
| §3 Architecture and units | T5, T7, T9, T10, T13, T14, T17, T18; boundary test T9 |
| §3.1 `FileProvider` | T13, T18, T19 |
| §3.2 Accounts | T2, T4, T6, T7, T21 |
| §3.3 Google-only paths | T20 |
| §3.4 Auth dispatch | T6, T7, T8, T21 |
| §4 Sign-in | T3, T5, T6, T7, T8, T21 |
| §5 Tool mapping | T14, T15, T16, T19 |
| §5.1 Rename and move conflicts | T15 |
| §5.2 Copy | T12, T15, T19 |
| §6 Upload and name conflicts | T11, T16, T17, T19 |
| §7.1 Authentication and URL safety | T9, T10, T11, T12 |
| §7.2 Retry and error mapping | T9, T10 |
| §7.3 Long operations | T11, T12, T15 |
| §8 Testing | Every task's unit tests; boundary T9; live T23 and T24; manual dialog check T24 |
| §9 App registration | T3 (error text), T22 (README) |
| §10 Live-test points | T23, T24 and "Live-test points" below |
| §11 Documentation | T19 (tool text), T22 |

---

## Chunk 1: Errors and account registry

### Task 1: Error classes

**Spec:** §3, §7.2, §7.3. Every later task raises these.

**Files:**
- Modify: `src/errors.ts`
- Test: `src/__tests__/errors.test.ts`

- [ ] **Step 1: Write the failing tests.**

`src/__tests__/errors.test.ts` (modify):

```diff
diff --git a/src/__tests__/errors.test.ts b/src/__tests__/errors.test.ts
index da6c79e..272a988 100644
--- a/src/__tests__/errors.test.ts
+++ b/src/__tests__/errors.test.ts
@@ -3,10 +3,18 @@ import {
   ApiDisabledError,
   AppError,
   ConflictError,
+  CopyStillRunningError,
   DriveApiError,
   ExportTooLargeError,
+  FileLockedError,
+  GraphApiError,
+  GraphThrottledError,
+  NameConflictError,
   NotFoundError,
+  OneDriveFullError,
+  ProviderNotSupportedError,
   ReauthRequiredError,
+  TargetChangedError,
   ValidationError,
   hasErrorCode,
 } from '../errors.js';
@@ -73,3 +81,24 @@ describe('content API errors', () => {
     );
   });
 });
+
+describe('OneDrive errors', () => {
+  it.each([
+    [
+      new ProviderNotSupportedError('work'),
+      'PROVIDER_NOT_SUPPORTED',
+      /"work".*not available on OneDrive/,
+    ],
+    [new NameConflictError('a.txt'), 'NAME_CONFLICT', /"a\.txt" already exists.*another name/],
+    [new TargetChangedError('a.txt'), 'TARGET_CHANGED', /"a\.txt" changed.*Check the file/],
+    [new GraphThrottledError(), 'GRAPH_THROTTLED', /try again later/],
+    [new CopyStillRunningError('a.txt'), 'COPY_STILL_RUNNING', /continues on the server/],
+    [new FileLockedError('a.txt'), 'FILE_LOCKED', /locked, probably open in Office/],
+    [new OneDriveFullError('work'), 'ONEDRIVE_FULL', /OneDrive storage is full/],
+    [new GraphApiError(500), 'GRAPH_API_ERROR', /OneDrive request failed \(500\)/],
+  ])('%s has its code and message', (err, code, message) => {
+    expect(err).toBeInstanceOf(AppError);
+    expect(err.code).toBe(code);
+    expect(err.message).toMatch(message);
+  });
+});
```

- [ ] **Step 2: Run them and watch them fail.**

Run: `npx vitest run src/__tests__/errors.test.ts`

Expected: FAIL. Test Files  1 failed (1); Tests  no tests. First error: `TypeError: ProviderNotSupportedError is not a constructor`.

- [ ] **Step 3: Implement.**

`src/errors.ts` (modify):

```diff
diff --git a/src/errors.ts b/src/errors.ts
index 23163ab..59f6706 100644
--- a/src/errors.ts
+++ b/src/errors.ts
@@ -143,6 +143,88 @@ export class DriveApiError extends AppError {
   }
 }
 
+export class ProviderNotSupportedError extends AppError {
+  readonly code = 'PROVIDER_NOT_SUPPORTED';
+
+  constructor(
+    readonly account: string,
+    options?: ErrorOptions,
+  ) {
+    super(
+      `"${account}" is a Microsoft account; this feature is not available on OneDrive yet.`,
+      options,
+    );
+  }
+}
+
+export class NameConflictError extends AppError {
+  readonly code = 'NAME_CONFLICT';
+
+  constructor(name: string, options?: ErrorOptions) {
+    super(`An item named "${name}" already exists there; choose another name.`, options);
+  }
+}
+
+export class TargetChangedError extends AppError {
+  readonly code = 'TARGET_CHANGED';
+
+  constructor(name: string, options?: ErrorOptions) {
+    super(
+      `"${name}" changed on OneDrive after it was checked, so the upload stopped (a lost final response can look the same). Check the file, then try again if needed.`,
+      options,
+    );
+  }
+}
+
+export class GraphThrottledError extends AppError {
+  readonly code = 'GRAPH_THROTTLED';
+
+  constructor(options?: ErrorOptions) {
+    super('OneDrive is limiting requests right now; try again later.', options);
+  }
+}
+
+export class CopyStillRunningError extends AppError {
+  readonly code = 'COPY_STILL_RUNNING';
+
+  constructor(name: string, options?: ErrorOptions) {
+    super(
+      `The copy of "${name}" is still running on OneDrive and continues on the server; check the target folder later.`,
+      options,
+    );
+  }
+}
+
+export class FileLockedError extends AppError {
+  readonly code = 'FILE_LOCKED';
+
+  constructor(name: string, options?: ErrorOptions) {
+    super(`File is locked, probably open in Office: ${name}`, options);
+  }
+}
+
+export class OneDriveFullError extends AppError {
+  readonly code = 'ONEDRIVE_FULL';
+
+  constructor(alias: string, options?: ErrorOptions) {
+    super(`OneDrive storage is full for "${alias}"`, options);
+  }
+}
+
+export class GraphApiError extends AppError {
+  readonly code = 'GRAPH_API_ERROR';
+
+  constructor(
+    readonly status: number | undefined,
+    options?: ErrorOptions,
+  ) {
+    super(
+      `OneDrive request failed${status === undefined ? '' : ` (${status})`}; try again.`,
+      options,
+    );
+  }
+}
+
 /** True when `err` is an object whose `code` property equals `code` (Node fs errors). */
 export function hasErrorCode(err: unknown, code: string): boolean {
   return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === code;
```

- [ ] **Step 4: Run them and watch them pass.**

Run: `npx vitest run src/__tests__/errors.test.ts`

Expected: PASS. Test Files  1 passed (1); Tests  15 passed (15).

- [ ] **Step 5: Format and run the whole check.**

Run: `npx prettier --write src/__tests__/errors.test.ts src/errors.ts` then `npm run check`

Expected: exit 0, `Tests  1019 passed | 6 skipped (1025)`.

- [ ] **Step 6: Commit.**

```bash
git add src/__tests__/errors.test.ts src/errors.ts
git commit -m "feat(errors): add the OneDrive error classes" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01UgKFZHQfQhzVqDYowSyGaA"
```

### Task 2: Account provider, `accountId`, token keys and the two email rules

**Spec:** §3.2. `AccountRecord` gains the provider; `tokenKey` becomes the only way to a token store key; `resolve` is strict and `resolveGoogleFirst` serves the Google-only surfaces.

**Files:**
- Modify: `src/config/account-registry.ts`
- Test: `src/config/__tests__/account-registry.test.ts`

- [ ] **Step 1: Write the failing tests.**

`src/config/__tests__/account-registry.test.ts` (modify):

```diff
diff --git a/src/config/__tests__/account-registry.test.ts b/src/config/__tests__/account-registry.test.ts
index b3f4fc1..1d77b8d 100644
--- a/src/config/__tests__/account-registry.test.ts
+++ b/src/config/__tests__/account-registry.test.ts
@@ -3,7 +3,13 @@ import os from 'node:os';
 import path from 'node:path';
 import { beforeEach, describe, expect, it } from 'vitest';
 import { AccountNotFoundError, ConfigError, ValidationError } from '../../errors.js';
-import { AccountRegistry, defaultAlias } from '../account-registry.js';
+import {
+  AccountRegistry,
+  defaultAlias,
+  isMicrosoft,
+  providerOf,
+  tokenKey,
+} from '../account-registry.js';
 import { expectMode } from '../../__tests__/fs-mode.js';
 
 let file: string;
@@ -136,3 +142,92 @@ describe('AccountRegistry', () => {
     await expect(registry.read()).rejects.toThrow(ConfigError);
   });
 });
+
+describe('accounts of two providers', () => {
+  const MS = {
+    alias: 'work',
+    email: 'same@example.com',
+    provider: 'microsoft',
+    accountId: 't.o',
+  } as const;
+
+  it('treats an absent provider as google and keeps Google records unchanged', async () => {
+    const google = await registry.add({ alias: 'g', email: 'g@example.com' });
+    expect(google).not.toHaveProperty('provider');
+    expect(providerOf(google)).toBe('google');
+    expect(isMicrosoft(google)).toBe(false);
+  });
+
+  it('keeps provider and accountId through the schema', async () => {
+    await registry.add(MS);
+    const fresh = new AccountRegistry(file);
+    expect((await fresh.read()).accounts[0]).toMatchObject({
+      provider: 'microsoft',
+      accountId: 't.o',
+    });
+  });
+
+  it('derives token keys', async () => {
+    expect(tokenKey(await registry.add({ alias: 'g', email: 'g@example.com' }))).toBe(
+      'g@example.com',
+    );
+    expect(tokenKey(await registry.add(MS))).toBe('microsoft:t.o');
+  });
+
+  it('refuses a Microsoft account without accountId', async () => {
+    await expect(
+      registry.add({ alias: 'm', email: 'a@b.c', provider: 'microsoft' }),
+    ).rejects.toThrow(ValidationError);
+    expect(() =>
+      tokenKey({ alias: 'm', email: 'a@b.c', addedAt: '', provider: 'microsoft' }),
+    ).toThrow(ConfigError);
+  });
+
+  it('is unique per email for Google and per accountId for Microsoft', async () => {
+    await registry.add({ alias: 'g', email: 'same@example.com' });
+    await registry.add(MS);
+    await registry.add({ ...MS, alias: 'personal', accountId: 't2.o2' });
+    await expect(registry.add({ ...MS, alias: 'again' })).rejects.toThrow(
+      /already registered as "work"/,
+    );
+    await expect(registry.add({ alias: 'g2', email: 'same@example.com' })).rejects.toThrow(
+      /already registered as "g"/,
+    );
+    await expect(registry.add({ ...MS, alias: 'g', accountId: 't3.o3' })).rejects.toThrow(
+      /--alias/,
+    );
+  });
+
+  describe('an email shared by several accounts', () => {
+    beforeEach(async () => {
+      await registry.add({ alias: 'g', email: 'same@example.com' });
+      await registry.add(MS);
+    });
+
+    it('is ambiguous where both providers are valid, naming the aliases', async () => {
+      await expect(registry.resolve('same@example.com')).rejects.toThrow(/\(g, work\).*alias/);
+      await expect(registry.setDefault('same@example.com')).rejects.toThrow(ValidationError);
+      await expect(registry.remove('same@example.com')).rejects.toThrow(ValidationError);
+    });
+
+    it('means the Google account on Google-only surfaces', async () => {
+      await expect(registry.resolveGoogleFirst('same@example.com')).resolves.toMatchObject({
+        alias: 'g',
+      });
+    });
+
+    it('resolves aliases on both paths', async () => {
+      await expect(registry.resolve('work')).resolves.toMatchObject({ alias: 'work' });
+      await expect(registry.resolveGoogleFirst('work')).resolves.toMatchObject({ alias: 'work' });
+    });
+  });
+
+  it('resolveGoogleFirst handles a Microsoft-only email, the default and unknown refs', async () => {
+    await registry.add(MS);
+    await expect(registry.resolveGoogleFirst('same@example.com')).resolves.toMatchObject({
+      alias: 'work',
+    });
+    await expect(registry.resolveGoogleFirst()).resolves.toMatchObject({ alias: 'work' });
+    await expect(registry.resolveGoogleFirst('nobody')).rejects.toThrow(AccountNotFoundError);
+  });
+});
```

- [ ] **Step 2: Run them and watch them fail.**

Run: `npx vitest run src/config/__tests__/account-registry.test.ts`

Expected: FAIL. Test Files  1 failed (1); Tests  9 failed | 12 passed (21). First error: `TypeError: providerOf is not a function`.

- [ ] **Step 3: Implement.**

`src/config/account-registry.ts` (modify):

```diff
diff --git a/src/config/account-registry.ts b/src/config/account-registry.ts
index b7a6aef..455cefa 100644
--- a/src/config/account-registry.ts
+++ b/src/config/account-registry.ts
@@ -8,10 +8,17 @@ export const ALIAS_PATTERN = /^[a-z0-9-]{1,32}$/;
 
 const EMAIL_PATTERN = /^[^@\s]+@[^@\s]+$/;
 
+export type AccountProvider = 'google' | 'microsoft';
+
 export interface AccountRecord {
   alias: string;
+  /** Google: the identity. Microsoft: the display address only (see `accountId`). */
   email: string;
   addedAt: string;
+  /** Absent means `google`. */
+  provider?: AccountProvider;
+  /** Microsoft only: `<tid>.<oid>`, the account's identity. */
+  accountId?: string;
 }
 
 export interface RegistryData {
@@ -26,6 +33,8 @@ const registrySchema = z.object({
       alias: z.string().regex(ALIAS_PATTERN),
       email: z.string().includes('@'),
       addedAt: z.string(),
+      provider: z.enum(['google', 'microsoft']).optional(),
+      accountId: z.string().min(1).optional(),
     }),
   ),
 });
@@ -42,6 +51,23 @@ export function defaultAlias(email: string): string {
   return alias === '' ? 'account' : alias;
 }
 
+export function providerOf(record: AccountRecord): AccountProvider {
+  return record.provider ?? 'google';
+}
+
+export function isMicrosoft(record: AccountRecord): boolean {
+  return providerOf(record) === 'microsoft';
+}
+
+/** The only way to derive a token store key (spec §3.2). */
+export function tokenKey(record: AccountRecord): string {
+  if (!isMicrosoft(record)) return record.email;
+  if (!record.accountId) {
+    throw new ConfigError(`Microsoft account "${record.alias}" has no accountId; add it again.`);
+  }
+  return `microsoft:${record.accountId}`;
+}
+
 function describeAccounts(accounts: AccountRecord[]): string {
   return accounts.length === 0
     ? 'none — run: marvin-drive auth add'
@@ -86,17 +112,32 @@ export class AccountRegistry {
     return accounts.find((a) => a.alias === needle || a.email === needle);
   }
 
-  /** Account by alias/email; without `ref`: the default, or the only account. */
+  private unknown(ref: string, data: RegistryData): AccountNotFoundError {
+    return new AccountNotFoundError(
+      `Unknown account "${ref}". Registered: ${describeAccounts(data.accounts)}`,
+    );
+  }
+
+  private matching(ref: string, data: RegistryData): AccountRecord[] {
+    const needle = ref.trim().toLowerCase();
+    return data.accounts.filter((a) => a.alias === needle || a.email === needle);
+  }
+
+  /**
+   * Where both providers are valid. An email shared by several accounts is an error listing
+   * the aliases. Without `ref`: the default, or the only account.
+   */
   async resolve(ref?: string): Promise<AccountRecord> {
     const data = await this.read();
     if (ref !== undefined) {
-      const found = await this.find(ref);
-      if (!found) {
-        throw new AccountNotFoundError(
-          `Unknown account "${ref}". Registered: ${describeAccounts(data.accounts)}`,
-        );
+      const found = this.matching(ref, data);
+      const [first] = found;
+      if (!first) throw this.unknown(ref, data);
+      if (found.length > 1) {
+        const aliases = found.map((a) => a.alias).join(', ');
+        throw new ValidationError(`"${ref}" matches several accounts (${aliases}); use an alias.`);
       }
-      return found;
+      return first;
     }
     const byDefault = data.accounts.find((a) => a.alias === data.default);
     if (byDefault) return byDefault;
@@ -109,8 +150,23 @@ export class AccountRegistry {
     );
   }
 
+  /** For Google-only surfaces: an email means the Google account of that address (spec §3.2). */
+  async resolveGoogleFirst(ref?: string): Promise<AccountRecord> {
+    if (ref === undefined) return this.resolve();
+    const data = await this.read();
+    const found = this.matching(ref, data);
+    const [first] = found;
+    if (!first) throw this.unknown(ref, data);
+    return found.find((a) => !isMicrosoft(a)) ?? first;
+  }
+
   async add(
-    input: { alias: string; email: string },
+    input: {
+      alias: string;
+      email: string;
+      provider?: AccountProvider;
+      accountId?: string;
+    },
     now: Date = new Date(),
   ): Promise<AccountRecord> {
     const alias = input.alias.trim().toLowerCase();
@@ -121,11 +177,17 @@ export class AccountRegistry {
     if (!EMAIL_PATTERN.test(email)) {
       throw new ValidationError(`"${input.email}" is not a valid email address`);
     }
+    const microsoft = input.provider === 'microsoft';
+    if (microsoft && !input.accountId) {
+      throw new ValidationError('A Microsoft account needs an accountId');
+    }
     const data = await this.read();
-    const sameEmail = data.accounts.find((a) => a.email === email);
-    if (sameEmail) {
+    const sameIdentity = data.accounts.find((a) =>
+      microsoft ? a.accountId === input.accountId : !isMicrosoft(a) && a.email === email,
+    );
+    if (sameIdentity) {
       throw new ValidationError(
-        `${email} is already registered as "${sameEmail.alias}"; use: marvin-drive auth login ${sameEmail.alias}`,
+        `${email} is already registered as "${sameIdentity.alias}"; use: marvin-drive auth login ${sameIdentity.alias}`,
       );
     }
     const sameAlias = data.accounts.find((a) => a.alias === alias);
@@ -134,7 +196,12 @@ export class AccountRegistry {
         `Alias "${alias}" is already used by ${sameAlias.email}; pass --alias <name>`,
       );
     }
-    const record: AccountRecord = { alias, email, addedAt: now.toISOString() };
+    const record: AccountRecord = {
+      alias,
+      email,
+      addedAt: now.toISOString(),
+      ...(microsoft ? { provider: 'microsoft' as const, accountId: input.accountId ?? '' } : {}),
+    };
     data.accounts.push(record);
     data.default ??= alias;
     await this.write(data);
```

- [ ] **Step 4: Run them and watch them pass.**

Run: `npx vitest run src/config/__tests__/account-registry.test.ts`

Expected: PASS. Test Files  1 passed (1); Tests  21 passed (21).

- [ ] **Step 5: Format and run the whole check.**

Run: `npx prettier --write src/config/__tests__/account-registry.test.ts src/config/account-registry.ts` then `npm run check`

Expected: exit 0, `Tests  1028 passed | 6 skipped (1034)`.

- [ ] **Step 6: Commit.**

```bash
git add src/config/__tests__/account-registry.test.ts src/config/account-registry.ts
git commit -m "feat(accounts): provider and accountId on accounts, token keys, email resolution rules" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01UgKFZHQfQhzVqDYowSyGaA"
```


---

## Chunk 2: Pending logins and token keys

### Task 3: Pending logins know their provider; the Microsoft client file

**Spec:** §4. Two-step login entries carry the provider, and `<configDir>/microsoft-client.json` is loaded with the registration steps in its error.

**Files:**
- Create: `src/config/microsoft-client.ts`
- Modify: `src/auth/pending-login.ts`, `src/config/paths.ts`
- Test: `src/auth/__tests__/pending-login.test.ts`, `src/config/__tests__/microsoft-client.test.ts`, `src/config/__tests__/paths.test.ts`

- [ ] **Step 1: Write the failing tests.**

`src/auth/__tests__/pending-login.test.ts` (modify):

```diff
diff --git a/src/auth/__tests__/pending-login.test.ts b/src/auth/__tests__/pending-login.test.ts
index f067371..21590b9 100644
--- a/src/auth/__tests__/pending-login.test.ts
+++ b/src/auth/__tests__/pending-login.test.ts
@@ -74,3 +74,41 @@ describe('PendingLoginStore', () => {
     await expect(store.take('s1')).rejects.toThrow(ConfigError);
   });
 });
+
+describe('PendingLogin provider', () => {
+  const ENTRY = {
+    state: 's',
+    codeVerifier: 'v',
+    redirectUri: 'http://localhost:1',
+    command: 'add',
+    account: null,
+  } as const;
+
+  it('keeps the provider and peeks it without consuming the entry', async () => {
+    const store = new PendingLoginStore(
+      path.join(await mkdtemp(path.join(os.tmpdir(), 'pend-')), 'p.json'),
+    );
+    await store.save({ ...ENTRY, provider: 'microsoft' });
+    await expect(store.peekProvider('s')).resolves.toBe('microsoft');
+    await expect(store.take('s')).resolves.toMatchObject({ provider: 'microsoft' });
+    await expect(store.peekProvider('s')).resolves.toBeNull();
+  });
+
+  it('treats an absent provider as google', async () => {
+    const store = new PendingLoginStore(
+      path.join(await mkdtemp(path.join(os.tmpdir(), 'pend-')), 'p.json'),
+    );
+    await store.save(ENTRY);
+    await expect(store.peekProvider('s')).resolves.toBe('google');
+  });
+
+  it('rejects a file with an unknown provider', async () => {
+    const dir = await mkdtemp(path.join(os.tmpdir(), 'pend-'));
+    const file = path.join(dir, 'p.json');
+    await writeFile(
+      file,
+      JSON.stringify({ version: 1, logins: [{ ...ENTRY, createdAt: 'x', provider: 'other' }] }),
+    );
+    await expect(new PendingLoginStore(file).peekProvider('s')).rejects.toThrow(ConfigError);
+  });
+});
```

`src/config/__tests__/microsoft-client.test.ts` (create):

```ts
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { ConfigError } from '../../errors.js';
import { loadMicrosoftClientId } from '../microsoft-client.js';

const GUID = '11111111-2222-4333-8444-555555555555';
let file: string;

beforeEach(async () => {
  file = path.join(await mkdtemp(path.join(os.tmpdir(), 'ms-client-')), 'microsoft-client.json');
});

describe('loadMicrosoftClientId', () => {
  it('returns the client id', async () => {
    await writeFile(file, JSON.stringify({ clientId: GUID }));
    await expect(loadMicrosoftClientId(file)).resolves.toBe(GUID);
  });

  it('explains the registration when the file is missing', async () => {
    await expect(loadMicrosoftClientId(file)).rejects.toThrow(ConfigError);
    await expect(loadMicrosoftClientId(file)).rejects.toThrow(
      /App registrations[\s\S]*Files\.ReadWrite/,
    );
  });

  it('rejects invalid JSON and a value that is not a guid', async () => {
    await writeFile(file, '{');
    await expect(loadMicrosoftClientId(file)).rejects.toThrow(/not valid JSON/);
    await writeFile(file, JSON.stringify({ clientId: 'nope' }));
    await expect(loadMicrosoftClientId(file)).rejects.toThrow(/must contain/);
  });
});
```

`src/config/__tests__/paths.test.ts` (modify):

```diff
diff --git a/src/config/__tests__/paths.test.ts b/src/config/__tests__/paths.test.ts
index 6b3563e..2ec16e2 100644
--- a/src/config/__tests__/paths.test.ts
+++ b/src/config/__tests__/paths.test.ts
@@ -10,6 +10,7 @@ describe('resolvePaths', () => {
     expect(p).toEqual({
       configDir: dir,
       clientSecret: path.join(dir, 'client_secret.json'),
+      microsoftClient: path.join(dir, 'microsoft-client.json'),
       accounts: path.join(dir, 'accounts.json'),
       tokens: path.join(dir, 'tokens.json'),
       pendingLogins: path.join(dir, 'pending-logins.json'),
```

- [ ] **Step 2: Run them and watch them fail.**

Run: `npx vitest run src/auth/__tests__/pending-login.test.ts src/config/__tests__/microsoft-client.test.ts src/config/__tests__/paths.test.ts`

Expected: FAIL. Test Files  3 failed (3); Tests  4 failed | 9 passed (13). First error: Failed to load `../microsoft-client.js` (the module does not exist yet).

- [ ] **Step 3: Implement.**

`src/auth/pending-login.ts` (modify):

```diff
diff --git a/src/auth/pending-login.ts b/src/auth/pending-login.ts
index 2e73693..1597440 100644
--- a/src/auth/pending-login.ts
+++ b/src/auth/pending-login.ts
@@ -1,5 +1,6 @@
 import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
 import path from 'node:path';
+import type { AccountProvider } from '../config/account-registry.js';
 import { AuthFlowError, ConfigError, hasErrorCode } from '../errors.js';
 import { renameReplacing } from '../files/rename-replacing.js';
 
@@ -11,10 +12,15 @@ export interface PendingLogin {
   state: string;
   codeVerifier: string;
   redirectUri: string;
-  /** `add`: the alias asked for (null = derived from the email); `login`: the account's email. */
+  /**
+   * `add`: the alias asked for (null = derived from the address); `login`: the account's email
+   * (Google) or `accountId` (Microsoft).
+   */
   command: 'add' | 'login';
   account: string | null;
   createdAt: string;
+  /** Absent means `google`. Decides which provider finishes this login. */
+  provider?: AccountProvider;
 }
 
 interface PendingFile {
@@ -55,6 +61,12 @@ export class PendingLoginStore {
     return found;
   }
 
+  /** The provider of a waiting login, without using it up. Null when no such login exists. */
+  async peekProvider(state: string): Promise<AccountProvider | null> {
+    const found = (await this.read()).find((l) => l.state === state);
+    return found ? (found.provider ?? 'google') : null;
+  }
+
   private expired(l: PendingLogin): boolean {
     return this.now().getTime() - Date.parse(l.createdAt) > PENDING_LOGIN_TTL_MS;
   }
@@ -118,6 +130,7 @@ function isPendingFile(value: unknown): value is PendingFile {
       typeof e.redirectUri === 'string' &&
       (e.command === 'add' || e.command === 'login') &&
       (e.account === null || typeof e.account === 'string') &&
+      (e.provider === undefined || e.provider === 'google' || e.provider === 'microsoft') &&
       typeof e.createdAt === 'string'
     );
   });
```

`src/config/microsoft-client.ts` (create):

```ts
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { ConfigError, hasErrorCode } from '../errors.js';

const schema = z.object({ clientId: z.uuid() });

const REGISTRATION_STEPS = [
  'Microsoft Entra admin center -> App registrations -> New registration:',
  '  1. Supported accounts: any organizational directory and personal Microsoft accounts.',
  '  2. Redirect: platform "Mobile and desktop applications", http://localhost',
  '  3. API permissions (Microsoft Graph, delegated): Files.ReadWrite, offline_access, User.Read, openid, profile, email.',
  '  4. Save the Application (client) ID in that file.',
].join('\n');

/** Reads `<configDir>/microsoft-client.json`. The client ID is not a secret. */
export async function loadMicrosoftClientId(file: string): Promise<string> {
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch (err) {
    if (!hasErrorCode(err, 'ENOENT')) throw new ConfigError(`Cannot read ${file}`, { cause: err });
    throw new ConfigError(
      `Microsoft client file not found at ${file}. It holds {"clientId": "<guid>"}.\n${REGISTRATION_STEPS}`,
      { cause: err },
    );
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    throw new ConfigError(`${file} is not valid JSON; expected {"clientId": "<guid>"}.`, {
      cause: err,
    });
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) throw new ConfigError(`${file} must contain {"clientId": "<guid>"}.`);
  return parsed.data.clientId;
}
```

`src/config/paths.ts` (modify):

```diff
diff --git a/src/config/paths.ts b/src/config/paths.ts
index be4da29..85dc322 100644
--- a/src/config/paths.ts
+++ b/src/config/paths.ts
@@ -4,6 +4,7 @@ import path from 'node:path';
 export interface Paths {
   configDir: string;
   clientSecret: string;
+  microsoftClient: string;
   accounts: string;
   tokens: string;
   pendingLogins: string;
@@ -20,6 +21,7 @@ export function resolvePaths(env: NodeJS.ProcessEnv = process.env): Paths {
   return {
     configDir,
     clientSecret: path.join(configDir, 'client_secret.json'),
+    microsoftClient: path.join(configDir, 'microsoft-client.json'),
     accounts: path.join(configDir, 'accounts.json'),
     tokens: path.join(configDir, 'tokens.json'),
     pendingLogins: path.join(configDir, 'pending-logins.json'),
```

- [ ] **Step 4: Run them and watch them pass.**

Run: `npx vitest run src/auth/__tests__/pending-login.test.ts src/config/__tests__/microsoft-client.test.ts src/config/__tests__/paths.test.ts`

Expected: PASS. Test Files  3 passed (3); Tests  16 passed (16).

- [ ] **Step 5: Format and run the whole check.**

Run: `npx prettier --write src/auth/__tests__/pending-login.test.ts src/auth/pending-login.ts src/config/__tests__/microsoft-client.test.ts src/config/__tests__/paths.test.ts src/config/microsoft-client.ts src/config/paths.ts` then `npm run check`

Expected: exit 0, `Tests  1034 passed | 6 skipped (1040)`.

- [ ] **Step 6: Commit.**

```bash
git add src/auth/__tests__/pending-login.test.ts src/auth/pending-login.ts src/config/__tests__/microsoft-client.test.ts src/config/__tests__/paths.test.ts src/config/microsoft-client.ts src/config/paths.ts
git commit -m "feat(auth): pending logins know their provider; load the Microsoft client id" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01UgKFZHQfQhzVqDYowSyGaA"
```

### Task 4: `tokenKey` in AuthService and DriveClientFactory

**Spec:** §3.2. No behaviour change for Google (`tokenKey` is the email there). Google-only surfaces switch to `resolveGoogleFirst`.

**Files:**
- Modify: `src/auth/auth-service.ts`, `src/drive/client-factory.ts`
- Test: `src/auth/__tests__/auth-service.test.ts`

- [ ] **Step 1: Write the failing tests.**

`src/auth/__tests__/auth-service.test.ts` (modify):

```diff
diff --git a/src/auth/__tests__/auth-service.test.ts b/src/auth/__tests__/auth-service.test.ts
index a90cd33..85052e6 100644
--- a/src/auth/__tests__/auth-service.test.ts
+++ b/src/auth/__tests__/auth-service.test.ts
@@ -302,3 +302,19 @@ describe('two-step login', () => {
     expect(await tokens.get('w@example.com')).toBe('rt-new');
   });
 });
+
+describe('AuthService token keys and email references', () => {
+  it('looks up a shared address as the Google account on Google-only surfaces', async () => {
+    login.mockImplementationOnce(answer(signIn('same@example.com', 'rt-google')));
+    await service.addAccount('g');
+    await registry.add({
+      alias: 'ms',
+      email: 'same@example.com',
+      provider: 'microsoft',
+      accountId: 't.o',
+    });
+    await expect(service.resolveAccount('same@example.com')).resolves.toMatchObject({ alias: 'g' });
+    const { refreshToken } = await service.authorize('same@example.com');
+    expect(refreshToken).toBe('rt-google');
+  });
+});
```

- [ ] **Step 2: Run them and watch them fail.**

Run: `npx vitest run src/auth/__tests__/auth-service.test.ts`

Expected: FAIL. Test Files  1 failed (1); Tests  1 failed | 20 passed (21). First error: `AssertionError: promise rejected "ValidationError: "same@example.com" match… { code: '…' }" instead of resolving`.

- [ ] **Step 3: Implement.**

`src/auth/auth-service.ts` (modify):

```diff
diff --git a/src/auth/auth-service.ts b/src/auth/auth-service.ts
index efc70f1..c273e23 100644
--- a/src/auth/auth-service.ts
+++ b/src/auth/auth-service.ts
@@ -2,6 +2,7 @@ import { Auth } from 'googleapis';
 import {
   ALIAS_PATTERN,
   defaultAlias,
+  tokenKey,
   type AccountRecord,
   type AccountRegistry,
 } from '../config/account-registry.js';
@@ -80,7 +81,7 @@ export class AuthService {
     });
     const { saved } = outcome;
     if (!saved) throw new AuthFlowError('Login finished without saving the account');
-    this.reauthNeeded.delete(saved.email);
+    this.reauthNeeded.delete(tokenKey(saved));
     return saved;
   }
 
@@ -95,7 +96,7 @@ export class AuthService {
     const normalized = alias === undefined ? null : alias.trim().toLowerCase();
     const result = await this.finishTwoStep({ command: 'add', account: normalized }, redirectUrl);
     const saved = await this.saveNewAccount(alias, result);
-    this.reauthNeeded.delete(saved.email);
+    this.reauthNeeded.delete(tokenKey(saved));
     return saved;
   }
 
@@ -117,8 +118,8 @@ export class AuthService {
         `Signed in as ${result.email}, but "${record.alias}" is ${record.email}. Nothing was saved.`,
       );
     }
-    await this.deps.tokens.set(record.email, result.refreshToken);
-    this.reauthNeeded.delete(record.email);
+    await this.deps.tokens.set(tokenKey(record), result.refreshToken);
+    this.reauthNeeded.delete(tokenKey(record));
     return record;
   }
 
@@ -192,7 +193,7 @@ export class AuthService {
       email: result.email,
     });
     try {
-      await this.deps.tokens.set(record.email, result.refreshToken);
+      await this.deps.tokens.set(tokenKey(record), result.refreshToken);
     } catch (err) {
       await this.deps.registry.remove(record.alias);
       throw err;
@@ -213,20 +214,20 @@ export class AuthService {
             `Signed in as ${result.email}, but "${record.alias}" is ${record.email}. Nothing was saved.`,
           );
         }
-        await this.deps.tokens.set(record.email, result.refreshToken);
+        await this.deps.tokens.set(tokenKey(record), result.refreshToken);
         outcome.saved = true;
       },
     });
     if (!outcome.saved) throw new AuthFlowError('Login finished without saving the account');
-    this.reauthNeeded.delete(record.email);
+    this.reauthNeeded.delete(tokenKey(record));
     return record;
   }
 
   async removeAccount(ref: string): Promise<AccountRecord> {
     const record = await this.deps.registry.resolve(ref);
-    const token = await this.deps.tokens.get(record.email);
+    const token = await this.deps.tokens.get(tokenKey(record));
     try {
-      await this.deps.tokens.delete(record.email);
+      await this.deps.tokens.delete(tokenKey(record));
     } catch (err) {
       this.log.warn('Failed to delete stored token; removing the account anyway', {
         alias: record.alias,
@@ -234,7 +235,7 @@ export class AuthService {
       });
     }
     await this.deps.registry.remove(record.alias);
-    this.reauthNeeded.delete(record.email);
+    this.reauthNeeded.delete(tokenKey(record));
     if (token) {
       try {
         const credentials = await this.deps.loadCredentials();
@@ -253,34 +254,36 @@ export class AuthService {
     return this.deps.registry.setDefault(ref);
   }
 
+  /** For Google-only surfaces: an email means the Google account of that address. */
   resolveAccount(ref?: string): Promise<AccountRecord> {
-    return this.deps.registry.resolve(ref);
+    return this.deps.registry.resolveGoogleFirst(ref);
   }
 
-  readRefreshToken(email: string): Promise<string | null> {
-    return this.deps.tokens.get(email);
+  /** `key` comes from `tokenKey(record)`. */
+  readRefreshToken(key: string): Promise<string | null> {
+    return this.deps.tokens.get(key);
   }
 
-  markReauthRequired(email: string): void {
-    this.reauthNeeded.add(email);
+  markReauthRequired(key: string): void {
+    this.reauthNeeded.add(key);
   }
 
-  markHealthy(email: string): void {
-    this.reauthNeeded.delete(email);
+  markHealthy(key: string): void {
+    this.reauthNeeded.delete(key);
   }
 
   async authorize(ref?: string): Promise<AuthorizedClient> {
-    const account = await this.deps.registry.resolve(ref);
-    const refreshToken = await this.deps.tokens.get(account.email);
+    const account = await this.deps.registry.resolveGoogleFirst(ref);
+    const refreshToken = await this.deps.tokens.get(tokenKey(account));
     if (!refreshToken) {
-      this.reauthNeeded.add(account.email);
+      this.reauthNeeded.add(tokenKey(account));
       throw new ReauthRequiredError(account.alias);
     }
     const client = this.newClient(await this.deps.loadCredentials());
     client.setCredentials({ refresh_token: refreshToken });
     client.on('tokens', (fresh) => {
       if (fresh.refresh_token && fresh.refresh_token !== refreshToken) {
-        this.deps.tokens.set(account.email, fresh.refresh_token).catch((err: unknown) => {
+        this.deps.tokens.set(tokenKey(account), fresh.refresh_token).catch((err: unknown) => {
           this.log.warn('Failed to persist rotated refresh token', {
             alias: account.alias,
             error: err,
@@ -304,17 +307,17 @@ export class AuthService {
   }
 
   private async checkStatus(account: AccountRecord, verify: boolean): Promise<AccountStatus> {
-    const token = await this.deps.tokens.get(account.email);
+    const token = await this.deps.tokens.get(tokenKey(account));
     if (!token) return 'reauth_required';
-    if (!verify) return this.reauthNeeded.has(account.email) ? 'reauth_required' : 'ok';
+    if (!verify) return this.reauthNeeded.has(tokenKey(account)) ? 'reauth_required' : 'ok';
     try {
       const { client } = await this.authorize(account.alias);
       await client.getAccessToken();
-      this.reauthNeeded.delete(account.email);
+      this.reauthNeeded.delete(tokenKey(account));
       return 'ok';
     } catch (err) {
       if (isInvalidGrant(err) || err instanceof ReauthRequiredError) {
-        this.reauthNeeded.add(account.email);
+        this.reauthNeeded.add(tokenKey(account));
         return 'reauth_required';
       }
       this.log.warn('Token check failed', { alias: account.alias, error: err });
```

`src/drive/client-factory.ts` (modify):

```diff
diff --git a/src/drive/client-factory.ts b/src/drive/client-factory.ts
index 89c3878..d5bd5f9 100644
--- a/src/drive/client-factory.ts
+++ b/src/drive/client-factory.ts
@@ -1,7 +1,7 @@
 import type { Auth } from 'googleapis';
 import type { AuthService } from '../auth/auth-service.js';
 import { isInvalidGrant } from '../auth/oauth-errors.js';
-import type { AccountRecord } from '../config/account-registry.js';
+import { tokenKey, type AccountRecord } from '../config/account-registry.js';
 import { ReauthRequiredError } from '../errors.js';
 import { logger as defaultLogger, type Logger } from '../logger.js';
 import { createDocsAdapter, type DocsAdapter } from './docs-adapter.js';
@@ -56,7 +56,7 @@ export class DriveClientFactory implements DriveRunner {
     const ctx = await this.context(accountRef);
     try {
       const result = await fn(ctx);
-      this.auth.markHealthy(ctx.account.email);
+      this.auth.markHealthy(tokenKey(ctx.account));
       return result;
     } catch (err) {
       if (!isInvalidGrant(err)) throw err;
@@ -64,7 +64,7 @@ export class DriveClientFactory implements DriveRunner {
       this.evict(ctx);
       let latest: string | null = null;
       try {
-        latest = await this.auth.readRefreshToken(ctx.account.email);
+        latest = await this.auth.readRefreshToken(tokenKey(ctx.account));
       } catch (readErr) {
         this.logger.warn('Keychain re-read failed', { alias: ctx.account.alias, error: readErr });
       }
@@ -72,7 +72,7 @@ export class DriveClientFactory implements DriveRunner {
         const retryCtx = await this.context(ctx.account.alias);
         try {
           const result = await fn(retryCtx);
-          this.auth.markHealthy(ctx.account.email);
+          this.auth.markHealthy(tokenKey(ctx.account));
           return result;
         } catch (retryErr) {
           if (!isInvalidGrant(retryErr)) throw retryErr;
@@ -80,7 +80,7 @@ export class DriveClientFactory implements DriveRunner {
           this.evict(retryCtx);
         }
       }
-      this.auth.markReauthRequired(ctx.account.email);
+      this.auth.markReauthRequired(tokenKey(ctx.account));
       throw new ReauthRequiredError(ctx.account.alias, { cause: lastErr });
     }
   }
@@ -92,10 +92,10 @@ export class DriveClientFactory implements DriveRunner {
 
   private async context(accountRef: string | undefined): Promise<CachedContext> {
     const account = await this.auth.resolveAccount(accountRef);
-    const token = await this.auth.readRefreshToken(account.email);
+    const token = await this.auth.readRefreshToken(tokenKey(account));
     if (!token) {
       this.cache.delete(account.email);
-      this.auth.markReauthRequired(account.email);
+      this.auth.markReauthRequired(tokenKey(account));
       throw new ReauthRequiredError(account.alias);
     }
     const cached = this.cache.get(account.email);
```

- [ ] **Step 4: Run them and watch them pass.**

Run: `npx vitest run src/auth/__tests__/auth-service.test.ts`

Expected: PASS. Test Files  1 passed (1); Tests  21 passed (21).

- [ ] **Step 5: Format and run the whole check.**

Run: `npx prettier --write src/auth/__tests__/auth-service.test.ts src/auth/auth-service.ts src/drive/client-factory.ts` then `npm run check`

Expected: exit 0, `Tests  1035 passed | 6 skipped (1041)`.

- [ ] **Step 6: Commit.**

```bash
git add src/auth/__tests__/auth-service.test.ts src/auth/auth-service.ts src/drive/client-factory.ts
git commit -m "refactor(auth): derive token store keys through tokenKey" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01UgKFZHQfQhzVqDYowSyGaA"
```


---

## Chunk 3: Loopback extraction

### Task 5: Extract `loopback.ts` from the login flow

**Spec:** §3, §4. Moves the provider-neutral helpers out of `login-flow.ts` with a provider label on every message, and adds `listenLocalhost`. Google messages are unchanged.

**Files:**
- Create: `src/auth/loopback.ts`
- Modify: `src/auth/auth-service.ts`, `src/auth/callback-page.ts`, `src/auth/login-flow.ts`
- Test: `src/auth/__tests__/login-flow.test.ts`, `src/auth/__tests__/loopback.test.ts`

- [ ] **Step 1: Write the failing tests.**

`src/auth/__tests__/login-flow.test.ts` (modify):

```diff
diff --git a/src/auth/__tests__/login-flow.test.ts b/src/auth/__tests__/login-flow.test.ts
index 7f5424f..ed6bc5b 100644
--- a/src/auth/__tests__/login-flow.test.ts
+++ b/src/auth/__tests__/login-flow.test.ts
@@ -4,11 +4,11 @@ import { AuthFlowError, ValidationError } from '../../errors.js';
 import {
   OAUTH_SCOPES,
   finishTwoStepLogin,
-  parseRedirectUrl,
   runLoginFlow,
   startTwoStepLogin,
   type OAuthFlowClient,
 } from '../login-flow.js';
+import { parseRedirectUrl } from '../loopback.js';
 
 const DRIVE_SCOPES = 'https://www.googleapis.com/auth/drive openid email';
 
@@ -595,7 +595,7 @@ describe('two-step login (--print-url / --redirect-url)', () => {
   });
 
   it('parses a bare query string too', () => {
-    expect(parseRedirectUrl('?state=s&code=c')).toEqual({ state: 's', code: 'c' });
-    expect(parseRedirectUrl('  state=s&code=c  ')).toEqual({ state: 's', code: 'c' });
+    expect(parseRedirectUrl('?state=s&code=c', 'Google')).toEqual({ state: 's', code: 'c' });
+    expect(parseRedirectUrl('  state=s&code=c  ', 'Google')).toEqual({ state: 's', code: 'c' });
   });
 });
```

`src/auth/__tests__/loopback.test.ts` (create):

```ts
import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { AuthFlowError, ValidationError } from '../../errors.js';
import {
  listenLocalhost,
  parseRedirectUrl,
  readRedirectUrl,
  redirectError,
  waitForCallback,
  withDeadline,
  type LocalhostListener,
} from '../loopback.js';

let listener: LocalhostListener | undefined;
afterEach(async () => {
  await listener?.close();
  listener = undefined;
});

describe('provider wording', () => {
  it('names the given provider in errors', async () => {
    expect(redirectError('server_error', 'Microsoft').message).toBe(
      'Microsoft returned an error: server_error',
    );
    expect(redirectError('access_denied', 'Microsoft').message).toBe(
      'Access was denied in the browser',
    );
    const never = new Promise<never>(() => {});
    await expect(withDeadline(never, 1, 'Microsoft')).rejects.toThrow(/contacting Microsoft/);
  });
});

describe('redirect URL parsing', () => {
  it('returns the parameters without judging them', () => {
    expect(readRedirectUrl('?state=s&error=nope')).toEqual({ state: 's', code: '', error: 'nope' });
  });
  it('rejects text that is not a redirect URL', () => {
    expect(() => readRedirectUrl('hello')).toThrow(ValidationError);
  });
  it('turns an error parameter into the provider message', () => {
    expect(() => parseRedirectUrl('?state=s&error=boom', 'Microsoft')).toThrow(AuthFlowError);
    expect(() => parseRedirectUrl('?state=s&error=boom', 'Microsoft')).toThrow(/Microsoft/);
  });
});

describe('listenLocalhost', () => {
  it('serves callbacks on 127.0.0.1', async () => {
    const server = createServer();
    listener = await listenLocalhost(server);
    const waiting = waitForCallback(server, 'st', 5000, 'Microsoft');
    const res = fetch(`http://127.0.0.1:${listener.port}/?state=st&code=c1`);
    const callback = await waiting;
    await callback.respond(200, { kind: 'success', email: 'a@b.c' });
    expect(callback.code).toBe('c1');
    expect((await res).status).toBe(200);
  });

  it('forwards requests that arrive on ::1 when that address exists', async () => {
    const server = createServer();
    listener = await listenLocalhost(server);
    const waiting = waitForCallback(server, 'st', 5000, 'Microsoft');
    let res: Promise<Response>;
    try {
      res = fetch(`http://[::1]:${listener.port}/?state=st&code=c6`);
      const callback = await Promise.race([
        waiting,
        res.then(() => {
          throw new Error('answered too early');
        }),
      ]);
      await callback.respond(200, { kind: 'finished' });
      expect(callback.code).toBe('c6');
    } catch (err) {
      if ((err as Error).message === 'answered too early') throw err;
      return; // no IPv6 loopback on this machine
    }
  });

  it('still works when ::1 cannot be bound', async () => {
    const server = createServer();
    const broken = (): Server => {
      const v6 = createServer();
      v6.listen = (() => {
        queueMicrotask(() => v6.emit('error', new Error('EADDRNOTAVAIL')));
        return v6;
      }) as Server['listen'];
      return v6;
    };
    listener = await listenLocalhost(server, broken);
    expect(listener.port).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run them and watch them fail.**

Run: `npx vitest run src/auth/__tests__/login-flow.test.ts src/auth/__tests__/loopback.test.ts`

Expected: FAIL. Test Files  2 failed (2); Tests  no tests. First error: Failed to load `../loopback.js` (the module does not exist yet).

- [ ] **Step 3: Implement.**

`src/auth/auth-service.ts` (modify):

```diff
diff --git a/src/auth/auth-service.ts b/src/auth/auth-service.ts
index c273e23..106659e 100644
--- a/src/auth/auth-service.ts
+++ b/src/auth/auth-service.ts
@@ -9,7 +9,8 @@ import {
 import type { ClientCredentials } from '../config/client-secret.js';
 import { AuthFlowError, ReauthRequiredError, ValidationError } from '../errors.js';
 import { logger as defaultLogger, type Logger } from '../logger.js';
-import { parseRedirectUrl, type LoginResult, type TwoStepStart } from './login-flow.js';
+import type { LoginResult, TwoStepStart } from './login-flow.js';
+import { parseRedirectUrl } from './loopback.js';
 import type { PendingLogin, PendingLoginStore } from './pending-login.js';
 import { isInvalidGrant } from './oauth-errors.js';
 import type { TokenStore } from './token-store.js';
@@ -150,7 +151,7 @@ export class AuthService {
     redirectUrl: string,
   ): Promise<LoginResult> {
     const twoStep = this.twoStep();
-    const { state } = parseRedirectUrl(redirectUrl);
+    const { state } = parseRedirectUrl(redirectUrl, 'Google');
     const pending = await twoStep.pending.take(state);
     if (!pending) {
       throw new AuthFlowError(
```

`src/auth/callback-page.ts` (modify):

```diff
diff --git a/src/auth/callback-page.ts b/src/auth/callback-page.ts
index 035871e..519dab8 100644
--- a/src/auth/callback-page.ts
+++ b/src/auth/callback-page.ts
@@ -1,5 +1,5 @@
 /**
- * The page the browser shows after the Google consent redirect hits our loopback server.
+ * The page the browser shows after the consent redirect hits our loopback server.
  * Self-contained by design: no scripts, no external fonts/images, strict CSP.
  */
 
```

`src/auth/login-flow.ts` (modify):

```diff
diff --git a/src/auth/login-flow.ts b/src/auth/login-flow.ts
index ab42908..35d6240 100644
--- a/src/auth/login-flow.ts
+++ b/src/auth/login-flow.ts
@@ -1,10 +1,16 @@
 import { randomBytes, randomInt } from 'node:crypto';
-import { createServer, type Server, type ServerResponse } from 'node:http';
-import type { AddressInfo } from 'node:net';
+import { createServer } from 'node:http';
 import { Auth } from 'googleapis';
 import { AppError, AuthFlowError, ValidationError } from '../errors.js';
-import { logger } from '../logger.js';
-import { CALLBACK_PAGE_HEADERS, renderCallbackPage, type CallbackPage } from './callback-page.js';
+import {
+  listen,
+  parseRedirectUrl,
+  waitForCallback,
+  waitForPaste,
+  withDeadline,
+  type Callback,
+  type ManualLogin,
+} from './loopback.js';
 
 const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive';
 export const OAUTH_SCOPES = [DRIVE_SCOPE, 'openid', 'email'] as const;
@@ -45,7 +51,7 @@ export interface LoginFlowOptions {
    * The loopback callback keeps working too (SSH tunnel); whichever arrives first wins.
    * `readLine` resolves null when input is closed and must stop when `signal` aborts.
    */
-  manual?: { readLine: (prompt: string, signal: AbortSignal) => Promise<string | null> };
+  manual?: ManualLogin;
 }
 
 export interface LoginResult {
@@ -53,155 +59,6 @@ export interface LoginResult {
   refreshToken: string;
 }
 
-/**
- * Writes a callback page. Resolves once it is flushed — or as soon as the browser is gone
- * (closed tab): Node never calls the `end` callback on a destroyed socket, so 'close' also settles.
- * Never throws and never writes twice.
- */
-function sendPage(res: ServerResponse, status: number, page: CallbackPage): Promise<void> {
-  return new Promise((resolve) => {
-    if (res.destroyed || res.headersSent) {
-      resolve();
-      return;
-    }
-    res.once('close', () => resolve());
-    try {
-      res.writeHead(status, CALLBACK_PAGE_HEADERS).end(renderCallbackPage(page), () => resolve());
-    } catch (err) {
-      logger.warn('Could not send the login result page', { error: err });
-      resolve();
-    }
-  });
-}
-
-/** Rejects with AuthFlowError if `work` does not settle within `ms`. */
-async function withDeadline<T>(work: Promise<T>, ms: number): Promise<T> {
-  let timer: NodeJS.Timeout | undefined;
-  const deadline = new Promise<never>((_, reject) => {
-    timer = setTimeout(() => {
-      reject(
-        new AuthFlowError(
-          `Login did not finish within ${Math.round(ms / 1000)} s while contacting Google. Check your connection and try again.`,
-        ),
-      );
-    }, ms);
-    timer.unref();
-  });
-  try {
-    return await Promise.race([work, deadline]);
-  } finally {
-    clearTimeout(timer);
-  }
-}
-
-interface Callback {
-  code: string;
-  /** Answers the browser request that delivered the code (held open until the login finishes). */
-  respond: (status: number, page: CallbackPage) => Promise<void>;
-}
-
-function waitForCallback(server: Server, state: string, timeoutMs: number): Promise<Callback> {
-  return new Promise((resolve, reject) => {
-    const timer = setTimeout(() => {
-      reject(new AuthFlowError(`Login timed out after ${Math.round(timeoutMs / 1000)} s`));
-    }, timeoutMs);
-    timer.unref();
-
-    let settled = false;
-    server.on('request', (req, res) => {
-      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
-      if (url.pathname !== '/') {
-        res.writeHead(404).end();
-        return;
-      }
-      if (settled) {
-        void sendPage(res, 200, { kind: 'finished' });
-        return;
-      }
-      const params = url.searchParams;
-      if (params.get('state') !== state) {
-        void sendPage(res, 400, { kind: 'stale' });
-        return;
-      }
-      const fail = (message: string): void => {
-        settled = true;
-        clearTimeout(timer);
-        // Reject only after the page is flushed; the caller closes all connections next.
-        void sendPage(res, 400, { kind: 'failure', message }).then(() => {
-          reject(new AuthFlowError(message));
-        });
-      };
-
-      const error = params.get('error');
-      if (error) {
-        return fail(
-          error === 'access_denied'
-            ? 'Access was denied in the browser'
-            : `Google returned an error: ${error}`,
-        );
-      }
-      const code = params.get('code');
-      if (!code) return fail('Callback did not include an authorization code');
-
-      settled = true;
-      clearTimeout(timer);
-      resolve({ code, respond: (status, page) => sendPage(res, status, page) });
-    });
-  });
-}
-
-const PASTE_PROMPT = 'Paste the full URL from the address bar: ';
-
-/** Parses a pasted redirect URL (or just its query string). */
-function parsePasted(input: string): URLSearchParams | null {
-  const text = input.trim();
-  if (!text) return null;
-  try {
-    const url = text.includes('://')
-      ? new URL(text)
-      : new URL(`http://127.0.0.1/?${text.replace(/^\?/, '')}`);
-    return url.searchParams;
-  } catch {
-    return null;
-  }
-}
-
-/** Reads pasted redirect URLs until one carries a code for this attempt. Never settles on EOF. */
-async function waitForPaste(
-  manual: NonNullable<LoginFlowOptions['manual']>,
-  state: string,
-  print: (message: string) => void,
-  signal: AbortSignal,
-): Promise<Callback> {
-  for (;;) {
-    const line = await manual.readLine(PASTE_PROMPT, signal);
-    if (line === null) return new Promise<never>(() => {}); // stdin closed: rely on the callback
-    const params = parsePasted(line);
-    if (!params || (!params.has('code') && !params.has('error'))) {
-      print('That does not look like the redirect URL (it contains "code=" and "state=").');
-      continue;
-    }
-    if (params.get('state') !== state) {
-      print('That URL belongs to a different login attempt; use the URL printed above.');
-      continue;
-    }
-    const error = params.get('error');
-    if (error) {
-      throw new AuthFlowError(
-        error === 'access_denied'
-          ? 'Access was denied in the browser'
-          : `Google returned an error: ${error}`,
-      );
-    }
-    const code = params.get('code');
-    if (!code) {
-      print('That URL has no authorization code; paste the full URL.');
-      continue;
-    }
-    return { code, respond: async (): Promise<void> => {} };
-  }
-}
-
 async function exchangeAndVerify(
   client: OAuthFlowClient,
   code: string,
@@ -229,17 +86,6 @@ async function exchangeAndVerify(
   return { email: payload.email.toLowerCase(), refreshToken: tokens.refresh_token };
 }
 
-async function listen(server: Server): Promise<number> {
-  await new Promise<void>((resolve, reject) => {
-    server.once('error', reject);
-    server.listen(0, '127.0.0.1', () => {
-      server.off('error', reject);
-      resolve();
-    });
-  });
-  return (server.address() as AddressInfo).port;
-}
-
 /** The Google consent URL: offline access (refresh token), PKCE S256, our scopes. */
 function buildAuthUrl(
   client: OAuthFlowClient,
@@ -276,7 +122,7 @@ export async function runLoginFlow(opts: LoginFlowOptions): Promise<LoginResult>
     const { codeVerifier, codeChallenge } = await client.generateCodeVerifierAsync();
     const timeoutMs =
       opts.timeoutMs ?? (opts.manual ? DEFAULT_MANUAL_TIMEOUT_MS : DEFAULT_TIMEOUT_MS);
-    const callbackPromise = waitForCallback(server, state, timeoutMs);
+    const callbackPromise = waitForCallback(server, state, timeoutMs, 'Google');
     callbackPromise.catch(() => undefined); // awaited below; prevents an unhandled rejection if we throw first
 
     const authUrl = buildAuthUrl(client, state, codeChallenge, opts.loginHint);
@@ -287,7 +133,7 @@ export async function runLoginFlow(opts: LoginFlowOptions): Promise<LoginResult>
           `Google then redirects to ${redirectUri}/?…, which usually fails to load on that device — ` +
           'that is expected. Copy the full URL from the address bar and paste it here.',
       );
-      const pasted = waitForPaste(opts.manual, state, opts.print, pasteAbort.signal);
+      const pasted = waitForPaste(opts.manual, state, opts.print, pasteAbort.signal, 'Google');
       pasted.catch(() => undefined); // awaited via the race below
       incoming = Promise.race([callbackPromise, pasted]);
     } else {
@@ -304,6 +150,7 @@ export async function runLoginFlow(opts: LoginFlowOptions): Promise<LoginResult>
       const result = await withDeadline(
         exchangeAndVerify(client, code, codeVerifier, opts.clientId),
         opts.finishTimeoutMs ?? DEFAULT_FINISH_TIMEOUT_MS,
+        'Google',
       );
       await opts.onVerified?.(result);
       await respond(200, { kind: 'success', email: result.email });
@@ -369,32 +216,13 @@ export async function startTwoStepLogin(
   };
 }
 
-/** The state and code of a redirect URL (or its query string); throws on anything else. */
-export function parseRedirectUrl(input: string): { state: string; code: string } {
-  const params = parsePasted(input);
-  if (!params || !params.has('state') || (!params.has('code') && !params.has('error'))) {
-    throw new ValidationError(
-      'That does not look like the redirect URL; it contains "state=" and "code=". Quote it in the shell.',
-    );
-  }
-  const error = params.get('error');
-  if (error) {
-    throw new AuthFlowError(
-      error === 'access_denied'
-        ? 'Access was denied in the browser'
-        : `Google returned an error: ${error}`,
-    );
-  }
-  return { state: params.get('state') ?? '', code: params.get('code') ?? '' };
-}
-
 /** Step 2: exchanges the code from the redirect URL with the stored PKCE verifier. */
 export async function finishTwoStepLogin(
   opts: TwoStepOptions,
   pending: { state: string; codeVerifier: string; redirectUri: string },
   redirectUrl: string,
 ): Promise<LoginResult> {
-  const { state, code } = parseRedirectUrl(redirectUrl);
+  const { state, code } = parseRedirectUrl(redirectUrl, 'Google');
   if (state !== pending.state) {
     throw new AuthFlowError('That redirect URL belongs to a different login attempt.');
   }
@@ -403,5 +231,6 @@ export async function finishTwoStepLogin(
   return withDeadline(
     exchangeAndVerify(client, code, pending.codeVerifier, opts.clientId),
     opts.finishTimeoutMs ?? DEFAULT_FINISH_TIMEOUT_MS,
+    'Google',
   );
 }
```

`src/auth/loopback.ts` (create):

```ts
import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { AuthFlowError, ValidationError } from '../errors.js';
import { logger } from '../logger.js';
import { CALLBACK_PAGE_HEADERS, renderCallbackPage, type CallbackPage } from './callback-page.js';

/** Which provider a message talks about, e.g. "Google". */
export type ProviderLabel = string;

/**
 * Writes a callback page. Resolves once it is flushed — or as soon as the browser is gone
 * (closed tab): Node never calls the `end` callback on a destroyed socket, so 'close' also settles.
 * Never throws and never writes twice.
 */
export function sendPage(res: ServerResponse, status: number, page: CallbackPage): Promise<void> {
  return new Promise((resolve) => {
    if (res.destroyed || res.headersSent) {
      resolve();
      return;
    }
    res.once('close', () => resolve());
    try {
      res.writeHead(status, CALLBACK_PAGE_HEADERS).end(renderCallbackPage(page), () => resolve());
    } catch (err) {
      logger.warn('Could not send the login result page', { error: err });
      resolve();
    }
  });
}

/** Rejects with AuthFlowError if `work` does not settle within `ms`. */
export async function withDeadline<T>(
  work: Promise<T>,
  ms: number,
  provider: ProviderLabel,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(
        new AuthFlowError(
          `Login did not finish within ${Math.round(ms / 1000)} s while contacting ${provider}. Check your connection and try again.`,
        ),
      );
    }, ms);
    timer.unref();
  });
  try {
    return await Promise.race([work, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

export interface Callback {
  code: string;
  /** Answers the browser request that delivered the code (held open until the login finishes). */
  respond: (status: number, page: CallbackPage) => Promise<void>;
}

/** No-browser mode: `readLine` resolves null when input is closed and stops when `signal` aborts. */
export interface ManualLogin {
  readLine: (prompt: string, signal: AbortSignal) => Promise<string | null>;
}

/** The message for an `error=` parameter on the redirect. */
export function redirectError(error: string, provider: ProviderLabel): AuthFlowError {
  return new AuthFlowError(
    error === 'access_denied'
      ? 'Access was denied in the browser'
      : `${provider} returned an error: ${error}`,
  );
}

export function waitForCallback(
  server: Server,
  state: string,
  timeoutMs: number,
  provider: ProviderLabel,
): Promise<Callback> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new AuthFlowError(`Login timed out after ${Math.round(timeoutMs / 1000)} s`));
    }, timeoutMs);
    timer.unref();

    let settled = false;
    server.on('request', (req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (url.pathname !== '/') {
        res.writeHead(404).end();
        return;
      }
      if (settled) {
        void sendPage(res, 200, { kind: 'finished' });
        return;
      }
      const params = url.searchParams;
      if (params.get('state') !== state) {
        void sendPage(res, 400, { kind: 'stale' });
        return;
      }
      const fail = (err: AuthFlowError): void => {
        settled = true;
        clearTimeout(timer);
        // Reject only after the page is flushed; the caller closes all connections next.
        void sendPage(res, 400, { kind: 'failure', message: err.message }).then(() => {
          reject(err);
        });
      };

      const error = params.get('error');
      if (error) return fail(redirectError(error, provider));
      const code = params.get('code');
      if (!code) return fail(new AuthFlowError('Callback did not include an authorization code'));

      settled = true;
      clearTimeout(timer);
      resolve({ code, respond: (status, page) => sendPage(res, status, page) });
    });
  });
}

const PASTE_PROMPT = 'Paste the full URL from the address bar: ';

/** Parses a pasted redirect URL (or just its query string). */
export function parsePasted(input: string): URLSearchParams | null {
  const text = input.trim();
  if (!text) return null;
  try {
    const url = text.includes('://')
      ? new URL(text)
      : new URL(`http://127.0.0.1/?${text.replace(/^\?/, '')}`);
    return url.searchParams;
  } catch {
    return null;
  }
}

/** Reads pasted redirect URLs until one carries a code for this attempt. Never settles on EOF. */
export async function waitForPaste(
  manual: ManualLogin,
  state: string,
  print: (message: string) => void,
  signal: AbortSignal,
  provider: ProviderLabel,
): Promise<Callback> {
  for (;;) {
    const line = await manual.readLine(PASTE_PROMPT, signal);
    if (line === null) return new Promise<never>(() => {}); // stdin closed: rely on the callback
    const params = parsePasted(line);
    if (!params || (!params.has('code') && !params.has('error'))) {
      print('That does not look like the redirect URL (it contains "code=" and "state=").');
      continue;
    }
    if (params.get('state') !== state) {
      print('That URL belongs to a different login attempt; use the URL printed above.');
      continue;
    }
    const error = params.get('error');
    if (error) throw redirectError(error, provider);
    const code = params.get('code');
    if (!code) {
      print('That URL has no authorization code; paste the full URL.');
      continue;
    }
    return { code, respond: async (): Promise<void> => {} };
  }
}

export async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  return (server.address() as AddressInfo).port;
}

export interface LocalhostListener {
  port: number;
  close: () => Promise<void>;
}

function closeServer(server: Server): Promise<void> {
  server.closeAllConnections();
  return new Promise<void>((resolve) => server.close(() => resolve()));
}

/**
 * For `http://localhost:<port>` redirects: browsers may resolve `localhost` to either address, so
 * the port is bound on 127.0.0.1 and, best effort, on ::1. Requests on ::1 reach `server`'s handlers.
 */
export async function listenLocalhost(
  server: Server,
  createV6: () => Server = createServer,
): Promise<LocalhostListener> {
  const port = await listen(server);
  const v6 = createV6();
  const bound = await new Promise<boolean>((resolve) => {
    v6.once('error', () => resolve(false));
    v6.listen(port, '::1', () => resolve(true));
  });
  if (bound) v6.on('request', (req, res) => server.emit('request', req, res));
  return {
    port,
    close: async (): Promise<void> => {
      await Promise.all([closeServer(server), bound ? closeServer(v6) : Promise.resolve()]);
    },
  };
}

export interface RedirectParams {
  state: string;
  code: string;
  error: string | null;
}

/** The parameters of a redirect URL (or its query string); throws on anything else. */
export function readRedirectUrl(input: string): RedirectParams {
  const params = parsePasted(input);
  if (!params || !params.has('state') || (!params.has('code') && !params.has('error'))) {
    throw new ValidationError(
      'That does not look like the redirect URL; it contains "state=" and "code=". Quote it in the shell.',
    );
  }
  return {
    state: params.get('state') ?? '',
    code: params.get('code') ?? '',
    error: params.get('error'),
  };
}

/** The state and code of a redirect URL; throws when it is not one or it reports an error. */
export function parseRedirectUrl(
  input: string,
  provider: ProviderLabel,
): { state: string; code: string } {
  const { state, code, error } = readRedirectUrl(input);
  if (error) throw redirectError(error, provider);
  return { state, code };
}
```

- [ ] **Step 4: Run them and watch them pass.**

Run: `npx vitest run src/auth/__tests__/login-flow.test.ts src/auth/__tests__/loopback.test.ts`

Expected: PASS. Test Files  2 passed (2); Tests  34 passed (34).

- [ ] **Step 5: Format and run the whole check.**

Run: `npx prettier --write src/auth/__tests__/login-flow.test.ts src/auth/__tests__/loopback.test.ts src/auth/auth-service.ts src/auth/callback-page.ts src/auth/login-flow.ts src/auth/loopback.ts` then `npm run check`

Expected: exit 0, `Tests  1042 passed | 6 skipped (1048)`.

- [ ] **Step 6: Commit.**

```bash
git add src/auth/__tests__/login-flow.test.ts src/auth/__tests__/loopback.test.ts src/auth/auth-service.ts src/auth/callback-page.ts src/auth/login-flow.ts src/auth/loopback.ts
git commit -m "refactor(auth): extract the provider-neutral loopback helpers from the login flow" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01UgKFZHQfQhzVqDYowSyGaA"
```


---

## Chunk 4: Auth dispatch

### Task 6: `ProviderAuth` and AuthService dispatch

**Spec:** §3.4, §4. `AuthService` stays the only entry point and dispatches before any Google step. Tests use a fake provider; the real one comes in Task 7.

**Files:**
- Create: `src/auth/provider-auth.ts`
- Modify: `src/auth/auth-service.ts`, `src/cli/format.ts`
- Test: `src/auth/__tests__/auth-service.test.ts`, `src/cli/__tests__/format.test.ts`, `src/mcp/__tests__/server.test.ts`

- [ ] **Step 1: Write the failing tests.**

`src/auth/__tests__/auth-service.test.ts` (modify):

```diff
diff --git a/src/auth/__tests__/auth-service.test.ts b/src/auth/__tests__/auth-service.test.ts
index 85052e6..0375fa0 100644
--- a/src/auth/__tests__/auth-service.test.ts
+++ b/src/auth/__tests__/auth-service.test.ts
@@ -2,13 +2,14 @@ import { mkdtemp } from 'node:fs/promises';
 import os from 'node:os';
 import path from 'node:path';
 import { Auth } from 'googleapis';
-import { beforeEach, describe, expect, it, vi } from 'vitest';
+import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
 import { AccountRegistry } from '../../config/account-registry.js';
-import { AuthFlowError, ReauthRequiredError, ValidationError } from '../../errors.js';
+import { AuthFlowError, ConfigError, ReauthRequiredError, ValidationError } from '../../errors.js';
 import { createLogger } from '../../logger.js';
 import { AuthService, type AuthServiceDeps } from '../auth-service.js';
 import type { LoginResult } from '../login-flow.js';
-import { PendingLoginStore } from '../pending-login.js';
+import { PendingLoginStore, type PendingLogin } from '../pending-login.js';
+import type { ProviderAuth } from '../provider-auth.js';
 import { InMemoryTokenStore } from '../token-store.js';
 
 const CREDS = { clientId: 'cid.apps.googleusercontent.com', clientSecret: 'secret' };
@@ -178,10 +179,17 @@ describe('AuthService.status', () => {
 
   it('reports token presence without network calls by default', async () => {
     await expect(service.status()).resolves.toEqual([
-      { alias: 'emco', email: 'emco@example.com', isDefault: true, status: 'ok' },
+      {
+        alias: 'emco',
+        email: 'emco@example.com',
+        provider: 'google',
+        isDefault: true,
+        status: 'ok',
+      },
       {
         alias: 'notoken',
         email: 'notoken@example.com',
+        provider: 'google',
         isDefault: false,
         status: 'reauth_required',
       },
@@ -318,3 +326,156 @@ describe('AuthService token keys and email references', () => {
     expect(refreshToken).toBe('rt-google');
   });
 });
+
+describe('AuthService dispatch to the Microsoft provider', () => {
+  const REF = {
+    alias: 'ms',
+    email: 'same@example.com',
+    provider: 'microsoft',
+    accountId: 't.o',
+  } as const;
+  const LOGIN_URL = 'https://login.example/authorize';
+  let pending: PendingLoginStore;
+  let dir: string;
+  let provider: { [K in keyof ProviderAuth]: Mock<ProviderAuth[K]> };
+  let loadCredentials: Mock<AuthServiceDeps['loadCredentials']>;
+  let dispatching: AuthService;
+
+  beforeEach(async () => {
+    dir = await mkdtemp(path.join(os.tmpdir(), 'marvin-dispatch-'));
+    pending = new PendingLoginStore(path.join(dir, 'pending.json'));
+    loadCredentials = vi.fn(async () => CREDS);
+    const added = { ...REF, addedAt: 'now' };
+    provider = {
+      add: vi.fn(async () => added),
+      startAdd: vi.fn(async () => LOGIN_URL),
+      finishAdd: vi.fn(async () => added),
+      relogin: vi.fn(async (r) => r),
+      startRelogin: vi.fn(async () => LOGIN_URL),
+      finishRelogin: vi.fn(async (r) => r),
+      checkStatus: vi.fn(async () => 'ok' as const),
+      forget: vi.fn(async () => undefined),
+    };
+    dispatching = new AuthService({
+      registry,
+      tokens,
+      loadCredentials,
+      login,
+      twoStep: { pending, start: vi.fn(), finish: vi.fn() },
+      microsoft: provider,
+      logger: createLogger(() => {}),
+    });
+  });
+
+  it('adds without touching the Google credentials', async () => {
+    await dispatching.addAccount('Ms', 'microsoft');
+    expect(provider.add).toHaveBeenCalledWith('ms');
+    await expect(dispatching.startAddAccount('ms2', 'microsoft')).resolves.toBe(LOGIN_URL);
+    expect(loadCredentials).not.toHaveBeenCalled();
+    expect(login).not.toHaveBeenCalled();
+  });
+
+  it('checks the alias before dispatching', async () => {
+    await registry.add(REF);
+    await expect(dispatching.addAccount('ms', 'microsoft')).rejects.toThrow(/already used/);
+    expect(provider.add).not.toHaveBeenCalled();
+  });
+
+  it('dispatches relogin, status and removal on the record', async () => {
+    const record = await registry.add(REF);
+    await dispatching.relogin('ms');
+    expect(provider.relogin).toHaveBeenCalledWith(record);
+    await expect(dispatching.startRelogin('ms')).resolves.toBe(LOGIN_URL);
+    await expect(dispatching.status()).resolves.toEqual([
+      { alias: 'ms', email: REF.email, provider: 'microsoft', isDefault: true, status: 'ok' },
+    ]);
+    expect(provider.checkStatus).toHaveBeenCalledWith(record, false);
+    await dispatching.removeAccount('ms');
+    expect(provider.forget).toHaveBeenCalledWith(record);
+    expect((await registry.read()).accounts).toEqual([]);
+  });
+
+  it('removes a Microsoft account with a shared address without touching the Google token', async () => {
+    login.mockImplementationOnce(answer(signIn('same@example.com', 'rt-google')));
+    await dispatching.addAccount('g');
+    await registry.add(REF);
+    const revoke = vi.spyOn(Auth.OAuth2Client.prototype, 'revokeToken');
+    await expect(dispatching.removeAccount('same@example.com')).rejects.toThrow(/use an alias/);
+    await dispatching.removeAccount('ms');
+    expect(await tokens.get('same@example.com')).toBe('rt-google');
+    expect(revoke).not.toHaveBeenCalled();
+  });
+
+  it('removes the account even when forgetting the token fails', async () => {
+    await registry.add(REF);
+    provider.forget.mockRejectedValueOnce(new Error('keychain'));
+    await dispatching.removeAccount('ms');
+    expect((await registry.read()).accounts).toEqual([]);
+  });
+
+  describe('finishing a two-step login', () => {
+    const entry = (extra: Partial<PendingLogin>): Omit<PendingLogin, 'createdAt'> => ({
+      state: 's1',
+      codeVerifier: 'v',
+      redirectUri: 'http://localhost:1',
+      command: 'add',
+      account: null,
+      provider: 'microsoft',
+      ...extra,
+    });
+    const URL_OK = 'http://localhost:1/?state=s1&code=c';
+
+    it('lets the entry decide the provider', async () => {
+      await pending.save(entry({}));
+      await dispatching.finishAddAccount(undefined, URL_OK);
+      expect(provider.finishAdd).toHaveBeenCalledWith(
+        expect.objectContaining({ state: 's1' }),
+        URL_OK,
+      );
+      expect(loadCredentials).not.toHaveBeenCalled();
+    });
+
+    it('rejects a provider flag that contradicts the entry', async () => {
+      await pending.save(entry({}));
+      await expect(dispatching.finishAddAccount(undefined, URL_OK, 'google')).rejects.toThrow(
+        /belongs to a microsoft login/,
+      );
+      expect(provider.finishAdd).not.toHaveBeenCalled();
+    });
+
+    it('requires the provider to match on relogin and compares accountId', async () => {
+      const record = await registry.add(REF);
+      await pending.save(entry({ command: 'login', account: 't.o' }));
+      await dispatching.finishRelogin('ms', URL_OK);
+      expect(provider.finishRelogin).toHaveBeenCalledWith(record, expect.anything(), URL_OK);
+
+      await pending.save(entry({ command: 'login', account: 't.other' }));
+      await expect(dispatching.finishRelogin('ms', URL_OK)).rejects.toThrow(
+        /same command and account/,
+      );
+
+      await pending.save(entry({ command: 'login', account: 't.o', provider: 'google' }));
+      await expect(dispatching.finishRelogin('ms', URL_OK)).rejects.toThrow(
+        /belongs to a google login/,
+      );
+    });
+
+    it('names the provider of the waiting login in a redirect error', async () => {
+      await pending.save(entry({}));
+      await expect(
+        dispatching.finishAddAccount(undefined, 'http://localhost:1/?state=s1&error=boom'),
+      ).rejects.toThrow('Microsoft returned an error: boom');
+    });
+
+    it('still names Google for a Google login', async () => {
+      await pending.save(entry({ provider: 'google' }));
+      await expect(
+        dispatching.finishAddAccount(undefined, 'http://localhost:1/?state=s1&error=boom'),
+      ).rejects.toThrow('Google returned an error: boom');
+    });
+  });
+
+  it('reports a clear error when no Microsoft provider is configured', async () => {
+    await expect(service.addAccount(undefined, 'microsoft')).rejects.toThrow(ConfigError);
+  });
+});
```

`src/cli/__tests__/format.test.ts` (modify):

```diff
diff --git a/src/cli/__tests__/format.test.ts b/src/cli/__tests__/format.test.ts
index 0f4a7e6..371f9a7 100644
--- a/src/cli/__tests__/format.test.ts
+++ b/src/cli/__tests__/format.test.ts
@@ -5,15 +5,33 @@ describe('formatAccounts', () => {
   it('marks the default and shows status', () => {
     expect(
       formatAccounts([
-        { alias: 'emco', email: 'emco@example.com', isDefault: true, status: 'ok' },
-        { alias: 'work', email: 'work@example.com', isDefault: false, status: 'reauth_required' },
-        { alias: 'misc', email: 'misc@example.com', isDefault: false, status: 'unknown' },
+        {
+          alias: 'emco',
+          email: 'emco@example.com',
+          provider: 'google',
+          isDefault: true,
+          status: 'ok',
+        },
+        {
+          alias: 'work',
+          email: 'work@example.com',
+          provider: 'microsoft',
+          isDefault: false,
+          status: 'reauth_required',
+        },
+        {
+          alias: 'misc',
+          email: 'misc@example.com',
+          provider: 'google',
+          isDefault: false,
+          status: 'unknown',
+        },
       ]),
     ).toBe(
       [
-        '* emco                 emco@example.com                     ok',
-        '  work                 work@example.com                     reauth_required',
-        '  misc                 misc@example.com                     unknown',
+        '* emco                 emco@example.com                     google     ok',
+        '  work                 work@example.com                     microsoft  reauth_required',
+        '  misc                 misc@example.com                     google     unknown',
       ].join('\n'),
     );
   });
```

`src/mcp/__tests__/server.test.ts` (modify):

```diff
diff --git a/src/mcp/__tests__/server.test.ts b/src/mcp/__tests__/server.test.ts
index b7b30e2..9753147 100644
--- a/src/mcp/__tests__/server.test.ts
+++ b/src/mcp/__tests__/server.test.ts
@@ -73,7 +73,9 @@ function textOf(result: unknown): string {
 
 beforeEach(async () => {
   drive = createFakeDrive();
-  statuses = [{ alias: 'emco', email: 'emco@example.com', isDefault: true, status: 'ok' }];
+  statuses = [
+    { alias: 'emco', email: 'emco@example.com', provider: 'google', isDefault: true, status: 'ok' },
+  ];
   verifyArgs = [];
   const files = new FileService({
     runner: createRunner(drive),
```

- [ ] **Step 2: Run them and watch them fail.**

Run: `npx vitest run src/auth/__tests__/auth-service.test.ts src/cli/__tests__/format.test.ts src/mcp/__tests__/server.test.ts`

Expected: FAIL. Test Files  2 failed | 1 passed (3); Tests  9 failed | 32 passed (41). First error: `AssertionError: expected '* emco                 emco@example.c…' to be '* emco                 emco@example.c…' // Object.is equality`.

- [ ] **Step 3: Implement.**

`src/auth/auth-service.ts` (modify):

```diff
diff --git a/src/auth/auth-service.ts b/src/auth/auth-service.ts
index 106659e..e192178 100644
--- a/src/auth/auth-service.ts
+++ b/src/auth/auth-service.ts
@@ -2,24 +2,29 @@ import { Auth } from 'googleapis';
 import {
   ALIAS_PATTERN,
   defaultAlias,
+  isMicrosoft,
+  providerOf,
   tokenKey,
+  type AccountProvider,
   type AccountRecord,
   type AccountRegistry,
 } from '../config/account-registry.js';
 import type { ClientCredentials } from '../config/client-secret.js';
-import { AuthFlowError, ReauthRequiredError, ValidationError } from '../errors.js';
+import { AuthFlowError, ConfigError, ReauthRequiredError, ValidationError } from '../errors.js';
 import { logger as defaultLogger, type Logger } from '../logger.js';
 import type { LoginResult, TwoStepStart } from './login-flow.js';
-import { parseRedirectUrl } from './loopback.js';
+import { readRedirectUrl, redirectError } from './loopback.js';
 import type { PendingLogin, PendingLoginStore } from './pending-login.js';
 import { isInvalidGrant } from './oauth-errors.js';
+import type { AccountStatus, ProviderAuth } from './provider-auth.js';
 import type { TokenStore } from './token-store.js';
 
-export type AccountStatus = 'ok' | 'reauth_required' | 'unknown';
+export type { AccountStatus } from './provider-auth.js';
 
 export interface AccountStatusEntry {
   alias: string;
   email: string;
+  provider: AccountProvider;
   isDefault: boolean;
   status: AccountStatus;
 }
@@ -54,6 +59,8 @@ export interface AuthServiceDeps {
     ) => Promise<LoginResult>;
   };
   newClient?: (credentials: ClientCredentials) => Auth.OAuth2Client;
+  /** The Microsoft sign-in; dispatched to before any Google step (spec §3.4). */
+  microsoft?: ProviderAuth;
   logger?: Logger;
 }
 
@@ -70,8 +77,14 @@ export class AuthService {
         new Auth.OAuth2Client({ clientId: c.clientId, clientSecret: c.clientSecret }));
   }
 
-  async addAccount(alias?: string): Promise<AccountRecord> {
-    await this.checkNewAlias(alias);
+  private microsoft(): ProviderAuth {
+    if (!this.deps.microsoft) throw new ConfigError('Microsoft accounts are not available here');
+    return this.deps.microsoft;
+  }
+
+  async addAccount(alias?: string, provider: AccountProvider = 'google'): Promise<AccountRecord> {
+    const normalized = await this.checkNewAlias(alias);
+    if (provider === 'microsoft') return this.microsoft().add(normalized ?? undefined);
     const credentials = await this.deps.loadCredentials();
     const outcome: { saved?: AccountRecord } = {};
     await this.deps.login({
@@ -87,15 +100,28 @@ export class AuthService {
   }
 
   /** `auth add --print-url`: returns the consent URL; finish with finishAddAccount. */
-  async startAddAccount(alias?: string): Promise<string> {
+  async startAddAccount(alias?: string, provider: AccountProvider = 'google'): Promise<string> {
     const normalized = await this.checkNewAlias(alias);
+    if (provider === 'microsoft') return this.microsoft().startAdd(normalized ?? undefined);
     return this.startTwoStep({ command: 'add', account: normalized });
   }
 
-  /** `auth add --redirect-url`: completes a login started by startAddAccount. */
-  async finishAddAccount(alias: string | undefined, redirectUrl: string): Promise<AccountRecord> {
+  /**
+   * `auth add --redirect-url`: completes a login started by startAddAccount. The waiting entry
+   * decides the provider; `provider` is only checked against it when given.
+   */
+  async finishAddAccount(
+    alias: string | undefined,
+    redirectUrl: string,
+    provider?: AccountProvider,
+  ): Promise<AccountRecord> {
     const normalized = alias === undefined ? null : alias.trim().toLowerCase();
-    const result = await this.finishTwoStep({ command: 'add', account: normalized }, redirectUrl);
+    const pending = await this.takePending(
+      { command: 'add', account: normalized, ...(provider ? { provider } : {}) },
+      redirectUrl,
+    );
+    if (pending.provider === 'microsoft') return this.microsoft().finishAdd(pending, redirectUrl);
+    const result = await this.finishGoogle(pending, redirectUrl);
     const saved = await this.saveNewAccount(alias, result);
     this.reauthNeeded.delete(tokenKey(saved));
     return saved;
@@ -104,16 +130,23 @@ export class AuthService {
   /** `auth login <account> --print-url`. */
   async startRelogin(ref: string): Promise<string> {
     const record = await this.deps.registry.resolve(ref);
+    if (isMicrosoft(record)) return this.microsoft().startRelogin(record);
     return this.startTwoStep({ command: 'login', account: record.email }, record.email);
   }
 
   /** `auth login <account> --redirect-url`. */
   async finishRelogin(ref: string, redirectUrl: string): Promise<AccountRecord> {
     const record = await this.deps.registry.resolve(ref);
-    const result = await this.finishTwoStep(
-      { command: 'login', account: record.email },
+    const pending = await this.takePending(
+      {
+        command: 'login',
+        account: isMicrosoft(record) ? (record.accountId ?? '') : record.email,
+        provider: providerOf(record),
+      },
       redirectUrl,
     );
+    if (isMicrosoft(record)) return this.microsoft().finishRelogin(record, pending, redirectUrl);
+    const result = await this.finishGoogle(pending, redirectUrl);
     if (result.email !== record.email) {
       throw new AuthFlowError(
         `Signed in as ${result.email}, but "${record.alias}" is ${record.email}. Nothing was saved.`,
@@ -145,27 +178,41 @@ export class AuthService {
     return started.authUrl;
   }
 
-  /** Takes the pending login for the URL's state (single use) and checks it was for `target`. */
-  private async finishTwoStep(
-    target: Pick<PendingLogin, 'command' | 'account'>,
+  /** Takes the waiting login for the URL's state (single use) and checks it was for `target`. */
+  private async takePending(
+    target: Pick<PendingLogin, 'command' | 'account' | 'provider'>,
     redirectUrl: string,
-  ): Promise<LoginResult> {
+  ): Promise<PendingLogin> {
     const twoStep = this.twoStep();
-    const { state } = parseRedirectUrl(redirectUrl, 'Google');
+    const { state, error } = readRedirectUrl(redirectUrl);
+    if (error) {
+      const provider = await twoStep.pending.peekProvider(state);
+      throw redirectError(error, provider === 'microsoft' ? 'Microsoft' : 'Google');
+    }
     const pending = await twoStep.pending.take(state);
     if (!pending) {
       throw new AuthFlowError(
         'No login is waiting for this redirect URL. Run the same command with --print-url first; its URL is valid for 10 minutes and works once.',
       );
     }
+    const provider = pending.provider ?? 'google';
+    if (target.provider !== undefined && target.provider !== provider) {
+      throw new AuthFlowError(
+        `This redirect URL belongs to a ${provider} login, not ${target.provider}. Nothing was saved; start again with --print-url.`,
+      );
+    }
     if (pending.command !== target.command || pending.account !== target.account) {
       const started = pending.command === 'add' ? 'auth add' : 'auth login';
       throw new AuthFlowError(
         `This redirect URL belongs to "${started}"${pending.account ? ` for ${pending.account}` : ''}; run --redirect-url with the same command and account as --print-url. Nothing was saved; start again with --print-url.`,
       );
     }
+    return pending;
+  }
+
+  private async finishGoogle(pending: PendingLogin, redirectUrl: string): Promise<LoginResult> {
     const credentials = await this.deps.loadCredentials();
-    return twoStep.finish(credentials, pending, redirectUrl);
+    return this.twoStep().finish(credentials, pending, redirectUrl);
   }
 
   /** Validates an alias for a new account; returns it normalized, or null when omitted. */
@@ -204,6 +251,7 @@ export class AuthService {
 
   async relogin(ref: string): Promise<AccountRecord> {
     const record = await this.deps.registry.resolve(ref);
+    if (isMicrosoft(record)) return this.microsoft().relogin(record);
     const credentials = await this.deps.loadCredentials();
     const outcome = { saved: false };
     await this.deps.login({
@@ -226,6 +274,18 @@ export class AuthService {
 
   async removeAccount(ref: string): Promise<AccountRecord> {
     const record = await this.deps.registry.resolve(ref);
+    if (isMicrosoft(record)) {
+      try {
+        await this.microsoft().forget(record);
+      } catch (err) {
+        this.log.warn('Failed to delete stored token; removing the account anyway', {
+          alias: record.alias,
+          error: err,
+        });
+      }
+      await this.deps.registry.remove(record.alias);
+      return record;
+    }
     const token = await this.deps.tokens.get(tokenKey(record));
     try {
       await this.deps.tokens.delete(tokenKey(record));
@@ -301,8 +361,11 @@ export class AuthService {
       data.accounts.map(async (a) => ({
         alias: a.alias,
         email: a.email,
+        provider: providerOf(a),
         isDefault: data.default === a.alias,
-        status: await this.checkStatus(a, verify),
+        status: isMicrosoft(a)
+          ? await this.microsoft().checkStatus(a, verify)
+          : await this.checkStatus(a, verify),
       })),
     );
   }
```

`src/auth/provider-auth.ts` (create):

```ts
import type { AccountRecord } from '../config/account-registry.js';
import type { PendingLogin } from './pending-login.js';

export type AccountStatus = 'ok' | 'reauth_required' | 'unknown';

/** What a non-Google sign-in provider implements; `AuthService` dispatches to it (spec §3.4). */
export interface ProviderAuth {
  add(alias?: string): Promise<AccountRecord>;
  startAdd(alias?: string): Promise<string>;
  finishAdd(pending: PendingLogin, redirectUrl: string): Promise<AccountRecord>;
  relogin(record: AccountRecord): Promise<AccountRecord>;
  startRelogin(record: AccountRecord): Promise<string>;
  finishRelogin(
    record: AccountRecord,
    pending: PendingLogin,
    redirectUrl: string,
  ): Promise<AccountRecord>;
  checkStatus(record: AccountRecord, verify: boolean): Promise<AccountStatus>;
  forget(record: AccountRecord): Promise<void>;
}
```

`src/cli/format.ts` (modify):

```diff
diff --git a/src/cli/format.ts b/src/cli/format.ts
index 2d44a90..99b68bf 100644
--- a/src/cli/format.ts
+++ b/src/cli/format.ts
@@ -4,7 +4,8 @@ export function formatAccounts(entries: AccountStatusEntry[]): string {
   if (entries.length === 0) return 'No accounts. Run: marvin-drive auth add';
   return entries
     .map(
-      (e) => `${e.isDefault ? '*' : ' '} ${e.alias.padEnd(20)} ${e.email.padEnd(36)} ${e.status}`,
+      (e) =>
+        `${e.isDefault ? '*' : ' '} ${e.alias.padEnd(20)} ${e.email.padEnd(36)} ${e.provider.padEnd(10)} ${e.status}`,
     )
     .join('\n');
 }
```

- [ ] **Step 4: Run them and watch them pass.**

Run: `npx vitest run src/auth/__tests__/auth-service.test.ts src/cli/__tests__/format.test.ts src/mcp/__tests__/server.test.ts`

Expected: PASS. Test Files  3 passed (3); Tests  41 passed (41).

- [ ] **Step 5: Format and run the whole check.**

Run: `npx prettier --write src/auth/__tests__/auth-service.test.ts src/auth/auth-service.ts src/auth/provider-auth.ts src/cli/__tests__/format.test.ts src/cli/format.ts src/mcp/__tests__/server.test.ts` then `npm run check`

Expected: exit 0, `Tests  1053 passed | 6 skipped (1059)`.

- [ ] **Step 6: Commit.**

```bash
git add src/auth/__tests__/auth-service.test.ts src/auth/auth-service.ts src/auth/provider-auth.ts src/cli/__tests__/format.test.ts src/cli/format.ts src/mcp/__tests__/server.test.ts
git commit -m "feat(auth): AuthService dispatches to a ProviderAuth for Microsoft accounts" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01UgKFZHQfQhzVqDYowSyGaA"
```


---

## Chunk 5: Microsoft sign-in

### Task 7: Microsoft sign-in

**Spec:** §3.4, §4, §3.2. Interactive and two-step PKCE logins, ID token labelling, the granted-scope check.

**Files:**
- Create: `src/auth/microsoft-auth.ts`
- Test: `src/auth/__tests__/microsoft-auth.test.ts`

- [ ] **Step 1: Write the failing tests.**

`src/auth/__tests__/microsoft-auth.test.ts` (create):

```ts
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AccountRegistry } from '../../config/account-registry.js';
import { AuthFlowError } from '../../errors.js';
import { createLogger } from '../../logger.js';
import { MICROSOFT_SCOPES, MicrosoftAuth, type MicrosoftAuthDeps } from '../microsoft-auth.js';
import { PendingLoginStore, type PendingLogin } from '../pending-login.js';
import { InMemoryTokenStore } from '../token-store.js';

const CLIENT = '11111111-2222-4333-8444-555555555555';
const idToken = (claims: Record<string, unknown>): string =>
  `h.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.sig`;
const CLAIMS = { tid: 'tid1', oid: 'oid1', email: 'Me@Example.com', preferred_username: 'x@y.z' };

let registry: AccountRegistry;
let tokens: InMemoryTokenStore;
let pending: PendingLoginStore;
let tokenBody: Record<string, unknown>;
let tokenStatus: number;
let posted: URLSearchParams[];
let printed: string[];
let openUrl: ReturnType<typeof vi.fn<MicrosoftAuthDeps['openUrl']>>;

const fakeFetch: typeof fetch = async (_url, init) => {
  posted.push(new URLSearchParams(String(init?.body)));
  return new Response(JSON.stringify(tokenBody), { status: tokenStatus });
};

function auth(extra: Partial<MicrosoftAuthDeps> = {}): MicrosoftAuth {
  return new MicrosoftAuth({
    registry,
    tokens,
    pending,
    loadClientId: async () => CLIENT,
    openUrl,
    print: (m) => printed.push(m),
    fetch: fakeFetch,
    timeoutMs: 5000,
    logger: createLogger(() => {}),
    ...extra,
  });
}

/** Plays the browser: sends the redirect to the loopback server on 127.0.0.1. */
function browser(query: (state: string) => string = (s) => `state=${s}&code=the-code`): void {
  openUrl.mockImplementation(async (url) => {
    const u = new URL(url);
    const port = new URL(u.searchParams.get('redirect_uri') ?? '').port;
    void fetch(`http://127.0.0.1:${port}/?${query(u.searchParams.get('state') ?? '')}`).catch(
      () => undefined,
    );
  });
}

beforeEach(async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ms-auth-'));
  registry = new AccountRegistry(path.join(dir, 'accounts.json'));
  tokens = new InMemoryTokenStore();
  pending = new PendingLoginStore(path.join(dir, 'pending.json'));
  tokenStatus = 200;
  tokenBody = {
    access_token: 'at',
    refresh_token: 'rt',
    id_token: idToken(CLAIMS),
    scope: 'Files.ReadWrite User.Read profile openid email',
    expires_in: 3600,
  };
  posted = [];
  printed = [];
  openUrl = vi.fn<MicrosoftAuthDeps['openUrl']>();
});

describe('MicrosoftAuth interactive login', () => {
  it('sends the PKCE parameters, scopes and prompt on the common authority', async () => {
    browser();
    await auth().add();
    const url = new URL(openUrl.mock.calls[0]?.[0] ?? '');
    expect(url.origin + url.pathname).toBe(
      'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
    );
    const q = url.searchParams;
    expect(q.get('client_id')).toBe(CLIENT);
    expect(q.get('scope')).toBe(MICROSOFT_SCOPES);
    expect(q.get('prompt')).toBe('select_account');
    expect(q.get('code_challenge_method')).toBe('S256');
    expect(q.get('redirect_uri')).toMatch(/^http:\/\/localhost:\d+$/);
    const form = posted[0];
    expect(form?.get('grant_type')).toBe('authorization_code');
    expect(form?.get('code')).toBe('the-code');
    expect(form?.get('redirect_uri')).toBe(q.get('redirect_uri'));
    const { createHash } = await import('node:crypto');
    expect(q.get('code_challenge')).toBe(
      createHash('sha256')
        .update(form?.get('code_verifier') ?? '')
        .digest('base64url'),
    );
  });

  it('stores the account under its accountId with the email claim as display address', async () => {
    browser();
    const record = await auth().add();
    expect(record).toMatchObject({
      alias: 'me',
      email: 'me@example.com',
      provider: 'microsoft',
      accountId: 'tid1.oid1',
    });
    expect(await tokens.get('microsoft:tid1.oid1')).toBe('rt');
    expect(printed.join()).not.toMatch(/Google/);
  });

  it('falls back to preferred_username when email has no @', async () => {
    tokenBody.id_token = idToken({ ...CLAIMS, email: 'nope' });
    browser();
    await expect(auth().add()).resolves.toMatchObject({ email: 'x@y.z' });
  });

  it.each([
    ['tid missing', { ...CLAIMS, tid: undefined }],
    ['oid missing', { ...CLAIMS, oid: undefined }],
    ['no address', { ...CLAIMS, email: 'a', preferred_username: 'b' }],
  ])('stores nothing when the token lacks identity: %s', async (_name, claims) => {
    tokenBody.id_token = idToken(claims);
    browser();
    await expect(auth().add()).rejects.toThrow(AuthFlowError);
    expect((await registry.read()).accounts).toEqual([]);
  });

  it('fails when the granted scope lacks Files.ReadWrite', async () => {
    tokenBody.scope = 'User.Read openid';
    browser();
    await expect(auth().add()).rejects.toThrow(/OneDrive access was not granted/);
    expect((await registry.read()).accounts).toEqual([]);
  });

  it('asks for --alias when the generated alias is taken', async () => {
    await registry.add({ alias: 'me', email: 'other@example.com' });
    browser();
    await expect(auth().add()).rejects.toThrow(/--alias/);
    expect(await tokens.get('microsoft:tid1.oid1')).toBeNull();
  });

  it('surfaces an access_denied redirect', async () => {
    browser((s) => `state=${s}&error=access_denied`);
    await expect(auth().add()).rejects.toThrow('Access was denied in the browser');
  });

  it('accepts a pasted redirect URL in no-browser mode', async () => {
    const readLine = vi.fn(async () => {
      const url = new URL(/https:\S+/.exec(printed[0] ?? '')?.[0] ?? '');
      return `http://localhost:1/?state=${url.searchParams.get('state') ?? ''}&code=pasted`;
    });
    await auth({ manual: { readLine } }).add('m');
    expect(posted[0]?.get('code')).toBe('pasted');
    expect(openUrl).not.toHaveBeenCalled();
  });
});

describe('MicrosoftAuth relogin', () => {
  it('compares accountId, not the address', async () => {
    const record = await registry.add({
      alias: 'w',
      email: 'old@example.com',
      provider: 'microsoft',
      accountId: 'tid1.oid1',
    });
    browser();
    await auth().relogin(record);
    expect(await tokens.get('microsoft:tid1.oid1')).toBe('rt');

    const other = await registry.add({
      alias: 'w2',
      email: 'me@example.com',
      provider: 'microsoft',
      accountId: 'tid2.oid2',
    });
    await expect(auth().relogin(other)).rejects.toThrow(/different account/);
    expect(await tokens.get('microsoft:tid2.oid2')).toBeNull();
  });
});

describe('MicrosoftAuth two-step login', () => {
  const take = async (url: string): Promise<PendingLogin> => {
    const state = new URL(url).searchParams.get('state') ?? '';
    const entry = await pending.take(state);
    if (!entry) throw new Error('no entry');
    return entry;
  };

  it('saves a pending entry for the provider and finishes with it', async () => {
    const a = auth();
    const url = await a.startAdd('my-alias');
    const entry = await take(url);
    expect(entry).toMatchObject({ command: 'add', account: 'my-alias', provider: 'microsoft' });
    expect(entry.redirectUri).toMatch(/^http:\/\/localhost:\d+$/);
    const record = await a.finishAdd(entry, `${entry.redirectUri}/?state=${entry.state}&code=c2`);
    expect(record.alias).toBe('my-alias');
    expect(posted[0]?.get('code_verifier')).toBe(entry.codeVerifier);
  });

  it('keeps the accountId as the relogin target', async () => {
    const record = await registry.add({
      alias: 'w',
      email: 'a@b.c',
      provider: 'microsoft',
      accountId: 'tid1.oid1',
    });
    const a = auth();
    const entry = await take(await a.startRelogin(record));
    expect(entry).toMatchObject({ command: 'login', account: 'tid1.oid1' });
    await a.finishRelogin(record, entry, `http://localhost/?state=${entry.state}&code=c3`);
    expect(await tokens.get('microsoft:tid1.oid1')).toBe('rt');
  });

  it('reports a refused sign-in without the response body', async () => {
    tokenStatus = 400;
    tokenBody = { error: 'invalid_request', error_description: 'secret detail' };
    const a = auth();
    const entry = await take(await a.startAdd());
    await expect(
      a.finishAdd(entry, `http://localhost/?state=${entry.state}&code=c`),
    ).rejects.toThrow('Microsoft refused the sign-in (invalid_request).');
  });
});

describe('MicrosoftAuth.forget', () => {
  it('deletes only this account token', async () => {
    const record = await registry.add({
      alias: 'w',
      email: 'same@example.com',
      provider: 'microsoft',
      accountId: 't.o',
    });
    await tokens.set('same@example.com', 'google-token');
    await tokens.set('microsoft:t.o', 'ms-token');
    await auth().forget(record);
    expect(await tokens.get('same@example.com')).toBe('google-token');
    expect(await tokens.get('microsoft:t.o')).toBeNull();
  });
});
```

- [ ] **Step 2: Run them and watch them fail.**

Run: `npx vitest run src/auth/__tests__/microsoft-auth.test.ts`

Expected: FAIL. Test Files  1 failed (1); Tests  no tests. First error: Failed to load `../microsoft-auth.js` (the module does not exist yet).

- [ ] **Step 3: Implement.**

`src/auth/microsoft-auth.ts` (create):

```ts
import { createHash, randomBytes, randomInt } from 'node:crypto';
import { createServer } from 'node:http';
import {
  defaultAlias,
  tokenKey,
  type AccountRecord,
  type AccountRegistry,
} from '../config/account-registry.js';
import { AppError, AuthFlowError } from '../errors.js';
import { logger as defaultLogger, type Logger } from '../logger.js';
import {
  listenLocalhost,
  parseRedirectUrl,
  waitForCallback,
  waitForPaste,
  withDeadline,
  type Callback,
  type ManualLogin,
} from './loopback.js';
import type { PendingLogin, PendingLoginStore } from './pending-login.js';
import type { AccountStatus, ProviderAuth } from './provider-auth.js';
import type { TokenStore } from './token-store.js';

const AUTHORITY = 'https://login.microsoftonline.com/common/oauth2/v2.0';
export const MICROSOFT_SCOPES = 'Files.ReadWrite offline_access User.Read openid profile email';
const LABEL = 'Microsoft';
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MANUAL_TIMEOUT_MS = 600_000;
const DEFAULT_FINISH_TIMEOUT_MS = 60_000;

export interface MicrosoftAuthDeps {
  registry: AccountRegistry;
  tokens: TokenStore;
  pending: PendingLoginStore;
  loadClientId: () => Promise<string>;
  openUrl: (url: string) => Promise<void>;
  print: (message: string) => void;
  manual?: ManualLogin;
  fetch?: typeof fetch;
  timeoutMs?: number;
  finishTimeoutMs?: number;
  logger?: Logger;
}

interface MicrosoftLogin {
  accountId: string;
  email: string;
  refreshToken: string;
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  id_token?: string;
  scope?: string;
  expires_in?: number;
  error?: string;
}

function pkce(): { codeVerifier: string; codeChallenge: string } {
  const codeVerifier = randomBytes(32).toString('base64url');
  return {
    codeVerifier,
    codeChallenge: createHash('sha256').update(codeVerifier).digest('base64url'),
  };
}

function authorizeUrl(params: {
  clientId: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
}): string {
  const query = new URLSearchParams({
    client_id: params.clientId,
    response_type: 'code',
    redirect_uri: params.redirectUri,
    response_mode: 'query',
    scope: MICROSOFT_SCOPES,
    state: params.state,
    code_challenge: params.codeChallenge,
    code_challenge_method: 'S256',
    prompt: 'select_account',
  });
  return `${AUTHORITY}/authorize?${query.toString()}`;
}

interface IdClaims {
  tid?: unknown;
  oid?: unknown;
  email?: unknown;
  preferred_username?: unknown;
}

/**
 * Reads the ID token's claims without verifying its signature: it comes straight from the token
 * endpoint over TLS, in the exchange that presented the PKCE verifier (OIDC Core §3.1.3.7), and
 * only labels the account.
 */
function readClaims(idToken: string | undefined): IdClaims {
  const payload = idToken?.split('.')[1];
  if (!payload) throw new AuthFlowError('Microsoft did not return an ID token.');
  try {
    return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as IdClaims;
  } catch (err) {
    throw new AuthFlowError('Microsoft returned an unreadable ID token.', { cause: err });
  }
}

function addressOf(claims: IdClaims): string | undefined {
  return [claims.email, claims.preferred_username].find(
    (v): v is string => typeof v === 'string' && v.includes('@'),
  );
}

function hasFilesScope(scope: string | undefined): boolean {
  return (scope ?? '')
    .split(' ')
    .some((s) => s.toLowerCase().replace(/^.*\//, '') === 'files.readwrite');
}

export class MicrosoftAuth implements ProviderAuth {
  private readonly log: Logger;
  private readonly post: typeof fetch;

  constructor(private readonly deps: MicrosoftAuthDeps) {
    this.log = deps.logger ?? defaultLogger;
    this.post = deps.fetch ?? fetch;
  }

  async add(alias?: string): Promise<AccountRecord> {
    const outcome: { saved?: AccountRecord } = {};
    await this.interactiveLogin(async (login) => {
      outcome.saved = await this.saveNew(alias, login);
    });
    if (!outcome.saved) throw new AuthFlowError('Login finished without saving the account');
    return outcome.saved;
  }

  startAdd(alias?: string): Promise<string> {
    return this.startTwoStep('add', alias ?? null);
  }

  async finishAdd(pending: PendingLogin, redirectUrl: string): Promise<AccountRecord> {
    return this.saveNew(
      pending.account ?? undefined,
      await this.finishTwoStep(pending, redirectUrl),
    );
  }

  async relogin(record: AccountRecord): Promise<AccountRecord> {
    let saved = false;
    await this.interactiveLogin(async (login) => {
      await this.saveRelogin(record, login);
      saved = true;
    });
    if (!saved) throw new AuthFlowError('Login finished without saving the account');
    return record;
  }

  startRelogin(record: AccountRecord): Promise<string> {
    return this.startTwoStep('login', record.accountId ?? '');
  }

  async finishRelogin(
    record: AccountRecord,
    pending: PendingLogin,
    redirectUrl: string,
  ): Promise<AccountRecord> {
    await this.saveRelogin(record, await this.finishTwoStep(pending, redirectUrl));
    return record;
  }

  async checkStatus(record: AccountRecord, _verify: boolean): Promise<AccountStatus> {
    return (await this.deps.tokens.get(tokenKey(record))) ? 'ok' : 'reauth_required';
  }

  async forget(record: AccountRecord): Promise<void> {
    await this.deps.tokens.delete(tokenKey(record));
  }

  private async saveNew(alias: string | undefined, login: MicrosoftLogin): Promise<AccountRecord> {
    const record = await this.deps.registry.add({
      alias: alias ?? defaultAlias(login.email),
      email: login.email,
      provider: 'microsoft',
      accountId: login.accountId,
    });
    try {
      await this.deps.tokens.set(tokenKey(record), login.refreshToken);
    } catch (err) {
      await this.deps.registry.remove(record.alias);
      throw err;
    }
    return record;
  }

  private async saveRelogin(record: AccountRecord, login: MicrosoftLogin): Promise<void> {
    if (login.accountId !== record.accountId) {
      throw new AuthFlowError(
        `Signed in as ${login.email}, a different account from "${record.alias}" (${record.email}). Nothing was saved.`,
      );
    }
    await this.deps.tokens.set(tokenKey(record), login.refreshToken);
  }

  private async startTwoStep(command: 'add' | 'login', account: string | null): Promise<string> {
    const clientId = await this.deps.loadClientId();
    const state = randomBytes(16).toString('hex');
    const { codeVerifier, codeChallenge } = pkce();
    const redirectUri = `http://localhost:${49152 + randomInt(65535 - 49152)}`;
    await this.deps.pending.save({
      state,
      codeVerifier,
      redirectUri,
      command,
      account,
      provider: 'microsoft',
    });
    return authorizeUrl({ clientId, redirectUri, state, codeChallenge });
  }

  private async finishTwoStep(pending: PendingLogin, redirectUrl: string): Promise<MicrosoftLogin> {
    const { code } = parseRedirectUrl(redirectUrl, LABEL);
    if (!code) throw new AuthFlowError('That redirect URL has no authorization code.');
    return withDeadline(
      this.exchange(
        code,
        pending.codeVerifier,
        pending.redirectUri,
        await this.deps.loadClientId(),
      ),
      this.deps.finishTimeoutMs ?? DEFAULT_FINISH_TIMEOUT_MS,
      LABEL,
    );
  }

  /** Browser login on a loopback port; `onVerified` saves before the browser is answered. */
  private async interactiveLogin(
    onVerified: (login: MicrosoftLogin) => Promise<void>,
  ): Promise<void> {
    const clientId = await this.deps.loadClientId();
    const state = randomBytes(16).toString('hex');
    const { codeVerifier, codeChallenge } = pkce();
    const server = createServer();
    const listener = await listenLocalhost(server);
    const pasteAbort = new AbortController();
    try {
      const redirectUri = `http://localhost:${listener.port}`;
      const { manual, print } = this.deps;
      const timeoutMs =
        this.deps.timeoutMs ?? (manual ? DEFAULT_MANUAL_TIMEOUT_MS : DEFAULT_TIMEOUT_MS);
      const callback = waitForCallback(server, state, timeoutMs, LABEL);
      callback.catch(() => undefined); // awaited below; prevents an unhandled rejection
      const authUrl = authorizeUrl({ clientId, redirectUri, state, codeChallenge });
      let incoming: Promise<Callback> = callback;
      if (manual) {
        print(
          `Open this URL in a browser on any device and sign in:\n${authUrl}\n\n` +
            `Microsoft then redirects to ${redirectUri}/?…, which usually fails to load on that device — ` +
            'that is expected. Copy the full URL from the address bar and paste it here.',
        );
        const pasted = waitForPaste(manual, state, print, pasteAbort.signal, LABEL);
        pasted.catch(() => undefined); // awaited via the race below
        incoming = Promise.race([callback, pasted]);
      } else {
        print(`Opening the browser for Microsoft sign-in. If it does not open, visit:\n${authUrl}`);
        this.deps.openUrl(authUrl).catch(() => {
          print('Could not open a browser automatically; use the URL above.');
        });
      }
      const { code, respond } = await incoming;
      pasteAbort.abort();
      try {
        const login = await withDeadline(
          this.exchange(code, codeVerifier, redirectUri, clientId),
          this.deps.finishTimeoutMs ?? DEFAULT_FINISH_TIMEOUT_MS,
          LABEL,
        );
        await onVerified(login);
        await respond(200, { kind: 'success', email: login.email });
      } catch (err) {
        const message =
          err instanceof AppError ? err.message : 'Unexpected error; see the terminal for details.';
        await respond(400, { kind: 'failure', message });
        throw err;
      }
    } finally {
      pasteAbort.abort();
      await listener.close();
    }
  }

  private async tokenRequest(form: Record<string, string>): Promise<{
    status: number;
    body: TokenResponse;
  }> {
    let res: Response;
    try {
      res = await this.post(`${AUTHORITY}/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(form).toString(),
      });
    } catch (err) {
      this.log.warn('Microsoft token endpoint unreachable', { error: err });
      throw new AuthFlowError(
        'Could not reach Microsoft sign-in. Check your connection and try again.',
      );
    }
    let body: TokenResponse = {};
    try {
      body = (await res.json()) as TokenResponse;
    } catch {
      // A non-JSON answer is handled by the status and the missing fields.
    }
    return { status: res.status, body };
  }

  private async exchange(
    code: string,
    codeVerifier: string,
    redirectUri: string,
    clientId: string,
  ): Promise<MicrosoftLogin> {
    const { status, body } = await this.tokenRequest({
      client_id: clientId,
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      code_verifier: codeVerifier,
      scope: MICROSOFT_SCOPES,
    });
    if (status !== 200) {
      throw new AuthFlowError(`Microsoft refused the sign-in (${body.error ?? status}).`);
    }
    if (!hasFilesScope(body.scope)) {
      throw new AuthFlowError(
        'OneDrive access was not granted. Run the login again and accept the "Have full access to your files" permission on the consent screen.',
      );
    }
    const claims = readClaims(body.id_token);
    const email = addressOf(claims);
    if (typeof claims.tid !== 'string' || typeof claims.oid !== 'string' || !email) {
      throw new AuthFlowError(
        'Microsoft did not identify the account (tenant, object ID or address is missing). Nothing was saved.',
      );
    }
    if (!body.refresh_token) {
      throw new AuthFlowError('Microsoft did not return a refresh token. Run the login again.');
    }
    return {
      accountId: `${claims.tid}.${claims.oid}`,
      email: email.toLowerCase(),
      refreshToken: body.refresh_token,
    };
  }
}
```

- [ ] **Step 4: Run them and watch them pass.**

Run: `npx vitest run src/auth/__tests__/microsoft-auth.test.ts`

Expected: PASS. Test Files  1 passed (1); Tests  15 passed (15).

- [ ] **Step 5: Format and run the whole check.**

Run: `npx prettier --write src/auth/__tests__/microsoft-auth.test.ts src/auth/microsoft-auth.ts` then `npm run check`

Expected: exit 0, `Tests  1068 passed | 6 skipped (1074)`.

- [ ] **Step 6: Commit.**

```bash
git add src/auth/__tests__/microsoft-auth.test.ts src/auth/microsoft-auth.ts
git commit -m "feat(auth): Microsoft PKCE sign-in with loopback and two-step logins" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01UgKFZHQfQhzVqDYowSyGaA"
```


---

## Chunk 6: Microsoft access tokens

### Task 8: Microsoft access tokens

**Spec:** §3.4, §4. Refresh rotation, single flight, the 60 s cache margin, the re-read on `invalid_grant`, and the class-owned reauth mark.

**Files:**
- Modify: `src/auth/microsoft-auth.ts`
- Test: `src/auth/__tests__/microsoft-auth.test.ts`

- [ ] **Step 1: Write the failing tests.**

`src/auth/__tests__/microsoft-auth.test.ts` (modify):

```diff
diff --git a/src/auth/__tests__/microsoft-auth.test.ts b/src/auth/__tests__/microsoft-auth.test.ts
index fa58c9a..c227951 100644
--- a/src/auth/__tests__/microsoft-auth.test.ts
+++ b/src/auth/__tests__/microsoft-auth.test.ts
@@ -3,7 +3,7 @@ import os from 'node:os';
 import path from 'node:path';
 import { beforeEach, describe, expect, it, vi } from 'vitest';
 import { AccountRegistry } from '../../config/account-registry.js';
-import { AuthFlowError } from '../../errors.js';
+import { AuthFlowError, ReauthRequiredError } from '../../errors.js';
 import { createLogger } from '../../logger.js';
 import { MICROSOFT_SCOPES, MicrosoftAuth, type MicrosoftAuthDeps } from '../microsoft-auth.js';
 import { PendingLoginStore, type PendingLogin } from '../pending-login.js';
@@ -240,3 +240,128 @@ describe('MicrosoftAuth.forget', () => {
     expect(await tokens.get('microsoft:t.o')).toBeNull();
   });
 });
+
+describe('MicrosoftAuth access tokens', () => {
+  const RECORD = {
+    alias: 'w',
+    email: 'a@b.c',
+    addedAt: 'now',
+    provider: 'microsoft',
+    accountId: 't.o',
+  } as const;
+  const KEY = 'microsoft:t.o';
+  let clock: number;
+  const timed = (): MicrosoftAuth => auth({ now: () => clock });
+
+  beforeEach(async () => {
+    clock = 1_000_000;
+    await tokens.set(KEY, 'rt-old');
+    tokenBody = { access_token: 'at1', refresh_token: 'rt-new', expires_in: 3600 };
+  });
+
+  it('replaces the stored refresh token on every response and asks for the same scopes', async () => {
+    await expect(timed().accessToken(RECORD)).resolves.toBe('at1');
+    expect(posted[0]?.get('grant_type')).toBe('refresh_token');
+    expect(posted[0]?.get('refresh_token')).toBe('rt-old');
+    expect(posted[0]?.get('scope')).toBe(MICROSOFT_SCOPES);
+    expect(await tokens.get(KEY)).toBe('rt-new');
+  });
+
+  it('caches until 60 s before expiry', async () => {
+    const a = timed();
+    await a.accessToken(RECORD);
+    clock += 3539_000;
+    await a.accessToken(RECORD);
+    expect(posted).toHaveLength(1);
+    clock += 2_000;
+    await a.accessToken(RECORD);
+    expect(posted).toHaveLength(2);
+  });
+
+  it('forceRefresh bypasses the cache', async () => {
+    const a = timed();
+    await a.accessToken(RECORD);
+    await a.accessToken(RECORD, { forceRefresh: true });
+    expect(posted).toHaveLength(2);
+  });
+
+  it('is single-flight per account', async () => {
+    const a = timed();
+    const [one, two] = await Promise.all([a.accessToken(RECORD), a.accessToken(RECORD)]);
+    expect([one, two]).toEqual(['at1', 'at1']);
+    expect(posted).toHaveLength(1);
+  });
+
+  it('re-reads the store once when another session rotated the token', async () => {
+    let calls = 0;
+    const a = auth({
+      now: () => clock,
+      fetch: async (_u, init) => {
+        calls++;
+        const form = new URLSearchParams(String(init?.body));
+        if (form.get('refresh_token') === 'rt-old') {
+          await tokens.set(KEY, 'rt-other-session');
+          return new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 });
+        }
+        return new Response(JSON.stringify({ access_token: 'at2', expires_in: 100 }));
+      },
+    });
+    await expect(a.accessToken(RECORD)).resolves.toBe('at2');
+    expect(calls).toBe(2);
+  });
+
+  it.each(['invalid_grant', 'interaction_required'])(
+    '%s without a newer token means reauth, tracked by this class',
+    async (error) => {
+      tokenStatus = 400;
+      tokenBody = { error };
+      const a = timed();
+      await expect(a.accessToken(RECORD)).rejects.toThrow(ReauthRequiredError);
+      await expect(a.checkStatus(RECORD, false)).resolves.toBe('reauth_required');
+      expect(posted).toHaveLength(1);
+    },
+  );
+
+  it('a successful refresh clears the reauth mark', async () => {
+    tokenStatus = 400;
+    tokenBody = { error: 'invalid_grant' };
+    const a = timed();
+    await expect(a.accessToken(RECORD)).rejects.toThrow(ReauthRequiredError);
+    tokenStatus = 200;
+    tokenBody = { access_token: 'at3', refresh_token: 'rt-3', expires_in: 3600 };
+    await a.accessToken(RECORD);
+    await expect(a.checkStatus(RECORD, false)).resolves.toBe('ok');
+  });
+
+  it('a missing stored token means reauth', async () => {
+    await tokens.delete(KEY);
+    await expect(timed().accessToken(RECORD)).rejects.toThrow(ReauthRequiredError);
+    await expect(timed().checkStatus(RECORD, false)).resolves.toBe('reauth_required');
+  });
+
+  it('a server failure is not a reauth', async () => {
+    tokenStatus = 503;
+    tokenBody = {};
+    const a = timed();
+    await expect(a.accessToken(RECORD)).rejects.toThrow(AuthFlowError);
+    await expect(a.checkStatus(RECORD, true)).resolves.toBe('unknown');
+  });
+
+  it('verify does a live refresh', async () => {
+    const a = timed();
+    await expect(a.checkStatus(RECORD, true)).resolves.toBe('ok');
+    expect(posted).toHaveLength(1);
+    tokenStatus = 400;
+    tokenBody = { error: 'invalid_grant' };
+    await expect(a.checkStatus(RECORD, true)).resolves.toBe('reauth_required');
+  });
+
+  it('keeps working when the rotated token cannot be saved', async () => {
+    const failing = new InMemoryTokenStore();
+    await failing.set(KEY, 'rt-old');
+    failing.set = async () => {
+      throw new Error('keychain');
+    };
+    await expect(auth({ tokens: failing }).accessToken(RECORD)).resolves.toBe('at1');
+  });
+});
```

- [ ] **Step 2: Run them and watch them fail.**

Run: `npx vitest run src/auth/__tests__/microsoft-auth.test.ts`

Expected: FAIL. Test Files  1 failed (1); Tests  12 failed | 15 passed (27). First error: `TypeError: timed(...).accessToken is not a function`.

- [ ] **Step 3: Implement.**

`src/auth/microsoft-auth.ts` (modify):

```diff
diff --git a/src/auth/microsoft-auth.ts b/src/auth/microsoft-auth.ts
index d46df05..c48e11d 100644
--- a/src/auth/microsoft-auth.ts
+++ b/src/auth/microsoft-auth.ts
@@ -6,7 +6,7 @@ import {
   type AccountRecord,
   type AccountRegistry,
 } from '../config/account-registry.js';
-import { AppError, AuthFlowError } from '../errors.js';
+import { AppError, AuthFlowError, ReauthRequiredError } from '../errors.js';
 import { logger as defaultLogger, type Logger } from '../logger.js';
 import {
   listenLocalhost,
@@ -27,6 +27,8 @@ const LABEL = 'Microsoft';
 const DEFAULT_TIMEOUT_MS = 120_000;
 const DEFAULT_MANUAL_TIMEOUT_MS = 600_000;
 const DEFAULT_FINISH_TIMEOUT_MS = 60_000;
+const EXPIRY_MARGIN_MS = 60_000;
+const DEFAULT_EXPIRES_IN_S = 3600;
 
 export interface MicrosoftAuthDeps {
   registry: AccountRegistry;
@@ -39,6 +41,7 @@ export interface MicrosoftAuthDeps {
   fetch?: typeof fetch;
   timeoutMs?: number;
   finishTimeoutMs?: number;
+  now?: () => number;
   logger?: Logger;
 }
 
@@ -119,13 +122,88 @@ function hasFilesScope(scope: string | undefined): boolean {
     .some((s) => s.toLowerCase().replace(/^.*\//, '') === 'files.readwrite');
 }
 
+function isRejected(body: TokenResponse): boolean {
+  return body.error === 'invalid_grant' || body.error === 'interaction_required';
+}
+
 export class MicrosoftAuth implements ProviderAuth {
   private readonly log: Logger;
   private readonly post: typeof fetch;
+  private readonly now: () => number;
+  private readonly cache = new Map<string, { token: string; expiresAt: number }>();
+  private readonly inFlight = new Map<string, Promise<string>>();
+  private readonly reauthNeeded = new Set<string>();
 
   constructor(private readonly deps: MicrosoftAuthDeps) {
     this.log = deps.logger ?? defaultLogger;
     this.post = deps.fetch ?? fetch;
+    this.now = deps.now ?? Date.now;
+  }
+
+  /** The only method `GraphClient` uses. Refresh is single-flight per account. */
+  accessToken(record: AccountRecord, options: { forceRefresh?: boolean } = {}): Promise<string> {
+    const key = tokenKey(record);
+    if (!options.forceRefresh) {
+      const cached = this.cache.get(key);
+      if (cached && cached.expiresAt - this.now() > EXPIRY_MARGIN_MS) {
+        return Promise.resolve(cached.token);
+      }
+    }
+    const running = this.inFlight.get(key);
+    if (running) return running;
+    const started = this.refresh(record, key).finally(() => this.inFlight.delete(key));
+    this.inFlight.set(key, started);
+    return started;
+  }
+
+  private async refresh(record: AccountRecord, key: string): Promise<string> {
+    const stored = await this.deps.tokens.get(key);
+    if (!stored) throw this.reauthRequired(record, key);
+    let { status, body } = await this.refreshRequest(stored);
+    if (isRejected(body)) {
+      // Another session may have rotated the token.
+      const latest = await this.deps.tokens.get(key);
+      if (latest && latest !== stored) ({ status, body } = await this.refreshRequest(latest));
+      if (isRejected(body)) throw this.reauthRequired(record, key);
+    }
+    if (status !== 200 || !body.access_token) {
+      throw new AuthFlowError(`Microsoft token refresh failed (${body.error ?? status}).`);
+    }
+    if (body.refresh_token) {
+      await this.deps.tokens.set(key, body.refresh_token).catch((err: unknown) => {
+        this.log.warn('Failed to persist rotated refresh token', {
+          alias: record.alias,
+          error: err,
+        });
+      });
+    }
+    const expiresIn = body.expires_in ?? DEFAULT_EXPIRES_IN_S;
+    this.cache.set(key, { token: body.access_token, expiresAt: this.now() + expiresIn * 1000 });
+    this.reauthNeeded.delete(key);
+    return body.access_token;
+  }
+
+  private async refreshRequest(refreshToken: string): Promise<{
+    status: number;
+    body: TokenResponse;
+  }> {
+    return this.tokenRequest({
+      client_id: await this.deps.loadClientId(),
+      grant_type: 'refresh_token',
+      refresh_token: refreshToken,
+      scope: MICROSOFT_SCOPES,
+    });
+  }
+
+  private reauthRequired(record: AccountRecord, key: string): ReauthRequiredError {
+    this.reauthNeeded.add(key);
+    this.cache.delete(key);
+    return new ReauthRequiredError(record.alias);
+  }
+
+  private clearLocal(key: string): void {
+    this.cache.delete(key);
+    this.reauthNeeded.delete(key);
   }
 
   async add(alias?: string): Promise<AccountRecord> {
@@ -171,12 +249,25 @@ export class MicrosoftAuth implements ProviderAuth {
     return record;
   }
 
-  async checkStatus(record: AccountRecord, _verify: boolean): Promise<AccountStatus> {
-    return (await this.deps.tokens.get(tokenKey(record))) ? 'ok' : 'reauth_required';
+  async checkStatus(record: AccountRecord, verify: boolean): Promise<AccountStatus> {
+    const key = tokenKey(record);
+    if (!(await this.deps.tokens.get(key))) return 'reauth_required';
+    if (!verify) return this.reauthNeeded.has(key) ? 'reauth_required' : 'ok';
+    try {
+      await this.accessToken(record, { forceRefresh: true });
+      return 'ok';
+    } catch (err) {
+      if (err instanceof ReauthRequiredError) return 'reauth_required';
+      this.log.warn('Token check failed', { alias: record.alias, error: err });
+      return 'unknown';
+    }
   }
 
+  /** Deletes this account's token only: this client type has no per-token revoke endpoint. */
   async forget(record: AccountRecord): Promise<void> {
-    await this.deps.tokens.delete(tokenKey(record));
+    const key = tokenKey(record);
+    await this.deps.tokens.delete(key);
+    this.clearLocal(key);
   }
 
   private async saveNew(alias: string | undefined, login: MicrosoftLogin): Promise<AccountRecord> {
@@ -192,6 +283,7 @@ export class MicrosoftAuth implements ProviderAuth {
       await this.deps.registry.remove(record.alias);
       throw err;
     }
+    this.clearLocal(tokenKey(record));
     return record;
   }
 
@@ -202,6 +294,7 @@ export class MicrosoftAuth implements ProviderAuth {
       );
     }
     await this.deps.tokens.set(tokenKey(record), login.refreshToken);
+    this.clearLocal(tokenKey(record));
   }
 
   private async startTwoStep(command: 'add' | 'login', account: string | null): Promise<string> {
```

- [ ] **Step 4: Run them and watch them pass.**

Run: `npx vitest run src/auth/__tests__/microsoft-auth.test.ts`

Expected: PASS. Test Files  1 passed (1); Tests  27 passed (27).

- [ ] **Step 5: Format and run the whole check.**

Run: `npx prettier --write src/auth/__tests__/microsoft-auth.test.ts src/auth/microsoft-auth.ts` then `npm run check`

Expected: exit 0, `Tests  1080 passed | 6 skipped (1086)`.

- [ ] **Step 6: Commit.**

```bash
git add src/auth/__tests__/microsoft-auth.test.ts src/auth/microsoft-auth.ts
git commit -m "feat(auth): Microsoft access tokens, refresh rotation and reauth tracking" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01UgKFZHQfQhzVqDYowSyGaA"
```


---

## Chunk 7: Graph retry, errors and client core

### Task 9: Graph retry rules, error mapping and the provider boundary

**Spec:** §7.2, §3. Pure units first, plus the boundary test. `withRetry` is not reused: it ignores `Retry-After` and retries 507.

**Files:**
- Create: `src/onedrive/graph-errors.ts`, `src/onedrive/graph-retry.ts`
- Test: `src/onedrive/__tests__/graph-errors.test.ts`, `src/onedrive/__tests__/graph-retry.test.ts`, `src/onedrive/__tests__/no-googleapis.test.ts`

- [ ] **Step 1: Write the failing tests.**

`src/onedrive/__tests__/graph-errors.test.ts` (create):

```ts
import { describe, expect, it, vi } from 'vitest';
import {
  FileLockedError,
  GraphApiError,
  GraphThrottledError,
  NameConflictError,
  NotFoundError,
  OneDriveFullError,
  PermissionDeniedError,
  TargetChangedError,
  ValidationError,
} from '../../errors.js';
import { createLogger } from '../../logger.js';
import { mapGraphError, sanitizeForLog } from '../graph-errors.js';

const body = (code: string, message = 'msg'): string =>
  JSON.stringify({ error: { code, message } });
const ctx = { alias: 'work', target: 'a.txt', log: createLogger(() => {}) };

describe('mapGraphError', () => {
  it.each([
    [403, body('accessDenied'), PermissionDeniedError],
    [404, body('itemNotFound'), NotFoundError],
    [409, body('nameAlreadyExists'), NameConflictError],
    [412, body('resourceModified'), TargetChangedError],
    [423, body('resourceLocked'), FileLockedError],
    [429, body('activityLimitReached'), GraphThrottledError],
    [503, 'not json', GraphThrottledError],
    [507, body('quotaLimitReached'), OneDriveFullError],
    [400, body('invalidRequest', 'The name contains invalid characters'), ValidationError],
    [400, body('invalidRequest', 'Bad cursor'), GraphApiError],
    [500, body('generalException'), GraphApiError],
    [403, body('notAllowed'), GraphApiError],
  ])('maps %i %s', (status, text, type) => {
    expect(mapGraphError(status, text, ctx)).toBeInstanceOf(type);
  });

  it('names the account in a permission error', () => {
    expect(mapGraphError(403, body('accessDenied'), ctx).message).toContain('"work"');
  });

  it('returns Graph message for an invalid name, but never for other errors', () => {
    const text = body('invalidRequest', 'The name is bad');
    expect(mapGraphError(400, text, ctx).message).toBe('The name is bad');
    expect(mapGraphError(500, body('x', 'internal detail'), ctx).message).not.toContain('internal');
  });

  it('logs the body of a generic error without URLs', () => {
    const warn = vi.fn();
    const log = { ...createLogger(() => {}), warn };
    mapGraphError(500, body('x', 'see https://upload.example/secret?t=1'), { ...ctx, log });
    expect(JSON.stringify(warn.mock.calls)).not.toContain('secret');
  });

  it('caps what it logs', () => {
    expect(sanitizeForLog('x'.repeat(5000))).toHaveLength(2000);
  });
});
```

`src/onedrive/__tests__/graph-retry.test.ts` (create):

```ts
import { describe, expect, it } from 'vitest';
import { MAX_RETRY_AFTER_MS, decideRetry, retryAfterMs } from '../graph-retry.js';

const base = { random: () => 0, baseDelayMs: 100, now: () => 1_000_000 };

describe('retryAfterMs', () => {
  it('reads seconds and HTTP dates, and caps them', () => {
    expect(retryAfterMs('7', 0)).toBe(7000);
    expect(retryAfterMs('600', 0)).toBe(MAX_RETRY_AFTER_MS);
    expect(retryAfterMs(new Date(5000).toUTCString(), 0)).toBe(5000);
  });
  it('is undefined when absent or invalid', () => {
    expect(retryAfterMs(null, 0)).toBeUndefined();
    expect(retryAfterMs('soon', 0)).toBeUndefined();
  });
});

describe('decideRetry', () => {
  it.each([
    [429, 'create', true],
    [429, 'idempotent', true],
    [503, 'idempotent', true],
    [503, 'create', false],
    [500, 'idempotent', true],
    [502, 'create', false],
    [507, 'idempotent', false],
    [404, 'idempotent', false],
    [undefined, 'idempotent', true],
    [undefined, 'create', false],
  ] as const)('status %s, class %s: retry %s', (status, retryClass, retry) => {
    expect(decideRetry({ ...base, status, retryClass, attempt: 0 }).retry).toBe(retry);
  });

  it('stops after three retries', () => {
    expect(decideRetry({ ...base, status: 429, retryClass: 'create', attempt: 2 }).retry).toBe(
      true,
    );
    expect(decideRetry({ ...base, status: 429, retryClass: 'create', attempt: 3 }).retry).toBe(
      false,
    );
  });

  it('honours Retry-After for 429 and idempotent 503', () => {
    const at = (status: number) =>
      decideRetry({ ...base, status, retryClass: 'idempotent', attempt: 0, retryAfter: '9' });
    expect(at(429).delayMs).toBe(9000);
    expect(at(503).delayMs).toBe(9000);
  });

  it('uses exponential backoff otherwise', () => {
    const at = (attempt: number) =>
      decideRetry({ ...base, status: 500, retryClass: 'idempotent', attempt, retryAfter: '9' });
    expect(at(0).delayMs).toBe(100);
    expect(at(2).delayMs).toBe(400);
  });

  it('accepts a custom retry limit', () => {
    const input = { ...base, status: 500, retryClass: 'idempotent', maxRetries: 5 } as const;
    expect(decideRetry({ ...input, attempt: 4 }).retry).toBe(true);
    expect(decideRetry({ ...input, attempt: 5 }).retry).toBe(false);
  });
});
```

`src/onedrive/__tests__/no-googleapis.test.ts` (create):

```ts
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { runtimeGoogleapisImports } from '../../__tests__/googleapis-imports.js';

const SRC = fileURLToPath(new URL('../..', import.meta.url));

describe('OneDrive provider boundary (spec §3)', () => {
  it('no runtime googleapis under src/onedrive, in microsoft-auth or in loopback', async () => {
    const onedrive = (await readdir(path.join(SRC, 'onedrive'), { recursive: true }))
      .filter((f) => f.endsWith('.ts'))
      .map((f) => path.join('onedrive', f));
    const files = [...onedrive, 'auth/microsoft-auth.ts', 'auth/loopback.ts'];
    expect(files.length).toBeGreaterThan(2);
    const offenders: string[] = [];
    for (const f of files) {
      const hits = runtimeGoogleapisImports(await readFile(path.join(SRC, f), 'utf8'));
      if (hits.length > 0) offenders.push(`${f}: ${hits.join(' | ')}`);
    }
    expect(offenders).toEqual([]);
  });
});
```

- [ ] **Step 2: Run them and watch them fail.**

Run: `npx vitest run src/onedrive/__tests__/graph-errors.test.ts src/onedrive/__tests__/graph-retry.test.ts src/onedrive/__tests__/no-googleapis.test.ts`

Expected: FAIL. Test Files  2 failed | 1 passed (3); Tests  1 passed (1). First error: Failed to load `../graph-errors.js` (the module does not exist yet).

- [ ] **Step 3: Implement.**

`src/onedrive/graph-errors.ts` (create):

```ts
import {
  AppError,
  FileLockedError,
  GraphApiError,
  GraphThrottledError,
  NameConflictError,
  NotFoundError,
  OneDriveFullError,
  PermissionDeniedError,
  TargetChangedError,
  ValidationError,
} from '../errors.js';
import type { Logger } from '../logger.js';

export interface GraphErrorContext {
  alias: string;
  /** The item's name or ID, for the message. */
  target?: string;
  log: Logger;
}

const MAX_LOGGED_BODY = 2000;

/** Pre-authenticated URLs must never reach a log. */
export function sanitizeForLog(text: string): string {
  return text.replace(/https?:\/\/\S+/g, '[url]').slice(0, MAX_LOGGED_BODY);
}

function parseBody(text: string): { code?: string; message?: string } {
  try {
    const parsed = JSON.parse(text) as { error?: { code?: unknown; message?: unknown } };
    const { code, message } = parsed.error ?? {};
    return {
      ...(typeof code === 'string' ? { code } : {}),
      ...(typeof message === 'string' ? { message } : {}),
    };
  } catch {
    return {};
  }
}

/** The mapping table of spec §7.2. */
export function mapGraphError(status: number, bodyText: string, ctx: GraphErrorContext): AppError {
  const { code, message } = parseBody(bodyText);
  const target = ctx.target ?? 'item';
  if (status === 403 && code?.toLowerCase() === 'accessdenied') {
    return new PermissionDeniedError(`${target} on account "${ctx.alias}"`);
  }
  if (status === 404) return new NotFoundError(target);
  if (status === 409) return new NameConflictError(target);
  if (status === 412) return new TargetChangedError(target);
  if (status === 423) return new FileLockedError(target);
  if (status === 429 || status === 503) return new GraphThrottledError();
  if (status === 507) return new OneDriveFullError(ctx.alias);
  if (status === 400 && message && /name/i.test(message)) return new ValidationError(message);
  ctx.log.warn('Graph request failed', { status, code, body: sanitizeForLog(bodyText) });
  return new GraphApiError(status);
}
```

`src/onedrive/graph-retry.ts` (create):

```ts
/** idempotent: safe to repeat; create: repeating after an unknown outcome could duplicate. */
export type GraphRetryClass = 'idempotent' | 'create';

export const MAX_RETRY_AFTER_MS = 60_000;
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_BASE_DELAY_MS = 500;

export interface RetryInput {
  /** Undefined means a network failure: no response arrived. */
  status: number | undefined;
  retryAfter?: string | null;
  retryClass: GraphRetryClass;
  /** How many retries have already happened. */
  attempt: number;
  maxRetries?: number;
  baseDelayMs?: number;
  random?: () => number;
  now?: () => number;
}

export interface RetryDecision {
  retry: boolean;
  delayMs: number;
}

/** `Retry-After` in milliseconds (seconds or HTTP date), capped; undefined when absent/invalid. */
export function retryAfterMs(value: string | null | undefined, now: number): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS);
  const date = Date.parse(value);
  if (Number.isNaN(date)) return undefined;
  return Math.min(Math.max(date - now, 0), MAX_RETRY_AFTER_MS);
}

/** The retry table of spec §7.2; 401 is the caller's refresh rule and is not handled here. */
export function decideRetry(input: RetryInput): RetryDecision {
  const { status, retryClass, attempt } = input;
  const maxRetries = input.maxRetries ?? DEFAULT_MAX_RETRIES;
  const base = input.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const random = input.random ?? Math.random;
  const backoff = base * 2 ** attempt + random() * base;
  const honour =
    status === 429 || (status === 503 && retryClass === 'idempotent')
      ? retryAfterMs(input.retryAfter, (input.now ?? Date.now)())
      : undefined;
  const retryable =
    status === 429 ||
    (retryClass === 'idempotent' && (status === undefined || (status >= 500 && status !== 507)));
  return { retry: retryable && attempt < maxRetries, delayMs: honour ?? backoff };
}
```

- [ ] **Step 4: Run them and watch them pass.**

Run: `npx vitest run src/onedrive/__tests__/graph-errors.test.ts src/onedrive/__tests__/graph-retry.test.ts src/onedrive/__tests__/no-googleapis.test.ts`

Expected: PASS. Test Files  3 passed (3); Tests  33 passed (33).

- [ ] **Step 5: Format and run the whole check.**

Run: `npx prettier --write src/onedrive/__tests__/graph-errors.test.ts src/onedrive/__tests__/graph-retry.test.ts src/onedrive/__tests__/no-googleapis.test.ts src/onedrive/graph-errors.ts src/onedrive/graph-retry.ts` then `npm run check`

Expected: exit 0, `Tests  1113 passed | 6 skipped (1119)`.

- [ ] **Step 6: Commit.**

```bash
git add src/onedrive/__tests__/graph-errors.test.ts src/onedrive/__tests__/graph-retry.test.ts src/onedrive/__tests__/no-googleapis.test.ts src/onedrive/graph-errors.ts src/onedrive/graph-retry.ts
git commit -m "feat(onedrive): Graph retry rules and error mapping" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01UgKFZHQfQhzVqDYowSyGaA"
```

### Task 10: `GraphClient` core: auth rules, retries, paging, download

**Spec:** §7.1, §7.2. The token only ever goes to graph.microsoft.com; redirects are manual; `pageToken` is checked before any request.

**Files:**
- Create: `src/onedrive/graph-client.ts`
- Test: `src/onedrive/__tests__/fake-graph.ts`, `src/onedrive/__tests__/graph-client.test.ts`

- [ ] **Step 1: Write the failing tests.**

`src/onedrive/__tests__/fake-graph.ts` (create):

```ts
import { Readable } from 'node:stream';
import { createLogger } from '../../logger.js';
import { GraphClient, type GraphClientDeps } from '../graph-client.js';

export const GRAPH = 'https://graph.microsoft.com/v1.0';

export interface FakeCall {
  url: string;
  /** URL without the Graph base, for concise assertions. */
  path: string;
  method: string;
  headers: Record<string, string>;
  redirect?: string;
  text?: string;
  bytes?: Buffer;
}

export type Responder = (call: FakeCall) => Response | Promise<Response>;

export interface FakeGraph {
  fetch: typeof fetch;
  calls: FakeCall[];
}

export const json = (body: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers });

export const graphError = (status: number, code: string, message = 'msg'): Response =>
  json({ error: { code, message } }, status);

export const empty = (status = 204, headers: Record<string, string> = {}): Response =>
  new Response(null, { status, headers });

/** Records every request, reading a streamed body fully, and answers with `responder`. */
export function fakeGraph(responder: Responder): FakeGraph {
  const calls: FakeCall[] = [];
  const fake = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const body = init?.body;
    const call: FakeCall = {
      url,
      path: url.startsWith(GRAPH) ? url.slice(GRAPH.length) : url,
      method: init?.method ?? 'GET',
      headers: Object.fromEntries(
        Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [
          k.toLowerCase(),
          v,
        ]),
      ),
      ...(init?.redirect ? { redirect: init.redirect } : {}),
    };
    if (typeof body === 'string') call.text = body;
    else if (body instanceof Readable) {
      const parts: Buffer[] = [];
      for await (const chunk of body) parts.push(chunk as Buffer);
      call.bytes = Buffer.concat(parts);
    }
    calls.push(call);
    return responder(call);
  };
  return { fetch: fake as typeof fetch, calls };
}

/** A client with instant sleeps and a token that records refreshes. */
export function makeClient(
  fake: FakeGraph,
  extra: Partial<GraphClientDeps> = {},
): { client: GraphClient; refreshes: () => number } {
  let refreshes = 0;
  const client = new GraphClient({
    alias: 'work',
    accessToken: async (options) => {
      if (options?.forceRefresh) refreshes++;
      return options?.forceRefresh ? 'fresh-token' : 'token';
    },
    fetch: fake.fetch,
    sleep: async () => undefined,
    random: () => 0,
    logger: createLogger(() => {}),
    ...extra,
  });
  return { client, refreshes: () => refreshes };
}
```

`src/onedrive/__tests__/graph-client.test.ts` (create):

```ts
import { describe, expect, it } from 'vitest';
import {
  GraphThrottledError,
  NameConflictError,
  ReauthRequiredError,
  ValidationError,
} from '../../errors.js';
import { assertSafeName, childPath, itemPath } from '../graph-client.js';
import { GRAPH, empty, fakeGraph, graphError, json, makeClient } from './fake-graph.js';

/** Answers from a list in order; the last answer repeats. */
function sequence(...answers: Array<() => Response>): () => Response {
  let i = 0;
  return () => (answers[Math.min(i++, answers.length - 1)] as () => Response)();
}

describe('paths', () => {
  it('encodes IDs and names and maps root', () => {
    expect(itemPath('a b#c')).toBe('/me/drive/items/a%20b%23c');
    expect(itemPath('root')).toBe('/me/drive/root');
    expect(childPath('root', 'x y#.txt')).toBe('/me/drive/root:/x%20y%23.txt');
    expect(childPath('p1', 'é.txt')).toBe('/me/drive/items/p1:/%C3%A9.txt');
  });

  it.each(['.', '..', 'a/b', 'a\\b', '/', '\\'])('rejects the ID or name %s', (value) => {
    expect(() => itemPath(value)).toThrow(ValidationError);
    expect(() => childPath('p1', value)).toThrow(ValidationError);
    expect(() => {
      assertSafeName(value);
    }).toThrow(ValidationError);
  });

  it('accepts names that only contain dots', () => {
    expect(childPath('p1', '.hidden')).toBe('/me/drive/items/p1:/.hidden');
    expect(childPath('p1', 'a..b')).toBe('/me/drive/items/p1:/a..b');
  });
});

describe('GraphClient requests', () => {
  it('sends the bearer token and JSON body to Graph', async () => {
    const fake = fakeGraph(() => json({ ok: true }));
    const { client } = makeClient(fake);
    await client.json('POST', '/me/x', { retry: 'create', body: { a: 1 } });
    expect(fake.calls[0]).toMatchObject({
      url: `${GRAPH}/me/x`,
      method: 'POST',
      redirect: 'manual',
      text: '{"a":1}',
    });
    expect(fake.calls[0]?.headers.authorization).toBe('Bearer token');
  });

  it('getOrNull returns null on 404 and throws otherwise', async () => {
    const { client } = makeClient(fakeGraph(() => graphError(404, 'itemNotFound')));
    await expect(client.getOrNull('/x')).resolves.toBeNull();
    const failing = makeClient(fakeGraph(() => graphError(423, 'resourceLocked')));
    await expect(failing.client.getOrNull('/x', 'a')).rejects.toThrow(/locked/);
  });

  it('refreshes once on 401 and repeats the request', async () => {
    const fake = fakeGraph(
      sequence(
        () => empty(401),
        () => json({ ok: 1 }),
      ),
    );
    const { client, refreshes } = makeClient(fake);
    await expect(client.get('/x')).resolves.toEqual({ ok: 1 });
    expect(refreshes()).toBe(1);
    expect(fake.calls[1]?.headers.authorization).toBe('Bearer fresh-token');
  });

  it('raises ReauthRequiredError on a second 401', async () => {
    const fake = fakeGraph(() => empty(401));
    const { client, refreshes } = makeClient(fake);
    await expect(client.get('/x')).rejects.toThrow(ReauthRequiredError);
    expect(refreshes()).toBe(1);
    expect(fake.calls).toHaveLength(2);
  });

  it('honours Retry-After on 429 and stops after three retries', async () => {
    const sleeps: number[] = [];
    const fake = fakeGraph(() => json({}, 429, { 'retry-after': '7' }));
    const { client } = makeClient(fake, { sleep: async (ms) => void sleeps.push(ms) });
    await expect(client.get('/x')).rejects.toThrow(GraphThrottledError);
    expect(fake.calls).toHaveLength(4);
    expect(sleeps).toEqual([7000, 7000, 7000]);
  });

  it('retries a create only on 429', async () => {
    const throttled = fakeGraph(
      sequence(
        () => json({}, 429),
        () => json({ id: '1' }),
      ),
    );
    await expect(
      makeClient(throttled).client.json('POST', '/x', { retry: 'create' }),
    ).resolves.toEqual({ id: '1' });
    const failed = fakeGraph(() => graphError(503, 'serviceNotAvailable'));
    await expect(makeClient(failed).client.json('POST', '/x', { retry: 'create' })).rejects.toThrow(
      GraphThrottledError,
    );
    expect(failed.calls).toHaveLength(1);
    const server = fakeGraph(() => graphError(500, 'x'));
    await makeClient(server)
      .client.json('POST', '/x', { retry: 'create' })
      .catch(() => undefined);
    expect(server.calls).toHaveLength(1);
  });

  it('never retries 507', async () => {
    const fake = fakeGraph(() => graphError(507, 'quotaLimitReached'));
    await expect(makeClient(fake).client.get('/x')).rejects.toThrow(/storage is full/);
    expect(fake.calls).toHaveLength(1);
  });

  it('retries an idempotent request after a network failure, not a create', async () => {
    let first = true;
    const fake = fakeGraph(() => {
      if (first) {
        first = false;
        throw new TypeError('fetch failed');
      }
      return json({ id: '1' });
    });
    await expect(makeClient(fake).client.get('/x')).resolves.toEqual({ id: '1' });
    const create = fakeGraph(() => {
      throw new TypeError('fetch failed');
    });
    await expect(makeClient(create).client.json('POST', '/x', { retry: 'create' })).rejects.toThrow(
      /OneDrive request failed/,
    );
    expect(create.calls).toHaveLength(1);
  });

  it('counts a 404 on a repeat as success when asked', async () => {
    const fake = fakeGraph(
      sequence(
        () => graphError(500, 'x'),
        () => graphError(404, 'itemNotFound'),
      ),
    );
    await expect(
      makeClient(fake).client.json('DELETE', '/x', {
        retry: 'idempotent',
        notFoundOnRepeatIsOk: true,
      }),
    ).resolves.toBeUndefined();
    const first = fakeGraph(() => graphError(404, 'itemNotFound'));
    await expect(
      makeClient(first).client.json('DELETE', '/x', {
        retry: 'idempotent',
        notFoundOnRepeatIsOk: true,
      }),
    ).rejects.toThrow(/not found/);
  });

  it('maps a conflict with the target name', async () => {
    const fake = fakeGraph(() => graphError(409, 'nameAlreadyExists'));
    await expect(
      makeClient(fake).client.json('POST', '/x', { retry: 'create', target: 'a.txt' }),
    ).rejects.toThrow(NameConflictError);
  });
});

describe('GraphClient.checkPageToken', () => {
  const { client } = makeClient(fakeGraph(() => json({})));
  it.each([
    `${GRAPH}/me/drive/items/x/children?$skiptoken=1`,
    `${GRAPH}/drives/DRIVE1/items/x/children?$skiptoken=1`,
    `${GRAPH}/drives/b%211/root/search?$skip=1`,
  ])('accepts %s', (token) => {
    expect(() => {
      client.checkPageToken(token, token.includes('b%211') ? 'b!1' : 'DRIVE1');
    }).not.toThrow();
  });

  it.each([
    'not a url',
    'http://graph.microsoft.com/v1.0/me/drive/items',
    'https://evil.example/v1.0/me/drive/items',
    'https://graph.microsoft.com.evil.example/v1.0/me/drive/x',
    `${GRAPH}/me/messages`,
    `${GRAPH}/me/drive/../messages`,
    `${GRAPH}/drives/OTHER/items/x`,
    'https://graph.microsoft.com/beta/me/drive/x',
    `${GRAPH}/me/drive/items/a%2fb`,
    `${GRAPH}/me/drive/items/a%2Fb`,
    `${GRAPH}/me/drive/items/a%5cb`,
    `${GRAPH}/me/drive/items/a%5Cb`,
    `${GRAPH}/me/drive/items/%2e%2e/x`,
    `${GRAPH}/me/drive/items/%2E%2E/x`,
    `${GRAPH}/me/drive/%2e/x`,
    `${GRAPH}/me/drive/./x`,
    `${GRAPH}/me/drive/x/..`,
    `${GRAPH}/me/drive/x\\y`,
    `${GRAPH}/me/drive/..%2\tF..%2\tFme/messages`,
    `${GRAPH}/me/drive/..%2\nF..%2\nFme/messages`,
    `${GRAPH}/me/drive/..%2\rF..%2\rFme/messages`,
    `${GRAPH}/me/drive/items/a\tb`,
    `${GRAPH}/me/drive/items/a\nb`,
    `${GRAPH}/me/drive/items/a b`,
    `${GRAPH}/me/drive/items/x?$skiptoken=a\tb`,
    `${GRAPH}/me/drive/items/a\u0000b`,
    `${GRAPH}/me/drive/items/a\u007fb`,
  ])('rejects %s', (token) => {
    const { client } = makeClient(fakeGraph(() => json({})));
    expect(() => {
      client.checkPageToken(token, 'DRIVE1');
    }).toThrow(
      new ValidationError(
        'pageToken is not a page link that can be followed safely for this account.',
      ),
    );
  });

  it('allows encoded characters in the query', () => {
    const { client } = makeClient(fakeGraph(() => json({})));
    expect(() => {
      client.checkPageToken(`${GRAPH}/me/drive/items/x/children?$skiptoken=a%2Fb%2E`, 'DRIVE1');
    }).not.toThrow();
  });
});

describe('GraphClient.download', () => {
  const read = async (stream: AsyncIterable<unknown>): Promise<string> => {
    let out = '';
    for await (const chunk of stream) out += Buffer.from(chunk as Uint8Array).toString();
    return out;
  };

  it('follows the redirect without the token', async () => {
    const fake = fakeGraph((call) =>
      call.url.startsWith(GRAPH)
        ? empty(302, { location: 'https://cdn.example/file?sig=secret' })
        : new Response('content'),
    );
    const stream = await makeClient(fake).client.download('/me/drive/items/1/content', 'a');
    expect(await read(stream)).toBe('content');
    expect(fake.calls[0]?.redirect).toBe('manual');
    expect(fake.calls[1]?.headers.authorization).toBeUndefined();
  });

  it('streams a direct response', async () => {
    const fake = fakeGraph(() => new Response('direct'));
    expect(await read(await makeClient(fake).client.download('/x', 'a'))).toBe('direct');
  });

  it('retries the pre-authenticated request', async () => {
    const answers = sequence(
      () => empty(500),
      () => new Response('ok'),
    );
    const fake = fakeGraph((call) =>
      call.url.startsWith(GRAPH) ? empty(302, { location: 'https://cdn.example/f' }) : answers(),
    );
    expect(await read(await makeClient(fake).client.download('/x', 'a'))).toBe('ok');
  });
});
```

- [ ] **Step 2: Run them and watch them fail.**

Run: `npx vitest run src/onedrive/__tests__/graph-client.test.ts`

Expected: FAIL. Test Files  1 failed (1); Tests  no tests. First error: Failed to load `../graph-client.js` (the module does not exist yet).

- [ ] **Step 3: Implement.**

`src/onedrive/graph-client.ts` (create):

```ts
import { Readable } from 'node:stream';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import {
  GraphApiError,
  NotFoundError,
  ReauthRequiredError,
  ValidationError,
  type AppError,
} from '../errors.js';
import { logger as defaultLogger, type Logger } from '../logger.js';
import { mapGraphError } from './graph-errors.js';
import { decideRetry, type GraphRetryClass } from './graph-retry.js';

const GRAPH_HOST = 'graph.microsoft.com';
const GRAPH_BASE = `https://${GRAPH_HOST}/v1.0`;

export interface GraphClientDeps {
  alias: string;
  accessToken: (options?: { forceRefresh?: boolean }) => Promise<string>;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  now?: () => number;
  logger?: Logger;
}

export interface GraphRequestOptions {
  retry: GraphRetryClass;
  /** The item's name or ID, for error messages. */
  target?: string;
  body?: unknown;
  headers?: Record<string, string>;
  /** A 404 on a repeat means an earlier attempt already succeeded. */
  notFoundOnRepeatIsOk?: boolean;
}

export function itemPath(id: string): string {
  assertSafeSegment(id, 'ID');
  return id === 'root' ? '/me/drive/root' : `/me/drive/items/${encodeURIComponent(id)}`;
}

/** Path-based address of a child; append `:/<action>` for an action on it. */
export function childPath(parentId: string, name: string): string {
  assertSafeName(name);
  return `${itemPath(parentId)}:/${encodeURIComponent(name)}`;
}

/** `encodeURIComponent` keeps `.` and `..`, and a separator must never reach the path. */
function assertSafeSegment(value: string, label: string): void {
  if (value === '.' || value === '..' || /[/\\]/.test(value)) {
    throw new ValidationError(`${label} "${value}" is not valid on OneDrive`);
  }
}

export function assertSafeName(name: string): void {
  assertSafeSegment(name, 'Name');
}

/** Encoded separators and dot segments that a server could decode into another path. */
function hasPathTrick(token: string): boolean {
  const rawPath = token.split(/[?#]/, 1)[0] ?? '';
  return (
    /%2f|%5c|%2e/i.test(rawPath) ||
    rawPath.includes('\\') ||
    rawPath.split('/').some((segment) => segment === '.' || segment === '..')
  );
}

/** `new URL()` silently strips tabs and newlines, which could hide a path trick from a check. */
function hasControlOrSpace(token: string): boolean {
  return /\s/.test(token) || [...token].some((ch) => ch.charCodeAt(0) < 0x20 || ch === '\x7f');
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * Authenticated Graph requests for one account. `Authorization` is only ever sent to
 * graph.microsoft.com; redirects are never followed with it (spec §7.1).
 */
export class GraphClient {
  private readonly fetch: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;
  private readonly now: () => number;
  private readonly log: Logger;

  constructor(private readonly deps: GraphClientDeps) {
    this.fetch = deps.fetch ?? fetch;
    this.sleep = deps.sleep ?? defaultSleep;
    this.random = deps.random ?? Math.random;
    this.now = deps.now ?? Date.now;
    this.log = deps.logger ?? defaultLogger;
  }

  get<T>(path: string, target?: string): Promise<T> {
    return this.json<T>('GET', path, { retry: 'idempotent', ...(target ? { target } : {}) });
  }

  /** Null on 404; every other failure throws. */
  async getOrNull<T>(path: string, target?: string): Promise<T | null> {
    try {
      return await this.get<T>(path, target);
    } catch (err) {
      if (err instanceof NotFoundError) return null;
      throw err;
    }
  }

  async json<T>(method: string, path: string, options: GraphRequestOptions): Promise<T> {
    const res = await this.send(method, `${GRAPH_BASE}${path}`, options);
    if (res.status === 204 || res.status === 404) return undefined as T;
    return (await res.json()) as T;
  }

  /** A `pageToken` must be a Graph page link of this account (spec §7.1). */
  checkPageToken(token: string, driveId: string): void {
    let url: URL | undefined;
    try {
      url = new URL(token);
    } catch {
      url = undefined;
    }
    const prefixes = ['/v1.0/me/drive/', `/v1.0/drives/${driveId}/`];
    prefixes.push(`/v1.0/drives/${driveId.replaceAll('!', '%21')}/`);
    const valid =
      !hasControlOrSpace(token) &&
      !hasPathTrick(token) &&
      url !== undefined &&
      !hasPathTrick(url.pathname) &&
      url.protocol === 'https:' &&
      url.host === GRAPH_HOST &&
      prefixes.some((p) => url.pathname.startsWith(p));
    if (!valid)
      throw new ValidationError(
        'pageToken is not a page link that can be followed safely for this account.',
      );
  }

  /** Follows a page link already accepted by `checkPageToken`. */
  async page<T>(url: string): Promise<T> {
    return (await (await this.send('GET', url, { retry: 'idempotent' })).json()) as T;
  }

  /** Streams item content. The redirect target is pre-authenticated and gets no token. */
  async download(path: string, target: string): Promise<Readable> {
    const res = await this.send('GET', `${GRAPH_BASE}${path}`, { retry: 'idempotent', target });
    if (res.status < 300) return this.bodyStream(res);
    const location = res.headers.get('location');
    if (!location) throw new GraphApiError(res.status);
    await res.body?.cancel();
    return this.bodyStream(await this.sendPreauthenticated('GET', location, target));
  }

  private bodyStream(res: Response): Readable {
    if (!res.body) throw new GraphApiError(res.status);
    return Readable.fromWeb(res.body as WebReadableStream);
  }

  /** One request with the 401 rule, retries and error mapping of spec §7.2. */
  protected async send(
    method: string,
    url: string,
    options: GraphRequestOptions,
  ): Promise<Response> {
    let refreshed = false;
    let forceRefresh = false;
    for (let attempt = 0; ;) {
      const token = await this.deps.accessToken(forceRefresh ? { forceRefresh } : undefined);
      forceRefresh = false;
      let res: Response | undefined;
      try {
        res = await this.fetch(url, {
          method,
          redirect: 'manual',
          headers: {
            Authorization: `Bearer ${token}`,
            ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
            ...options.headers,
          },
          ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
        });
      } catch (err) {
        this.log.warn('Graph request failed to reach the network', { error: err });
      }
      if (res?.status === 401) {
        await res.body?.cancel();
        if (refreshed) throw new ReauthRequiredError(this.deps.alias);
        refreshed = true;
        forceRefresh = true;
        continue;
      }
      if (res && res.status < 400) return res;
      if (res?.status === 404 && options.notFoundOnRepeatIsOk && attempt > 0) return res;
      const decision = this.decide(res, options.retry, attempt);
      if (!decision.retry) throw await this.failure(res, options.target);
      await res?.body?.cancel();
      await this.sleep(decision.delayMs);
      attempt++;
    }
  }

  /** A pre-authenticated URL: never an Authorization header, never logged. */
  protected async sendPreauthenticated(
    method: string,
    url: string,
    target?: string,
  ): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
      let res: Response | undefined;
      try {
        res = await this.fetch(url, { method });
      } catch {
        res = undefined;
      }
      if (res && res.status < 400) return res;
      const decision = this.decide(res, 'idempotent', attempt);
      if (!decision.retry) throw await this.failure(res, target);
      await res?.body?.cancel();
      await this.sleep(decision.delayMs);
    }
  }

  protected decide(
    res: Response | undefined,
    retryClass: GraphRetryClass,
    attempt: number,
    maxRetries?: number,
  ): { retry: boolean; delayMs: number } {
    return decideRetry({
      status: res?.status,
      retryAfter: res?.headers.get('retry-after'),
      retryClass,
      attempt,
      random: this.random,
      now: this.now,
      ...(maxRetries === undefined ? {} : { maxRetries }),
    });
  }

  protected async failure(res: Response | undefined, target?: string): Promise<AppError> {
    if (!res) return new GraphApiError(undefined);
    const text = await res.text().catch(() => '');
    return mapGraphError(res.status, text, {
      alias: this.deps.alias,
      log: this.log,
      ...(target ? { target } : {}),
    });
  }
}
```

- [ ] **Step 4: Run them and watch them pass.**

Run: `npx vitest run src/onedrive/__tests__/graph-client.test.ts`

Expected: PASS. Test Files  1 passed (1); Tests  52 passed (52).

- [ ] **Step 5: Format and run the whole check.**

Run: `npx prettier --write src/onedrive/__tests__/fake-graph.ts src/onedrive/__tests__/graph-client.test.ts src/onedrive/graph-client.ts` then `npm run check`

Expected: exit 0, `Tests  1165 passed | 6 skipped (1171)`.

- [ ] **Step 6: Commit.**

```bash
git add src/onedrive/__tests__/fake-graph.ts src/onedrive/__tests__/graph-client.test.ts src/onedrive/graph-client.ts
git commit -m "feat(onedrive): GraphClient with the auth, paging and download rules" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01UgKFZHQfQhzVqDYowSyGaA"
```


---

## Chunk 8: Graph upload sessions and copy monitor

### Task 11: Upload sessions

**Spec:** §7.3, §6. 10 MiB fragments from a stream per fragment, resume from `nextExpectedRanges`, one restart on a lost session. A test against a local server proves the platform `fetch` sends a real `Content-Length`.

**Files:**
- Modify: `src/onedrive/graph-client.ts`
- Test: `src/onedrive/__tests__/graph-client.upload.test.ts`

- [ ] **Step 1: Write the failing tests.**

`src/onedrive/__tests__/graph-client.upload.test.ts` (create):

```ts
import { randomBytes } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { GraphApiError, NameConflictError, TargetChangedError } from '../../errors.js';
import { createLogger } from '../../logger.js';
import { FRAGMENT_SIZE } from '../graph-client.js';
import { empty, fakeGraph, graphError, json, makeClient, type FakeCall } from './fake-graph.js';

const UPLOAD_URL = 'https://upload.example/session?sig=secret';
const SIZE = FRAGMENT_SIZE + 1000;
let localPath: string;
let content: Buffer;

beforeEach(async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'graph-upload-'));
  localPath = path.join(dir, 'file.bin');
  content = randomBytes(SIZE);
  await writeFile(localPath, content);
});

const request = () => ({
  createPath: '/me/drive/items/p:/f.bin:/createUploadSession',
  body: { item: { '@microsoft.graph.conflictBehavior': 'fail' } },
  localPath,
  size: SIZE,
  target: 'f.bin',
});

const isCreate = (c: FakeCall): boolean => c.path.endsWith('createUploadSession');
const puts = (calls: FakeCall[]): FakeCall[] => calls.filter((c) => c.method === 'PUT');
const session = (): Response => json({ uploadUrl: UPLOAD_URL });
const progress = (next: number): Response => json({ nextExpectedRanges: [`${next}-`] }, 202);
const done = (): Response => json({ id: 'new' }, 201);

describe('GraphClient.upload', () => {
  it('sends ordered fragments with no token and returns the item', async () => {
    let n = 0;
    const fake = fakeGraph((c) => {
      if (isCreate(c)) return session();
      return n++ === 0 ? progress(FRAGMENT_SIZE) : done();
    });
    await expect(makeClient(fake).client.upload(request())).resolves.toEqual({ id: 'new' });
    const [first, second] = puts(fake.calls);
    expect(first?.headers['content-range']).toBe(`bytes 0-${FRAGMENT_SIZE - 1}/${SIZE}`);
    expect(first?.headers['content-length']).toBe(String(FRAGMENT_SIZE));
    expect(second?.headers['content-range']).toBe(`bytes ${FRAGMENT_SIZE}-${SIZE - 1}/${SIZE}`);
    // Buffer.equals: toEqual walks 10 MiB element by element and can hit the test timeout.
    const sent = Buffer.concat([first?.bytes ?? Buffer.alloc(0), second?.bytes ?? Buffer.alloc(0)]);
    expect(sent.equals(content)).toBe(true);
    expect(puts(fake.calls).every((c) => c.headers.authorization === undefined)).toBe(true);
    expect(fake.calls.find(isCreate)?.headers.authorization).toBe('Bearer token');
  });

  it.each([
    ['a failed fragment', 500, 'generalException'],
    ['a 416 on a fragment', 416, 'invalidRange'],
  ])('resumes %s from the offset the session reports', async (_name, status, code) => {
    const reported = 320 * 1024;
    let n = 0;
    const fake = fakeGraph((c) => {
      if (isCreate(c)) return session();
      if (c.method === 'GET') return json({ nextExpectedRanges: [`${reported}-`] });
      return n++ === 0 ? graphError(status, code) : done();
    });
    await makeClient(fake).client.upload(request());
    const [first, second] = puts(fake.calls);
    expect(first?.headers['content-range']).toBe(`bytes 0-${FRAGMENT_SIZE - 1}/${SIZE}`);
    expect(second?.headers['content-range']).toBe(`bytes ${reported}-${SIZE - 1}/${SIZE}`);
    expect(second?.bytes?.equals(content.subarray(reported))).toBe(true);
  });

  it('restarts after a lost final response, resending If-Match and the body', async () => {
    let n = 0;
    const fake = fakeGraph((c) => {
      if (isCreate(c)) return session();
      if (c.method === 'GET') return graphError(404, 'itemNotFound');
      const attempt = n++;
      if (attempt === 0) throw new TypeError('fetch failed');
      return attempt === 1 ? graphError(404, 'itemNotFound') : done();
    });
    const upload = { ...request(), size: 1000, headers: { 'If-Match': 'etag1' } };
    await expect(makeClient(fake).client.upload(upload)).resolves.toEqual({ id: 'new' });
    const creates = fake.calls.filter(isCreate);
    expect(creates.map((c) => c.headers['if-match'])).toEqual(['etag1', 'etag1']);
    expect(puts(fake.calls).at(-1)?.bytes?.equals(content.subarray(0, 1000))).toBe(true);
  });

  it('survives a network failure on a fragment', async () => {
    let n = 0;
    const fake = fakeGraph((c) => {
      if (isCreate(c)) return session();
      if (c.method === 'GET') return json({});
      if (n++ === 0) throw new TypeError('fetch failed');
      return n === 2 ? progress(FRAGMENT_SIZE) : done();
    });
    await expect(makeClient(fake).client.upload(request())).resolves.toEqual({ id: 'new' });
  });

  it('gives up after 5 retries and deletes the session', async () => {
    const fake = fakeGraph((c) => {
      if (isCreate(c)) return session();
      if (c.method === 'GET') return json({});
      if (c.method === 'DELETE') return empty();
      return graphError(500, 'x');
    });
    await expect(makeClient(fake).client.upload(request())).rejects.toThrow(
      /OneDrive request failed/,
    );
    expect(puts(fake.calls)).toHaveLength(6);
    expect(fake.calls.at(-1)).toMatchObject({ method: 'DELETE', url: UPLOAD_URL });
  });

  it('restarts the whole upload once when the session is gone', async () => {
    let creates = 0;
    const fake = fakeGraph((c) => {
      if (isCreate(c)) {
        creates++;
        return session();
      }
      return creates === 1 ? graphError(404, 'itemNotFound') : done();
    });
    await makeClient(fake).client.upload({ ...request(), size: 1000 });
    expect(creates).toBe(2);
  });

  it('fails after a second lost session', async () => {
    const fake = fakeGraph((c) => (isCreate(c) ? session() : graphError(404, 'itemNotFound')));
    await expect(makeClient(fake).client.upload({ ...request(), size: 1000 })).rejects.toThrow(
      /404/,
    );
  });

  it('deletes the session and reports a conflict on the last fragment', async () => {
    let n = 0;
    const fake = fakeGraph((c) => {
      if (isCreate(c)) return session();
      if (c.method === 'DELETE') return empty();
      return n++ === 0 ? progress(FRAGMENT_SIZE) : graphError(409, 'nameAlreadyExists');
    });
    await expect(makeClient(fake).client.upload(request())).rejects.toThrow(NameConflictError);
    expect(fake.calls.at(-1)?.method).toBe('DELETE');
  });

  it('reports 412 at session creation', async () => {
    const fake = fakeGraph(() => graphError(412, 'resourceModified'));
    await expect(makeClient(fake).client.upload(request())).rejects.toThrow(TargetChangedError);
  });

  it('keeps the session URL out of errors and logs', async () => {
    const lines: string[] = [];
    const logger = createLogger((line) => {
      lines.push(line);
    });
    const fake = fakeGraph((c) =>
      isCreate(c) ? session() : graphError(400, 'invalidRequest', `bad ${UPLOAD_URL}`),
    );
    const err = (await makeClient(fake, { logger })
      .client.upload(request())
      .catch((e: unknown) => e)) as Error;
    expect(err).toBeInstanceOf(GraphApiError);
    expect(err.message).not.toContain('upload.example');
    expect(lines.join('')).toContain('Graph request failed');
    expect(lines.join('')).not.toContain('sig=secret');
    expect(lines.join('')).not.toContain('upload.example');
  });

  it('sends a real Content-Length, not chunked, through the platform fetch', async () => {
    const seen: Array<Record<string, string | string[] | undefined>> = [];
    const server = createServer((req, res) => {
      seen.push(req.headers);
      req.resume();
      req.on('end', () => res.writeHead(201).end(JSON.stringify({ id: 'real' })));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    try {
      const local = `http://127.0.0.1:${port}/s`;
      const client = makeClient({
        calls: [],
        fetch: ((input: string, init?: RequestInit) =>
          String(input).includes('graph.microsoft.com')
            ? Promise.resolve(json({ uploadUrl: local }))
            : fetch(input, init)) as typeof fetch,
      }).client;
      await expect(client.upload({ ...request(), size: 1000 })).resolves.toEqual({ id: 'real' });
      expect(seen[0]?.['content-length']).toBe('1000');
      expect(seen[0]?.['transfer-encoding']).toBeUndefined();
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
```

- [ ] **Step 2: Run them and watch them fail.**

Run: `npx vitest run src/onedrive/__tests__/graph-client.upload.test.ts`

Expected: FAIL. Test Files  1 failed (1); Tests  12 failed (12).

- [ ] **Step 3: Implement.**

`src/onedrive/graph-client.ts` (modify):

```diff
diff --git a/src/onedrive/graph-client.ts b/src/onedrive/graph-client.ts
index 43d04c8..e9b389c 100644
--- a/src/onedrive/graph-client.ts
+++ b/src/onedrive/graph-client.ts
@@ -1,3 +1,4 @@
+import { createReadStream } from 'node:fs';
 import { Readable } from 'node:stream';
 import type { ReadableStream as WebReadableStream } from 'node:stream/web';
 import {
@@ -34,6 +35,27 @@ export interface GraphRequestOptions {
   notFoundOnRepeatIsOk?: boolean;
 }
 
+/** 10 MiB, a multiple of 320 KiB as Graph requires. */
+export const FRAGMENT_SIZE = 10 * 1024 * 1024;
+const MAX_FRAGMENT_RETRIES = 5;
+const SESSION_LOST = Symbol('session lost');
+
+export interface UploadRequest {
+  /** Path of the `createUploadSession` action. */
+  createPath: string;
+  body: Record<string, unknown>;
+  headers?: Record<string, string>;
+  localPath: string;
+  size: number;
+  target: string;
+}
+
+function nextOffset(ranges: unknown, fallback: number): number {
+  const first = Array.isArray(ranges) ? (ranges[0] as unknown) : undefined;
+  const offset = typeof first === 'string' ? Number(first.split('-')[0]) : Number.NaN;
+  return Number.isInteger(offset) && offset >= 0 ? offset : fallback;
+}
+
 export function itemPath(id: string): string {
   assertSafeSegment(id, 'ID');
   return id === 'root' ? '/me/drive/root' : `/me/drive/items/${encodeURIComponent(id)}`;
@@ -154,6 +176,104 @@ export class GraphClient {
     return this.bodyStream(await this.sendPreauthenticated('GET', location, target));
   }
 
+  /** Uploads a non-empty file through a session; a 404 on the session restarts it once. */
+  async upload<T>(request: UploadRequest): Promise<T> {
+    for (let restarted = false; ; restarted = true) {
+      const { uploadUrl } = await this.json<{ uploadUrl: string }>('POST', request.createPath, {
+        retry: 'idempotent',
+        body: request.body,
+        target: request.target,
+        ...(request.headers ? { headers: request.headers } : {}),
+      });
+      const result = await this.sendFragments<T>(uploadUrl, request);
+      if (result !== SESSION_LOST) return result;
+      if (restarted) throw new GraphApiError(404);
+    }
+  }
+
+  private async sendFragments<T>(
+    uploadUrl: string,
+    request: UploadRequest,
+  ): Promise<T | typeof SESSION_LOST> {
+    let offset = 0;
+    let failures = 0;
+    const giveUp = async (res: Response | undefined): Promise<AppError> => {
+      const error = await this.failure(res, request.target);
+      await this.deleteSession(uploadUrl);
+      return error;
+    };
+    for (;;) {
+      const end = Math.min(offset + FRAGMENT_SIZE, request.size) - 1;
+      const res = await this.putFragment(uploadUrl, request, offset, end);
+      if (res?.status === 200 || res?.status === 201) return (await res.json()) as T;
+      if (res?.status === 202) {
+        const progress = (await res.json().catch(() => ({}))) as { nextExpectedRanges?: unknown };
+        offset = nextOffset(progress.nextExpectedRanges, end + 1);
+        failures = 0;
+        continue;
+      }
+      if (res?.status === 404) return SESSION_LOST;
+      const transient =
+        res === undefined || res.status === 416 || res.status === 429 || res.status >= 500;
+      const decision = this.decide(
+        res?.status === 416 ? new Response(null, { status: 500 }) : res,
+        'idempotent',
+        failures,
+        MAX_FRAGMENT_RETRIES,
+      );
+      if (!transient || !decision.retry) throw await giveUp(res);
+      await res?.body?.cancel();
+      failures++;
+      await this.sleep(decision.delayMs);
+      offset = await this.resumeOffset(uploadUrl, offset);
+    }
+  }
+
+  /** Sends one fragment. Undefined means no response arrived. */
+  private async putFragment(
+    uploadUrl: string,
+    request: UploadRequest,
+    start: number,
+    end: number,
+  ): Promise<Response | undefined> {
+    const body = createReadStream(request.localPath, { start, end });
+    try {
+      return await this.fetch(uploadUrl, {
+        method: 'PUT',
+        headers: {
+          'Content-Length': String(end - start + 1),
+          'Content-Range': `bytes ${start}-${end}/${request.size}`,
+        },
+        body: body as unknown as RequestInit['body'],
+        duplex: 'half',
+      } as RequestInit);
+    } catch {
+      return undefined;
+    } finally {
+      body.destroy();
+    }
+  }
+
+  /** Asks the session where to continue; keeps `current` when it cannot tell. */
+  private async resumeOffset(uploadUrl: string, current: number): Promise<number> {
+    try {
+      const res = await this.fetch(uploadUrl, { method: 'GET' });
+      if (!res.ok) return current;
+      const status = (await res.json()) as { nextExpectedRanges?: unknown };
+      return nextOffset(status.nextExpectedRanges, current);
+    } catch {
+      return current;
+    }
+  }
+
+  private async deleteSession(uploadUrl: string): Promise<void> {
+    try {
+      await this.fetch(uploadUrl, { method: 'DELETE' });
+    } catch {
+      // Best effort: an abandoned session expires by itself.
+    }
+  }
+
   private bodyStream(res: Response): Readable {
     if (!res.body) throw new GraphApiError(res.status);
     return Readable.fromWeb(res.body as WebReadableStream);
```

- [ ] **Step 4: Run them and watch them pass.**

Run: `npx vitest run src/onedrive/__tests__/graph-client.upload.test.ts`

Expected: PASS. Test Files  1 passed (1); Tests  12 passed (12).

- [ ] **Step 5: Format and run the whole check.**

Run: `npx prettier --write src/onedrive/__tests__/graph-client.upload.test.ts src/onedrive/graph-client.ts` then `npm run check`

Expected: exit 0, `Tests  1177 passed | 6 skipped (1183)`.

- [ ] **Step 6: Commit.**

```bash
git add src/onedrive/__tests__/graph-client.upload.test.ts src/onedrive/graph-client.ts
git commit -m "feat(onedrive): resumable upload sessions in GraphClient" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01UgKFZHQfQhzVqDYowSyGaA"
```

### Task 12: Copy monitor

**Spec:** §7.3, §5.2. Once Graph accepted a copy it is never repeated.

**Files:**
- Modify: `src/onedrive/graph-client.ts`
- Test: `src/onedrive/__tests__/graph-client.copy.test.ts`

- [ ] **Step 1: Write the failing tests.**

`src/onedrive/__tests__/graph-client.copy.test.ts` (create):

```ts
import { describe, expect, it } from 'vitest';
import { CopyStillRunningError, GraphApiError, NameConflictError } from '../../errors.js';
import {
  GRAPH,
  empty,
  fakeGraph,
  graphError,
  json,
  makeClient,
  type FakeCall,
} from './fake-graph.js';

const MONITOR = 'https://monitor.example/op?sig=secret';
const accepted = (): Response => empty(202, { location: MONITOR });
const readItem = async (id: string): Promise<{ id: string }> => ({ id });
const posts = (calls: FakeCall[]): FakeCall[] => calls.filter((c) => c.method === 'POST');

function client(responder: Parameters<typeof fakeGraph>[0]) {
  let clock = 0;
  const fake = fakeGraph(responder);
  const { client: c } = makeClient(fake, {
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
  });
  return { fake, c };
}

describe('GraphClient.copy', () => {
  it('polls the monitor without the token and reads the new item', async () => {
    let polls = 0;
    const { fake, c } = client((call) => {
      if (call.url.startsWith(GRAPH)) return accepted();
      polls++;
      return polls < 3
        ? json({ status: 'inProgress' }, 202)
        : json({ status: 'completed', resourceId: 'new-id' });
    });
    await expect(c.copy('/x/copy', { name: 'n' }, 'n', readItem)).resolves.toEqual({
      id: 'new-id',
    });
    const monitorCalls = fake.calls.filter((call) => call.url === MONITOR);
    expect(monitorCalls).toHaveLength(3);
    expect(monitorCalls.every((call) => call.headers.authorization === undefined)).toBe(true);
    expect(posts(fake.calls)).toHaveLength(1);
  });

  it('maps a failed copy with a name conflict', async () => {
    const { c } = client((call) =>
      call.url.startsWith(GRAPH)
        ? accepted()
        : json({ status: 'failed', error: { code: 'nameAlreadyExists', message: 'x' } }),
    );
    await expect(c.copy('/x', {}, 'a.txt', readItem)).rejects.toThrow(NameConflictError);
  });

  it('reports another failure generically', async () => {
    const { c } = client((call) =>
      call.url.startsWith(GRAPH)
        ? accepted()
        : json({ status: 'failed', error: { code: 'other', message: 'private' } }),
    );
    const err = (await c.copy('/x', {}, 'a', readItem).catch((e: unknown) => e)) as Error;
    expect(err).toBeInstanceOf(GraphApiError);
    expect(err.message).not.toContain('private');
  });

  it('gives up after 60 s without repeating the copy', async () => {
    const { fake, c } = client((call) =>
      call.url.startsWith(GRAPH) ? accepted() : json({ status: 'inProgress' }, 202),
    );
    await expect(c.copy('/x', {}, 'a', readItem)).rejects.toThrow(CopyStillRunningError);
    expect(posts(fake.calls)).toHaveLength(1);
    expect(fake.calls.filter((call) => call.url === MONITOR)).toHaveLength(30);
  });

  it('keeps polling through a failed monitor read', async () => {
    let polls = 0;
    const { c } = client((call) => {
      if (call.url.startsWith(GRAPH)) return accepted();
      if (polls++ === 0) throw new TypeError('fetch failed');
      return json({ status: 'completed', resourceId: 'id2' });
    });
    await expect(c.copy('/x', {}, 'a', readItem)).resolves.toEqual({ id: 'id2' });
  });

  it('retries only a 429 on the initial POST', async () => {
    let n = 0;
    const { fake, c } = client((call) => {
      if (!call.url.startsWith(GRAPH)) return json({ status: 'completed', resourceId: 'i' });
      return n++ === 0 ? json({}, 429) : accepted();
    });
    await c.copy('/x', {}, 'a', readItem);
    expect(posts(fake.calls)).toHaveLength(2);

    const failed = client(() => graphError(500, 'x'));
    await expect(failed.c.copy('/x', {}, 'a', readItem)).rejects.toThrow(GraphApiError);
    expect(posts(failed.fake.calls)).toHaveLength(1);
  });

  it('fails when Graph gives no monitor URL', async () => {
    const { c } = client(() => empty(202));
    await expect(c.copy('/x', {}, 'a', readItem)).rejects.toThrow(GraphApiError);
  });
});
```

- [ ] **Step 2: Run them and watch them fail.**

Run: `npx vitest run src/onedrive/__tests__/graph-client.copy.test.ts`

Expected: FAIL. Test Files  1 failed (1); Tests  7 failed (7). First error: `TypeError: c.copy is not a function`.

- [ ] **Step 3: Implement.**

`src/onedrive/graph-client.ts` (modify):

```diff
diff --git a/src/onedrive/graph-client.ts b/src/onedrive/graph-client.ts
index e9b389c..27ba68c 100644
--- a/src/onedrive/graph-client.ts
+++ b/src/onedrive/graph-client.ts
@@ -2,7 +2,9 @@ import { createReadStream } from 'node:fs';
 import { Readable } from 'node:stream';
 import type { ReadableStream as WebReadableStream } from 'node:stream/web';
 import {
+  CopyStillRunningError,
   GraphApiError,
+  NameConflictError,
   NotFoundError,
   ReauthRequiredError,
   ValidationError,
@@ -39,6 +41,14 @@ export interface GraphRequestOptions {
 export const FRAGMENT_SIZE = 10 * 1024 * 1024;
 const MAX_FRAGMENT_RETRIES = 5;
 const SESSION_LOST = Symbol('session lost');
+const COPY_POLL_MS = 2000;
+const COPY_TIMEOUT_MS = 60_000;
+
+interface CopyMonitor {
+  status?: string;
+  resourceId?: string;
+  error?: { code?: string; message?: string };
+}
 
 export interface UploadRequest {
   /** Path of the `createUploadSession` action. */
@@ -274,6 +284,50 @@ export class GraphClient {
     }
   }
 
+  /**
+   * Starts a copy and waits for it. Once Graph has accepted it (202) it is never repeated; only a
+   * 429 on the initial POST is retried (spec §7.3).
+   */
+  async copy<T>(
+    path: string,
+    body: unknown,
+    target: string,
+    readItem: (id: string) => Promise<T>,
+  ): Promise<T> {
+    const res = await this.send('POST', `${GRAPH_BASE}${path}`, {
+      retry: 'create',
+      body,
+      target,
+    });
+    await res.body?.cancel();
+    const monitor = res.headers.get('location');
+    if (!monitor) throw new GraphApiError(res.status);
+    const started = this.now();
+    for (;;) {
+      await this.sleep(COPY_POLL_MS);
+      const state = await this.readCopyMonitor(monitor);
+      if (state?.status === 'completed' && state.resourceId) return readItem(state.resourceId);
+      if (state?.status === 'failed') {
+        const { code, message } = state.error ?? {};
+        if (code?.toLowerCase() === 'namealreadyexists' || /already exists/i.test(message ?? '')) {
+          throw new NameConflictError(target);
+        }
+        throw new GraphApiError(undefined);
+      }
+      if (this.now() - started >= COPY_TIMEOUT_MS) throw new CopyStillRunningError(target);
+    }
+  }
+
+  /** The monitor URL is pre-authenticated. A failed read just means "ask again". */
+  private async readCopyMonitor(url: string): Promise<CopyMonitor | undefined> {
+    try {
+      const res = await this.fetch(url, { method: 'GET' });
+      return (await res.json()) as CopyMonitor;
+    } catch {
+      return undefined;
+    }
+  }
+
   private bodyStream(res: Response): Readable {
     if (!res.body) throw new GraphApiError(res.status);
     return Readable.fromWeb(res.body as WebReadableStream);
```

- [ ] **Step 4: Run them and watch them pass.**

Run: `npx vitest run src/onedrive/__tests__/graph-client.copy.test.ts`

Expected: PASS. Test Files  1 passed (1); Tests  7 passed (7).

- [ ] **Step 5: Format and run the whole check.**

Run: `npx prettier --write src/onedrive/__tests__/graph-client.copy.test.ts src/onedrive/graph-client.ts` then `npm run check`

Expected: exit 0, `Tests  1184 passed | 6 skipped (1190)`.

- [ ] **Step 6: Commit.**

```bash
git add src/onedrive/__tests__/graph-client.copy.test.ts src/onedrive/graph-client.ts
git commit -m "feat(onedrive): copy monitor in GraphClient" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01UgKFZHQfQhzVqDYowSyGaA"
```


---

## Chunk 9: File provider

### Task 13: `FileProvider` and `resolveUploadPath`

**Spec:** §3.1. Moves the neutral types out of `file-service.ts`; `FileService` now implements the interface. No behaviour change.

**Files:**
- Create: `src/files/file-provider.ts`, `src/files/local-paths.ts`
- Modify: `src/files/file-service.ts`
- Test: `src/files/__tests__/local-paths.test.ts`

- [ ] **Step 1: Write the failing tests.**

`src/files/__tests__/local-paths.test.ts` (create):

```ts
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { ValidationError } from '../../errors.js';
import { clampPageSize } from '../file-provider.js';
import { resolveUploadPath } from '../local-paths.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'local-paths-'));
});

describe('resolveUploadPath', () => {
  it('returns the absolute path and size', async () => {
    const file = path.join(dir, 'a.txt');
    await writeFile(file, 'abc');
    await expect(resolveUploadPath(file)).resolves.toEqual({ localPath: file, size: 3 });
  });

  it.each([
    ['relative paths', () => 'a.txt', /absolute/],
    ['missing files', () => path.join(dir, 'none'), /Cannot read/],
    ['folders', () => dir, /not a regular file/],
  ])('rejects %s', async (_name, input, message) => {
    await expect(resolveUploadPath(input())).rejects.toThrow(ValidationError);
    await expect(resolveUploadPath(input())).rejects.toThrow(message);
  });
});

describe('clampPageSize', () => {
  it('clamps to 1..200 and defaults to 50', () => {
    expect(clampPageSize(undefined)).toBe(50);
    expect(clampPageSize(0)).toBe(1);
    expect(clampPageSize(999)).toBe(200);
  });
});
```

- [ ] **Step 2: Run them and watch them fail.**

Run: `npx vitest run src/files/__tests__/local-paths.test.ts`

Expected: FAIL. Test Files  1 failed (1); Tests  no tests. First error: Failed to load `../file-provider.js` (the module does not exist yet).

- [ ] **Step 3: Implement.**

`src/files/file-provider.ts` (create):

```ts
import type { DriveFile } from '../drive/drive-adapter.js';
import type { ExportFormat } from './export-formats.js';
import type { SearchCriteria } from './query.js';

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

export function clampPageSize(pageSize: number | undefined): number {
  return Math.min(Math.max(Math.trunc(pageSize ?? DEFAULT_PAGE_SIZE), 1), MAX_PAGE_SIZE);
}

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

export interface AccountInput {
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

export interface UploadInput extends AccountInput {
  localPath: string;
  parentId?: string;
  name?: string;
  convertToGoogle?: boolean;
}

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

/** `getMetadata` on OneDrive: `FileSummary` plus what Graph can report. */
export interface OneDriveMetadata extends FileSummary {
  createdTime?: string;
  webViewLink?: string;
  trashed?: boolean;
  owners?: Array<{ displayName?: string; emailAddress?: string }>;
}

export type FileMetadata = DriveFile | OneDriveMetadata;

export interface ExistingFile {
  id: string;
  name: string;
  size?: number;
  modifiedTime?: string;
  modifiedBy?: string;
}

export type ReplaceAnswer = 'overwrite' | 'cancel' | 'no_answer';
export type ConfirmReplace = (existing: ExistingFile) => Promise<ReplaceAnswer>;

export interface UploadOptions {
  confirmReplace?: ConfirmReplace;
}

/** A successful result: nothing was written and Claude should not retry. */
export interface UploadCancelled {
  cancelled: true;
  reason: 'user' | 'no_answer';
  existing: ExistingFile;
}

/** The file operations behind the `drive_*` tools (spec §3.1). */
export interface FileProvider {
  list(input: ListInput): Promise<ListResult>;
  search(input: SearchInput): Promise<ListResult>;
  getMetadata(input: FileRef): Promise<FileMetadata>;
  createFolder(input: CreateFolderInput): Promise<FileSummary>;
  move(input: MoveInput): Promise<FileSummary>;
  rename(input: RenameInput): Promise<FileSummary>;
  copy(input: CopyInput): Promise<FileSummary>;
  delete(input: DeleteInput): Promise<DeleteResult>;
  restore(input: FileRef): Promise<FileSummary>;
  upload(input: UploadInput, options?: UploadOptions): Promise<FileSummary | UploadCancelled>;
  download(input: DownloadInput): Promise<DownloadResult>;
}
```

`src/files/file-service.ts` (modify):

```diff
diff --git a/src/files/file-service.ts b/src/files/file-service.ts
index 8cc04cc..72e447e 100644
--- a/src/files/file-service.ts
+++ b/src/files/file-service.ts
@@ -1,5 +1,4 @@
 import { createReadStream } from 'node:fs';
-import { stat } from 'node:fs/promises';
 import path from 'node:path';
 import type { AuditOp, AuditSink } from '../audit/audit-log.js';
 import { OperationRunner } from '../core/operation.js';
@@ -8,10 +7,29 @@ import type { DriveFile, DriveFileList } from '../drive/drive-adapter.js';
 import { NotFoundError, ValidationError } from '../errors.js';
 import { logger as defaultLogger, type Logger } from '../logger.js';
 import { statusOf } from './drive-errors.js';
-import { expandHome, resolveDestination, writeUnique } from './destination.js';
-import { GOOGLE_MIME, isGoogleNative, resolveExport, type ExportFormat } from './export-formats.js';
+import { resolveDestination, writeUnique } from './destination.js';
+import { GOOGLE_MIME, isGoogleNative, resolveExport } from './export-formats.js';
 import { openExport } from './export-stream.js';
-import { buildListQuery, buildSearchQuery, type SearchCriteria } from './query.js';
+import {
+  clampPageSize,
+  type CopyInput,
+  type CreateFolderInput,
+  type DeleteInput,
+  type DeleteResult,
+  type DownloadInput,
+  type DownloadResult,
+  type FileProvider,
+  type FileRef,
+  type FileSummary,
+  type ListInput,
+  type ListResult,
+  type MoveInput,
+  type RenameInput,
+  type SearchInput,
+  type UploadInput,
+} from './file-provider.js';
+import { resolveUploadPath } from './local-paths.js';
+import { buildListQuery, buildSearchQuery } from './query.js';
 import { type RetryClass, type RetryOptions } from './retry.js';
 import { googleTargetMime, uploadMimeType } from './upload-mime.js';
 
@@ -22,23 +40,6 @@ export const FILE_FIELDS =
 
 const DOWNLOAD_FIELDS = 'id, name, mimeType, size, webViewLink, shortcutDetails, exportLinks';
 
-const DEFAULT_PAGE_SIZE = 50;
-const MAX_PAGE_SIZE = 200;
-
-export interface FileSummary {
-  id: string;
-  name: string;
-  mimeType: string;
-  size?: number;
-  modifiedTime?: string;
-  parents?: string[];
-}
-
-export interface ListResult {
-  files: FileSummary[];
-  nextPageToken?: string;
-}
-
 export interface FileServiceDeps {
   runner: DriveRunner;
   audit: AuditSink;
@@ -47,73 +48,6 @@ export interface FileServiceDeps {
   logger?: Logger;
 }
 
-interface AccountInput {
-  account?: string;
-}
-
-export interface ListInput extends AccountInput {
-  folderId?: string;
-  pageSize?: number;
-  pageToken?: string;
-  includeTrashed?: boolean;
-}
-
-export interface SearchInput extends AccountInput, SearchCriteria {
-  pageSize?: number;
-  pageToken?: string;
-}
-
-export interface FileRef extends AccountInput {
-  fileId: string;
-}
-
-export interface CreateFolderInput extends AccountInput {
-  name: string;
-  parentId?: string;
-}
-
-export interface MoveInput extends FileRef {
-  newParentId: string;
-}
-
-export interface RenameInput extends FileRef {
-  newName: string;
-}
-
-export interface CopyInput extends FileRef {
-  parentId?: string;
-  name?: string;
-}
-
-export interface DeleteInput extends FileRef {
-  permanent?: boolean;
-}
-
-export interface DeleteResult {
-  fileId: string;
-  name?: string;
-  permanent: boolean;
-}
-
-export interface UploadInput extends AccountInput {
-  localPath: string;
-  parentId?: string;
-  name?: string;
-  convertToGoogle?: boolean;
-}
-
-export interface DownloadInput extends FileRef {
-  destPath?: string;
-  exportFormat?: ExportFormat;
-}
-
-export interface DownloadResult {
-  path: string;
-  size: number;
-  mimeType: string;
-  exportFormat: ExportFormat | null;
-}
-
 export function toSummary(file: DriveFile): FileSummary {
   return {
     id: file.id ?? '',
@@ -143,11 +77,7 @@ function toListResult(list: DriveFileList): ListResult {
   };
 }
 
-function clampPageSize(pageSize: number | undefined): number {
-  return Math.min(Math.max(Math.trunc(pageSize ?? DEFAULT_PAGE_SIZE), 1), MAX_PAGE_SIZE);
-}
-
-export class FileService {
+export class FileService implements FileProvider {
   protected readonly log: Logger;
   private readonly ops: OperationRunner;
 
@@ -323,21 +253,7 @@ export class FileService {
   }
 
   async upload(input: UploadInput): Promise<FileSummary> {
-    const expanded = expandHome(input.localPath);
-    if (!path.isAbsolute(expanded)) {
-      throw new ValidationError(`localPath must be an absolute path (got "${input.localPath}")`);
-    }
-    const localPath = path.resolve(expanded);
-    let size: number;
-    try {
-      const info = await stat(localPath);
-      if (!info.isFile()) throw new ValidationError(`${localPath} is not a regular file`);
-      size = info.size;
-    } catch (err) {
-      if (err instanceof ValidationError) throw err;
-      throw new ValidationError(`Cannot read ${localPath}`, { cause: err });
-    }
-
+    const { localPath, size } = await resolveUploadPath(input.localPath);
     const convert = input.convertToGoogle ?? false;
     const parentId = input.parentId ?? 'root';
     const requestBody = {
```

`src/files/local-paths.ts` (create):

```ts
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { ValidationError } from '../errors.js';
import { expandHome } from './destination.js';

export interface UploadPath {
  localPath: string;
  size: number;
}

/** Checks a local upload source: absolute (`~` allowed) and a regular file. */
export async function resolveUploadPath(input: string): Promise<UploadPath> {
  const expanded = expandHome(input);
  if (!path.isAbsolute(expanded)) {
    throw new ValidationError(`localPath must be an absolute path (got "${input}")`);
  }
  const localPath = path.resolve(expanded);
  try {
    const info = await stat(localPath);
    if (!info.isFile()) throw new ValidationError(`${localPath} is not a regular file`);
    return { localPath, size: info.size };
  } catch (err) {
    if (err instanceof ValidationError) throw err;
    throw new ValidationError(`Cannot read ${localPath}`, { cause: err });
  }
}
```

- [ ] **Step 4: Run them and watch them pass.**

Run: `npx vitest run src/files/__tests__/local-paths.test.ts`

Expected: PASS. Test Files  1 passed (1); Tests  5 passed (5).

- [ ] **Step 5: Format and run the whole check.**

Run: `npx prettier --write src/files/__tests__/local-paths.test.ts src/files/file-provider.ts src/files/file-service.ts src/files/local-paths.ts` then `npm run check`

Expected: exit 0, `Tests  1189 passed | 6 skipped (1195)`.

- [ ] **Step 6: Commit.**

```bash
git add src/files/__tests__/local-paths.test.ts src/files/file-provider.ts src/files/file-service.ts src/files/local-paths.ts
git commit -m "refactor(files): extract FileProvider and resolveUploadPath" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01UgKFZHQfQhzVqDYowSyGaA"
```


---

## Chunk 10: Read operations

### Task 14: `map-item` and the read operations

**Spec:** §5. `OneDriveFileService` starts with `list`, `search`, `getMetadata` and `download`, plus the cached drive info.

**Files:**
- Create: `src/onedrive/map-item.ts`, `src/onedrive/onedrive-file-service.ts`
- Test: `src/onedrive/__tests__/map-item.test.ts`, `src/onedrive/__tests__/onedrive-file-service.read.test.ts`

- [ ] **Step 1: Write the failing tests.**

`src/onedrive/__tests__/map-item.test.ts` (create):

```ts
import { describe, expect, it } from 'vitest';
import { FOLDER_MIME, PACKAGE_MIME, toExistingFile, toMetadata, toSummary } from '../map-item.js';

const FILE = {
  id: 'i1',
  name: 'a.txt',
  size: 12,
  file: { mimeType: 'text/plain' },
  lastModifiedDateTime: '2026-01-02T00:00:00Z',
  parentReference: { id: 'p1' },
};

describe('toSummary', () => {
  it('maps a file', () => {
    expect(toSummary(FILE)).toEqual({
      id: 'i1',
      name: 'a.txt',
      mimeType: 'text/plain',
      size: 12,
      modifiedTime: '2026-01-02T00:00:00Z',
      parents: ['p1'],
    });
  });

  it('reports folders and packages with their fixed types and no folder size', () => {
    expect(toSummary({ id: 'f', name: 'd', size: 99, folder: {} })).toEqual({
      id: 'f',
      name: 'd',
      mimeType: FOLDER_MIME,
    });
    expect(toSummary({ id: 'p', name: 'n', package: {} }).mimeType).toBe(PACKAGE_MIME);
  });

  it('falls back to octet-stream', () => {
    expect(toSummary({ id: 'x', name: 'y', file: {} }).mimeType).toBe('application/octet-stream');
  });
});

describe('toMetadata', () => {
  it('adds the OneDrive metadata fields', () => {
    expect(
      toMetadata({
        ...FILE,
        createdDateTime: '2026-01-01T00:00:00Z',
        webUrl: 'https://x',
        createdBy: { user: { displayName: 'Me', email: 'me@x.y' } },
      }),
    ).toMatchObject({
      createdTime: '2026-01-01T00:00:00Z',
      webViewLink: 'https://x',
      trashed: false,
      owners: [{ displayName: 'Me', emailAddress: 'me@x.y' }],
    });
  });

  it('marks deleted items', () => {
    expect(toMetadata({ ...FILE, deleted: {} }).trashed).toBe(true);
  });
});

describe('toExistingFile', () => {
  it('describes the file for the dialog', () => {
    expect(
      toExistingFile({
        ...FILE,
        lastModifiedBy: { user: { displayName: 'Ayse', email: 'a@x.y' } },
      }),
    ).toEqual({
      id: 'i1',
      name: 'a.txt',
      size: 12,
      modifiedTime: '2026-01-02T00:00:00Z',
      modifiedBy: 'Ayse',
    });
    expect(toExistingFile({ id: 'i', name: 'n' })).toEqual({ id: 'i', name: 'n' });
  });
});
```

`src/onedrive/__tests__/onedrive-file-service.read.test.ts` (create):

```ts
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { NotFoundError, UnsupportedTypeError, ValidationError } from '../../errors.js';
import { createAudit, silentLogger } from '../../files/__tests__/fakes.js';
import { OneDriveFileService } from '../onedrive-file-service.js';
import { GRAPH, fakeGraph, graphError, json, makeClient, type Responder } from './fake-graph.js';

const FILE = { id: 'i1', name: 'a.txt', size: 3, file: { mimeType: 'text/plain' } };
let downloads: string;

beforeEach(async () => {
  downloads = await mkdtemp(path.join(os.tmpdir(), 'od-read-'));
});

function service(responder: Responder) {
  const fake = fakeGraph(responder);
  const { client } = makeClient(fake);
  const svc = new OneDriveFileService({
    clients: async () => client,
    audit: createAudit(),
    downloadsDir: downloads,
    logger: silentLogger(),
  });
  return { svc, fake };
}

const REJECTIONS = /not available on OneDrive/;

describe('OneDriveFileService.list', () => {
  it('lists the root and drops remoteItem entries', async () => {
    const { svc, fake } = service(() =>
      json({
        value: [FILE, { id: 'shared', name: 's', remoteItem: {} }],
        '@odata.nextLink': `${GRAPH}/me/drive/items/x/children?$skiptoken=2`,
      }),
    );
    await expect(svc.list({ account: 'work', pageSize: 999 })).resolves.toEqual({
      files: [{ id: 'i1', name: 'a.txt', mimeType: 'text/plain', size: 3 }],
      nextPageToken: `${GRAPH}/me/drive/items/x/children?$skiptoken=2`,
    });
    expect(fake.calls[0]?.path).toMatch(/^\/me\/drive\/root\/children\?\$top=200&/);
  });

  it('encodes the folder ID', async () => {
    const { svc, fake } = service(() => json({ value: [] }));
    await svc.list({ account: 'work', folderId: 'a b' });
    expect(fake.calls.at(-1)?.path).toContain('/me/drive/items/a%20b/children');
  });

  it('treats a remote folder as not found and does not list it', async () => {
    const { svc, fake } = service(() => json({ id: 's', name: 's', remoteItem: {} }));
    await expect(svc.list({ account: 'work', folderId: 's' })).rejects.toThrow(NotFoundError);
    expect(fake.calls).toHaveLength(1);
  });

  it('refuses a separator in a folder ID without a request', async () => {
    const { svc, fake } = service(() => json({ value: [] }));
    await expect(svc.list({ account: 'work', folderId: '../x' })).rejects.toThrow(ValidationError);
    expect(fake.calls).toEqual([]);
  });

  it('rejects includeTrashed but accepts false', async () => {
    const { svc } = service(() => json({ value: [] }));
    await expect(svc.list({ account: 'work', includeTrashed: true })).rejects.toThrow(REJECTIONS);
    await expect(svc.list({ account: 'work', includeTrashed: false })).resolves.toBeDefined();
  });

  it('follows an accepted page token after fetching the drive info', async () => {
    const next = `${GRAPH}/drives/D1/items/x/children?$skiptoken=3`;
    const { svc, fake } = service((c) =>
      c.url === next
        ? json({ value: [FILE] })
        : c.path.startsWith('/me/drive/root')
          ? json({ id: 'R' })
          : json({ id: 'D1', driveType: 'personal' }),
    );
    await expect(svc.list({ account: 'work', pageToken: next })).resolves.toMatchObject({
      files: [{ id: 'i1' }],
    });
    expect(fake.calls.at(-1)?.url).toBe(next);
  });

  it('rejects a foreign page token without following it', async () => {
    const { svc, fake } = service((c) =>
      c.path.startsWith('/me/drive/root') ? json({ id: 'R' }) : json({ id: 'D1', driveType: 'x' }),
    );
    await expect(
      svc.list({ account: 'work', pageToken: 'https://evil.example/x' }),
    ).rejects.toThrow(ValidationError);
    expect(fake.calls.map((c) => c.url)).not.toContain('https://evil.example/x');
  });

  it('caches the drive info per account', async () => {
    const next = `${GRAPH}/me/drive/items/x/children?$skiptoken=3`;
    const { svc, fake } = service((c) =>
      c.url === next
        ? json({ value: [] })
        : c.path.startsWith('/me/drive/root')
          ? json({ id: 'R' })
          : json({ id: 'D1', driveType: 'x' }),
    );
    await svc.list({ account: 'work', pageToken: next });
    await svc.list({ account: 'work', pageToken: next });
    expect(fake.calls.filter((c) => c.path.startsWith('/me/drive?'))).toHaveLength(1);
  });

  it('needs the alias from the router', async () => {
    const { svc } = service(() => json({ value: [] }));
    await expect(svc.list({})).rejects.toThrow(/account alias/);
  });
});

describe('OneDriveFileService.search', () => {
  it('doubles single quotes and encodes the query', async () => {
    const { svc, fake } = service(() => json({ value: [FILE] }));
    await svc.search({ account: 'work', query: "it's a b" });
    expect(fake.calls[0]?.path).toContain("/me/drive/root/search(q='it''s%20a%20b')?");
  });

  it('drops remoteItem entries', async () => {
    const { svc } = service(() => json({ value: [{ id: 's', name: 's', remoteItem: {} }] }));
    await expect(svc.search({ account: 'work', query: 'x' })).resolves.toEqual({ files: [] });
  });

  it.each([
    ['rawQuery', { rawQuery: 'x' }],
    ['mimeType', { mimeType: 'x' }],
    ['modifiedAfter', { modifiedAfter: 'x' }],
  ])('rejects %s', async (_name, extra) => {
    const { svc } = service(() => json({ value: [] }));
    await expect(svc.search({ account: 'work', query: 'q', ...extra })).rejects.toThrow(REJECTIONS);
  });

  it('requires a query', async () => {
    const { svc } = service(() => json({ value: [] }));
    await expect(svc.search({ account: 'work' })).rejects.toThrow(/query is required/);
  });
});

describe('OneDriveFileService.getMetadata', () => {
  it('returns OneDriveMetadata', async () => {
    const { svc } = service(() => json({ ...FILE, webUrl: 'https://x' }));
    await expect(svc.getMetadata({ account: 'work', fileId: 'i1' })).resolves.toMatchObject({
      id: 'i1',
      webViewLink: 'https://x',
      trashed: false,
    });
  });

  it('treats a remote item as not found', async () => {
    const { svc } = service(() => json({ id: 's', name: 's', remoteItem: {} }));
    await expect(svc.getMetadata({ account: 'work', fileId: 's' })).rejects.toThrow(NotFoundError);
  });
});

describe('OneDriveFileService.download', () => {
  it('writes the content without overwriting', async () => {
    const { svc } = service((c) =>
      c.path.endsWith('/content') ? new Response('new') : json(FILE),
    );
    await writeFile(path.join(downloads, 'a.txt'), 'keep me');
    const result = await svc.download({ account: 'work', fileId: 'i1' });
    expect(result).toMatchObject({ exportFormat: null, mimeType: 'text/plain', size: 3 });
    expect(path.basename(result.path)).not.toBe('a.txt');
    expect(await readFile(path.join(downloads, 'a.txt'), 'utf8')).toBe('keep me');
    expect(await readFile(result.path, 'utf8')).toBe('new');
    expect((await readdir(downloads)).filter((f) => f.endsWith('.part'))).toEqual([]);
  });

  it('rejects exportFormat, folders and packages', async () => {
    const folder = service(() => json({ id: 'f', name: 'd', folder: {} }));
    await expect(
      folder.svc.download({ account: 'work', fileId: 'f', exportFormat: 'pdf' }),
    ).rejects.toThrow(REJECTIONS);
    await expect(folder.svc.download({ account: 'work', fileId: 'f' })).rejects.toThrow(
      UnsupportedTypeError,
    );
    const pack = service(() => json({ id: 'p', name: 'n', package: {} }));
    await expect(pack.svc.download({ account: 'work', fileId: 'p' })).rejects.toThrow(
      UnsupportedTypeError,
    );
  });

  it('treats a remote item as not found', async () => {
    const { svc } = service(() => json({ id: 's', name: 's', remoteItem: {} }));
    await expect(svc.download({ account: 'work', fileId: 's' })).rejects.toThrow(NotFoundError);
  });

  it('maps a missing item', async () => {
    const { svc } = service(() => graphError(404, 'itemNotFound'));
    await expect(svc.download({ account: 'work', fileId: 'x' })).rejects.toThrow(NotFoundError);
  });
});
```

- [ ] **Step 2: Run them and watch them fail.**

Run: `npx vitest run src/onedrive/__tests__/map-item.test.ts src/onedrive/__tests__/onedrive-file-service.read.test.ts`

Expected: FAIL. Test Files  2 failed (2); Tests  no tests. First error: Failed to load `../map-item.js` (the module does not exist yet).

- [ ] **Step 3: Implement.**

`src/onedrive/map-item.ts` (create):

```ts
import type { ExistingFile, FileSummary, OneDriveMetadata } from '../files/file-provider.js';

export const FOLDER_MIME = 'inode/directory';
export const PACKAGE_MIME = 'application/x-onedrive-package';
const DEFAULT_MIME = 'application/octet-stream';

interface GraphIdentity {
  displayName?: string;
  email?: string;
}

export interface GraphItem {
  id: string;
  name: string;
  size?: number;
  eTag?: string;
  webUrl?: string;
  createdDateTime?: string;
  lastModifiedDateTime?: string;
  folder?: object;
  file?: { mimeType?: string };
  package?: object;
  remoteItem?: object;
  deleted?: object;
  parentReference?: { id?: string; driveId?: string };
  createdBy?: { user?: GraphIdentity };
  lastModifiedBy?: { user?: GraphIdentity };
}

export function mimeOf(item: GraphItem): string {
  if (item.folder) return FOLDER_MIME;
  if (item.package) return PACKAGE_MIME;
  return item.file?.mimeType ?? DEFAULT_MIME;
}

export function toSummary(item: GraphItem): FileSummary {
  const parent = item.parentReference?.id;
  return {
    id: item.id,
    name: item.name,
    mimeType: mimeOf(item),
    ...(item.size !== undefined && !item.folder ? { size: item.size } : {}),
    ...(item.lastModifiedDateTime ? { modifiedTime: item.lastModifiedDateTime } : {}),
    ...(parent ? { parents: [parent] } : {}),
  };
}

export function toMetadata(item: GraphItem): OneDriveMetadata {
  const owner = item.createdBy?.user;
  return {
    ...toSummary(item),
    ...(item.createdDateTime ? { createdTime: item.createdDateTime } : {}),
    ...(item.webUrl ? { webViewLink: item.webUrl } : {}),
    trashed: item.deleted !== undefined,
    ...(owner
      ? {
          owners: [
            {
              ...(owner.displayName ? { displayName: owner.displayName } : {}),
              ...(owner.email ? { emailAddress: owner.email } : {}),
            },
          ],
        }
      : {}),
  };
}

export function toExistingFile(item: GraphItem): ExistingFile {
  const modifier = item.lastModifiedBy?.user;
  const modifiedBy = modifier?.displayName ?? modifier?.email;
  return {
    id: item.id,
    name: item.name,
    ...(item.size !== undefined ? { size: item.size } : {}),
    ...(item.lastModifiedDateTime ? { modifiedTime: item.lastModifiedDateTime } : {}),
    ...(modifiedBy ? { modifiedBy } : {}),
  };
}
```

`src/onedrive/onedrive-file-service.ts` (create):

```ts
import type { AuditOp, AuditSink } from '../audit/audit-log.js';
import { NotFoundError, UnsupportedTypeError, ValidationError } from '../errors.js';
import { resolveDestination, writeUnique } from '../files/destination.js';
import {
  clampPageSize,
  type DownloadInput,
  type DownloadResult,
  type FileRef,
  type ListInput,
  type ListResult,
  type OneDriveMetadata,
  type SearchInput,
} from '../files/file-provider.js';
import { logger as defaultLogger, type Logger } from '../logger.js';
import { itemPath, type GraphClient } from './graph-client.js';
import {
  FOLDER_MIME,
  PACKAGE_MIME,
  mimeOf,
  toMetadata,
  toSummary,
  type GraphItem,
} from './map-item.js';

export const ITEM_SELECT =
  'id,name,size,eTag,webUrl,createdDateTime,lastModifiedDateTime,file,folder,package,remoteItem,deleted,parentReference,createdBy,lastModifiedBy';

export interface OneDriveFileServiceDeps {
  clients: (alias: string) => Promise<GraphClient>;
  audit: AuditSink;
  downloadsDir: string;
  logger?: Logger;
}

interface DriveInfo {
  driveId: string;
  driveType: string;
  rootId: string;
}

interface GraphPage {
  value?: GraphItem[];
  '@odata.nextLink'?: string;
}

function rejectOption(name: string): never {
  throw new ValidationError(`${name}: this option is not available on OneDrive accounts`);
}

function toResult(page: GraphPage): ListResult {
  return {
    files: (page.value ?? []).filter((item) => !item.remoteItem).map(toSummary),
    ...(page['@odata.nextLink'] ? { nextPageToken: page['@odata.nextLink'] } : {}),
  };
}

/** The `drive_*` operations on a user's own OneDrive through Graph (spec §5). */
export class OneDriveFileService {
  protected readonly log: Logger;
  private readonly driveInfos = new Map<string, Promise<DriveInfo>>();

  constructor(protected readonly deps: OneDriveFileServiceDeps) {
    this.log = deps.logger ?? defaultLogger;
  }

  async list(input: ListInput): Promise<ListResult> {
    if (input.includeTrashed) rejectOption('includeTrashed');
    const { client, alias } = await this.client(input.account);
    if (input.pageToken) return this.nextPage(client, alias, input.pageToken);
    const folder = input.folderId ?? 'root';
    await this.assertOwnItem(client, folder);
    const query = `$top=${clampPageSize(input.pageSize)}&$select=${ITEM_SELECT}`;
    return toResult(await client.get<GraphPage>(`${itemPath(folder)}/children?${query}`, folder));
  }

  async search(input: SearchInput): Promise<ListResult> {
    if (input.rawQuery !== undefined) rejectOption('rawQuery');
    if (input.mimeType !== undefined) rejectOption('mimeType');
    if (input.modifiedAfter !== undefined) rejectOption('modifiedAfter');
    const { client, alias } = await this.client(input.account);
    if (input.pageToken) return this.nextPage(client, alias, input.pageToken);
    if (!input.query?.trim()) throw new ValidationError('query is required on OneDrive accounts');
    const q = encodeURIComponent(input.query.replaceAll("'", "''"));
    const query = `$top=${clampPageSize(input.pageSize)}&$select=${ITEM_SELECT}`;
    return toResult(await client.get<GraphPage>(`/me/drive/root/search(q='${q}')?${query}`));
  }

  async getMetadata(input: FileRef): Promise<OneDriveMetadata> {
    const { client } = await this.client(input.account);
    return toMetadata(await this.readItem(client, input.fileId));
  }

  async download(input: DownloadInput): Promise<DownloadResult> {
    if (input.exportFormat !== undefined) rejectOption('exportFormat');
    const { client } = await this.client(input.account);
    const item = await this.readItem(client, input.fileId);
    if (item.folder) throw new UnsupportedTypeError(FOLDER_MIME);
    if (item.package) throw new UnsupportedTypeError(PACKAGE_MIME);
    const destination = await resolveDestination({
      ...(input.destPath !== undefined ? { destPath: input.destPath } : {}),
      defaultDir: this.deps.downloadsDir,
      driveName: item.name,
      fileId: item.id,
    });
    const written = await writeUnique(destination, () =>
      client.download(`${itemPath(item.id)}/content`, item.name),
    );
    return { path: written.path, size: written.size, mimeType: mimeOf(item), exportFormat: null };
  }

  /** `FileRouter` always passes the account's alias. */
  protected async client(
    account: string | undefined,
  ): Promise<{ client: GraphClient; alias: string }> {
    if (!account) throw new ValidationError('OneDrive operations need an account alias');
    return { client: await this.deps.clients(account), alias: account };
  }

  /** Reads an item of the user's own drive; `remoteItem` entries are out of reach (spec §2). */
  protected async readItem(client: GraphClient, id: string): Promise<GraphItem> {
    const item = await client.get<GraphItem>(`${itemPath(id)}?$select=${ITEM_SELECT}`, id);
    if (item.remoteItem) throw new NotFoundError(id);
    return item;
  }

  /** Reads the ID once, so a `remoteItem` counts as not found; `root` is always the user's own. */
  protected async assertOwnItem(client: GraphClient, id: string): Promise<void> {
    if (id !== 'root') await this.readItem(client, id);
  }

  /** `driveId`, `driveType` and the real root ID, cached per account for the process lifetime. */
  protected driveInfo(client: GraphClient, alias: string): Promise<DriveInfo> {
    let info = this.driveInfos.get(alias);
    if (!info) {
      info = this.fetchDriveInfo(client);
      info.catch(() => this.driveInfos.delete(alias));
      this.driveInfos.set(alias, info);
    }
    return info;
  }

  private async fetchDriveInfo(client: GraphClient): Promise<DriveInfo> {
    const [drive, root] = await Promise.all([
      client.get<{ id: string; driveType: string }>('/me/drive?$select=id,driveType'),
      client.get<{ id: string }>('/me/drive/root?$select=id'),
    ]);
    return { driveId: drive.id, driveType: drive.driveType, rootId: root.id };
  }

  private async nextPage(client: GraphClient, alias: string, token: string): Promise<ListResult> {
    const { driveId } = await this.driveInfo(client, alias);
    client.checkPageToken(token, driveId);
    return toResult(await client.page<GraphPage>(token));
  }

  /** Writes an audit entry; failures are logged, never thrown (the change already happened). */
  protected async recordAudit(
    alias: string,
    op: AuditOp,
    file: { id?: string; name?: string },
    details: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.deps.audit.record({
        account: alias,
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

- [ ] **Step 4: Run them and watch them pass.**

Run: `npx vitest run src/onedrive/__tests__/map-item.test.ts src/onedrive/__tests__/onedrive-file-service.read.test.ts`

Expected: PASS. Test Files  2 passed (2); Tests  27 passed (27).

- [ ] **Step 5: Format and run the whole check.**

Run: `npx prettier --write src/onedrive/__tests__/map-item.test.ts src/onedrive/__tests__/onedrive-file-service.read.test.ts src/onedrive/map-item.ts src/onedrive/onedrive-file-service.ts` then `npm run check`

Expected: exit 0, `Tests  1216 passed | 6 skipped (1222)`.

- [ ] **Step 6: Commit.**

```bash
git add src/onedrive/__tests__/map-item.test.ts src/onedrive/__tests__/onedrive-file-service.read.test.ts src/onedrive/map-item.ts src/onedrive/onedrive-file-service.ts
git commit -m "feat(onedrive): map driveItems and the read operations" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01UgKFZHQfQhzVqDYowSyGaA"
```


---

## Chunk 11: File mutations

### Task 15: Create folder, rename, move, copy, delete, restore

**Spec:** §5, §5.1, §5.2. Preflight name checks for `PATCH`, and audit records with the alias.

**Files:**
- Modify: `src/onedrive/onedrive-file-service.ts`
- Test: `src/onedrive/__tests__/onedrive-file-service.mutations.test.ts`

- [ ] **Step 1: Write the failing tests.**

`src/onedrive/__tests__/onedrive-file-service.mutations.test.ts` (create):

```ts
import { describe, expect, it, beforeEach } from 'vitest';
import type { AuditEntry, AuditSink } from '../../audit/audit-log.js';
import {
  CopyStillRunningError,
  GraphApiError,
  NameConflictError,
  NotFoundError,
  ValidationError,
} from '../../errors.js';
import { silentLogger } from '../../files/__tests__/fakes.js';
import { OneDriveFileService } from '../onedrive-file-service.js';
import {
  empty,
  fakeGraph,
  graphError,
  json,
  makeClient,
  type FakeCall,
  type Responder,
} from './fake-graph.js';

const ITEM = { id: 'i1', name: 'a.txt', file: {}, parentReference: { id: 'p1', driveId: 'D1' } };
let entries: Array<Omit<AuditEntry, 'ts'>>;
const audit: AuditSink = {
  record: async (entry) => void entries.push(entry),
};

beforeEach(() => {
  entries = [];
});

function drive(call: FakeCall): Response | undefined {
  if (call.path.startsWith('/me/drive?')) return json({ id: 'D1', driveType: 'personal' });
  if (call.path === '/me/drive/root?$select=id') return json({ id: 'ROOT' });
  return undefined;
}

function service(responder: Responder, extra: Parameters<typeof makeClient>[1] = {}) {
  const fake = fakeGraph((c) => drive(c) ?? responder(c));
  const { client } = makeClient(fake, extra);
  const svc = new OneDriveFileService({
    clients: async () => client,
    audit,
    downloadsDir: '/tmp/unused',
    logger: silentLogger(),
  });
  return { svc, fake };
}

const notFound = (): Response => graphError(404, 'itemNotFound');
const of = (calls: FakeCall[], method: string): FakeCall[] =>
  calls.filter((c) => c.method === method);
const bodyOf = (call: FakeCall | undefined): unknown => JSON.parse(call?.text ?? 'null');
const account = 'work';

describe('createFolder', () => {
  it('fails on a conflict and audits with the alias', async () => {
    const { svc, fake } = service(() => json({ id: 'f', name: 'd', folder: {} }));
    await expect(svc.createFolder({ account, name: 'd' })).resolves.toMatchObject({
      mimeType: 'inode/directory',
    });
    expect(fake.calls[0]?.path).toMatch(/^\/me\/drive\/root\/children/);
    expect(bodyOf(fake.calls[0])).toEqual({
      name: 'd',
      folder: {},
      '@microsoft.graph.conflictBehavior': 'fail',
    });
    expect(entries[0]).toMatchObject({
      account,
      op: 'create_folder',
      details: { parentId: 'root' },
    });
  });

  it('maps a conflict', async () => {
    const { svc } = service(() => graphError(409, 'nameAlreadyExists'));
    await expect(svc.createFolder({ account, name: 'd' })).rejects.toThrow(NameConflictError);
    expect(entries).toEqual([]);
  });
});

describe('rename', () => {
  const route =
    (preflight: () => Response, renamed = ITEM): Responder =>
    (c) => {
      if (c.method === 'PATCH') return json({ ...renamed, name: 'b.txt' });
      if (c.path.includes('b.txt')) return preflight();
      return json(ITEM);
    };

  it('reads the current parent, checks the name and renames', async () => {
    const { svc, fake } = service(route(notFound));
    await expect(svc.rename({ account, fileId: 'i1', newName: 'b.txt' })).resolves.toMatchObject({
      name: 'b.txt',
    });
    expect(fake.calls[1]?.path).toBe('/me/drive/items/p1:/b.txt?$select=id');
    expect(bodyOf(of(fake.calls, 'PATCH')[0])).toEqual({ name: 'b.txt' });
    expect(entries[0]).toMatchObject({
      op: 'rename',
      details: { oldName: 'a.txt', newName: 'b.txt' },
    });
  });

  it('refuses when another item has the name, sending no PATCH', async () => {
    const { svc, fake } = service(route(() => json({ id: 'other' })));
    await expect(svc.rename({ account, fileId: 'i1', newName: 'b.txt' })).rejects.toThrow(
      NameConflictError,
    );
    expect(of(fake.calls, 'PATCH')).toEqual([]);
  });

  it('allows a case-only rename, which finds itself', async () => {
    const { svc, fake } = service(route(() => json({ id: 'i1' })));
    await svc.rename({ account, fileId: 'i1', newName: 'b.txt' });
    expect(of(fake.calls, 'PATCH')).toHaveLength(1);
  });

  it('aborts on a preflight failure other than 404', async () => {
    const { svc, fake } = service(route(() => graphError(403, 'accessDenied')));
    await expect(svc.rename({ account, fileId: 'i1', newName: 'b.txt' })).rejects.toThrow(
      /permission/,
    );
    expect(of(fake.calls, 'PATCH')).toEqual([]);
  });

  it('maps a 409 from the PATCH', async () => {
    const { svc } = service((c) =>
      c.method === 'PATCH' ? graphError(409, 'nameAlreadyExists') : route(notFound)(c),
    );
    await expect(svc.rename({ account, fileId: 'i1', newName: 'b.txt' })).rejects.toThrow(
      NameConflictError,
    );
  });

  it('refuses the root folder', async () => {
    const { svc } = service(() => json({ id: 'r', name: 'root', folder: {} }));
    await expect(svc.rename({ account, fileId: 'root', newName: 'x' })).rejects.toThrow(
      ValidationError,
    );
  });
});

describe('move', () => {
  const route =
    (preflight: () => Response = notFound): Responder =>
    (c) => {
      if (c.method === 'PATCH') return json({ ...ITEM, parentReference: { id: 'p2' } });
      if (c.path.includes(':/a.txt')) return preflight();
      return json(ITEM);
    };

  it('uses the target folder for the preflight and audits the old parent', async () => {
    const { svc, fake } = service(route());
    await svc.move({ account, fileId: 'i1', newParentId: 'p2' });
    expect(fake.calls.some((c) => c.path === '/me/drive/items/p2:/a.txt?$select=id')).toBe(true);
    expect(bodyOf(of(fake.calls, 'PATCH')[0])).toEqual({ parentReference: { id: 'p2' } });
    expect(entries[0]).toMatchObject({
      op: 'move',
      details: { oldParents: ['p1'], newParentId: 'p2' },
    });
  });

  it('replaces root by the real ID', async () => {
    const { svc, fake } = service(route());
    await svc.move({ account, fileId: 'i1', newParentId: 'root' });
    expect(bodyOf(of(fake.calls, 'PATCH')[0])).toEqual({ parentReference: { id: 'ROOT' } });
  });

  it('is a no-op without audit when already there, also for root', async () => {
    const { svc, fake } = service(route());
    await svc.move({ account, fileId: 'i1', newParentId: 'p1' });
    expect(of(fake.calls, 'PATCH')).toEqual([]);
    expect(entries).toEqual([]);
    const inRoot = service(() => json({ ...ITEM, parentReference: { id: 'ROOT' } }));
    await inRoot.svc.move({ account, fileId: 'i1', newParentId: 'root' });
    expect(of(inRoot.fake.calls, 'PATCH')).toEqual([]);
  });

  it('refuses a name conflict in the target, sending no PATCH', async () => {
    const { svc, fake } = service(route(() => json({ id: 'other' })));
    await expect(svc.move({ account, fileId: 'i1', newParentId: 'p2' })).rejects.toThrow(
      NameConflictError,
    );
    expect(of(fake.calls, 'PATCH')).toEqual([]);
  });

  it('aborts on a preflight failure other than 404', async () => {
    const { svc, fake } = service(route(() => graphError(500, 'x')));
    await expect(svc.move({ account, fileId: 'i1', newParentId: 'p2' })).rejects.toThrow(
      GraphApiError,
    );
    expect(of(fake.calls, 'PATCH')).toEqual([]);
  });
});

const MONITOR = 'https://monitor.example/op';

describe('copy', () => {
  const route =
    (monitor: () => Response = () => json({ status: 'completed', resourceId: 'new' })): Responder =>
    (c) => {
      if (c.method === 'POST') return empty(202, { location: MONITOR });
      if (c.url === MONITOR) return monitor();
      if (c.path.startsWith('/me/drive/items/new'))
        return json({ ...ITEM, id: 'new', name: 'copy' });
      return json(ITEM);
    };

  it('needs a name or a target folder', async () => {
    const { svc, fake } = service(route());
    await expect(svc.copy({ account, fileId: 'i1' })).rejects.toThrow(ValidationError);
    expect(fake.calls).toEqual([]);
  });

  it('sends driveId and the target and sends no conflict parameter', async () => {
    const { svc, fake } = service(route());
    await expect(svc.copy({ account, fileId: 'i1', parentId: 'p2' })).resolves.toMatchObject({
      id: 'new',
    });
    const post = of(fake.calls, 'POST')[0];
    expect(post?.path).toBe('/me/drive/items/i1/copy');
    expect(bodyOf(post)).toEqual({ parentReference: { driveId: 'D1', id: 'p2' } });
    expect(entries[0]).toMatchObject({
      op: 'copy',
      fileId: 'new',
      details: { sourceId: 'i1', parentId: 'p2' },
    });
  });

  it('uses the current parent when only a name is given', async () => {
    const { svc, fake } = service(route());
    await svc.copy({ account, fileId: 'i1', name: 'b.txt' });
    expect(bodyOf(of(fake.calls, 'POST')[0])).toEqual({
      parentReference: { driveId: 'D1', id: 'p1' },
      name: 'b.txt',
    });
  });

  it('replaces root by the real ID', async () => {
    const { svc, fake } = service(route());
    await svc.copy({ account, fileId: 'i1', parentId: 'root' });
    expect(bodyOf(of(fake.calls, 'POST')[0])).toEqual({
      parentReference: { driveId: 'D1', id: 'ROOT' },
    });
  });

  it('marks the audit record pending when the copy keeps running', async () => {
    let clock = 0;
    const { svc } = service(
      route(() => json({ status: 'inProgress' }, 202)),
      {
        now: () => clock,
        sleep: async (ms) => {
          clock += ms;
        },
      },
    );
    await expect(svc.copy({ account, fileId: 'i1', parentId: 'p2' })).rejects.toThrow(
      CopyStillRunningError,
    );
    expect(entries[0]).toMatchObject({ op: 'copy', fileId: 'i1', details: { pending: true } });
  });

  it('copies a folder', async () => {
    const folder = { name: 'dir', folder: {}, parentReference: { id: 'p1', driveId: 'D1' } };
    const { svc, fake } = service((c) => {
      if (c.method === 'POST') return empty(202, { location: MONITOR });
      if (c.url === MONITOR) return json({ status: 'completed', resourceId: 'd2' });
      return json({ ...folder, id: c.path.includes('/items/d2') ? 'd2' : 'd1' });
    });
    await expect(svc.copy({ account, fileId: 'd1', parentId: 'p2' })).resolves.toMatchObject({
      id: 'd2',
      mimeType: 'inode/directory',
    });
    expect(of(fake.calls, 'POST')[0]?.path).toBe('/me/drive/items/d1/copy');
  });

  it('audits a completed copy even when reading the new item fails', async () => {
    const { svc } = service((c) => {
      if (c.method === 'POST') return empty(202, { location: MONITOR });
      if (c.url === MONITOR) return json({ status: 'completed', resourceId: 'new' });
      if (c.path.startsWith('/me/drive/items/new')) return graphError(500, 'x');
      return json(ITEM);
    });
    await expect(
      svc.copy({ account, fileId: 'i1', parentId: 'p2', name: 'c.txt' }),
    ).rejects.toThrow(GraphApiError);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      op: 'copy',
      fileId: 'new',
      name: 'c.txt',
      details: { sourceId: 'i1', parentId: 'p2' },
    });
  });
});

describe('delete', () => {
  it('sends the item to the recycle bin', async () => {
    const { svc, fake } = service((c) => (c.method === 'DELETE' ? empty() : json(ITEM)));
    await expect(svc.delete({ account, fileId: 'i1' })).resolves.toEqual({
      fileId: 'i1',
      name: 'a.txt',
      permanent: false,
    });
    expect(of(fake.calls, 'DELETE')[0]?.path).toBe('/me/drive/items/i1');
    expect(entries[0]).toMatchObject({ op: 'delete', details: { permanent: false } });
  });

  it('refuses the root folder', async () => {
    const { svc, fake } = service(() => json({ id: 'r', name: 'root', folder: {} }));
    await expect(svc.delete({ account, fileId: 'root' })).rejects.toThrow(ValidationError);
    expect(of(fake.calls, 'DELETE')).toEqual([]);
  });

  it('rejects permanent, accepts false', async () => {
    const { svc } = service((c) => (c.method === 'DELETE' ? empty() : json(ITEM)));
    await expect(svc.delete({ account, fileId: 'i1', permanent: true })).rejects.toThrow(
      /not available on OneDrive/,
    );
    await expect(svc.delete({ account, fileId: 'i1', permanent: false })).resolves.toBeDefined();
  });

  it('counts a 404 after a failed attempt as success', async () => {
    let n = 0;
    const { svc } = service((c) => {
      if (c.method !== 'DELETE') return json(ITEM);
      return n++ === 0 ? graphError(500, 'x') : notFound();
    });
    await expect(svc.delete({ account, fileId: 'i1' })).resolves.toMatchObject({ fileId: 'i1' });
    expect(entries).toHaveLength(1);
  });
});

describe('restore', () => {
  it('restores on a personal drive', async () => {
    const { svc, fake } = service(() => json(ITEM));
    await expect(svc.restore({ account, fileId: 'i1' })).resolves.toMatchObject({ id: 'i1' });
    expect(of(fake.calls, 'POST')[0]?.path).toBe('/me/drive/items/i1/restore');
    expect(entries[0]).toMatchObject({ op: 'restore' });
  });

  it('points a business drive to the web recycle bin', async () => {
    const fake = fakeGraph((c) =>
      c.path.startsWith('/me/drive?')
        ? json({ id: 'D', driveType: 'business' })
        : json({ id: 'R' }),
    );
    const { client } = makeClient(fake);
    const svc = new OneDriveFileService({
      clients: async () => client,
      audit,
      downloadsDir: '/x',
      logger: silentLogger(),
    });
    await expect(svc.restore({ account, fileId: 'i1' })).rejects.toThrow(/OneDrive website/);
    expect(of(fake.calls, 'POST')).toEqual([]);
  });
});

describe('audit failures', () => {
  it('never fail the operation', async () => {
    const svc = new OneDriveFileService({
      clients: async () =>
        makeClient(fakeGraph(() => json({ id: 'f', name: 'd', folder: {} }))).client,
      audit: { record: () => Promise.reject(new Error('disk')) },
      downloadsDir: '/x',
      logger: silentLogger(),
    });
    await expect(svc.createFolder({ account, name: 'd' })).resolves.toBeDefined();
  });
});

describe('a remoteItem counts as not found', () => {
  const remoteOr: Responder = (c) =>
    c.path.startsWith('/me/drive/items/shared')
      ? json({ id: 'shared', name: 's', remoteItem: {} })
      : json(ITEM);

  it.each<[string, (svc: OneDriveFileService) => Promise<unknown>]>([
    ['createFolder parent', (s) => s.createFolder({ account, name: 'd', parentId: 'shared' })],
    ['rename', (s) => s.rename({ account, fileId: 'shared', newName: 'b.txt' })],
    ['move source', (s) => s.move({ account, fileId: 'shared', newParentId: 'p2' })],
    ['move target', (s) => s.move({ account, fileId: 'i1', newParentId: 'shared' })],
    ['delete', (s) => s.delete({ account, fileId: 'shared' })],
    ['copy source with a name only', (s) => s.copy({ account, fileId: 'shared', name: 'c' })],
    ['copy source with a target', (s) => s.copy({ account, fileId: 'shared', parentId: 'p2' })],
    ['copy target', (s) => s.copy({ account, fileId: 'i1', parentId: 'shared' })],
  ])('%s', async (_name, run) => {
    const { svc, fake } = service(remoteOr);
    await expect(run(svc)).rejects.toThrow(NotFoundError);
    expect(fake.calls.filter((c) => c.method !== 'GET')).toEqual([]);
  });

  it('reads root as the own drive without a check', async () => {
    const { svc, fake } = service(() => json({ id: 'f', name: 'd', folder: {} }));
    await svc.createFolder({ account, name: 'd', parentId: 'root' });
    expect(fake.calls.filter((c) => c.method === 'GET')).toEqual([]);
  });
});

describe('unsafe path values', () => {
  it.each(['.', '..', 'a/b', 'a\\b'])(
    'rename refuses the name %s without a request',
    async (newName) => {
      const { svc, fake } = service(() => json(ITEM));
      await expect(svc.rename({ account, fileId: 'i1', newName })).rejects.toThrow(ValidationError);
      expect(fake.calls).toEqual([]);
    },
  );

  it.each(['.', '..', 'a/b', 'a\\b'])(
    'delete refuses the ID %s without a request',
    async (fileId) => {
      const { svc, fake } = service(() => json(ITEM));
      await expect(svc.delete({ account, fileId })).rejects.toThrow(ValidationError);
      expect(fake.calls).toEqual([]);
    },
  );
});
```

- [ ] **Step 2: Run them and watch them fail.**

Run: `npx vitest run src/onedrive/__tests__/onedrive-file-service.mutations.test.ts`

Expected: FAIL. Test Files  1 failed (1); Tests  44 failed (44). First error: `TypeError: svc.createFolder is not a function`.

- [ ] **Step 3: Implement.**

`src/onedrive/onedrive-file-service.ts` (modify):

```diff
diff --git a/src/onedrive/onedrive-file-service.ts b/src/onedrive/onedrive-file-service.ts
index c7750c9..3561920 100644
--- a/src/onedrive/onedrive-file-service.ts
+++ b/src/onedrive/onedrive-file-service.ts
@@ -1,18 +1,31 @@
 import type { AuditOp, AuditSink } from '../audit/audit-log.js';
-import { NotFoundError, UnsupportedTypeError, ValidationError } from '../errors.js';
+import {
+  CopyStillRunningError,
+  NameConflictError,
+  NotFoundError,
+  UnsupportedTypeError,
+  ValidationError,
+} from '../errors.js';
 import { resolveDestination, writeUnique } from '../files/destination.js';
 import {
   clampPageSize,
+  type CopyInput,
+  type CreateFolderInput,
+  type DeleteInput,
+  type DeleteResult,
   type DownloadInput,
   type DownloadResult,
   type FileRef,
+  type FileSummary,
   type ListInput,
   type ListResult,
+  type MoveInput,
   type OneDriveMetadata,
+  type RenameInput,
   type SearchInput,
 } from '../files/file-provider.js';
 import { logger as defaultLogger, type Logger } from '../logger.js';
-import { itemPath, type GraphClient } from './graph-client.js';
+import { assertSafeName, childPath, itemPath, type GraphClient } from './graph-client.js';
 import {
   FOLDER_MIME,
   PACKAGE_MIME,
@@ -108,6 +121,156 @@ export class OneDriveFileService {
     return { path: written.path, size: written.size, mimeType: mimeOf(item), exportFormat: null };
   }
 
+  async createFolder(input: CreateFolderInput): Promise<FileSummary> {
+    const { client, alias } = await this.client(input.account);
+    const parentId = input.parentId ?? 'root';
+    await this.assertOwnItem(client, parentId);
+    const created = await client.json<GraphItem>(
+      'POST',
+      `${itemPath(parentId)}/children?$select=${ITEM_SELECT}`,
+      {
+        retry: 'create',
+        target: input.name,
+        body: { name: input.name, folder: {}, '@microsoft.graph.conflictBehavior': 'fail' },
+      },
+    );
+    await this.recordAudit(alias, 'create_folder', created, { parentId });
+    return toSummary(created);
+  }
+
+  async rename(input: RenameInput): Promise<FileSummary> {
+    assertSafeName(input.newName);
+    const { client, alias } = await this.client(input.account);
+    const item = await this.readItem(client, input.fileId);
+    const parentId = item.parentReference?.id;
+    if (!parentId) throw new ValidationError('The root folder cannot be renamed');
+    await this.assertNameFree(client, parentId, input.newName, item.id);
+    const renamed = await client.json<GraphItem>(
+      'PATCH',
+      `${itemPath(item.id)}?$select=${ITEM_SELECT}`,
+      { retry: 'idempotent', target: input.newName, body: { name: input.newName } },
+    );
+    await this.recordAudit(alias, 'rename', renamed, {
+      oldName: item.name,
+      newName: input.newName,
+    });
+    return toSummary(renamed);
+  }
+
+  async move(input: MoveInput): Promise<FileSummary> {
+    const { client, alias } = await this.client(input.account);
+    const item = await this.readItem(client, input.fileId);
+    const { rootId } = await this.driveInfo(client, alias);
+    const targetId = input.newParentId === 'root' ? rootId : input.newParentId;
+    const parent = item.parentReference?.id;
+    if (parent === targetId) return toSummary(item);
+    await this.assertOwnItem(client, input.newParentId);
+    await this.assertNameFree(client, targetId, item.name, item.id);
+    const moved = await client.json<GraphItem>(
+      'PATCH',
+      `${itemPath(item.id)}?$select=${ITEM_SELECT}`,
+      { retry: 'idempotent', target: item.name, body: { parentReference: { id: targetId } } },
+    );
+    await this.recordAudit(alias, 'move', moved, {
+      oldParents: parent ? [parent] : [],
+      newParentId: input.newParentId,
+    });
+    return toSummary(moved);
+  }
+
+  async copy(input: CopyInput): Promise<FileSummary> {
+    if (input.name === undefined && input.parentId === undefined) {
+      throw new ValidationError('Give a name or a target folder for the copy on OneDrive');
+    }
+    const { client, alias } = await this.client(input.account);
+    const { driveId, rootId } = await this.driveInfo(client, alias);
+    const source = await this.readItem(client, input.fileId);
+    const parentId =
+      input.parentId === 'root' ? rootId : (input.parentId ?? source.parentReference?.id);
+    if (input.parentId !== undefined) await this.assertOwnItem(client, input.parentId);
+    if (!parentId) throw new ValidationError('The root folder cannot be copied');
+    const target = input.name ?? input.fileId;
+    const details = { sourceId: input.fileId, parentId: input.parentId ?? null };
+    try {
+      const copied = await client.copy<GraphItem>(
+        `${itemPath(input.fileId)}/copy`,
+        { parentReference: { driveId, id: parentId }, ...(input.name ? { name: input.name } : {}) },
+        target,
+        (id) =>
+          this.readItem(client, id).catch(async (err: unknown) => {
+            // The copy exists even though it could not be read back.
+            await this.recordAudit(
+              alias,
+              'copy',
+              { id, ...(input.name ? { name: input.name } : {}) },
+              details,
+            );
+            throw err;
+          }),
+      );
+      await this.recordAudit(alias, 'copy', copied, details);
+      return toSummary(copied);
+    } catch (err) {
+      if (err instanceof CopyStillRunningError) {
+        await this.recordAudit(
+          alias,
+          'copy',
+          { id: input.fileId, ...(input.name ? { name: input.name } : {}) },
+          { ...details, pending: true },
+        );
+      }
+      throw err;
+    }
+  }
+
+  async delete(input: DeleteInput): Promise<DeleteResult> {
+    if (input.permanent) rejectOption('permanent');
+    const { client, alias } = await this.client(input.account);
+    const item = await this.readItem(client, input.fileId);
+    if (!item.parentReference?.id) throw new ValidationError('The root folder cannot be deleted');
+    await client.json('DELETE', itemPath(item.id), {
+      retry: 'idempotent',
+      target: item.name,
+      notFoundOnRepeatIsOk: true,
+    });
+    await this.recordAudit(alias, 'delete', item, { permanent: false });
+    return { fileId: item.id, name: item.name, permanent: false };
+  }
+
+  async restore(input: FileRef): Promise<FileSummary> {
+    const { client, alias } = await this.client(input.account);
+    const { driveType } = await this.driveInfo(client, alias);
+    if (driveType === 'business') {
+      throw new ValidationError(
+        'Restore works on personal OneDrive only; on a work or school account restore the item from the recycle bin on the OneDrive website.',
+      );
+    }
+    const restored = await client.json<GraphItem>('POST', `${itemPath(input.fileId)}/restore`, {
+      retry: 'create',
+      target: input.fileId,
+      body: {},
+    });
+    await this.recordAudit(alias, 'restore', restored, {});
+    return toSummary(restored);
+  }
+
+  /**
+   * Graph documents no conflict option for PATCH, so the name is checked first. Finding the item
+   * itself (a case-only rename) is fine; any failure other than 404 aborts (spec §5.1).
+   */
+  private async assertNameFree(
+    client: GraphClient,
+    parentId: string,
+    name: string,
+    itemId: string,
+  ): Promise<void> {
+    const found = await client.getOrNull<GraphItem>(
+      `${childPath(parentId, name)}?$select=id`,
+      name,
+    );
+    if (found && found.id !== itemId) throw new NameConflictError(name);
+  }
+
   /** `FileRouter` always passes the account's alias. */
   protected async client(
     account: string | undefined,
```

- [ ] **Step 4: Run them and watch them pass.**

Run: `npx vitest run src/onedrive/__tests__/onedrive-file-service.mutations.test.ts`

Expected: PASS. Test Files  1 passed (1); Tests  44 passed (44).

- [ ] **Step 5: Format and run the whole check.**

Run: `npx prettier --write src/onedrive/__tests__/onedrive-file-service.mutations.test.ts src/onedrive/onedrive-file-service.ts` then `npm run check`

Expected: exit 0, `Tests  1260 passed | 6 skipped (1266)`.

- [ ] **Step 6: Commit.**

```bash
git add src/onedrive/__tests__/onedrive-file-service.mutations.test.ts src/onedrive/onedrive-file-service.ts
git commit -m "feat(onedrive): create folder, rename, move, copy, delete and restore" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01UgKFZHQfQhzVqDYowSyGaA"
```


---

## Chunk 12: Upload and conflict dialog

### Task 16: Upload with the conflict flow

**Spec:** §6. Nothing is written before an `overwrite`. The class now implements `FileProvider`.

**Files:**
- Modify: `src/onedrive/onedrive-file-service.ts`
- Test: `src/onedrive/__tests__/onedrive-file-service.upload.test.ts`

- [ ] **Step 1: Write the failing tests.**

`src/onedrive/__tests__/onedrive-file-service.upload.test.ts` (create):

```ts
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuditEntry } from '../../audit/audit-log.js';
import {
  NameConflictError,
  NotFoundError,
  TargetChangedError,
  ValidationError,
} from '../../errors.js';
import { silentLogger } from '../../files/__tests__/fakes.js';
import type { ConfirmReplace } from '../../files/file-provider.js';
import { OneDriveFileService } from '../onedrive-file-service.js';
import {
  empty,
  fakeGraph,
  graphError,
  json,
  makeClient,
  type FakeCall,
  type Responder,
} from './fake-graph.js';

const account = 'work';
const UPLOAD_URL = 'https://upload.example/s';
const CHILD = '/me/drive/items/p1:/a.txt';
const EXISTING = {
  id: 'old',
  name: 'a.txt',
  size: 9,
  eTag: 'etag1',
  file: {},
  lastModifiedDateTime: '2026-01-01T00:00:00Z',
  lastModifiedBy: { user: { displayName: 'Ayse' } },
};
const NEW = { id: 'new', name: 'a.txt', size: 5, file: {}, parentReference: { id: 'p1' } };
const notFound = (): Response => graphError(404, 'itemNotFound');
const session = (): Response => json({ uploadUrl: UPLOAD_URL });

let entries: Array<Omit<AuditEntry, 'ts'>>;
let localPath: string;
let emptyPath: string;

beforeEach(async () => {
  entries = [];
  const dir = await mkdtemp(path.join(os.tmpdir(), 'od-upload-'));
  localPath = path.join(dir, 'a.txt');
  emptyPath = path.join(dir, 'empty.txt');
  await writeFile(localPath, 'hello');
  await writeFile(emptyPath, '');
});

function service(responder: Responder) {
  const fake = fakeGraph((c) =>
    c.path.startsWith('/me/drive/items/p1?')
      ? json({ id: 'p1', name: 'p', folder: {} })
      : responder(c),
  );
  const { client } = makeClient(fake);
  const svc = new OneDriveFileService({
    clients: async () => client,
    audit: { record: async (e) => void entries.push(e) },
    downloadsDir: '/x',
    logger: silentLogger(),
  });
  return { svc, fake };
}

const isRead = (c: FakeCall): boolean => c.method === 'GET' && c.path.startsWith(CHILD);
const writes = (calls: FakeCall[]): FakeCall[] =>
  calls.filter((c) => c.method !== 'GET' && c.method !== 'DELETE');
const input = () => ({ account, localPath, parentId: 'p1' });

/** New file, no conflict: read 404, session, one fragment. */
const clean: Responder = (c) => {
  if (isRead(c)) return notFound();
  if (c.path.endsWith('createUploadSession')) return session();
  return json(NEW, 201);
};

describe('upload of a new file', () => {
  it('reads first, creates a session with fail and uploads', async () => {
    const { svc, fake } = service(clean);
    await expect(svc.upload(input())).resolves.toMatchObject({ id: 'new' });
    expect(fake.calls.map((c) => c.method)).toEqual(['GET', 'GET', 'POST', 'PUT']);
    expect(fake.calls[2]?.path).toBe(`${CHILD}:/createUploadSession`);
    expect(JSON.parse(fake.calls[2]?.text ?? '')).toEqual({
      item: { '@microsoft.graph.conflictBehavior': 'fail' },
    });
    expect(fake.calls[3]?.bytes?.toString()).toBe('hello');
    expect(entries[0]).toMatchObject({
      account,
      op: 'upload',
      details: { size: 5, replaced: false },
    });
  });

  it('uses the local file name and root by default', async () => {
    const { svc, fake } = service((c) =>
      c.method === 'GET'
        ? notFound()
        : c.path.endsWith('createUploadSession')
          ? session()
          : json(NEW, 201),
    );
    await svc.upload({ account, localPath });
    expect(fake.calls[0]?.path).toContain('/me/drive/root:/a.txt?');
  });

  it('sends an empty file with a PUT and conflictBehavior=fail', async () => {
    const { svc, fake } = service((c) => (isRead(c) ? notFound() : json(NEW, 201)));
    await svc.upload({ ...input(), localPath: emptyPath, name: 'a.txt' });
    expect(fake.calls.map((c) => c.method)).toEqual(['GET', 'GET', 'PUT']);
    expect(fake.calls[2]?.path).toBe(`${CHILD}:/content?@microsoft.graph.conflictBehavior=fail`);
  });

  it('aborts on a read failure other than 404', async () => {
    const { svc, fake } = service(() => graphError(403, 'accessDenied'));
    await expect(svc.upload(input())).rejects.toThrow(/permission/);
    expect(writes(fake.calls)).toEqual([]);
  });

  it('rejects convertToGoogle, accepts false', async () => {
    const { svc } = service(clean);
    await expect(svc.upload({ ...input(), convertToGoogle: true })).rejects.toThrow(
      /not available on OneDrive/,
    );
    await expect(svc.upload({ ...input(), convertToGoogle: false })).resolves.toBeDefined();
  });

  it('treats a remote target folder as not found and writes nothing', async () => {
    const { svc, fake } = service(() => json({ id: 'shared', name: 's', remoteItem: {} }));
    await expect(svc.upload({ account, localPath, parentId: 'shared' })).rejects.toThrow(
      NotFoundError,
    );
    expect(fake.calls).toHaveLength(1);
  });

  it.each(['.', '..', 'a/b', 'a\\b'])('refuses the name %s without a request', async (name) => {
    const { svc, fake } = service(clean);
    await expect(svc.upload({ ...input(), name })).rejects.toThrow(ValidationError);
    expect(fake.calls).toEqual([]);
  });

  it('checks the local path before any request', async () => {
    const { svc, fake } = service(clean);
    await expect(svc.upload({ ...input(), localPath: 'relative.txt' })).rejects.toThrow(
      ValidationError,
    );
    expect(fake.calls).toEqual([]);
  });
});

describe('upload onto an existing name', () => {
  const conflict: Responder = (c) => {
    if (isRead(c)) return json(EXISTING);
    if (c.path.endsWith('createUploadSession')) return session();
    return json({ ...NEW, id: 'old' });
  };

  it('fails without confirmReplace and writes nothing', async () => {
    const { svc, fake } = service(conflict);
    await expect(svc.upload(input())).rejects.toThrow(NameConflictError);
    expect(writes(fake.calls)).toEqual([]);
  });

  it('refuses a folder or package, offering no choice', async () => {
    const confirmReplace = vi.fn<ConfirmReplace>(async () => 'overwrite');
    for (const facet of [{ folder: {} }, { package: {} }, { remoteItem: {} }]) {
      const { svc, fake } = service(() => json({ ...EXISTING, file: undefined, ...facet }));
      await expect(svc.upload(input(), { confirmReplace })).rejects.toThrow(NameConflictError);
      expect(writes(fake.calls)).toEqual([]);
    }
    expect(confirmReplace).not.toHaveBeenCalled();
  });

  it.each([
    ['cancel', 'user'],
    ['no_answer', 'no_answer'],
  ] as const)('%s returns UploadCancelled and writes nothing', async (answer, reason) => {
    const { svc, fake } = service(conflict);
    const confirmReplace = vi.fn<ConfirmReplace>(async () => answer);
    await expect(svc.upload(input(), { confirmReplace })).resolves.toEqual({
      cancelled: true,
      reason,
      existing: {
        id: 'old',
        name: 'a.txt',
        size: 9,
        modifiedTime: '2026-01-01T00:00:00Z',
        modifiedBy: 'Ayse',
      },
    });
    expect(writes(fake.calls)).toEqual([]);
    expect(entries).toEqual([]);
  });

  it('overwrite uses If-Match, replace and starts over', async () => {
    const { svc, fake } = service(conflict);
    await svc.upload(input(), { confirmReplace: async () => 'overwrite' });
    const create = fake.calls.find((c) => c.path.endsWith('createUploadSession'));
    expect(create?.path).toBe('/me/drive/items/old/createUploadSession');
    expect(create?.headers['if-match']).toBe('etag1');
    expect(JSON.parse(create?.text ?? '')).toEqual({
      item: { '@microsoft.graph.conflictBehavior': 'replace' },
    });
    expect(entries[0]).toMatchObject({ op: 'upload', details: { replaced: true } });
  });

  it('overwrite of an empty file is a conditional PUT', async () => {
    const { svc, fake } = service((c) => (isRead(c) ? json(EXISTING) : json(NEW)));
    await svc.upload(
      { ...input(), localPath: emptyPath, name: 'a.txt' },
      { confirmReplace: async () => 'overwrite' },
    );
    const put = fake.calls.find((c) => c.method === 'PUT');
    expect(put?.path).toBe('/me/drive/items/old/content');
    expect(put?.headers['if-match']).toBe('etag1');
  });

  it('a 412 on overwrite raises TargetChangedError asking to check the file', async () => {
    const { svc } = service((c) =>
      isRead(c) ? json(EXISTING) : graphError(412, 'resourceModified'),
    );
    const err = (await svc
      .upload(input(), { confirmReplace: async () => 'overwrite' })
      .catch((e: unknown) => e)) as Error;
    expect(err).toBeInstanceOf(TargetChangedError);
    expect(err.message).toMatch(/Check the file/);
  });
});

describe('a conflict that appears after the first read', () => {
  let reads: number;
  beforeEach(() => {
    reads = 0;
  });
  const race =
    (at: Responder): Responder =>
    (c) => {
      if (isRead(c)) return reads++ === 0 ? notFound() : json(EXISTING);
      return at(c);
    };

  it('a 409 at session creation enters the question', async () => {
    const { svc } = service(race(() => graphError(409, 'nameAlreadyExists')));
    const confirmReplace = vi.fn<ConfirmReplace>(async () => 'cancel');
    await expect(svc.upload(input(), { confirmReplace })).resolves.toMatchObject({
      cancelled: true,
    });
    expect(confirmReplace).toHaveBeenCalledOnce();
  });

  it('a 409 on the last fragment deletes the session first', async () => {
    const { svc, fake } = service(
      race((c) => {
        if (c.path.endsWith('createUploadSession')) return session();
        if (c.method === 'DELETE') return empty();
        return graphError(409, 'nameAlreadyExists');
      }),
    );
    const confirmReplace = vi.fn<ConfirmReplace>(async () => 'cancel');
    await svc.upload(input(), { confirmReplace });
    const del = fake.calls.findIndex((c) => c.method === 'DELETE');
    const lastRead = fake.calls.map(isRead).lastIndexOf(true);
    expect(del).toBeGreaterThan(-1);
    expect(del).toBeLessThan(lastRead);
  });

  it('a 409 on an empty file enters the question', async () => {
    const { svc } = service(race(() => graphError(409, 'nameAlreadyExists')));
    const confirmReplace = vi.fn<ConfirmReplace>(async () => 'cancel');
    await svc.upload({ ...input(), localPath: emptyPath, name: 'a.txt' }, { confirmReplace });
    expect(confirmReplace).toHaveBeenCalledOnce();
  });

  it('a lost final response, a restart and a 409 end in the question', async () => {
    let creates = 0;
    let fragments = 0;
    const { svc } = service(
      race((c) => {
        if (c.path.endsWith('createUploadSession')) {
          return creates++ === 0 ? session() : graphError(409, 'nameAlreadyExists');
        }
        if (c.method === 'GET') return notFound();
        if (fragments++ === 0) throw new TypeError('fetch failed');
        return notFound();
      }),
    );
    const confirmReplace = vi.fn<ConfirmReplace>(async () => 'cancel');
    await expect(svc.upload(input(), { confirmReplace })).resolves.toMatchObject({
      cancelled: true,
      existing: { id: 'old' },
    });
    expect(creates).toBe(2);
    expect(confirmReplace).toHaveBeenCalledOnce();
  });

  it('a vanished item raises TargetChangedError', async () => {
    const { svc, fake } = service((c) =>
      isRead(c) ? notFound() : graphError(409, 'nameAlreadyExists'),
    );
    await expect(svc.upload(input(), { confirmReplace: async () => 'overwrite' })).rejects.toThrow(
      TargetChangedError,
    );
    expect(fake.calls.filter((c) => c.method === 'PUT')).toEqual([]);
  });
});
```

- [ ] **Step 2: Run them and watch them fail.**

Run: `npx vitest run src/onedrive/__tests__/onedrive-file-service.upload.test.ts`

Expected: FAIL. Test Files  1 failed (1); Tests  23 failed (23). First error: `TypeError: svc.upload is not a function`.

- [ ] **Step 3: Implement.**

`src/onedrive/onedrive-file-service.ts` (modify):

```diff
diff --git a/src/onedrive/onedrive-file-service.ts b/src/onedrive/onedrive-file-service.ts
index 3561920..4087231 100644
--- a/src/onedrive/onedrive-file-service.ts
+++ b/src/onedrive/onedrive-file-service.ts
@@ -1,8 +1,10 @@
+import path from 'node:path';
 import type { AuditOp, AuditSink } from '../audit/audit-log.js';
 import {
   CopyStillRunningError,
   NameConflictError,
   NotFoundError,
+  TargetChangedError,
   UnsupportedTypeError,
   ValidationError,
 } from '../errors.js';
@@ -15,6 +17,7 @@ import {
   type DeleteResult,
   type DownloadInput,
   type DownloadResult,
+  type FileProvider,
   type FileRef,
   type FileSummary,
   type ListInput,
@@ -23,13 +26,18 @@ import {
   type OneDriveMetadata,
   type RenameInput,
   type SearchInput,
+  type UploadCancelled,
+  type UploadInput,
+  type UploadOptions,
 } from '../files/file-provider.js';
+import { resolveUploadPath } from '../files/local-paths.js';
 import { logger as defaultLogger, type Logger } from '../logger.js';
 import { assertSafeName, childPath, itemPath, type GraphClient } from './graph-client.js';
 import {
   FOLDER_MIME,
   PACKAGE_MIME,
   mimeOf,
+  toExistingFile,
   toMetadata,
   toSummary,
   type GraphItem,
@@ -68,7 +76,7 @@ function toResult(page: GraphPage): ListResult {
 }
 
 /** The `drive_*` operations on a user's own OneDrive through Graph (spec §5). */
-export class OneDriveFileService {
+export class OneDriveFileService implements FileProvider {
   protected readonly log: Logger;
   private readonly driveInfos = new Map<string, Promise<DriveInfo>>();
 
@@ -121,6 +129,103 @@ export class OneDriveFileService {
     return { path: written.path, size: written.size, mimeType: mimeOf(item), exportFormat: null };
   }
 
+  /** Spec §6. The dialog runs outside any retry; nothing is written before an `overwrite`. */
+  async upload(
+    input: UploadInput,
+    options: UploadOptions = {},
+  ): Promise<FileSummary | UploadCancelled> {
+    if (input.convertToGoogle) rejectOption('convertToGoogle');
+    const { localPath, size } = await resolveUploadPath(input.localPath);
+    const { client, alias } = await this.client(input.account);
+    const parentId = input.parentId ?? 'root';
+    const name = input.name ?? path.basename(localPath);
+    const target = childPath(parentId, name);
+    await this.assertOwnItem(client, parentId);
+    const read = (): Promise<GraphItem | null> =>
+      client.getOrNull<GraphItem>(`${target}?$select=${ITEM_SELECT}`, name);
+    const details = { localPath, parentId, size };
+
+    let existing = await read();
+    if (!existing) {
+      try {
+        const created = await this.createNew(client, target, name, localPath, size);
+        await this.recordAudit(alias, 'upload', created, { ...details, replaced: false });
+        return toSummary(created);
+      } catch (err) {
+        if (!(err instanceof NameConflictError)) throw err;
+      }
+      existing = await read();
+      if (!existing) throw new TargetChangedError(name);
+    }
+    if (existing.folder || existing.package || existing.remoteItem) {
+      throw new NameConflictError(name);
+    }
+    if (!options.confirmReplace) throw new NameConflictError(name);
+    if (!existing.eTag) throw new TargetChangedError(name);
+
+    const answer = await options.confirmReplace(toExistingFile(existing));
+    if (answer !== 'overwrite') {
+      return {
+        cancelled: true,
+        reason: answer === 'cancel' ? 'user' : 'no_answer',
+        existing: toExistingFile(existing),
+      };
+    }
+    const replaced = await this.replace(client, existing, existing.eTag, localPath, size);
+    await this.recordAudit(alias, 'upload', replaced, { ...details, replaced: true });
+    return toSummary(replaced);
+  }
+
+  /** `fail` is the real guard: a conflict raises NameConflictError even after the first read. */
+  private createNew(
+    client: GraphClient,
+    target: string,
+    name: string,
+    localPath: string,
+    size: number,
+  ): Promise<GraphItem> {
+    if (size === 0) {
+      return client.json<GraphItem>(
+        'PUT',
+        `${target}:/content?@microsoft.graph.conflictBehavior=fail`,
+        { retry: 'create', target: name },
+      );
+    }
+    return client.upload<GraphItem>({
+      createPath: `${target}:/createUploadSession`,
+      body: { item: { '@microsoft.graph.conflictBehavior': 'fail' } },
+      localPath,
+      size,
+      target: name,
+    });
+  }
+
+  private replace(
+    client: GraphClient,
+    existing: GraphItem,
+    eTag: string,
+    localPath: string,
+    size: number,
+  ): Promise<GraphItem> {
+    const headers = { 'If-Match': eTag };
+    const item = itemPath(existing.id);
+    if (size === 0) {
+      return client.json<GraphItem>('PUT', `${item}/content`, {
+        retry: 'create',
+        target: existing.name,
+        headers,
+      });
+    }
+    return client.upload<GraphItem>({
+      createPath: `${item}/createUploadSession`,
+      body: { item: { '@microsoft.graph.conflictBehavior': 'replace' } },
+      headers,
+      localPath,
+      size,
+      target: existing.name,
+    });
+  }
+
   async createFolder(input: CreateFolderInput): Promise<FileSummary> {
     const { client, alias } = await this.client(input.account);
     const parentId = input.parentId ?? 'root';
```

- [ ] **Step 4: Run them and watch them pass.**

Run: `npx vitest run src/onedrive/__tests__/onedrive-file-service.upload.test.ts`

Expected: PASS. Test Files  1 passed (1); Tests  23 passed (23).

- [ ] **Step 5: Format and run the whole check.**

Run: `npx prettier --write src/onedrive/__tests__/onedrive-file-service.upload.test.ts src/onedrive/onedrive-file-service.ts` then `npm run check`

Expected: exit 0, `Tests  1283 passed | 6 skipped (1289)`.

- [ ] **Step 6: Commit.**

```bash
git add src/onedrive/__tests__/onedrive-file-service.upload.test.ts src/onedrive/onedrive-file-service.ts
git commit -m "feat(onedrive): upload with the conflict flow" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01UgKFZHQfQhzVqDYowSyGaA"
```

### Task 17: Overwrite / Cancel dialog

**Spec:** §6. The `ConfirmReplace` callback over MCP form elicitation with a 10 minute timeout.

**Files:**
- Create: `src/mcp/confirm-replace.ts`
- Test: `src/mcp/__tests__/confirm-replace.test.ts`

- [ ] **Step 1: Write the failing tests.**

`src/mcp/__tests__/confirm-replace.test.ts` (create):

```ts
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ElicitRequestSchema, type ElicitResult } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it, vi } from 'vitest';
import { silentLogger } from '../../files/__tests__/fakes.js';
import type { ClientCapabilities } from '@modelcontextprotocol/sdk/types.js';
import {
  CONFIRM_TIMEOUT_MS,
  createConfirmReplace,
  supportsConfirmReplace,
} from '../confirm-replace.js';

const FILE = {
  id: 'i',
  name: 'a.txt',
  size: 9,
  modifiedTime: '2026-01-01T00:00:00Z',
  modifiedBy: 'Ayse',
};

async function connect(capabilities: ClientCapabilities, answer?: () => Promise<ElicitResult>) {
  const server = new McpServer({ name: 's', version: '1' });
  const client = new Client({ name: 'c', version: '1' }, { capabilities });
  const received: Array<{ message: string; requestedSchema: unknown }> = [];
  if (answer) {
    client.setRequestHandler(ElicitRequestSchema, async (request) => {
      received.push(request.params as (typeof received)[number]);
      return answer();
    });
  }
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  return { server, received };
}

const FORM = { elicitation: { form: {} } };

describe('createConfirmReplace', () => {
  it('asks with a message naming the file, size, time and modifier', async () => {
    const { server, received } = await connect(FORM, async () => ({
      action: 'accept',
      content: { choice: 'Overwrite' },
    }));
    const confirm = createConfirmReplace(server.server, silentLogger());
    await expect(confirm(FILE)).resolves.toBe('overwrite');
    expect(received[0]?.message).toMatch(/a\.txt.*9 bytes.*2026-01-01.*Ayse/);
    expect(received[0]?.requestedSchema).toMatchObject({
      properties: { choice: { enum: ['Overwrite', 'Cancel'] } },
    });
  });

  it.each([
    ['accept Cancel', { action: 'accept', content: { choice: 'Cancel' } }],
    ['decline', { action: 'decline' }],
    ['dismiss', { action: 'cancel' }],
  ] as const)('%s means cancel', async (_name, result) => {
    const { server } = await connect(FORM, async () => result);
    await expect(createConfirmReplace(server.server, silentLogger())(FILE)).resolves.toBe('cancel');
  });

  it('a failed request is no_answer', async () => {
    const { server } = await connect(FORM, async () => {
      throw new Error('boom');
    });
    await expect(createConfirmReplace(server.server, silentLogger())(FILE)).resolves.toBe(
      'no_answer',
    );
  });

  it('asks with a 10 minute timeout', async () => {
    const elicitInput = vi.fn(async () => ({ action: 'cancel' as const }));
    const server = { elicitInput } as unknown as McpServer['server'];
    await createConfirmReplace(server, silentLogger())(FILE);
    expect(elicitInput).toHaveBeenCalledWith(expect.anything(), { timeout: CONFIRM_TIMEOUT_MS });
    expect(CONFIRM_TIMEOUT_MS).toBe(600_000);
  });

  it('a timeout is no_answer', async () => {
    const server = {
      elicitInput: async () => Promise.reject(new Error('Request timed out')),
    } as unknown as McpServer['server'];
    await expect(createConfirmReplace(server, silentLogger())(FILE)).resolves.toBe('no_answer');
  });
});

describe('supportsConfirmReplace', () => {
  it('needs elicitation.form from the client', async () => {
    const yes = await connect(FORM, async () => ({ action: 'cancel' }));
    expect(supportsConfirmReplace(yes.server.server)).toBe(true);
    const no = await connect({});
    expect(supportsConfirmReplace(no.server.server)).toBe(false);
  });
});
```

- [ ] **Step 2: Run them and watch them fail.**

Run: `npx vitest run src/mcp/__tests__/confirm-replace.test.ts`

Expected: FAIL. Test Files  1 failed (1); Tests  no tests. First error: Failed to load `../confirm-replace.js` (the module does not exist yet).

- [ ] **Step 3: Implement.**

`src/mcp/confirm-replace.ts` (create):

```ts
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { ConfirmReplace, ExistingFile } from '../files/file-provider.js';
import type { Logger } from '../logger.js';

/** The user decides at their own pace; the SDK's default of 60 s is too short. */
export const CONFIRM_TIMEOUT_MS = 10 * 60_000;

function describeFile(file: ExistingFile): string {
  const size = file.size === undefined ? 'unknown size' : `${file.size} bytes`;
  const when = file.modifiedTime ? `, last modified ${file.modifiedTime}` : '';
  const who = file.modifiedBy ? ` by ${file.modifiedBy}` : '';
  return `"${file.name}" already exists on OneDrive (${size}${when}${who}). Overwrite it?`;
}

/** True when the connected client declared form elicitation, which `elicitInput` requires. */
export function supportsConfirmReplace(server: Server): boolean {
  return server.getClientCapabilities()?.elicitation?.form !== undefined;
}

/** The Overwrite / Cancel dialog behind the `ConfirmReplace` callback (spec §6). */
export function createConfirmReplace(server: Server, log: Logger): ConfirmReplace {
  return async (file) => {
    try {
      const result = await server.elicitInput(
        {
          mode: 'form',
          message: describeFile(file),
          requestedSchema: {
            type: 'object',
            properties: {
              choice: { type: 'string', title: 'Action', enum: ['Overwrite', 'Cancel'] },
            },
            required: ['choice'],
          },
        },
        { timeout: CONFIRM_TIMEOUT_MS },
      );
      if (result.action !== 'accept') return 'cancel';
      return result.content?.choice === 'Overwrite' ? 'overwrite' : 'cancel';
    } catch (err) {
      log.warn('Overwrite question got no answer', { error: err });
      return 'no_answer';
    }
  };
}
```

- [ ] **Step 4: Run them and watch them pass.**

Run: `npx vitest run src/mcp/__tests__/confirm-replace.test.ts`

Expected: PASS. Test Files  1 passed (1); Tests  8 passed (8).

- [ ] **Step 5: Format and run the whole check.**

Run: `npx prettier --write src/mcp/__tests__/confirm-replace.test.ts src/mcp/confirm-replace.ts` then `npm run check`

Expected: exit 0, `Tests  1291 passed | 6 skipped (1297)`.

- [ ] **Step 6: Commit.**

```bash
git add src/mcp/__tests__/confirm-replace.test.ts src/mcp/confirm-replace.ts
git commit -m "feat(mcp): Overwrite / Cancel dialog behind ConfirmReplace" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01UgKFZHQfQhzVqDYowSyGaA"
```


---

## Chunk 13: FileRouter and MCP wiring

### Task 18: `FileRouter`

**Spec:** §3.1. Resolves the account (strict rule) and passes the alias on.

**Files:**
- Create: `src/files/file-router.ts`
- Test: `src/files/__tests__/file-router.test.ts`

- [ ] **Step 1: Write the failing tests.**

`src/files/__tests__/file-router.test.ts` (create):

```ts
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AccountRegistry } from '../../config/account-registry.js';
import { AccountNotFoundError, ValidationError } from '../../errors.js';
import type { FileProvider } from '../file-provider.js';
import { FileRouter } from '../file-router.js';

const METHODS = [
  'list',
  'search',
  'getMetadata',
  'createFolder',
  'move',
  'rename',
  'copy',
  'delete',
  'restore',
  'upload',
  'download',
] as const;

function fakeProvider(): FileProvider {
  return Object.fromEntries(
    METHODS.map((m) => [m, vi.fn(async () => ({ from: m }))]),
  ) as unknown as FileProvider;
}

const INPUTS = { fileId: 'f', name: 'n', newName: 'x', newParentId: 'p', localPath: '/a', q: 'q' };
let registry: AccountRegistry;
let google: FileProvider;
let microsoft: FileProvider;
let router: FileRouter;

beforeEach(async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'router-'));
  registry = new AccountRegistry(path.join(dir, 'a.json'));
  await registry.add({ alias: 'g', email: 'same@example.com' });
  await registry.add({
    alias: 'ms',
    email: 'same@example.com',
    provider: 'microsoft',
    accountId: 't.o',
  });
  google = fakeProvider();
  microsoft = fakeProvider();
  router = new FileRouter({ registry, google, microsoft });
});

describe('FileRouter', () => {
  it.each(METHODS)('%s goes to the account provider with the alias', async (method) => {
    const call = router[method] as (i: unknown, o?: unknown) => Promise<unknown>;
    await call.call(router, { ...INPUTS, account: 'ms' });
    expect(microsoft[method]).toHaveBeenCalledWith(
      expect.objectContaining({ account: 'ms' }),
      ...(method === 'upload' ? [undefined] : []),
    );
    expect(google[method]).not.toHaveBeenCalled();
    await call.call(router, { ...INPUTS, account: 'g' });
    expect(google[method]).toHaveBeenCalledWith(
      expect.objectContaining({ account: 'g' }),
      ...(method === 'upload' ? [undefined] : []),
    );
  });

  it('uses the default account when none is given', async () => {
    await router.list({});
    expect(google.list).toHaveBeenCalledWith({ account: 'g' });
  });

  it('passes the upload options on', async () => {
    const confirmReplace = async (): Promise<'cancel'> => 'cancel';
    await router.upload({ localPath: '/a', account: 'ms' }, { confirmReplace });
    expect(microsoft.upload).toHaveBeenCalledWith(
      { localPath: '/a', account: 'ms' },
      { confirmReplace },
    );
  });

  it('rejects an email shared by several accounts, naming the aliases', async () => {
    await expect(router.list({ account: 'same@example.com' })).rejects.toThrow(ValidationError);
    await expect(router.list({ account: 'same@example.com' })).rejects.toThrow(/g, ms/);
  });

  it('reports an unknown account', async () => {
    await expect(router.list({ account: 'nobody' })).rejects.toThrow(AccountNotFoundError);
  });
});
```

- [ ] **Step 2: Run them and watch them fail.**

Run: `npx vitest run src/files/__tests__/file-router.test.ts`

Expected: FAIL. Test Files  1 failed (1); Tests  no tests. First error: Failed to load `../file-router.js` (the module does not exist yet).

- [ ] **Step 3: Implement.**

`src/files/file-router.ts` (create):

```ts
import { isMicrosoft, type AccountRegistry } from '../config/account-registry.js';
import type {
  AccountInput,
  CopyInput,
  CreateFolderInput,
  DeleteInput,
  DeleteResult,
  DownloadInput,
  DownloadResult,
  FileMetadata,
  FileProvider,
  FileRef,
  FileSummary,
  ListInput,
  ListResult,
  MoveInput,
  RenameInput,
  SearchInput,
  UploadCancelled,
  UploadInput,
  UploadOptions,
} from './file-provider.js';

export interface FileRouterDeps {
  registry: Pick<AccountRegistry, 'resolve'>;
  google: FileProvider;
  microsoft: FileProvider;
}

/** Picks the provider from the account record; a provider only ever sees the alias (spec §3.1). */
export class FileRouter implements FileProvider {
  constructor(private readonly deps: FileRouterDeps) {}

  private async route<I extends AccountInput>(
    input: I,
  ): Promise<{ provider: FileProvider; resolved: I & { account: string } }> {
    const record = await this.deps.registry.resolve(input.account);
    return {
      provider: isMicrosoft(record) ? this.deps.microsoft : this.deps.google,
      resolved: { ...input, account: record.alias },
    };
  }

  async list(input: ListInput): Promise<ListResult> {
    const { provider, resolved } = await this.route(input);
    return provider.list(resolved);
  }

  async search(input: SearchInput): Promise<ListResult> {
    const { provider, resolved } = await this.route(input);
    return provider.search(resolved);
  }

  async getMetadata(input: FileRef): Promise<FileMetadata> {
    const { provider, resolved } = await this.route(input);
    return provider.getMetadata(resolved);
  }

  async createFolder(input: CreateFolderInput): Promise<FileSummary> {
    const { provider, resolved } = await this.route(input);
    return provider.createFolder(resolved);
  }

  async move(input: MoveInput): Promise<FileSummary> {
    const { provider, resolved } = await this.route(input);
    return provider.move(resolved);
  }

  async rename(input: RenameInput): Promise<FileSummary> {
    const { provider, resolved } = await this.route(input);
    return provider.rename(resolved);
  }

  async copy(input: CopyInput): Promise<FileSummary> {
    const { provider, resolved } = await this.route(input);
    return provider.copy(resolved);
  }

  async delete(input: DeleteInput): Promise<DeleteResult> {
    const { provider, resolved } = await this.route(input);
    return provider.delete(resolved);
  }

  async restore(input: FileRef): Promise<FileSummary> {
    const { provider, resolved } = await this.route(input);
    return provider.restore(resolved);
  }

  async upload(
    input: UploadInput,
    options?: UploadOptions,
  ): Promise<FileSummary | UploadCancelled> {
    const { provider, resolved } = await this.route(input);
    return provider.upload(resolved, options);
  }

  async download(input: DownloadInput): Promise<DownloadResult> {
    const { provider, resolved } = await this.route(input);
    return provider.download(resolved);
  }
}
```

- [ ] **Step 4: Run them and watch them pass.**

Run: `npx vitest run src/files/__tests__/file-router.test.ts`

Expected: PASS. Test Files  1 passed (1); Tests  15 passed (15).

- [ ] **Step 5: Format and run the whole check.**

Run: `npx prettier --write src/files/__tests__/file-router.test.ts src/files/file-router.ts` then `npm run check`

Expected: exit 0, `Tests  1306 passed | 6 skipped (1312)`.

- [ ] **Step 6: Commit.**

```bash
git add src/files/__tests__/file-router.test.ts src/files/file-router.ts
git commit -m "feat(files): FileRouter picks the provider from the account" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01UgKFZHQfQhzVqDYowSyGaA"
```

### Task 19: Drive tools on `FileProvider`; compose OneDrive in `buildApp`

**Spec:** §3, §5, §6, §11. Tool text becomes provider-neutral and marks Google-only parameters. `App.googleFiles` keeps the Google live tests typed.

**Files:**
- Modify: `src/app.ts`, `src/mcp/drive-tools.ts`, `src/mcp/server.ts`, `src/mcp/shared.ts`
- Test: `src/__tests__/app.test.ts`, `src/mcp/__tests__/drive-tools.onedrive.test.ts`, `tests/e2e/content.e2e.test.ts`, `tests/e2e/drive.e2e.test.ts`, `tests/e2e/watch.e2e.test.ts`

- [ ] **Step 1: Write the failing tests.**

`src/__tests__/app.test.ts` (modify):

```diff
diff --git a/src/__tests__/app.test.ts b/src/__tests__/app.test.ts
index b699c01..f784245 100644
--- a/src/__tests__/app.test.ts
+++ b/src/__tests__/app.test.ts
@@ -3,6 +3,7 @@ import os from 'node:os';
 import path from 'node:path';
 import { afterEach, beforeEach, describe, expect, it } from 'vitest';
 import { buildApp } from '../app.js';
+import { FileRouter } from '../files/file-router.js';
 import { WatchService } from '../watch/watch-service.js';
 
 let tmp: string;
@@ -14,6 +15,12 @@ afterEach(async () => {
 });
 
 describe('buildApp', () => {
+  it('routes file operations through the FileRouter', () => {
+    const app = buildApp({ MARVIN_DRIVE_CONFIG_DIR: tmp, MARVIN_DRIVE_TOKEN_STORE: 'file' });
+    expect(app.files).toBeInstanceOf(FileRouter);
+    expect(app.paths.microsoftClient).toBe(path.join(tmp, 'microsoft-client.json'));
+  });
+
   it('wires the watch service under <configDir>/watch', () => {
     const app = buildApp({ MARVIN_DRIVE_CONFIG_DIR: tmp, MARVIN_DRIVE_TOKEN_STORE: 'file' });
     expect(app.watch).toBeInstanceOf(WatchService);
```

`src/mcp/__tests__/drive-tools.onedrive.test.ts` (create):

```ts
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it, vi } from 'vitest';
import { silentLogger } from '../../files/__tests__/fakes.js';
import type { FileProvider, UploadOptions } from '../../files/file-provider.js';
import { registerDriveTools } from '../drive-tools.js';

const FILE = { id: 'i', name: 'a.txt' };

async function connect(withElicitation: boolean) {
  const upload = vi.fn<FileProvider['upload']>(async () => ({
    id: 'new',
    name: 'a',
    mimeType: 'text/plain',
  }));
  const files = { upload } as unknown as FileProvider;
  const server = new McpServer({ name: 's', version: '1' });
  registerDriveTools(server, { files, auth: { status: async () => [] } }, silentLogger());
  const client = new Client(
    { name: 'c', version: '1' },
    { capabilities: withElicitation ? { elicitation: { form: {} } } : {} },
  );
  if (withElicitation) {
    client.setRequestHandler(ElicitRequestSchema, async () => ({
      action: 'accept',
      content: { choice: 'Cancel' },
    }));
  }
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  return { client, upload };
}

const callUpload = (client: Client) =>
  client.callTool({ name: 'drive_upload', arguments: { localPath: '/a' } });

describe('drive_upload and the overwrite dialog', () => {
  it('passes confirmReplace when the client declares form elicitation', async () => {
    const { client, upload } = await connect(true);
    await callUpload(client);
    const options = upload.mock.calls[0]?.[1] as UploadOptions;
    await expect(options.confirmReplace?.(FILE)).resolves.toBe('cancel');
  });

  it('passes no callback otherwise', async () => {
    const { client, upload } = await connect(false);
    await callUpload(client);
    expect(upload.mock.calls[0]?.[1]).toEqual({});
  });

  it('offers no overwrite parameter to the model', async () => {
    const { client } = await connect(false);
    const tool = (await client.listTools()).tools.find((t) => t.name === 'drive_upload');
    expect(Object.keys(tool?.inputSchema.properties ?? {})).toEqual([
      'account',
      'localPath',
      'parentId',
      'name',
      'convertToGoogle',
    ]);
  });

  it('marks the Google-only parameters', async () => {
    const { client } = await connect(false);
    const tools = (await client.listTools()).tools;
    const schema = (name: string, key: string): unknown =>
      (tools.find((t) => t.name === name)?.inputSchema.properties as Record<string, unknown>)[key];
    for (const [name, key] of [
      ['drive_list', 'includeTrashed'],
      ['drive_search', 'rawQuery'],
      ['drive_search', 'mimeType'],
      ['drive_search', 'modifiedAfter'],
      ['drive_download', 'exportFormat'],
      ['drive_upload', 'convertToGoogle'],
      ['drive_delete', 'permanent'],
    ] as const) {
      expect(schema(name, key)).toMatchObject({
        description: expect.stringMatching(/Google accounts only/),
      });
    }
  });
});
```

`tests/e2e/content.e2e.test.ts` (modify):

```diff
diff --git a/tests/e2e/content.e2e.test.ts b/tests/e2e/content.e2e.test.ts
index 9627bd9..e03b65e 100644
--- a/tests/e2e/content.e2e.test.ts
+++ b/tests/e2e/content.e2e.test.ts
@@ -9,7 +9,7 @@ const account = process.env.MARVIN_E2E_ACCOUNT;
 
 describe.runIf(account)('Content E2E (live)', () => {
   it('reads and edits Docs, Sheets and Slides in place', async () => {
-    const { files, docs, sheets, slides } = buildApp();
+    const { googleFiles: files, docs, sheets, slides } = buildApp();
     const tmp = await mkdtemp(path.join(os.tmpdir(), 'marvin-content-e2e-'));
     const root = await files.createFolder({ account, name: `marvin-content-e2e-${Date.now()}` });
     try {
```

`tests/e2e/drive.e2e.test.ts` (modify):

```diff
diff --git a/tests/e2e/drive.e2e.test.ts b/tests/e2e/drive.e2e.test.ts
index e29e131..0007a8c 100644
--- a/tests/e2e/drive.e2e.test.ts
+++ b/tests/e2e/drive.e2e.test.ts
@@ -8,7 +8,7 @@ const account = process.env.MARVIN_E2E_ACCOUNT;
 
 describe.runIf(account)('Drive E2E (live)', () => {
   it('folder → upload → move → rename → search → download → export → trash → restore → delete', async () => {
-    const { files } = buildApp();
+    const { googleFiles: files } = buildApp();
     const tmp = await mkdtemp(path.join(os.tmpdir(), 'marvin-e2e-'));
     const root = await files.createFolder({ account, name: `marvin-e2e-${Date.now()}` });
     try {
```

`tests/e2e/watch.e2e.test.ts` (modify):

```diff
diff --git a/tests/e2e/watch.e2e.test.ts b/tests/e2e/watch.e2e.test.ts
index ac99a70..d25bbe5 100644
--- a/tests/e2e/watch.e2e.test.ts
+++ b/tests/e2e/watch.e2e.test.ts
@@ -34,7 +34,7 @@ async function until<T>(probe: () => Promise<T | undefined>, timeoutMs: number):
 describe.runIf(account && editor)('Watch E2E (live)', () => {
   it('foreign edit → edited event with diff and push; own edit → stored, no push; comment finding', async () => {
     const app = buildApp();
-    const { files, docs } = app;
+    const { googleFiles: files, docs } = app;
     const tmp = await mkdtemp(path.join(os.tmpdir(), 'marvin-watch-e2e-'));
     // A temp watch dir (own lease): a running `marvin-drive serve` is not disturbed.
     const runner = new DriveClientFactory(app.auth);
```

- [ ] **Step 2: Run them and watch them fail.**

Run: `npx vitest run src/__tests__/app.test.ts src/mcp/__tests__/drive-tools.onedrive.test.ts`

Expected: FAIL. Test Files  2 failed (2); Tests  4 failed | 2 passed (6). First error: `AssertionError: expected FileService{ deps: { …(3) }, …(2) } to be an instance of FileRouter`.

- [ ] **Step 3: Implement.**

`src/app.ts` (modify):

```diff
diff --git a/src/app.ts b/src/app.ts
index e81f5ae..1722994 100644
--- a/src/app.ts
+++ b/src/app.ts
@@ -9,10 +9,12 @@ import {
   type LoginResult,
   type TwoStepStart,
 } from './auth/login-flow.js';
+import { MicrosoftAuth } from './auth/microsoft-auth.js';
 import { PendingLoginStore } from './auth/pending-login.js';
 import { FileAuditLog } from './audit/audit-log.js';
 import { AccountRegistry } from './config/account-registry.js';
 import { loadClientSecret, type ClientCredentials } from './config/client-secret.js';
+import { loadMicrosoftClientId } from './config/microsoft-client.js';
 import { resolvePaths, type Paths } from './config/paths.js';
 import { DocsService } from './content/docs-service.js';
 import { SheetsService } from './content/sheets-service.js';
@@ -21,7 +23,10 @@ import { DriveClientFactory } from './drive/client-factory.js';
 import { PairStore } from './sync/pair-store.js';
 import { SyncService } from './sync/sync-service.js';
 import { createLocalTrash } from './sync/trash.js';
+import { FileRouter } from './files/file-router.js';
 import { FileService } from './files/file-service.js';
+import { GraphClient } from './onedrive/graph-client.js';
+import { OneDriveFileService } from './onedrive/onedrive-file-service.js';
 import { createGoogleWatchProvider } from './watch/google/provider.js';
 import { WatchService, pollIntervalMs } from './watch/watch-service.js';
 import { WatchStore } from './watch/watch-store.js';
@@ -29,7 +34,9 @@ import { WatchStore } from './watch/watch-store.js';
 export interface App {
   paths: Paths;
   auth: AuthService;
-  files: FileService;
+  /** All accounts: picks Google or OneDrive from the account record. */
+  files: FileRouter;
+  googleFiles: FileService;
   docs: DocsService;
   sheets: SheetsService;
   slides: SlidesService;
@@ -45,9 +52,28 @@ export interface BuildAppOptions {
 /** Composition root: wires real implementations together. */
 export function buildApp(env: NodeJS.ProcessEnv = process.env, options: BuildAppOptions = {}): App {
   const paths = resolvePaths(env);
+  const registry = new AccountRegistry(paths.accounts);
+  const tokens = selectTokenStore(env, paths.tokens);
+  const pending = new PendingLoginStore(paths.pendingLogins);
+  const openUrl = async (url: string): Promise<void> => {
+    await open(url);
+  };
+  const print = (message: string): void => {
+    process.stderr.write(`${message}\n`);
+  };
+  const microsoft = new MicrosoftAuth({
+    registry,
+    tokens,
+    pending,
+    loadClientId: (): Promise<string> => loadMicrosoftClientId(paths.microsoftClient),
+    openUrl,
+    print,
+    ...(options.manualLogin ? { manual: options.manualLogin } : {}),
+  });
   const auth = new AuthService({
-    registry: new AccountRegistry(paths.accounts),
-    tokens: selectTokenStore(env, paths.tokens),
+    registry,
+    tokens,
+    microsoft,
     loadCredentials: (): Promise<ClientCredentials> => loadClientSecret(paths.clientSecret),
     login: ({ credentials, loginHint, onVerified }): Promise<LoginResult> =>
       runLoginFlow({
@@ -56,15 +82,11 @@ export function buildApp(env: NodeJS.ProcessEnv = process.env, options: BuildApp
         ...(loginHint ? { loginHint } : {}),
         onVerified,
         ...(options.manualLogin ? { manual: options.manualLogin } : {}),
-        openUrl: async (url) => {
-          await open(url);
-        },
-        print: (message) => {
-          process.stderr.write(`${message}\n`);
-        },
+        openUrl,
+        print,
       }),
     twoStep: {
-      pending: new PendingLoginStore(paths.pendingLogins),
+      pending,
       start: (credentials, loginHint): Promise<TwoStepStart> =>
         startTwoStepLogin({ ...credentials, ...(loginHint ? { loginHint } : {}) }),
       finish: (credentials, pending, redirectUrl): Promise<LoginResult> =>
@@ -73,7 +95,23 @@ export function buildApp(env: NodeJS.ProcessEnv = process.env, options: BuildApp
   });
   const runner = new DriveClientFactory(auth);
   const audit = new FileAuditLog(paths.audit);
-  const files = new FileService({ runner, audit, downloadsDir: paths.downloadsDir });
+  const googleFiles = new FileService({ runner, audit, downloadsDir: paths.downloadsDir });
+  const files = new FileRouter({
+    registry,
+    google: googleFiles,
+    microsoft: new OneDriveFileService({
+      clients: async (alias): Promise<GraphClient> => {
+        const record = await registry.resolve(alias);
+        return new GraphClient({
+          alias: record.alias,
+          accessToken: (tokenOptions): Promise<string> =>
+            microsoft.accessToken(record, tokenOptions),
+        });
+      },
+      audit,
+      downloadsDir: paths.downloadsDir,
+    }),
+  });
   const docs = new DocsService({ runner, audit });
   const sheets = new SheetsService({ runner, audit });
   const slides = new SlidesService({ runner, audit });
@@ -92,5 +130,5 @@ export function buildApp(env: NodeJS.ProcessEnv = process.env, options: BuildApp
     }),
     intervalMs: pollIntervalMs(env),
   });
-  return { paths, auth, files, docs, sheets, slides, sync, watch };
+  return { paths, auth, files, googleFiles, docs, sheets, slides, sync, watch };
 }
```

`src/mcp/drive-tools.ts` (modify):

```diff
diff --git a/src/mcp/drive-tools.ts b/src/mcp/drive-tools.ts
index 924116b..27bbd97 100644
--- a/src/mcp/drive-tools.ts
+++ b/src/mcp/drive-tools.ts
@@ -2,8 +2,9 @@ import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
 import { z } from 'zod';
 import type { AuthService } from '../auth/auth-service.js';
 import { EXPORT_FORMATS } from '../files/export-formats.js';
-import type { FileService } from '../files/file-service.js';
+import type { FileProvider } from '../files/file-provider.js';
 import type { Logger } from '../logger.js';
+import { createConfirmReplace, supportsConfirmReplace } from './confirm-replace.js';
 import { account, fileId, pageSize, pageToken, respond } from './shared.js';
 
 export const DRIVE_TOOL_NAMES = [
@@ -21,9 +22,11 @@ export const DRIVE_TOOL_NAMES = [
   'drive_restore',
 ] as const;
 
+const GOOGLE_ONLY = 'Google accounts only: not available on OneDrive accounts.';
+
 export function registerDriveTools(
   server: McpServer,
-  deps: { files: FileService; auth: Pick<AuthService, 'status'> },
+  deps: { files: FileProvider; auth: Pick<AuthService, 'status'> },
   log: Logger,
 ): void {
   const { files } = deps;
@@ -32,7 +35,7 @@ export function registerDriveTools(
     'drive_list_accounts',
     {
       description:
-        'List registered Google accounts, the default, and token status (ok / reauth_required). verify=true does a live token refresh.',
+        'List registered accounts (Google and Microsoft) with their provider, the default, and token status (ok / reauth_required). verify=true does a live token refresh.',
       inputSchema: { verify: z.boolean().optional() },
     },
     async ({ verify }) => respond(log, () => deps.auth.status(verify ?? false)),
@@ -42,13 +45,13 @@ export function registerDriveTools(
     'drive_list',
     {
       description:
-        'List files in a folder (default: My Drive root). Excludes trash unless includeTrashed.',
+        'List files in a folder (default: the drive root). Excludes trash unless includeTrashed.',
       inputSchema: {
         account,
         folderId: z.string().min(1).optional().describe('Folder ID (default "root")'),
         pageSize,
         pageToken,
-        includeTrashed: z.boolean().optional(),
+        includeTrashed: z.boolean().optional().describe(GOOGLE_ONLY),
       },
     },
     async (args) => respond(log, () => files.list(args)),
@@ -58,13 +61,13 @@ export function registerDriveTools(
     'drive_search',
     {
       description:
-        'Search files. query matches names and full text; rawQuery is raw Drive query syntax (ANDed). Excludes trash unless rawQuery mentions "trashed". Note: any mention of "trashed" in rawQuery (even inside a quoted value) disables the default trashed = false filter.',
+        'Search files. query matches names and full text; rawQuery is raw Drive query syntax (ANDed). Excludes trash unless rawQuery mentions "trashed". Note: any mention of "trashed" in rawQuery (even inside a quoted value) disables the default trashed = false filter. OneDrive accounts need query and do not accept the other filters.',
       inputSchema: {
         account,
         query: z.string().optional(),
-        mimeType: z.string().optional(),
-        modifiedAfter: z.string().optional().describe('ISO 8601 date or datetime'),
-        rawQuery: z.string().optional(),
+        mimeType: z.string().optional().describe(GOOGLE_ONLY),
+        modifiedAfter: z.string().optional().describe(`ISO 8601 date or datetime. ${GOOGLE_ONLY}`),
+        rawQuery: z.string().optional().describe(GOOGLE_ONLY),
         pageSize,
         pageToken,
       },
@@ -85,7 +88,7 @@ export function registerDriveTools(
     'drive_download',
     {
       description:
-        'Download a file to local disk and return its path. Google Docs/Sheets/Slides/Drawings are exported (defaults docx/xlsx/pptx/png). Never overwrites.',
+        'Download a file to local disk and return its path. Google Docs/Sheets/Slides/Drawings are exported (defaults docx/xlsx/pptx/png). OneNote packages cannot be downloaded from OneDrive. Never overwrites.',
       inputSchema: {
         account,
         fileId,
@@ -96,7 +99,7 @@ export function registerDriveTools(
           .describe(
             'Absolute directory (existing, or ending with "/"; "\\" also on Windows) or absolute file path; ~ allowed. Default ~/Downloads/marvin-drive/',
           ),
-        exportFormat: z.enum(EXPORT_FORMATS).optional(),
+        exportFormat: z.enum(EXPORT_FORMATS).optional().describe(GOOGLE_ONLY),
       },
     },
     async (args) => respond(log, () => files.download(args)),
@@ -106,16 +109,24 @@ export function registerDriveTools(
     'drive_upload',
     {
       description:
-        'Upload a local file. convertToGoogle turns office/text/csv files into Google Docs/Sheets/Slides.',
+        'Upload a local file. convertToGoogle turns office/text/csv files into Google Docs/Sheets/Slides. On OneDrive an existing name fails, or the user is asked Overwrite / Cancel when the client can ask; a cancelled upload is a normal result, do not retry it.',
       inputSchema: {
         account,
         localPath: z.string().min(1).describe('Absolute local file path (~/ allowed)'),
         parentId: z.string().min(1).optional().describe('Destination folder ID (default root)'),
         name: z.string().min(1).optional(),
-        convertToGoogle: z.boolean().optional(),
+        convertToGoogle: z.boolean().optional().describe(GOOGLE_ONLY),
       },
     },
-    async (args) => respond(log, () => files.upload(args)),
+    async (args) =>
+      respond(log, () =>
+        files.upload(
+          args,
+          supportsConfirmReplace(server.server)
+            ? { confirmReplace: createConfirmReplace(server.server, log) }
+            : {},
+        ),
+      ),
   );
 
   server.registerTool(
@@ -148,7 +159,8 @@ export function registerDriveTools(
   server.registerTool(
     'drive_copy',
     {
-      description: 'Copy a file (folders cannot be copied).',
+      description:
+        'Copy a file. On Google accounts folders cannot be copied. On OneDrive folders can be copied, and a name or parentId is required.',
       inputSchema: {
         account,
         fileId,
@@ -163,8 +175,12 @@ export function registerDriveTools(
     'drive_delete',
     {
       description:
-        'Delete a file or folder. Default moves it to trash (restorable for 30 days); permanent=true deletes forever.',
-      inputSchema: { account, fileId, permanent: z.boolean().optional() },
+        'Delete a file or folder. Default moves it to trash or the OneDrive recycle bin (Google: restorable for 30 days); permanent=true deletes forever.',
+      inputSchema: {
+        account,
+        fileId,
+        permanent: z.boolean().optional().describe(GOOGLE_ONLY),
+      },
     },
     async (args) => respond(log, () => files.delete(args)),
   );
@@ -172,7 +188,8 @@ export function registerDriveTools(
   server.registerTool(
     'drive_restore',
     {
-      description: 'Restore a file or folder from trash.',
+      description:
+        'Restore a file or folder from trash. OneDrive: personal accounts only (work or school: use the website recycle bin).',
       inputSchema: { account, fileId },
     },
     async (args) => respond(log, () => files.restore(args)),
```

`src/mcp/server.ts` (modify):

```diff
diff --git a/src/mcp/server.ts b/src/mcp/server.ts
index 1750d08..c10aae9 100644
--- a/src/mcp/server.ts
+++ b/src/mcp/server.ts
@@ -3,7 +3,7 @@ import type { AuthService } from '../auth/auth-service.js';
 import type { DocsService } from '../content/docs-service.js';
 import type { SheetsService } from '../content/sheets-service.js';
 import type { SlidesService } from '../content/slides-service.js';
-import type { FileService } from '../files/file-service.js';
+import type { FileProvider } from '../files/file-provider.js';
 import { logger as defaultLogger, type Logger } from '../logger.js';
 import type { SyncService } from '../sync/sync-service.js';
 import type { WatchApi } from '../watch/watch-service.js';
@@ -25,7 +25,7 @@ export const TOOL_NAMES = [
 ] as const;
 
 export interface McpDeps {
-  files: FileService;
+  files: FileProvider;
   docs: DocsService;
   sheets: SheetsService;
   slides: SlidesService;
```

`src/mcp/shared.ts` (modify):

```diff
diff --git a/src/mcp/shared.ts b/src/mcp/shared.ts
index 2c7b0d0..37d87cb 100644
--- a/src/mcp/shared.ts
+++ b/src/mcp/shared.ts
@@ -8,7 +8,10 @@ export const account = z
   .min(1)
   .optional()
   .describe('Account alias or email. Omit to use the default account.');
-export const fileId = z.string().min(1).describe('Google Drive file or folder ID');
+export const fileId = z
+  .string()
+  .min(1)
+  .describe('File or folder ID (from a Google Drive or OneDrive account)');
 export const pageSize = z
   .number()
   .int()
```

- [ ] **Step 4: Run them and watch them pass.**

Run: `npx vitest run src/__tests__/app.test.ts src/mcp/__tests__/drive-tools.onedrive.test.ts`

Expected: PASS. Test Files  2 passed (2); Tests  6 passed (6).

- [ ] **Step 5: Format and run the whole check.**

Run: `npx prettier --write src/__tests__/app.test.ts src/app.ts src/mcp/__tests__/drive-tools.onedrive.test.ts src/mcp/drive-tools.ts src/mcp/server.ts src/mcp/shared.ts tests/e2e/content.e2e.test.ts tests/e2e/drive.e2e.test.ts tests/e2e/watch.e2e.test.ts` then `npm run check`

Expected: exit 0, `Tests  1311 passed | 6 skipped (1317)`.

- [ ] **Step 6: Commit.**

```bash
git add src/__tests__/app.test.ts src/app.ts src/mcp/__tests__/drive-tools.onedrive.test.ts src/mcp/drive-tools.ts src/mcp/server.ts src/mcp/shared.ts tests/e2e/content.e2e.test.ts tests/e2e/drive.e2e.test.ts tests/e2e/watch.e2e.test.ts
git commit -m "feat(mcp): drive tools on FileProvider; compose OneDrive in buildApp" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01UgKFZHQfQhzVqDYowSyGaA"
```


---

## Chunk 14: §3.3 rejections

### Task 20: The Google-only rejections

**Spec:** §3.3. Three checks plus `authorize`, each raising `ProviderNotSupportedError`.

**Files:**
- Modify: `src/app.ts`, `src/auth/auth-service.ts`, `src/drive/client-factory.ts`, `src/sync/pair-admin.ts`, `src/sync/sync-service.ts`, `src/watch/google/provider.ts`
- Test: `src/__tests__/app.test.ts`, `src/auth/__tests__/auth-service.test.ts`, `src/drive/__tests__/client-factory.test.ts`, `src/sync/__tests__/sync-service.pairs.test.ts`, `src/watch/google/__tests__/provider.test.ts`

- [ ] **Step 1: Write the failing tests.**

`src/__tests__/app.test.ts` (modify):

```diff
diff --git a/src/__tests__/app.test.ts b/src/__tests__/app.test.ts
index f784245..81b214b 100644
--- a/src/__tests__/app.test.ts
+++ b/src/__tests__/app.test.ts
@@ -1,11 +1,19 @@
-import { mkdtemp, rm } from 'node:fs/promises';
+import { mkdir, mkdtemp, rm } from 'node:fs/promises';
 import os from 'node:os';
 import path from 'node:path';
-import { afterEach, beforeEach, describe, expect, it } from 'vitest';
+import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
 import { buildApp } from '../app.js';
+import { AccountRegistry } from '../config/account-registry.js';
+import { ProviderNotSupportedError } from '../errors.js';
+import { writeMarker } from '../sync/pair-store.js';
 import { FileRouter } from '../files/file-router.js';
 import { WatchService } from '../watch/watch-service.js';
 
+vi.mock('../sync/pair-store.js', async (original) => {
+  const actual = await original<typeof import('../sync/pair-store.js')>();
+  return { ...actual, writeMarker: vi.fn(actual.writeMarker) };
+});
+
 let tmp: string;
 beforeEach(async () => {
   tmp = await mkdtemp(path.join(os.tmpdir(), 'app-'));
@@ -15,6 +23,22 @@ afterEach(async () => {
 });
 
 describe('buildApp', () => {
+  it('refuses a Microsoft account in sync before writeMarker', async () => {
+    const app = buildApp({ MARVIN_DRIVE_CONFIG_DIR: tmp, MARVIN_DRIVE_TOKEN_STORE: 'file' });
+    await new AccountRegistry(app.paths.accounts).add({
+      alias: 'ms',
+      email: 'a@b.c',
+      provider: 'microsoft',
+      accountId: 't.o',
+    });
+    const localDir = path.join(tmp, 'Local');
+    await mkdir(localDir);
+    await expect(
+      app.sync.createPair({ name: 'docs', localDir, remoteFolderId: 'R', account: 'ms' }),
+    ).rejects.toThrow(ProviderNotSupportedError);
+    expect(writeMarker).not.toHaveBeenCalled();
+  });
+
   it('routes file operations through the FileRouter', () => {
     const app = buildApp({ MARVIN_DRIVE_CONFIG_DIR: tmp, MARVIN_DRIVE_TOKEN_STORE: 'file' });
     expect(app.files).toBeInstanceOf(FileRouter);
```

`src/auth/__tests__/auth-service.test.ts` (modify):

```diff
diff --git a/src/auth/__tests__/auth-service.test.ts b/src/auth/__tests__/auth-service.test.ts
index 0375fa0..995c8fa 100644
--- a/src/auth/__tests__/auth-service.test.ts
+++ b/src/auth/__tests__/auth-service.test.ts
@@ -4,7 +4,13 @@ import path from 'node:path';
 import { Auth } from 'googleapis';
 import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
 import { AccountRegistry } from '../../config/account-registry.js';
-import { AuthFlowError, ConfigError, ReauthRequiredError, ValidationError } from '../../errors.js';
+import {
+  AuthFlowError,
+  ConfigError,
+  ProviderNotSupportedError,
+  ReauthRequiredError,
+  ValidationError,
+} from '../../errors.js';
 import { createLogger } from '../../logger.js';
 import { AuthService, type AuthServiceDeps } from '../auth-service.js';
 import type { LoginResult } from '../login-flow.js';
@@ -479,3 +485,10 @@ describe('AuthService dispatch to the Microsoft provider', () => {
     await expect(service.addAccount(undefined, 'microsoft')).rejects.toThrow(ConfigError);
   });
 });
+
+describe('AuthService.authorize', () => {
+  it('rejects a Microsoft account', async () => {
+    await registry.add({ alias: 'ms', email: 'a@b.c', provider: 'microsoft', accountId: 't.o' });
+    await expect(service.authorize('ms')).rejects.toThrow(ProviderNotSupportedError);
+  });
+});
```

`src/drive/__tests__/client-factory.test.ts` (modify):

```diff
diff --git a/src/drive/__tests__/client-factory.test.ts b/src/drive/__tests__/client-factory.test.ts
index c2422ed..65c4534 100644
--- a/src/drive/__tests__/client-factory.test.ts
+++ b/src/drive/__tests__/client-factory.test.ts
@@ -6,7 +6,7 @@ import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
 import { AuthService } from '../../auth/auth-service.js';
 import { InMemoryTokenStore } from '../../auth/token-store.js';
 import { AccountRegistry } from '../../config/account-registry.js';
-import { ReauthRequiredError } from '../../errors.js';
+import { ProviderNotSupportedError, ReauthRequiredError } from '../../errors.js';
 import { createLogger } from '../../logger.js';
 import { DriveClientFactory, type DriveContext, type GoogleAdapters } from '../client-factory.js';
 
@@ -17,10 +17,11 @@ let tokens: InMemoryTokenStore;
 let auth: AuthService;
 let makeAdapter: Mock<(client: Auth.OAuth2Client) => GoogleAdapters>;
 let factory: DriveClientFactory;
+let registry: AccountRegistry;
 
 beforeEach(async () => {
   const dir = await mkdtemp(path.join(os.tmpdir(), 'marvin-factory-'));
-  const registry = new AccountRegistry(path.join(dir, 'accounts.json'));
+  registry = new AccountRegistry(path.join(dir, 'accounts.json'));
   await registry.add({ alias: 'emco', email: 'emco@example.com' });
   tokens = new InMemoryTokenStore();
   await tokens.set('emco@example.com', 'rt-1');
@@ -139,3 +140,33 @@ describe('DriveClientFactory', () => {
     );
   });
 });
+
+describe('DriveClientFactory with Microsoft accounts (spec §3.3)', () => {
+  const MS = {
+    alias: 'ms',
+    email: 'emco@example.com',
+    provider: 'microsoft',
+    accountId: 't.o',
+  } as const;
+
+  it('rejects the alias before reading a refresh token', async () => {
+    await registry.add(MS);
+    const read = vi.spyOn(auth, 'readRefreshToken');
+    await expect(factory.run('ms', async () => 'x')).rejects.toThrow(ProviderNotSupportedError);
+    expect(read).not.toHaveBeenCalled();
+    expect(makeAdapter).not.toHaveBeenCalled();
+  });
+
+  it('treats a shared address as the Google account', async () => {
+    await registry.add(MS);
+    await expect(factory.run('emco@example.com', async () => 'ok')).resolves.toBe('ok');
+  });
+
+  it('rejects a Microsoft default account', async () => {
+    await registry.add(MS);
+    await registry.setDefault('ms');
+    await expect(factory.run(undefined, async () => 'x')).rejects.toThrow(
+      ProviderNotSupportedError,
+    );
+  });
+});
```

`src/sync/__tests__/sync-service.pairs.test.ts` (modify):

```diff
diff --git a/src/sync/__tests__/sync-service.pairs.test.ts b/src/sync/__tests__/sync-service.pairs.test.ts
index 143b2fc..97c4196 100644
--- a/src/sync/__tests__/sync-service.pairs.test.ts
+++ b/src/sync/__tests__/sync-service.pairs.test.ts
@@ -2,7 +2,7 @@ import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promis
 import os from 'node:os';
 import path from 'node:path';
 import { afterEach, beforeEach, describe, expect, it } from 'vitest';
-import { ValidationError } from '../../errors.js';
+import { ProviderNotSupportedError, ValidationError } from '../../errors.js';
 import { createAudit, createRunner, noSleep, silentLogger } from '../../files/__tests__/fakes.js';
 import { PairStore, markerName, probeCaseInsensitive } from '../pair-store.js';
 import { SyncService } from '../sync-service.js';
@@ -42,6 +42,24 @@ async function createDocs(): Promise<void> {
 }
 
 describe('createPair', () => {
+  it('rejects an unsupported account without touching the folder', async () => {
+    const guarded = new SyncService({
+      runner: createRunner(mem.drive),
+      audit,
+      retry: noSleep,
+      logger: silentLogger(),
+      store,
+      trash: refuseTrash,
+      assertSupportedAccount: async (ref) => {
+        throw new ProviderNotSupportedError(ref ?? 'default');
+      },
+    });
+    await expect(
+      guarded.createPair({ name: 'docs', localDir: local, remoteFolderId: 'ROOT', account: 'ms' }),
+    ).rejects.toThrow(ProviderNotSupportedError);
+    expect(await readdir(local)).toEqual([]);
+  });
+
   it('stores validated googleExport preferences (defaults for omitted types)', async () => {
     await sync.createPair({
       name: 'docs',
```

`src/watch/google/__tests__/provider.test.ts` (create):

```ts
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { AccountRegistry } from '../../../config/account-registry.js';
import { ProviderNotSupportedError } from '../../../errors.js';
import {
  createAudit,
  createFakeDrive,
  createRunner,
  silentLogger,
} from '../../../files/__tests__/fakes.js';
import { emptyState, type WatchEntry } from '../../types.js';
import { listWatches, removeWatch } from '../../watch-list.js';
import { WatchStore } from '../../watch-store.js';
import { createGoogleWatchProvider } from '../provider.js';

const SHARED = 'same@example.com';
const ENTRY: WatchEntry = {
  id: 'f1',
  name: 'File',
  kind: 'other',
  folder: false,
  addedAt: '2026-01-01T00:00:00.000Z',
};

let registry: AccountRegistry;
let store: WatchStore;
let deps: Parameters<typeof removeWatch>[0];

beforeEach(async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'watch-provider-'));
  registry = new AccountRegistry(path.join(dir, 'a.json'));
  await registry.add({ alias: 'g', email: SHARED });
  await registry.add({ alias: 'ms', email: SHARED, provider: 'microsoft', accountId: 't.o' });
  store = new WatchStore({ dir: path.join(dir, 'watch') });
  await store.ensureDir();
  await store.save(SHARED, { ...emptyState(), entries: [ENTRY] });
  deps = {
    store,
    provider: createGoogleWatchProvider({
      runner: createRunner(createFakeDrive()),
      audit: createAudit(),
      resolveAccount: (ref) => registry.resolveGoogleFirst(ref),
      logger: silentLogger(),
    }),
    now: () => new Date(),
    log: silentLogger(),
  };
});

describe('Google watch provider with Microsoft accounts (spec §3.3)', () => {
  it('rejects a Microsoft alias', async () => {
    await expect(deps.provider.resolveAccount('ms')).rejects.toThrow(ProviderNotSupportedError);
  });

  it('remove with the Microsoft alias leaves the Google watch of the same address alone', async () => {
    await expect(removeWatch(deps, { fileId: 'f1', account: 'ms' })).rejects.toThrow(
      ProviderNotSupportedError,
    );
    expect((await store.load(SHARED)).entries).toHaveLength(1);
  });

  it('list with the Microsoft alias is rejected too', async () => {
    await expect(listWatches(deps, { account: 'ms' })).rejects.toThrow(ProviderNotSupportedError);
  });

  it('the shared address means the Google account', async () => {
    await expect(removeWatch(deps, { fileId: 'f1', account: SHARED })).resolves.toMatchObject({
      action: 'remove',
    });
    expect((await store.load(SHARED)).entries).toEqual([]);
  });
});
```

- [ ] **Step 2: Run them and watch them fail.**

Run: `npx vitest run src/__tests__/app.test.ts src/auth/__tests__/auth-service.test.ts src/drive/__tests__/client-factory.test.ts src/sync/__tests__/sync-service.pairs.test.ts src/watch/google/__tests__/provider.test.ts`

Expected: FAIL. Test Files  5 failed (5); Tests  8 failed | 62 passed (70). First error: `AssertionError: expected error to be instance of ProviderNotSupportedError`.

- [ ] **Step 3: Implement.**

`src/app.ts` (modify):

```diff
diff --git a/src/app.ts b/src/app.ts
index 1722994..2fc6127 100644
--- a/src/app.ts
+++ b/src/app.ts
@@ -12,7 +12,7 @@ import {
 import { MicrosoftAuth } from './auth/microsoft-auth.js';
 import { PendingLoginStore } from './auth/pending-login.js';
 import { FileAuditLog } from './audit/audit-log.js';
-import { AccountRegistry } from './config/account-registry.js';
+import { AccountRegistry, isMicrosoft } from './config/account-registry.js';
 import { loadClientSecret, type ClientCredentials } from './config/client-secret.js';
 import { loadMicrosoftClientId } from './config/microsoft-client.js';
 import { resolvePaths, type Paths } from './config/paths.js';
@@ -20,6 +20,7 @@ import { DocsService } from './content/docs-service.js';
 import { SheetsService } from './content/sheets-service.js';
 import { SlidesService } from './content/slides-service.js';
 import { DriveClientFactory } from './drive/client-factory.js';
+import { ProviderNotSupportedError } from './errors.js';
 import { PairStore } from './sync/pair-store.js';
 import { SyncService } from './sync/sync-service.js';
 import { createLocalTrash } from './sync/trash.js';
@@ -120,6 +121,10 @@ export function buildApp(env: NodeJS.ProcessEnv = process.env, options: BuildApp
     audit,
     store: new PairStore({ dir: paths.syncDir }),
     trash: createLocalTrash(),
+    assertSupportedAccount: async (ref): Promise<void> => {
+      const account = await auth.resolveAccount(ref);
+      if (isMicrosoft(account)) throw new ProviderNotSupportedError(account.alias);
+    },
   });
   const watch = new WatchService({
     store: new WatchStore({ dir: paths.watchDir }),
```

`src/auth/auth-service.ts` (modify):

```diff
diff --git a/src/auth/auth-service.ts b/src/auth/auth-service.ts
index e192178..63bd97e 100644
--- a/src/auth/auth-service.ts
+++ b/src/auth/auth-service.ts
@@ -10,7 +10,13 @@ import {
   type AccountRegistry,
 } from '../config/account-registry.js';
 import type { ClientCredentials } from '../config/client-secret.js';
-import { AuthFlowError, ConfigError, ReauthRequiredError, ValidationError } from '../errors.js';
+import {
+  AuthFlowError,
+  ConfigError,
+  ProviderNotSupportedError,
+  ReauthRequiredError,
+  ValidationError,
+} from '../errors.js';
 import { logger as defaultLogger, type Logger } from '../logger.js';
 import type { LoginResult, TwoStepStart } from './login-flow.js';
 import { readRedirectUrl, redirectError } from './loopback.js';
@@ -335,6 +341,7 @@ export class AuthService {
 
   async authorize(ref?: string): Promise<AuthorizedClient> {
     const account = await this.deps.registry.resolveGoogleFirst(ref);
+    if (isMicrosoft(account)) throw new ProviderNotSupportedError(account.alias);
     const refreshToken = await this.deps.tokens.get(tokenKey(account));
     if (!refreshToken) {
       this.reauthNeeded.add(tokenKey(account));
```

`src/drive/client-factory.ts` (modify):

```diff
diff --git a/src/drive/client-factory.ts b/src/drive/client-factory.ts
index d5bd5f9..c38f91d 100644
--- a/src/drive/client-factory.ts
+++ b/src/drive/client-factory.ts
@@ -1,8 +1,8 @@
 import type { Auth } from 'googleapis';
 import type { AuthService } from '../auth/auth-service.js';
 import { isInvalidGrant } from '../auth/oauth-errors.js';
-import { tokenKey, type AccountRecord } from '../config/account-registry.js';
-import { ReauthRequiredError } from '../errors.js';
+import { isMicrosoft, tokenKey, type AccountRecord } from '../config/account-registry.js';
+import { ProviderNotSupportedError, ReauthRequiredError } from '../errors.js';
 import { logger as defaultLogger, type Logger } from '../logger.js';
 import { createDocsAdapter, type DocsAdapter } from './docs-adapter.js';
 import { createDriveAdapter, type DriveAdapter } from './drive-adapter.js';
@@ -92,6 +92,7 @@ export class DriveClientFactory implements DriveRunner {
 
   private async context(accountRef: string | undefined): Promise<CachedContext> {
     const account = await this.auth.resolveAccount(accountRef);
+    if (isMicrosoft(account)) throw new ProviderNotSupportedError(account.alias);
     const token = await this.auth.readRefreshToken(tokenKey(account));
     if (!token) {
       this.cache.delete(account.email);
```

`src/sync/pair-admin.ts` (modify):

```diff
diff --git a/src/sync/pair-admin.ts b/src/sync/pair-admin.ts
index b58cf77..c6d01cb 100644
--- a/src/sync/pair-admin.ts
+++ b/src/sync/pair-admin.ts
@@ -32,6 +32,8 @@ export interface SyncEnv {
   log: Logger;
   clock: () => Date;
   store: PairStore;
+  /** Throws when the account cannot be synced, before anything touches the user's folder. */
+  assertSupportedAccount: (ref: string | undefined) => Promise<void>;
 }
 
 export interface CreatePairInput {
@@ -120,6 +122,7 @@ export async function createPair(env: SyncEnv, input: CreatePairInput): Promise<
       localDir,
       remoteFolderId: input.remoteFolderId ?? '',
     });
+    await env.assertSupportedAccount(input.account);
     const id = randomUUID();
     await writeMarker(localDir, input.name, id);
     let remote: { folderId: string; alias: string };
```

`src/sync/sync-service.ts` (modify):

```diff
diff --git a/src/sync/sync-service.ts b/src/sync/sync-service.ts
index d9506a8..3889fc5 100644
--- a/src/sync/sync-service.ts
+++ b/src/sync/sync-service.ts
@@ -53,6 +53,8 @@ export interface SyncServiceDeps extends OperationDeps {
   /** Moves local files to the OS trash (the app passes `createLocalTrash()`; tests pass a fake, never the real trash). */
   trash: LocalTrash;
   clock?: () => Date;
+  /** Rejects accounts sync cannot serve (the app rejects Microsoft accounts). */
+  assertSupportedAccount?: (ref: string | undefined) => Promise<void>;
 }
 
 export interface RunInput {
@@ -84,7 +86,14 @@ export class SyncService {
     this.ops = new OperationRunner(deps);
     this.log = deps.logger ?? defaultLogger;
     this.clock = deps.clock ?? ((): Date => new Date());
-    this.env = { ops: this.ops, log: this.log, clock: this.clock, store: deps.store };
+    this.env = {
+      ops: this.ops,
+      log: this.log,
+      clock: this.clock,
+      store: deps.store,
+      assertSupportedAccount:
+        deps.assertSupportedAccount ?? ((): Promise<void> => Promise.resolve()),
+    };
   }
 
   private get store(): PairStore {
```

`src/watch/google/provider.ts` (modify):

```diff
diff --git a/src/watch/google/provider.ts b/src/watch/google/provider.ts
index 7deb469..01b9f73 100644
--- a/src/watch/google/provider.ts
+++ b/src/watch/google/provider.ts
@@ -1,7 +1,8 @@
 import type { AuditSink } from '../../audit/audit-log.js';
-import type { AccountRecord } from '../../config/account-registry.js';
+import { isMicrosoft, type AccountRecord } from '../../config/account-registry.js';
 import { OperationRunner } from '../../core/operation.js';
 import type { DriveRunner } from '../../drive/client-factory.js';
+import { ProviderNotSupportedError } from '../../errors.js';
 import type { RetryOptions } from '../../files/retry.js';
 import type { Logger } from '../../logger.js';
 import type { WatchAccount, WatchProvider } from '../feed.js';
@@ -27,6 +28,7 @@ export function createGoogleWatchProvider(deps: GoogleWatchDeps): WatchProvider
   return {
     resolveAccount: async (ref): Promise<WatchAccount> => {
       const account = await deps.resolveAccount(ref);
+      if (isMicrosoft(account)) throw new ProviderNotSupportedError(account.alias);
       return { email: account.email, alias: account.alias };
     },
     feed: (email) => new GoogleChangeFeed(ops, email),
```

- [ ] **Step 4: Run them and watch them pass.**

Run: `npx vitest run src/__tests__/app.test.ts src/auth/__tests__/auth-service.test.ts src/drive/__tests__/client-factory.test.ts src/sync/__tests__/sync-service.pairs.test.ts src/watch/google/__tests__/provider.test.ts`

Expected: PASS. Test Files  5 passed (5); Tests  70 passed (70).

- [ ] **Step 5: Format and run the whole check.**

Run: `npx prettier --write src/__tests__/app.test.ts src/app.ts src/auth/__tests__/auth-service.test.ts src/auth/auth-service.ts src/drive/__tests__/client-factory.test.ts src/drive/client-factory.ts src/sync/__tests__/sync-service.pairs.test.ts src/sync/pair-admin.ts src/sync/sync-service.ts src/watch/google/__tests__/provider.test.ts src/watch/google/provider.ts` then `npm run check`

Expected: exit 0, `Tests  1321 passed | 6 skipped (1327)`.

- [ ] **Step 6: Commit.**

```bash
git add src/__tests__/app.test.ts src/app.ts src/auth/__tests__/auth-service.test.ts src/auth/auth-service.ts src/drive/__tests__/client-factory.test.ts src/drive/client-factory.ts src/sync/__tests__/sync-service.pairs.test.ts src/sync/pair-admin.ts src/sync/sync-service.ts src/watch/google/__tests__/provider.test.ts src/watch/google/provider.ts
git commit -m "feat(accounts): Microsoft accounts never reach Google code" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01UgKFZHQfQhzVqDYowSyGaA"
```


---

## Chunk 15: CLI

### Task 21: CLI: `--provider`, provider-aware text

**Spec:** §4, §3.4, §3.2. Google wording stays on the Google path. `src/cli/auth-text.ts` keeps the new text testable.

**Files:**
- Create: `src/cli/auth-text.ts`
- Modify: `src/auth/auth-service.ts`, `src/cli/program.ts`
- Test: `src/auth/__tests__/auth-service.test.ts`, `src/cli/__tests__/auth-text.test.ts`

- [ ] **Step 1: Write the failing tests.**

`src/auth/__tests__/auth-service.test.ts` (modify):

```diff
diff --git a/src/auth/__tests__/auth-service.test.ts b/src/auth/__tests__/auth-service.test.ts
index 995c8fa..2296178 100644
--- a/src/auth/__tests__/auth-service.test.ts
+++ b/src/auth/__tests__/auth-service.test.ts
@@ -158,6 +158,21 @@ describe('AuthService.removeAccount token failures', () => {
   });
 });
 
+describe('AuthService.accountFor', () => {
+  it('rejects a shared address, unlike the Google-only lookup', async () => {
+    login.mockImplementationOnce(answer(signIn('same@example.com')));
+    await service.addAccount('g');
+    await registry.add({
+      alias: 'ms',
+      email: 'same@example.com',
+      provider: 'microsoft',
+      accountId: 't.o',
+    });
+    await expect(service.accountFor('same@example.com')).rejects.toThrow(/use an alias/);
+    await expect(service.accountFor('ms')).resolves.toMatchObject({ provider: 'microsoft' });
+  });
+});
+
 describe('AuthService.authorize', () => {
   it('throws ReauthRequiredError when no token is stored', async () => {
     await registry.add({ alias: 'emco', email: 'emco@example.com' });
```

`src/cli/__tests__/auth-text.test.ts` (create):

```ts
import { describe, expect, it } from 'vitest';
import { ValidationError } from '../../errors.js';
import {
  parseProviderOption,
  providerFlag,
  removedMessage,
  twoStepInstructions,
} from '../auth-text.js';

describe('parseProviderOption', () => {
  it('accepts the two providers and leaves an absent flag undefined', () => {
    expect(parseProviderOption('google')).toBe('google');
    expect(parseProviderOption('microsoft')).toBe('microsoft');
    expect(parseProviderOption(undefined)).toBeUndefined();
  });
  it('rejects anything else', () => {
    expect(() => parseProviderOption('dropbox')).toThrow(ValidationError);
  });
});

describe('twoStepInstructions', () => {
  it('keeps the Google wording on the Google path', () => {
    expect(twoStepInstructions('auth add', 'google')).toContain(
      'Google then redirects to http://127.0.0.1:<port>/',
    );
  });
  it('names Microsoft and localhost on the Microsoft path', () => {
    const text = twoStepInstructions('auth add --provider microsoft', 'microsoft');
    expect(text).toContain('Microsoft then redirects to http://localhost:<port>/');
    expect(text).toContain('marvin-drive auth add --provider microsoft --redirect-url');
    expect(text).not.toContain('Google');
  });
});

describe('providerFlag', () => {
  it('is only printed for Microsoft', () => {
    expect(providerFlag('google')).toBe('');
    expect(providerFlag('microsoft')).toBe(' --provider microsoft');
  });
});

describe('removedMessage', () => {
  const base = { alias: 'a', email: 'a@b.c', addedAt: 'x' };
  it('keeps the Google message', () => {
    expect(removedMessage(base)).toBe('Removed a (a@b.c)');
  });
  it('says a Microsoft token is only deleted locally', () => {
    expect(removedMessage({ ...base, provider: 'microsoft', accountId: 't.o' })).toMatch(
      /deleted on this machine.*no per-token revoke/,
    );
  });
});
```

- [ ] **Step 2: Run them and watch them fail.**

Run: `npx vitest run src/auth/__tests__/auth-service.test.ts src/cli/__tests__/auth-text.test.ts`

Expected: FAIL. Test Files  2 failed (2); Tests  1 failed | 33 passed (34). First error: Failed to load `../auth-text.js` (the module does not exist yet).

- [ ] **Step 3: Implement.**

`src/auth/auth-service.ts` (modify):

```diff
diff --git a/src/auth/auth-service.ts b/src/auth/auth-service.ts
index 63bd97e..dd89784 100644
--- a/src/auth/auth-service.ts
+++ b/src/auth/auth-service.ts
@@ -321,6 +321,11 @@ export class AuthService {
     return this.deps.registry.setDefault(ref);
   }
 
+  /** The account as the CLI means it: an email shared by several accounts is an error. */
+  accountFor(ref: string): Promise<AccountRecord> {
+    return this.deps.registry.resolve(ref);
+  }
+
   /** For Google-only surfaces: an email means the Google account of that address. */
   resolveAccount(ref?: string): Promise<AccountRecord> {
     return this.deps.registry.resolveGoogleFirst(ref);
```

`src/cli/auth-text.ts` (create):

```ts
import {
  isMicrosoft,
  type AccountProvider,
  type AccountRecord,
} from '../config/account-registry.js';
import { ValidationError } from '../errors.js';

/** Undefined stays undefined: step two of a login takes the provider from its waiting entry. */
export function parseProviderOption(value: string | undefined): AccountProvider | undefined {
  if (value === undefined) return undefined;
  if (value === 'google' || value === 'microsoft') return value;
  throw new ValidationError(`--provider must be google or microsoft (got "${value}")`);
}

/** What to do after --print-url printed the sign-in URL. */
export function twoStepInstructions(command: string, provider: AccountProvider): string {
  const [name, host] =
    provider === 'microsoft' ? ['Microsoft', 'localhost'] : ['Google', '127.0.0.1'];
  return (
    `\nOpen the URL above in a browser on any device and sign in. ${name} then redirects to ` +
    `http://${host}:<port>/?…, which fails to load — that is expected. Copy the full URL ` +
    'from the address bar and, within 10 minutes, run:\n' +
    `  marvin-drive ${command} --redirect-url '<that URL>'\n`
  );
}

/** A flag only when it says something the default does not. */
export function providerFlag(provider: AccountProvider): string {
  return provider === 'microsoft' ? ' --provider microsoft' : '';
}

export function removedMessage(record: AccountRecord): string {
  const removed = `Removed ${record.alias} (${record.email})`;
  if (!isMicrosoft(record)) return removed;
  return (
    `${removed}. The token was deleted on this machine; Microsoft has no per-token revoke for ` +
    'this kind of app. To end its access fully, remove the app under your Microsoft account ' +
    'privacy settings (https://account.live.com/consent/Manage) or ask your administrator.'
  );
}
```

`src/cli/program.ts` (modify):

```diff
diff --git a/src/cli/program.ts b/src/cli/program.ts
index ba6a34b..da75dc4 100644
--- a/src/cli/program.ts
+++ b/src/cli/program.ts
@@ -2,10 +2,17 @@ import { createInterface } from 'node:readline/promises';
 import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
 import { Command } from 'commander';
 import { buildApp } from '../app.js';
+import { providerOf } from '../config/account-registry.js';
 import { ValidationError } from '../errors.js';
 import { logger } from '../logger.js';
 import { createMcpServer } from '../mcp/server.js';
 import { VERSION } from '../version.js';
+import {
+  parseProviderOption,
+  providerFlag,
+  removedMessage,
+  twoStepInstructions,
+} from './auth-text.js';
 import { formatAccounts } from './format.js';
 import { runHookCli } from './hook.js';
 import { serve } from './serve.js';
@@ -88,9 +95,13 @@ async function withLoginApp<T>(
   }
 }
 
+function googleHint(provider: 'google' | 'microsoft'): void {
+  if (provider === 'google') process.stderr.write(`${TESTING_MODE_HINT}\n`);
+}
+
 const NO_BROWSER_HELP = 'do not open a browser; paste the redirect URL instead (servers, SSH)';
 const PRINT_URL_HELP =
-  'step 1 of a login without waiting: print the Google URL and exit (finish with --redirect-url)';
+  'step 1 of a login without waiting: print the sign-in URL and exit (finish with --redirect-url)';
 const REDIRECT_URL_HELP =
   'step 2: finish a --print-url login with the URL the browser was redirected to (quote it)';
 
@@ -110,46 +121,45 @@ function twoStepMode(opts: LoginOpts): 'print' | 'finish' | null {
   return null;
 }
 
-function printTwoStepUrl(url: string, command: string): void {
+function printTwoStepUrl(url: string, command: string, provider: 'google' | 'microsoft'): void {
   out(url);
-  process.stderr.write(
-    '\nOpen the URL above in a browser on any device and sign in. Google then redirects to ' +
-      'http://127.0.0.1:<port>/?…, which fails to load — that is expected. Copy the full URL ' +
-      'from the address bar and, within 10 minutes, run:\n' +
-      `  marvin-drive ${command} --redirect-url '<that URL>'\n`,
-  );
+  process.stderr.write(twoStepInstructions(command, provider));
 }
 
 const program = new Command()
   .name('marvin-drive')
-  .description('Multi-account Google Drive MCP server and CLI')
+  .description('Multi-account Google Drive and OneDrive MCP server and CLI')
   .version(VERSION);
 
-const auth = program.command('auth').description('Manage Google accounts');
+const auth = program.command('auth').description('Manage Google and Microsoft accounts');
 
 auth
   .command('add')
-  .description('Sign in with a Google account and register it')
+  .description('Sign in with a Google or Microsoft account and register it')
+  .option('--provider <provider>', 'google (default) or microsoft')
   .option('--alias <alias>', 'short name for the account (default: email local part)')
   .option('--no-browser', NO_BROWSER_HELP)
   .option('--print-url', PRINT_URL_HELP)
   .option('--redirect-url <url>', REDIRECT_URL_HELP)
-  .action(async (opts: LoginOpts & { alias?: string }) => {
+  .action(async (opts: LoginOpts & { alias?: string; provider?: string }) => {
     const step = twoStepMode(opts);
     const app = (): ReturnType<typeof buildApp> => buildApp();
+    const asked = parseProviderOption(opts.provider);
+    const provider = asked ?? 'google';
     if (step === 'print') {
-      process.stderr.write(`${TESTING_MODE_HINT}\n`);
-      const url = await app().auth.startAddAccount(opts.alias);
-      printTwoStepUrl(url, `auth add${opts.alias ? ` --alias ${opts.alias}` : ''}`);
+      googleHint(provider);
+      const url = await app().auth.startAddAccount(opts.alias, provider);
+      const command = `auth add${opts.alias ? ` --alias ${opts.alias}` : ''}${providerFlag(provider)}`;
+      printTwoStepUrl(url, command, provider);
       return;
     }
     if (step === 'finish') {
-      const record = await app().auth.finishAddAccount(opts.alias, opts.redirectUrl ?? '');
+      const record = await app().auth.finishAddAccount(opts.alias, opts.redirectUrl ?? '', asked);
       out(`Added ${record.alias} (${record.email})`);
       return;
     }
-    process.stderr.write(`${TESTING_MODE_HINT}\n`);
-    const record = await withLoginApp(opts, (a) => a.auth.addAccount(opts.alias));
+    googleHint(provider);
+    const record = await withLoginApp(opts, (a) => a.auth.addAccount(opts.alias, provider));
     out(`Added ${record.alias} (${record.email})`);
   });
 
@@ -163,8 +173,9 @@ auth
   .action(async (ref: string, opts: LoginOpts) => {
     const step = twoStepMode(opts);
     if (step === 'print') {
-      process.stderr.write(`${TESTING_MODE_HINT}\n`);
-      printTwoStepUrl(await buildApp().auth.startRelogin(ref), `auth login ${ref}`);
+      const provider = providerOf(await buildApp().auth.accountFor(ref));
+      googleHint(provider);
+      printTwoStepUrl(await buildApp().auth.startRelogin(ref), `auth login ${ref}`, provider);
       return;
     }
     if (step === 'finish') {
@@ -172,7 +183,7 @@ auth
       out(`Signed in again: ${record.alias} (${record.email})`);
       return;
     }
-    process.stderr.write(`${TESTING_MODE_HINT}\n`);
+    googleHint(providerOf(await buildApp().auth.accountFor(ref)));
     const record = await withLoginApp(opts, (app) => app.auth.relogin(ref));
     out(`Signed in again: ${record.alias} (${record.email})`);
   });
@@ -187,11 +198,10 @@ auth
 
 auth
   .command('remove')
-  .description('Remove an account and revoke its token')
+  .description('Remove an account (Google: also revokes its token)')
   .argument('<account>', 'alias or email')
   .action(async (ref: string) => {
-    const record = await buildApp().auth.removeAccount(ref);
-    out(`Removed ${record.alias} (${record.email})`);
+    out(removedMessage(await buildApp().auth.removeAccount(ref)));
   });
 
 auth
```

- [ ] **Step 4: Run them and watch them pass.**

Run: `npx vitest run src/auth/__tests__/auth-service.test.ts src/cli/__tests__/auth-text.test.ts`

Expected: PASS. Test Files  2 passed (2); Tests  41 passed (41).

- [ ] **Step 5: Format and run the whole check.**

Run: `npx prettier --write src/auth/__tests__/auth-service.test.ts src/auth/auth-service.ts src/cli/__tests__/auth-text.test.ts src/cli/auth-text.ts src/cli/program.ts` then `npm run check`

Expected: exit 0, `Tests  1329 passed | 6 skipped (1335)`.

- [ ] **Step 6: Commit.**

```bash
git add src/auth/__tests__/auth-service.test.ts src/auth/auth-service.ts src/cli/__tests__/auth-text.test.ts src/cli/auth-text.ts src/cli/program.ts
git commit -m "feat(cli): auth add --provider microsoft; provider-aware login text" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01UgKFZHQfQhzVqDYowSyGaA"
```


---

## Chunk 16: Documentation

### Task 22: Documentation

**Spec:** §9, §11. README (accounts, differences, registration), `docs/FEATURES.md`, `docs/CHANGELOG.md`.

**Files:**
- Modify: `README.md`, `docs/CHANGELOG.md`, `docs/FEATURES.md`

- [ ] **Step 1: Write the changes.**

`README.md` (modify):

````diff
diff --git a/README.md b/README.md
index b5df0e0..e05dee6 100644
--- a/README.md
+++ b/README.md
@@ -1,6 +1,6 @@
 # Marvin Drive MCP Handler
 
-Local MCP server + CLI that lets Claude Code manage files in one or more Google Drive accounts, read and edit Google Docs, Sheets and Slides, and keep a chosen set of local files in two-way sync with a Drive folder, through your own Google OAuth client.
+Local MCP server + CLI that lets Claude Code manage files in one or more Google Drive and OneDrive accounts, read and edit Google Docs, Sheets and Slides, and keep a chosen set of local files in two-way sync with a Drive folder, through your own Google and Microsoft app registrations.
 
 ## Requirements
 
@@ -21,6 +21,40 @@ marvin-drive auth add --alias <name>   # e.g. work; default: the part of the ema
 
 Error messages refer to `marvin-drive …`; without `npm link`, run the same command as `node dist/cli/main.js …`.
 
+## OneDrive accounts
+
+A Microsoft account (personal or work/school) can be registered next to Google accounts. The `drive_*` tools then work on that account's own OneDrive; the account decides the provider, the tool names stay the same. Files shared with you, SharePoint and Teams libraries are not reachable, and sync, watch and the Docs/Sheets/Slides tools are Google-only for now (they return a clear error).
+
+Register an app once. Microsoft Entra admin center → App registrations → New registration:
+
+1. Supported accounts: any organizational directory and personal Microsoft accounts.
+2. Redirect: platform "Mobile and desktop applications", `http://localhost`.
+3. API permissions (Microsoft Graph, delegated): `Files.ReadWrite`, `offline_access`, `User.Read`, `openid`, `profile`, `email`.
+4. Save the Application (client) ID in `~/.config/google-handler/microsoft-client.json` as `{ "clientId": "<guid>" }`. It is not a secret.
+
+Since June 2024 an app must be registered in a directory (tenant), obtained from a work account, an Azure subscription or the Microsoft 365 Developer Program.
+
+```bash
+marvin-drive auth add --provider microsoft --alias <name>   # also --no-browser, --print-url, --redirect-url
+```
+
+An address can be both a personal and a work account, so a Microsoft account is identified internally by its tenant and object ID. When one address belongs to several accounts, use the alias.
+
+Differences on OneDrive:
+
+| Tool                                                | Difference                                                                                             |
+| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
+| `drive_list`                                        | `includeTrashed` is not available                                                                      |
+| `drive_search`                                      | `query` is required; `rawQuery`, `mimeType` and `modifiedAfter` are not available                      |
+| `drive_download`                                    | `exportFormat` is not available; OneNote packages cannot be downloaded                                 |
+| `drive_upload`                                      | `convertToGoogle` is not available. An existing name fails, or Claude Code asks you Overwrite / Cancel |
+| `drive_create_folder`, `drive_rename`, `drive_move` | A name conflict is an error                                                                            |
+| `drive_copy`                                        | Folders can be copied; a name or a target folder is required; a name conflict is an error              |
+| `drive_delete`                                      | Moves to the recycle bin; `permanent` is not available                                                 |
+| `drive_restore`                                     | Personal accounts only; on work or school accounts use the recycle bin on the OneDrive website         |
+
+`auth remove` deletes the token on this machine; Microsoft has no per-token revoke for this kind of app.
+
 ## Register with Claude Code
 
 ```bash
@@ -70,22 +104,22 @@ claude mcp add marvin-drive --scope user -- node "$PWD\dist\cli\main.js" serve
 
 ## CLI
 
-| Command                                                                                                  | Purpose                                                                                                     |
-| -------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
-| `marvin-drive auth add [--alias a] [--no-browser\|--print-url\|--redirect-url u]`                        | Browser login, register account (first = default)                                                           |
-| `marvin-drive auth login <alias> [--no-browser\|--print-url\|--redirect-url u]`                          | Re-login an expired account                                                                                 |
-| `marvin-drive auth list [--verify]`                                                                      | Accounts and token status                                                                                   |
-| `marvin-drive auth remove <alias>`                                                                       | Remove account, delete + revoke token                                                                       |
-| `marvin-drive auth default <alias>`                                                                      | Set the default account                                                                                     |
-| `marvin-drive serve`                                                                                     | MCP server on stdio                                                                                         |
-| `marvin-drive sync list`                                                                                 | Sync pairs with counts and last applied run                                                                 |
-| `marvin-drive sync run <name> [--apply] [--plan-id <id>] [--allow-mass-delete] [--confirm-remote-trash]` | Dry run (default) or apply a sync; exit code 1 on failure/abort; `--confirm-remote-trash` needs `--plan-id` |
-| `marvin-drive sync release <name> [--all \| <paths…>] [--apply]`                                         | Keep files in Drive only: local copies go to the system trash (dry run by default)                          |
-| `marvin-drive sync repair-marker <name>`                                                                 | Rewrite the folder marker after confirming the local folder                                                 |
-| `marvin-drive watch add\|remove <fileId> [--account a]`                                                  | Watch a file or folder (folders recursively) for changes by others / stop watching                          |
-| `marvin-drive watch list [--account a]`                                                                  | Watched files and folders                                                                                   |
-| `marvin-drive watch delivery [hook\|channel]`                                                            | Show or set how changes reach Claude Code (default `hook`)                                                  |
-| `marvin-drive changes [--all] [--own] [--json] [--hook]`                                                 | Changes in watched files (unread by default, marks them read); `--hook` is the `UserPromptSubmit` hook      |
+| Command                                                                                                          | Purpose                                                                                                     |
+| ---------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
+| `marvin-drive auth add [--provider google\|microsoft] [--alias a] [--no-browser\|--print-url\|--redirect-url u]` | Browser login, register account (first = default)                                                           |
+| `marvin-drive auth login <alias> [--no-browser\|--print-url\|--redirect-url u]`                                  | Re-login an expired account                                                                                 |
+| `marvin-drive auth list [--verify]`                                                                              | Accounts and token status                                                                                   |
+| `marvin-drive auth remove <alias>`                                                                               | Remove account, delete token (Google: also revokes it)                                                      |
+| `marvin-drive auth default <alias>`                                                                              | Set the default account                                                                                     |
+| `marvin-drive serve`                                                                                             | MCP server on stdio                                                                                         |
+| `marvin-drive sync list`                                                                                         | Sync pairs with counts and last applied run                                                                 |
+| `marvin-drive sync run <name> [--apply] [--plan-id <id>] [--allow-mass-delete] [--confirm-remote-trash]`         | Dry run (default) or apply a sync; exit code 1 on failure/abort; `--confirm-remote-trash` needs `--plan-id` |
+| `marvin-drive sync release <name> [--all \| <paths…>] [--apply]`                                                 | Keep files in Drive only: local copies go to the system trash (dry run by default)                          |
+| `marvin-drive sync repair-marker <name>`                                                                         | Rewrite the folder marker after confirming the local folder                                                 |
+| `marvin-drive watch add\|remove <fileId> [--account a]`                                                          | Watch a file or folder (folders recursively) for changes by others / stop watching                          |
+| `marvin-drive watch list [--account a]`                                                                          | Watched files and folders                                                                                   |
+| `marvin-drive watch delivery [hook\|channel]`                                                                    | Show or set how changes reach Claude Code (default `hook`)                                                  |
+| `marvin-drive changes [--all] [--own] [--json] [--hook]`                                                         | Changes in watched files (unread by default, marks them read); `--hook` is the `UserPromptSubmit` hook      |
 
 ## MCP tools
 
@@ -217,17 +251,18 @@ Good to know:
 
 ## Files
 
-| Path                                          | Content                              |
-| --------------------------------------------- | ------------------------------------ |
-| `~/.config/google-handler/client_secret.json` | OAuth client (never commit)          |
-| `~/.config/google-handler/accounts.json`      | Aliases and emails (no secrets)      |
-| `~/.config/google-handler/audit.jsonl`        | Every mutating operation             |
-| `~/.config/google-handler/sync/<name>.json`   | Sync pair state (selection, records) |
-| `~/.config/google-handler/watch/`             | Watch list, snapshots, change inbox  |
-| `<local folder>/.marvin-sync-<name>`          | Sync folder marker (pair id)         |
-| Keychain service `marvin-drive`               | Refresh tokens (default)             |
-| `~/.config/google-handler/tokens.json`        | Refresh tokens (`…TOKEN_STORE=file`) |
-| `~/Downloads/marvin-drive/`                   | Default download folder              |
+| Path                                             | Content                              |
+| ------------------------------------------------ | ------------------------------------ |
+| `~/.config/google-handler/client_secret.json`    | OAuth client (never commit)          |
+| `~/.config/google-handler/microsoft-client.json` | Microsoft client ID (not a secret)   |
+| `~/.config/google-handler/accounts.json`         | Aliases and emails (no secrets)      |
+| `~/.config/google-handler/audit.jsonl`           | Every mutating operation             |
+| `~/.config/google-handler/sync/<name>.json`      | Sync pair state (selection, records) |
+| `~/.config/google-handler/watch/`                | Watch list, snapshots, change inbox  |
+| `<local folder>/.marvin-sync-<name>`             | Sync folder marker (pair id)         |
+| Keychain service `marvin-drive`                  | Refresh tokens (default)             |
+| `~/.config/google-handler/tokens.json`           | Refresh tokens (`…TOKEN_STORE=file`) |
+| `~/Downloads/marvin-drive/`                      | Default download folder              |
 
 ## Development
 
````

`docs/CHANGELOG.md` (modify):

```diff
diff --git a/docs/CHANGELOG.md b/docs/CHANGELOG.md
index 9adce09..11486e6 100644
--- a/docs/CHANGELOG.md
+++ b/docs/CHANGELOG.md
@@ -3,6 +3,7 @@
 ## Unreleased
 
 ### Added
+- OneDrive accounts (sub-project 1): `auth add --provider microsoft` registers a personal or work/school Microsoft account, and the `drive_*` tools work on its own OneDrive. Provider shown in `auth list` and `drive_list_accounts`. Upload name conflicts ask Overwrite / Cancel through MCP elicitation. No new dependencies.
 - Drive watch: `drive_watch` / `drive_changes` MCP tools (34 tools in total) and CLI `marvin-drive watch add|remove|list|delivery` and `marvin-drive changes`. Watched files and folders are polled through the Drive Changes API; Claude learns who changed what and when (diffs for Docs, Sheets and Slides, and new comments when the file also changed; comment-only changes are not detected yet) and only informs. Delivery by a `UserPromptSubmit` hook (`changes --hook`, default) or by Claude Code channel push (`--dangerously-load-development-channels server:marvin-drive`).
 - New dependency: `diff` (jsdiff, BSD-3) for line diffs. `MARVIN_WATCH_POLL_SECONDS` sets the poll interval (default 30, between 15 and 3600).
 - The MCP server declares the experimental `claude/channel` capability and server instructions that tell Claude to treat change notifications as third-party data.
@@ -17,6 +18,7 @@
 - Sync deletions of local files work on Windows (Recycle Bin) and Linux/other Unix (freedesktop.org trash), without new dependencies. The file is moved with one rename after its trash record is reserved; when no trash can be used with certainty the action fails and the file stays.
 
 ### Changed
+- Tool descriptions are provider-neutral and mark Google-only parameters. Accounts are shown with their provider in `auth list`.
 - The sync pair lock now uses the shared `src/core/file-lock.ts` helper (same behaviour; a busy lock error is now named `FileLockBusyError` in logs).
 - `src/cli/main.ts` is a small entry that loads the rest of the CLI lazily, so the hook path starts fast; the former entry is `src/cli/program.ts`.
 - Sync: deleting a tracked file locally no longer trashes its Drive copy automatically; it waits in `pendingConfirmation` until confirmed (`confirm-needs-mass-delete` warns when the confirmed run would also need `allowMassDelete`).
```

`docs/FEATURES.md` (modify):

```diff
diff --git a/docs/FEATURES.md b/docs/FEATURES.md
index 22246c5..5cf270c 100644
--- a/docs/FEATURES.md
+++ b/docs/FEATURES.md
@@ -58,7 +58,17 @@ Status: ⬜ planned · 🟨 in progress · ✅ done
 - ⬜ Live E2E with two accounts (`MARVIN_E2E_EDITOR`): written, not run live yet
 - ✅ Comment-only changes: the two-account live E2E showed Drive reports them through the Changes API and they pass the no-op rule, so no separate comment polling is needed (plan Task 33 skipped)
 
+### 8. OneDrive sign-in and file operations (spec: `docs/superpowers/specs/2026-11-08-onedrive-files-design.md`)
+- ✅ Microsoft PKCE login (`auth add --provider microsoft`), personal and work/school accounts, two-step login, token rotation
+- ✅ `FileRouter` picks Google or OneDrive from the account; the `drive_*` tools are unchanged
+- ✅ GraphClient: token only to graph.microsoft.com, retry rules, resumable upload sessions, copy monitor
+- ✅ `drive_upload` name conflicts ask Overwrite / Cancel through MCP elicitation; rename, move and copy conflicts are errors
+- ✅ Microsoft accounts are rejected on the Google-only tools (content, sync, watch)
+- ⬜ Live E2E (`MARVIN_E2E_MS_PERSONAL`, `MARVIN_E2E_MS_WORK`): written, not run live yet. Personal: not live-tested. Work/school: not live-tested
+- ⬜ Overwrite / Cancel dialog answered after more than 60 s in Claude Code: manual check, not done yet
+
 ## Later
+- ⬜ OneDrive: sync, change watching (Graph `delta`), Office content editing, files shared with the user, SharePoint and Teams libraries
 - ⬜ Remote (HTTP) MCP server for claude.ai connectors / mobile (Drive + content tools; no local sync)
 - ⬜ Sync watch mode (continuous sync)
 - ⬜ GUI with Claude-API file classification for sync selection (plugs into `sync_select`; terminal use keeps Claude Code as the selector)
```

- [ ] **Step 2: Format and run the whole check.**

Run: `npx prettier --write README.md docs/CHANGELOG.md docs/FEATURES.md` then `npm run check`

Expected: exit 0, `Tests  1329 passed | 6 skipped (1335)`.

- [ ] **Step 3: Commit.**

```bash
git add README.md docs/CHANGELOG.md docs/FEATURES.md
git commit -m "docs(onedrive): accounts, differences and app registration" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01UgKFZHQfQhzVqDYowSyGaA"
```


---

## Chunk 17: Live E2E

### Task 23: Live E2E

**Spec:** §8, §10. Opt-in with `MARVIN_E2E_MS_PERSONAL` and `MARVIN_E2E_MS_WORK`. It stays skipped in `npm run check`.

**Files:**
- Test: `tests/e2e/onedrive.e2e.test.ts`

- [ ] **Step 1: Write the live test.**

`tests/e2e/onedrive.e2e.test.ts` (create):

```ts
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import {
  NameConflictError,
  NotFoundError,
  TargetChangedError,
  ValidationError,
} from '../../src/errors.js';
import type { FileSummary, UploadCancelled } from '../../src/files/file-provider.js';

const ACCOUNTS: Array<['personal' | 'work', string | undefined]> = [
  ['personal', process.env.MARVIN_E2E_MS_PERSONAL],
  ['work', process.env.MARVIN_E2E_MS_WORK],
];
const LARGE_SIZE = 10 * 1024 * 1024 + 1234;
const LONG_MS = 600_000;

function created(result: FileSummary | UploadCancelled): FileSummary {
  if ('cancelled' in result) throw new Error('upload was cancelled');
  return result;
}

const sha = (data: Buffer): string => createHash('sha256').update(data).digest('hex');

describe.each(ACCOUNTS)('OneDrive E2E (%s)', (kind, account) => {
  it.runIf(account)(
    'files, conflicts and cleanup on the live drive',
    { timeout: LONG_MS },
    async () => {
      const { files } = buildApp();
      const tmp = await mkdtemp(path.join(os.tmpdir(), 'marvin-od-e2e-'));
      const stamp = `marvin-e2e-${Date.now()}`;
      const root = await files.createFolder({ account, name: stamp });
      const local = async (name: string, data: Buffer | string): Promise<string> => {
        const file = path.join(tmp, name);
        await writeFile(file, data);
        return file;
      };
      const readBack = async (fileId: string): Promise<Buffer> => {
        const down = await files.download({
          account,
          fileId,
          destPath: `${tmp}/dl-${Date.now()}/`,
        });
        return readFile(down.path);
      };

      try {
        // Uploads: empty (PUT), small and over one fragment (session).
        const empty = created(
          await files.upload({
            account,
            localPath: await local('empty.txt', ''),
            parentId: root.id,
          }),
        );
        expect(empty.size ?? 0).toBe(0);
        const small = created(
          await files.upload({
            account,
            localPath: await local('small.txt', 'hello onedrive'),
            parentId: root.id,
          }),
        );
        const largeData = randomBytes(LARGE_SIZE);
        const large = created(
          await files.upload({
            account,
            localPath: await local('large.bin', largeData),
            parentId: root.id,
          }),
        );

        // List and page: proves the @odata.nextLink shape is accepted (spec §10).
        const first = await files.list({ account, folderId: root.id, pageSize: 2 });
        expect(first.files).toHaveLength(2);
        expect(first.nextPageToken).toBeDefined();
        const second = await files.list({
          account,
          folderId: root.id,
          pageToken: first.nextPageToken ?? '',
        });
        expect([...first.files, ...second.files].map((f) => f.id).sort()).toEqual(
          [empty.id, small.id, large.id].sort(),
        );

        // Search has index lag: poll.
        let hit = false;
        const searchName = created(
          await files.upload({
            account,
            localPath: await local(`${stamp}-needle.txt`, 'x'),
            parentId: root.id,
          }),
        );
        for (let i = 0; i < 60 && !hit; i++) {
          const found = await files.search({ account, query: stamp });
          hit = found.files.some((f) => f.id === searchName.id);
          if (!hit) await new Promise((resolve) => setTimeout(resolve, 5000));
        }
        expect(hit).toBe(true);

        // Download and compare.
        expect((await readBack(small.id)).toString()).toBe('hello onedrive');
        expect(sha(await readBack(large.id))).toBe(sha(largeData));

        // Rename, move (also to root and back), copy.
        const sub = await files.createFolder({ account, name: 'sub', parentId: root.id });
        const renamed = await files.rename({ account, fileId: small.id, newName: 'renamed.txt' });
        expect(renamed.name).toBe('renamed.txt');
        const moved = await files.move({ account, fileId: small.id, newParentId: sub.id });
        expect(moved.parents).toEqual([sub.id]);
        const atRoot = await files.move({ account, fileId: small.id, newParentId: 'root' });
        expect(atRoot.name).toBe('renamed.txt');
        await files.move({ account, fileId: small.id, newParentId: sub.id });
        const copy = await files.copy({ account, fileId: small.id, name: 'copied.txt' });
        expect(copy.name).toBe('copied.txt');

        // Conflicts leave the original or the target unchanged.
        await expect(
          files.upload({
            account,
            localPath: await local('renamed.txt', 'other'),
            parentId: sub.id,
          }),
        ).rejects.toThrow(NameConflictError);
        expect((await readBack(small.id)).toString()).toBe('hello onedrive');

        await expect(
          files.rename({ account, fileId: copy.id, newName: 'renamed.txt' }),
        ).rejects.toThrow(NameConflictError);
        expect((await files.getMetadata({ account, fileId: copy.id })).name).toBe('copied.txt');

        const twin = created(
          await files.upload({
            account,
            localPath: await local('renamed.txt', 'other'),
            parentId: root.id,
          }),
        );
        await expect(files.move({ account, fileId: twin.id, newParentId: sub.id })).rejects.toThrow(
          NameConflictError,
        );
        expect((await readBack(twin.id)).toString()).toBe('other');

        await expect(files.copy({ account, fileId: copy.id, name: 'renamed.txt' })).rejects.toThrow(
          NameConflictError,
        );
        expect((await readBack(small.id)).toString()).toBe('hello onedrive');

        // A stale eTag: the file changes between the question and the overwrite.
        const staleSource = await local('renamed.txt', 'loses the race');
        await expect(
          files.upload(
            { account, localPath: staleSource, parentId: sub.id },
            {
              confirmReplace: async () => {
                await files.upload(
                  {
                    account,
                    localPath: await local('winner.txt', 'wins the race'),
                    parentId: sub.id,
                    name: 'renamed.txt',
                  },
                  { confirmReplace: async () => 'overwrite' },
                );
                return 'overwrite';
              },
            },
          ),
        ).rejects.toThrow(TargetChangedError);
        expect((await readBack(small.id)).toString()).toBe('wins the race');

        // Delete and, on personal drives, restore.
        await files.delete({ account, fileId: copy.id });
        await expect(files.getMetadata({ account, fileId: copy.id })).rejects.toThrow(
          NotFoundError,
        );
        if (kind === 'personal') {
          const restored = await files.restore({ account, fileId: copy.id });
          expect(restored.name).toBe('copied.txt');
        } else {
          await expect(files.restore({ account, fileId: copy.id })).rejects.toThrow(
            ValidationError,
          );
        }
      } finally {
        await files.delete({ account, fileId: root.id }).catch(() => undefined);
        await rm(tmp, { recursive: true, force: true });
      }
    },
  );
});
```

- [ ] **Step 2: Check that it stays skipped without the variables.**

Run: `npx vitest run --config vitest.e2e.config.ts tests/e2e/onedrive.e2e.test.ts`

Expected: `Tests  2 skipped (2)`.

- [ ] **Step 3: Format and run the whole check.**

Run: `npx prettier --write tests/e2e/onedrive.e2e.test.ts` then `npm run check`

Expected: exit 0, `Tests  1329 passed | 6 skipped (1335)`.

- [ ] **Step 4: Commit.**

```bash
git add tests/e2e/onedrive.e2e.test.ts
git commit -m "test(onedrive): live E2E for personal and work accounts" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01UgKFZHQfQhzVqDYowSyGaA"
```


---

## Chunk 18: Live run (needs the user's sign-in)

### Task 24: Run the live E2E and settle the §10 points

**Needs the user's sign-in. Do not start it without the user at the keyboard.** The app is already registered and its client ID is in `~/.config/google-handler/microsoft-client.json`. This task makes live Microsoft calls, on the test folder only.

**Spec:** §8, §10.

**Files:**
- Modify: `docs/FEATURES.md`; plus the code and tests of any Diff from "Live-test points" that a failed point requires

- [ ] **Step 1: Build, so the CLI and the MCP server run this code.**

Run: `npm run build`

Expected: exit 0.

- [ ] **Step 2: Add the accounts (the user signs in twice).**

Run each command, then ask the user to finish the sign-in in the browser. Use the work account for the first and the personal account for the second.

```bash
marvin-drive auth add --provider microsoft --alias ms-work
marvin-drive auth add --provider microsoft --alias ms-personal
marvin-drive auth list --verify
```

Expected: `Added ms-work (...)`, `Added ms-personal (...)`, and both listed as `microsoft` with status `ok`.

A successful sign-in confirms the first §10 point (any port on `http://localhost`). If a work account from another tenant is available, sign in with it once as well, then remove it with `marvin-drive auth remove <alias>`, for the consent point. If only one account type is available, continue with that one and record the other as "not live-tested".

- [ ] **Step 3: Run the live test.**

Run: `MARVIN_E2E_MS_PERSONAL=ms-personal MARVIN_E2E_MS_WORK=ms-work npx vitest run --config vitest.e2e.config.ts tests/e2e/onedrive.e2e.test.ts`

Expected: `Tests  2 passed (2)`. Leave out the variable of an account type that was not added; its test is then skipped.

- [ ] **Step 4: Check the two points the test cannot reach.**

Rename and move conflicts stop at the §5.1 preflight, and the empty-file `PUT` is guarded by the §6 read, so the test cannot see Graph's own answer. In Graph Explorer, signed in to the test account: send a `PATCH` that renames a file to the name of a sibling and expect 409; send `PUT .../{name}:/content?@microsoft.graph.conflictBehavior=fail` with an empty body onto an existing name and expect 409.

- [ ] **Step 5: Record every §10 point, and apply the matching fallback when one fails.**

Write this table into `docs/FEATURES.md` under section 8, with each result filled in as `confirmed` or `not confirmed` (or `not live-tested`, with the reason):

| §10 point | Personal | Work |
|---|---|---|
| Entra accepts any port for a registered `http://localhost` | | |
| `PATCH` rename and move return 409 on a name conflict | | |
| `copy` without a conflict parameter fails on a name conflict | | |
| `PUT` of an empty file honours `conflictBehavior=fail` | | |
| `If-Match` is honoured on `createUploadSession` and on `PUT items/{id}/content` | | |
| `@odata.nextLink` has one of the two path shapes of §7.1 | | |
| A work account in another tenant can consent to an unverified app | n/a | |
| `elicitInput` works on the protocol revision Claude Code negotiates | | |

For each `not confirmed`, make the change named in that row of "Live-test points": apply its Diff with `git apply`, update the unit tests that pin the old behaviour, add the documented note to the README where the row asks for one, and run `npm run check` (expected: exit 0). Then repeat Step 3.

- [ ] **Step 6: Manual dialog check (the user answers).**

Run `npm run build`, then restart Claude Code so it loads the new server.

1. Ask Claude to upload a local file onto a name that already exists on `ms-personal`.
2. Wait more than 60 s before answering the Overwrite / Cancel question, and answer **Overwrite**. Expected: the tool call was not ended first, the upload succeeds, and the OneDrive file has the new content.
3. Repeat, answer **Cancel**. Expected: the result is `cancelled: true` with reason `user`, and the OneDrive file is unchanged.

Record the result in the `elicitInput` row of the table.

- [ ] **Step 7: Update the status and commit.**

In `docs/FEATURES.md` section 8, replace the two "written, not run live yet" and "manual check, not done yet" lines with the outcome for each account type. Run `npx prettier --write docs/FEATURES.md` then `npm run check` (expected: exit 0).

```bash
git add docs/FEATURES.md
git commit -m "docs(onedrive): record the live E2E and the spec section 10 results" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01UgKFZHQfQhzVqDYowSyGaA"
```

If a fallback Diff was applied, add its code and tests to that `git add` and adjust the subject.


---

## Live-test points (spec §10)

Task 24 runs the Task 23 test and the manual dialog check to confirm these. Nothing here is applied unless a point fails. The diffs below compile against the tree Task 23 leaves (`npm run typecheck`, `npm run lint`); each changes the behaviour some unit tests pin, so update those tests in the same commit.

| Point | How it is checked | If it does not hold |
|---|---|---|
| Entra accepts any port for a registered `http://localhost` | `auth add --provider microsoft` succeeds | Fixed registered port: diff 1, and register `http://localhost:53682` in README step 2 |
| `PATCH` rename and move return 409 on a name conflict | Not reachable: the §5.1 preflight stops first. A direct `PATCH` by hand, or the race | No code change: the preflight stays the only guard. Document the small race in the README table |
| `copy` without a conflict parameter fails on a name conflict, on both drive types | E2E `copy ... name: 'renamed.txt'` rejects, on each account type | Target-name preflight: diff 2 |
| `PUT` of an empty file honours `conflictBehavior=fail` | Create a name between the read and the `PUT`, by hand with Graph Explorer | No code change: the §6 read stays the only guard. Document that a file created in that narrow window could be replaced by an empty one |
| `If-Match` is honoured on `createUploadSession` and on `PUT items/{id}/content` | E2E stale-eTag case raises `TargetChangedError`; the winner's content stays | Compare the eTag immediately before the upload: diff 3, and document the small race |
| `@odata.nextLink` has one of the two path shapes of §7.1 | E2E list and page | Add only the observed shape: diff 4. The host check stays |
| A work account in another tenant can consent to an unverified app | Sign in with such an account | Document that its admin must consent. Personal and same-tenant accounts are unaffected |
| `elicitInput` of SDK 1.32.2 works on the protocol revision Claude Code negotiates | Manual dialog check below | Adapt `src/mcp/confirm-replace.ts` only; the `ConfirmReplace` boundary stays |

The manual dialog check of spec §8 is Step 6 of Task 24. Automated tests cover the callback only.

**Diff 1: fixed registered port**

```diff
diff --git a/src/auth/loopback.ts b/src/auth/loopback.ts
index 7b8642c..4d76104 100644
--- a/src/auth/loopback.ts
+++ b/src/auth/loopback.ts
@@ -168,10 +168,10 @@ export async function waitForPaste(
   }
 }
 
-export async function listen(server: Server): Promise<number> {
+export async function listen(server: Server, fixedPort = 0): Promise<number> {
   await new Promise<void>((resolve, reject) => {
     server.once('error', reject);
-    server.listen(0, '127.0.0.1', () => {
+    server.listen(fixedPort, '127.0.0.1', () => {
       server.off('error', reject);
       resolve();
     });
@@ -196,8 +196,9 @@ function closeServer(server: Server): Promise<void> {
 export async function listenLocalhost(
   server: Server,
   createV6: () => Server = createServer,
+  fixedPort = 0,
 ): Promise<LocalhostListener> {
-  const port = await listen(server);
+  const port = await listen(server, fixedPort);
   const v6 = createV6();
   const bound = await new Promise<boolean>((resolve) => {
     v6.once('error', () => resolve(false));
diff --git a/src/auth/microsoft-auth.ts b/src/auth/microsoft-auth.ts
index c48e11d..014dcfc 100644
--- a/src/auth/microsoft-auth.ts
+++ b/src/auth/microsoft-auth.ts
@@ -1,4 +1,4 @@
-import { createHash, randomBytes, randomInt } from 'node:crypto';
+import { createHash, randomBytes } from 'node:crypto';
 import { createServer } from 'node:http';
 import {
   defaultAlias,
@@ -24,6 +24,7 @@ import type { TokenStore } from './token-store.js';
 const AUTHORITY = 'https://login.microsoftonline.com/common/oauth2/v2.0';
 export const MICROSOFT_SCOPES = 'Files.ReadWrite offline_access User.Read openid profile email';
 const LABEL = 'Microsoft';
+const REDIRECT_PORT = 53682;
 const DEFAULT_TIMEOUT_MS = 120_000;
 const DEFAULT_MANUAL_TIMEOUT_MS = 600_000;
 const DEFAULT_FINISH_TIMEOUT_MS = 60_000;
@@ -301,7 +302,7 @@ export class MicrosoftAuth implements ProviderAuth {
     const clientId = await this.deps.loadClientId();
     const state = randomBytes(16).toString('hex');
     const { codeVerifier, codeChallenge } = pkce();
-    const redirectUri = `http://localhost:${49152 + randomInt(65535 - 49152)}`;
+    const redirectUri = `http://localhost:${REDIRECT_PORT}`;
     await this.deps.pending.save({
       state,
       codeVerifier,
@@ -336,7 +337,7 @@ export class MicrosoftAuth implements ProviderAuth {
     const state = randomBytes(16).toString('hex');
     const { codeVerifier, codeChallenge } = pkce();
     const server = createServer();
-    const listener = await listenLocalhost(server);
+    const listener = await listenLocalhost(server, createServer, REDIRECT_PORT);
     const pasteAbort = new AbortController();
     try {
       const redirectUri = `http://localhost:${listener.port}`;
```

**Diff 2: target-name preflight for `copy`**

```diff
diff --git a/src/onedrive/onedrive-file-service.ts b/src/onedrive/onedrive-file-service.ts
index 4087231..f4eb160 100644
--- a/src/onedrive/onedrive-file-service.ts
+++ b/src/onedrive/onedrive-file-service.ts
@@ -294,6 +294,7 @@ export class OneDriveFileService implements FileProvider {
       input.parentId === 'root' ? rootId : (input.parentId ?? source.parentReference?.id);
     if (input.parentId !== undefined) await this.assertOwnItem(client, input.parentId);
     if (!parentId) throw new ValidationError('The root folder cannot be copied');
+    await this.assertNameFree(client, parentId, input.name ?? source.name);
     const target = input.name ?? input.fileId;
     const details = { sourceId: input.fileId, parentId: input.parentId ?? null };
     try {
@@ -367,7 +368,7 @@ export class OneDriveFileService implements FileProvider {
     client: GraphClient,
     parentId: string,
     name: string,
-    itemId: string,
+    itemId?: string,
   ): Promise<void> {
     const found = await client.getOrNull<GraphItem>(
       `${childPath(parentId, name)}?$select=id`,
```

**Diff 3: compare the eTag immediately before the overwrite**

```diff
diff --git a/src/onedrive/onedrive-file-service.ts b/src/onedrive/onedrive-file-service.ts
index 4087231..d603c51 100644
--- a/src/onedrive/onedrive-file-service.ts
+++ b/src/onedrive/onedrive-file-service.ts
@@ -200,7 +200,7 @@ export class OneDriveFileService implements FileProvider {
     });
   }
 
-  private replace(
+  private async replace(
     client: GraphClient,
     existing: GraphItem,
     eTag: string,
@@ -209,6 +209,8 @@ export class OneDriveFileService implements FileProvider {
   ): Promise<GraphItem> {
     const headers = { 'If-Match': eTag };
     const item = itemPath(existing.id);
+    const current = await client.getOrNull<GraphItem>(`${item}?$select=eTag`, existing.name);
+    if (current?.eTag !== eTag) throw new TargetChangedError(existing.name);
     if (size === 0) {
       return client.json<GraphItem>('PUT', `${item}/content`, {
         retry: 'create',
```

**Diff 4: add the observed `@odata.nextLink` shape (replace the example path with the one seen)**

```diff
diff --git a/src/onedrive/graph-client.ts b/src/onedrive/graph-client.ts
index 27ba68c..7af7a4e 100644
--- a/src/onedrive/graph-client.ts
+++ b/src/onedrive/graph-client.ts
@@ -157,6 +157,7 @@ export class GraphClient {
     }
     const prefixes = ['/v1.0/me/drive/', `/v1.0/drives/${driveId}/`];
     prefixes.push(`/v1.0/drives/${driveId.replaceAll('!', '%21')}/`);
+    prefixes.push(`/v1.0/me/drives/${driveId}/`);
     const valid =
       !hasControlOrSpace(token) &&
       !hasPathTrick(token) &&
```

