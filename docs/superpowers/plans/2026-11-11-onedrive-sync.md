# OneDrive Selective Sync Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The existing `sync_*` tools and `sync` CLI commands work for Microsoft accounts (personal OneDrive) with the Phase A and Phase B behaviour of Google sync, except the Google-native export path. Google sync behaviour does not change.

**Architecture:** The sync engine stops calling Drive. Every remote read and write goes through one port, `SyncRemote` (`src/sync/remote/sync-remote.ts`), which speaks provider-neutral `RemoteItem`s. `GoogleSyncRemote` wraps the Drive adapter through the `OperationRunner` (today's calls, fields and queries); `OneDriveSyncRemote` wraps sub-project 1's `GraphClient`. The engine keeps every decision and audit record; the port owns transport, retries and error mapping. OneDrive adds quickXor hashes, `delta` deletion evidence, name rules and a cloud-desktop-folder guard.

**Tech Stack:** TypeScript (strict, ESM/NodeNext), Node ≥ 22.12, Vitest, ESLint (`--max-warnings=0`), Prettier. No new dependencies.

---

**Spec (read first, authoritative):** `docs/superpowers/specs/2026-11-11-onedrive-sync-design.md`. Rules it builds on: `2026-11-03-selective-sync-design.md` (Phase A), `2026-11-07-sync-phase-b-addendum.md` (Phase B).

Chunk 1 is derived from a working implementation: one commit per task, each step's failure and pass were observed, and the code blocks are the committed code (new files in full, changes as unified diffs against the previous task's state).

## Ground rules

- Branch from `feat/onedrive-sync`; **never push**. No live Google or Microsoft calls in any task; the live E2E runs are the user's.
- Created files appear in full. Changes are unified diffs; apply them with `git apply` or by hand, tasks in order.
- After every task: `npx prettier --write <changed files>` then `npm run check` (typecheck, eslint with zero warnings, prettier, vitest). Never commit red.
- Chunk 1 is a pure refactor for Google: existing rule tests keep their expectations, only setup changes. The Drive calls are pinned by `src/sync/__tests__/google-remote.test.ts`.
- Imports use the `.js` suffix. Non-test code has explicit return types; tests are exempt.
- Test helpers: `src/files/__tests__/fakes.ts` (`createFakeDrive`, `createRunner`, `createAudit`, `noSleep`, `silentLogger`, `httpError`), `src/sync/__tests__/memory-drive.ts`, `drive-tree.ts`, `fixtures.ts`; new in Chunk 1: `src/sync/__tests__/fake-remote.ts` (`googleRemoteOver(drive, { prefs?, logger? })`).
- A test file for a module that does not exist yet fails with `Cannot find module`; that is the expected red.

## Decisions where the spec leaves room (Chunk 1; keep consistent)

1. **Extra port members.** Besides spec §2.1, `SyncRemote` has `account` (the resolved alias, used for `pair.account` and audit records) and `read(id)` (like `get`, but a missing or unreadable item throws the provider's `NotFoundError`/`PermissionDeniedError`). The executor, release, `checkRoots` and `createPair` use `read` so their Google messages and outcomes stay as they are; §5's "null from `get` at the other call sites" mapping is Chunk 3 work and switches those sites to `get`.
2. **Content in a consumer callback.** `download(id, consume)` and `exportNative(source, plan, consume)` run `consume(open)` inside one retried operation, instead of returning a `Readable`. That keeps today's retry boundary (`placeExclusive` / `downloadReplace` inside `ops.exec`, so a retry reopens the stream). `exportNew` passes `(open) => open()` and keeps the stream outside the retry, as before.
3. **Native exports.** `readNative(id)` re-reads with `SYNC_EXPORT_FIELDS` and returns an opaque `NativeSource { item }`; `GoogleSyncRemote` keeps the `DriveFile` (export links, web link) in a `WeakMap` for `exportNative`. OneDrive throws `ValidationError` from both (natives never exist there).
4. **`findChildren` on Google.** Folders: every page of the folder query, `files(id, name)`, then the fold-key filter; the engine still requires the NFC name on case-sensitive volumes. Files: one page (`pageSize 100`) of the exact-name query, as the duplicate-upload check always did (not paged).
5. **Remote factory.** `SyncEnv.remoteFor(pair)` builds the pair's remote from `pair.account` and `pair.googleExport` (classification of natives needs the pair's export prefs, so the Google remote is per pair). `SyncEnv.openRemote(ref, prefs)` resolves an account reference before a pair exists, through one `OperationRunner.exec` that reads `ctx.account.alias` and makes no Drive call. Chunk 3 makes both pick the provider.
6. **`canAddChildren`.** Missing in Drive's answer counts as allowed (`!== false`), which is today's `remoteRootProblem` rule.
7. **`RemoteEntry.md5`, `SyncRecord.remoteMd5` and `PlanInput.md5s` stay** in Chunk 1. `md5Of(item)` (`content-compare.ts`) reads an md5 `ContentHash`; `ContentHash` replaces md5 in the engine in Chunk 2.
8. **`RemoteIgnoreReason`** is already `RemoteUnsupported | 'unrepresentable' | 'ignored-name'`; Google only produces `shortcut` and `native-unsupported`. Report texts for the new reasons are Chunk 3.

## Known differences on Google (Chunk 1)

- The probe's parent walk (`remote-probe.ts`) reads each parent folder with the full sync fields instead of `'id, parents'`; the outcome is the same, the response is a little larger.
- `sync_create_pair` resolves the account alias in its own runner call before the Drive call (no Drive request, same account errors).
- Natives are classified while listing. A pair with export settings that `resolveExport` refuses would now make that folder an unknown subtree instead of failing the scan; such settings are refused at `sync_create_pair`, so this cannot happen in practice.

## File structure (whole feature)

| File | Status | Chunk | Responsibility |
|---|---|---|---|
| `src/sync/remote/sync-remote.ts` | Create | 1 | Port and types: `HashKind`, `ContentHash`, `RemoteUnsupported`, `RemoteItem`, `NativeSource`, `SyncRemote`, `DeletionFeed` |
| `src/sync/remote/google-remote.ts` | Create | 1 | `GoogleSyncRemote`, `toRemoteItem`, `classifyRemote`, `validateGoogleExport`, the Drive fields and queries |
| `src/sync/remote-kinds.ts` | Delete | 1 | Moved into `google-remote.ts` (`exportKey` into `remote-scanner.ts`) |
| `src/sync/remote-scanner.ts` | Modify | 1, 3 | Walk over `RemoteItem`s; OneDrive fold rules for `uploadKey` neighbours |
| `src/sync/remote-probe.ts` | Modify | 1, 3 | `SyncRemote.get`; OneDrive evidence mapping (§4.1) |
| `src/sync/remote-folders.ts` | Modify | 1 | `findChildren` / `createFolder` |
| `src/sync/scan-select.ts` | Modify | 1, 2, 3 | Scans and probes through the pair's remote; digests; deletion feed read |
| `src/sync/executor.ts` | Modify | 1, 2, 3 | Every remote call on the port; digests; §5 outcome mapping |
| `src/sync/transfer.ts` | Modify | 1, 2 | No Drive calls; `writeTemp` expected hash and size (§3.3) |
| `src/sync/exec-records.ts` | Modify | 1, 2 | `fromRemote`; local digests in `localFields` |
| `src/sync/exec-export.ts` | Modify | 1 | `readNative` / `exportNative` |
| `src/sync/release.ts` | Modify | 1, 2 | `verifyRemote` on the port; `verifyLocal` / `check()` digests |
| `src/sync/pair-admin.ts` | Modify | 1, 3, 4 | `remoteRootProblem` on `RemoteItem`, `openRemote`; Microsoft settings; cloud-folder guard |
| `src/sync/content-compare.ts` | Modify | 1, 2 | `remoteUnchangedSince` on `RemoteItem`, `md5Of`; `sameContent`, `LocalDigests` |
| `src/sync/planner.ts`, `plan-shared.ts`, `plan-remote-only.ts`, `plan-tracked.ts`, `plan-untracked.ts` | Modify | 2, 3 | Hash compares through `content-compare`; planId hashes `kind:value`; provider words; name checks |
| `src/sync/local-scanner.ts`, `resolve.ts` | Modify | 2 | `hashFileDigests`, `LocalDigests`, `hashTargets` extras (§3.1) |
| `src/sync/types.ts`, `pair-store.ts` | Modify | 1, 2, 3 | Types; pair file v2 (`remoteHash`, `remoteCursor`, `remoteDeletedIds`) and v1 migration |
| `src/sync/report.ts` | Modify | 3 | Texts for `onenote`, `special`, `shared` |
| `src/sync/remote/onedrive-remote.ts` | Create | 3 | `OneDriveSyncRemote` over `GraphClient`, root `delta` feed |
| `src/sync/remote/quickxor.ts` | Create | 3 | Incremental QuickXorHash |
| `src/sync/remote/remote-names.ts` | Create | 3 | `remoteNameProblem(provider, name)` |
| `src/sync/cloud-folders.ts` | Create | 4 | Desktop client folder guard (§6) |
| `src/sync/sync-service.ts`, `src/app.ts`, MCP/CLI sync account checks | Modify | 1, 3 | Remote factory; account routing, `assertSupportedAccount` dropped for sync |
| `src/sync/__tests__/fake-remote.ts` | Create | 1 | `googleRemoteOver(drive)` test helper |
| `src/sync/__tests__/google-remote.test.ts` | Create | 1 | Classification, `toRemoteItem`, the pinned Drive calls (replaces `remote-kinds.test.ts`) |
| `src/sync/__tests__/{exec-records,remote-folders,pair-admin}.test.ts` | Create | 1 | Unit tests for the moved call sites |
| `src/sync/__tests__/no-googleapis.test.ts` | Modify | 1 | The `SyncRemote` boundary test |
| `tests/e2e/onedrive-sync.e2e.test.ts` | Create | 3 | Live OneDrive sync E2E (§9) |
| `README.md`, `CHANGELOG.md`, tool descriptions | Modify | 4 | OneDrive row, desktop-folder rule, evidence rule, upload-session race |

## Task map (Chunk 1)

| Task | Commit | What moves onto the port |
|---|---|---|
| 1 | `3d50975` | Types; `classifyRemote`, `validateGoogleExport`, `toRemoteItem` |
| 2 | `ad64355` | `GoogleSyncRemote` reads, pinned |
| 3 | `e5a20be` | `GoogleSyncRemote` writes and content, pinned |
| 4 | `f21fc43` | Remote scan; `SyncEnv.remoteFor` / `openRemote` |
| 5 | `df63eed` | Probe |
| 6 | `b1d8645` | Executor re-reads and trash; `remoteUnchangedSince` |
| 7 | `4190dc9` | Uploads, `replaceContent`, duplicate check, `fromRemote` |
| 8 | `fcf2977` | Upload folders |
| 9 | `1a6baf2` | Downloads and native exports |
| 10 | `2ae858a` | Release re-read |
| 11 | `8914c45` | Pair roots |
| 12 | `bb95108` | Boundary test |

## Chunk 1: SyncRemote port (Google only)

Spec §8 item 1. Every task keeps the Google behaviour; existing rule tests keep their expectations, only their setup changes (a `GoogleSyncRemote` over the existing fake Drive). Starting point: **1329 passed, 6 skipped (1335)**, 124 files, on `feat/onedrive-sync` at `5fa5182`.

### Task 1: Port types; Drive classification moves to the Google remote

**Spec:** §2.1, §2.3 (`remote-kinds.ts` moves under `google-remote.ts`). Commit `3d50975` on the reference branch.

**Files:**
- Test (create): `src/sync/__tests__/google-remote.test.ts`
- Test (delete): `src/sync/__tests__/remote-kinds.test.ts`
- Test: `src/sync/__tests__/remote-scanner.test.ts`
- Modify: `src/sync/pair-admin.ts`
- Delete: `src/sync/remote-kinds.ts`
- Modify: `src/sync/remote-probe.ts`
- Modify: `src/sync/remote-scanner.ts`
- Create: `src/sync/remote/google-remote.ts`
- Create: `src/sync/remote/sync-remote.ts`
- Modify: `src/sync/types.ts`

- [ ] **Step 1: Write the failing test (and its setup).**

`src/sync/__tests__/google-remote.test.ts` (create):

```ts
import { describe, expect, it } from 'vitest';
import { ValidationError } from '../../errors.js';
import { GOOGLE_MIME } from '../../files/export-formats.js';
import { classifyRemote, toRemoteItem, validateGoogleExport } from '../remote/google-remote.js';
import { DEFAULT_GOOGLE_EXPORT } from '../types.js';
import { binary, folder } from './drive-tree.js';
import { DOCX_MIME } from './fixtures.js';

describe('classifyRemote', () => {
  it('binary files', () => {
    expect(classifyRemote({ mimeType: 'application/pdf' }, DEFAULT_GOOGLE_EXPORT)).toEqual({
      kind: 'binary',
    });
  });
  it('Google-native files with the pair export format', () => {
    expect(classifyRemote({ mimeType: GOOGLE_MIME.document }, DEFAULT_GOOGLE_EXPORT)).toEqual({
      kind: 'native',
      mimeType: GOOGLE_MIME.document,
      exportFormat: 'docx',
      exportMime: DOCX_MIME,
      extension: 'docx',
    });
    const prefs = { ...DEFAULT_GOOGLE_EXPORT, spreadsheet: 'csv' as const };
    expect(classifyRemote({ mimeType: GOOGLE_MIME.spreadsheet }, prefs)).toMatchObject({
      kind: 'native',
      exportFormat: 'csv',
      exportMime: 'text/csv',
    });
    expect(classifyRemote({ mimeType: GOOGLE_MIME.drawing }, DEFAULT_GOOGLE_EXPORT)).toMatchObject({
      exportFormat: 'pdf',
    });
  });
  it('unsupported Google types (Forms, Sites, Apps Script, Jamboard, Maps)', () => {
    for (const t of ['form', 'site', 'script', 'jam', 'map']) {
      expect(
        classifyRemote({ mimeType: `application/vnd.google-apps.${t}` }, DEFAULT_GOOGLE_EXPORT),
      ).toEqual({ kind: 'unsupported', reason: 'native-unsupported' });
    }
  });
});
describe('validateGoogleExport', () => {
  it('fills omitted types with the defaults', () => {
    expect(validateGoogleExport({})).toEqual(DEFAULT_GOOGLE_EXPORT);
    expect(validateGoogleExport({ document: 'pdf' })).toEqual({
      ...DEFAULT_GOOGLE_EXPORT,
      document: 'pdf',
    });
  });
  it('rejects a format the type cannot be exported as', () => {
    expect(() => validateGoogleExport({ spreadsheet: 'docx' })).toThrow(ValidationError);
    expect(() => validateGoogleExport({ spreadsheet: 'docx' })).toThrow(
      'Google Sheets cannot be exported as "docx"',
    );
  });
});
describe('toRemoteItem', () => {
  it('maps a binary Drive file', () => {
    expect(
      toRemoteItem(binary('b', 'a.pdf', 'P', { trashed: true }), DEFAULT_GOOGLE_EXPORT),
    ).toEqual({
      id: 'b',
      name: 'a.pdf',
      parentId: 'P',
      kind: 'file',
      mimeType: 'application/pdf',
      size: 10,
      modifiedTime: '2026-11-02T00:00:00.000Z',
      createdTime: '2026-11-01T00:00:00.000Z',
      hash: { kind: 'md5', value: 'md5-b' },
      version: null,
      trashed: true,
      canEdit: true,
      canTrash: true,
      canAddChildren: false,
      native: null,
    });
  });
  it('defaults missing fields like the scanner did', () => {
    expect(toRemoteItem({}, DEFAULT_GOOGLE_EXPORT)).toMatchObject({
      id: '',
      name: '',
      parentId: null,
      kind: 'file',
      mimeType: 'application/octet-stream',
      size: null,
      modifiedTime: '',
      createdTime: '',
      hash: null,
      trashed: false,
      canEdit: false,
      canTrash: false,
      canAddChildren: true,
    });
    expect(toRemoteItem({ size: '0' }, DEFAULT_GOOGLE_EXPORT).size).toBe(0);
  });
  it('folders, shortcuts and natives', () => {
    expect(toRemoteItem(folder('f', 'docs', 'P'), DEFAULT_GOOGLE_EXPORT).kind).toBe('folder');
    expect(
      toRemoteItem({ id: 's', mimeType: GOOGLE_MIME.shortcut }, DEFAULT_GOOGLE_EXPORT),
    ).toMatchObject({ kind: 'unsupported', unsupported: 'shortcut' });
    expect(
      toRemoteItem(
        { id: 'x', mimeType: 'application/vnd.google-apps.form' },
        DEFAULT_GOOGLE_EXPORT,
      ),
    ).toMatchObject({ kind: 'unsupported', unsupported: 'native-unsupported' });
    const prefs = { ...DEFAULT_GOOGLE_EXPORT, spreadsheet: 'csv' as const };
    expect(toRemoteItem({ id: 'g', mimeType: GOOGLE_MIME.spreadsheet }, prefs)).toMatchObject({
      kind: 'file',
      hash: null,
      native: { mimeType: GOOGLE_MIME.spreadsheet, exportFormat: 'csv', exportMime: 'text/csv' },
    });
  });
});
```

Delete `src/sync/__tests__/remote-kinds.test.ts`:

```bash
git rm src/sync/__tests__/remote-kinds.test.ts
```

`src/sync/__tests__/remote-scanner.test.ts` (modify):

```diff
diff --git a/src/sync/__tests__/remote-scanner.test.ts b/src/sync/__tests__/remote-scanner.test.ts
index c38d3b2..daeb037 100644
--- a/src/sync/__tests__/remote-scanner.test.ts
+++ b/src/sync/__tests__/remote-scanner.test.ts
@@ -1,7 +1,7 @@
 import { describe, expect, it } from 'vitest';
 import { NotFoundError, ReauthRequiredError } from '../../errors.js';
 import { GOOGLE_MIME } from '../../files/export-formats.js';
-import { childrenQuery, scanRemote } from '../remote-scanner.js';
+import { childrenQuery, exportKey, scanRemote } from '../remote-scanner.js';
 import { DEFAULT_GOOGLE_EXPORT } from '../types.js';
 import { binary, folder, treeLister } from './drive-tree.js';
 
@@ -14,6 +14,14 @@ describe('childrenQuery', () => {
   });
 });
 
+describe('exportKey', () => {
+  it('adds the extension unless present, NFC, under the parent key', () => {
+    expect(exportKey('', 'Plan', 'docx')).toBe('Plan.docx');
+    expect(exportKey('a/b', 'Report.DOCX', 'docx')).toBe('a/b/Report.DOCX');
+    expect(exportKey('', 'şartname'.normalize('NFD'), 'docx')).toBe('şartname.docx');
+  });
+});
+
 describe('scanRemote', () => {
   it('walks nested folders with NFC keys, ancestors and capabilities', async () => {
     const list = treeLister([
```

- [ ] **Step 2: Run it and watch it fail.**

Run: `npx vitest run src/sync/__tests__/google-remote.test.ts`

Expected: FAIL. `Error: Cannot find module '../remote/google-remote.js'`; Tests  no tests.

- [ ] **Step 3: Implement.**

`src/sync/pair-admin.ts` (modify):

```diff
diff --git a/src/sync/pair-admin.ts b/src/sync/pair-admin.ts
index c6d01cb..8b63ff7 100644
--- a/src/sync/pair-admin.ts
+++ b/src/sync/pair-admin.ts
@@ -17,7 +17,7 @@ import {
   writeMarker,
   type PairStore,
 } from './pair-store.js';
-import { validateGoogleExport } from './remote-kinds.js';
+import { validateGoogleExport } from './remote/google-remote.js';
 import {
   PAIR_NAME,
   SYNC_FILE_FIELDS,
```

Delete `src/sync/remote-kinds.ts`:

```bash
git rm src/sync/remote-kinds.ts
```

`src/sync/remote-probe.ts` (modify):

```diff
diff --git a/src/sync/remote-probe.ts b/src/sync/remote-probe.ts
index d73faae..9a99b33 100644
--- a/src/sync/remote-probe.ts
+++ b/src/sync/remote-probe.ts
@@ -3,7 +3,7 @@ import { AppError, NotFoundError, PermissionDeniedError } from '../errors.js';
 import { GOOGLE_MIME } from '../files/export-formats.js';
 import { isAbortError } from './errors.js';
 import { baseName, isIgnoredName, isRepresentable } from './paths.js';
-import { classifyRemote } from './remote-kinds.js';
+import { classifyRemote } from './remote/google-remote.js';
 import { toRemoteEntry } from './remote-scanner.js';
 import {
   DEFAULT_GOOGLE_EXPORT,
```

`src/sync/remote-scanner.ts` (modify):

```diff
diff --git a/src/sync/remote-scanner.ts b/src/sync/remote-scanner.ts
index 542dc3c..3ba9130 100644
--- a/src/sync/remote-scanner.ts
+++ b/src/sync/remote-scanner.ts
@@ -2,8 +2,9 @@ import type { DriveFile, DriveFileList } from '../drive/drive-adapter.js';
 import { GOOGLE_MIME } from '../files/export-formats.js';
 import { escapeQueryValue } from '../files/query.js';
 import { isAbortError } from './errors.js';
+import { ensureExtension } from '../files/filename.js';
 import { baseName, foldKey, isIgnoredName, isRepresentable } from './paths.js';
-import { classifyRemote, exportKey, type RemoteKind } from './remote-kinds.js';
+import { classifyRemote, type RemoteKind } from './remote/google-remote.js';
 import {
   DEFAULT_GOOGLE_EXPORT,
   SYNC_FILE_FIELDS,
@@ -25,6 +26,12 @@ export function childrenQuery(folderId: string): string {
   return `'${escapeQueryValue(folderId)}' in parents and trashed = false`;
 }
 
+/** Local key of a native file's export: Drive name + extension unless present (NFC). */
+export function exportKey(parentKey: string, remoteName: string, extension: string): string {
+  const name = ensureExtension(remoteName.normalize('NFC'), extension);
+  return parentKey === '' ? name : `${parentKey}/${name}`;
+}
+
 function joinKey(parent: string, name: string): string {
   const nfc = name.normalize('NFC');
   return parent === '' ? nfc : `${parent}/${nfc}`;
@@ -78,7 +85,7 @@ async function listAll(list: FolderLister, folderId: string): Promise<DriveFile[
 /**
  * Breadth-first walk of the pair's Drive folder (spec §4 remote-scanner). Duplicate
  * folder names and failed listings become unknown subtrees. Google-native files are
- * classified by remote-kinds and keyed by their export name; shortcuts, natives that
+ * classified by the Google remote and keyed by their export name; shortcuts, natives that
  * cannot be exported, unrepresentable and dot/part names are ignored and reported.
  */
 export async function scanRemote(
```

`src/sync/remote/google-remote.ts` (create):

```ts
import type { DriveFile } from '../../drive/drive-adapter.js';
import {
  GOOGLE_MIME,
  isGoogleNative,
  resolveExport,
  type ExportFormat,
} from '../../files/export-formats.js';
import { DEFAULT_GOOGLE_EXPORT, type GoogleExportPrefs } from '../types.js';
import type { RemoteItem } from './sync-remote.js';

/**
 * The only sync module that knows Drive shapes: Google-native, folder and shortcut MIME
 * types, `resolveExport` (addendum §4.1).
 */
export type RemoteKind =
  | { kind: 'binary' }
  | {
      kind: 'native';
      mimeType: string;
      exportFormat: ExportFormat;
      exportMime: string;
      extension: string;
    }
  | { kind: 'unsupported'; reason: 'native-unsupported' };

const PREF_BY_MIME: Readonly<Record<string, keyof GoogleExportPrefs>> = {
  [GOOGLE_MIME.document]: 'document',
  [GOOGLE_MIME.spreadsheet]: 'spreadsheet',
  [GOOGLE_MIME.presentation]: 'presentation',
  [GOOGLE_MIME.drawing]: 'drawing',
};

/** Binary, exportable native (with the pair's format), or unsupported native. */
export function classifyRemote(file: DriveFile, prefs: GoogleExportPrefs): RemoteKind {
  const mimeType = file.mimeType ?? '';
  if (!isGoogleNative(mimeType)) return { kind: 'binary' };
  const pref = PREF_BY_MIME[mimeType];
  if (pref === undefined) return { kind: 'unsupported', reason: 'native-unsupported' };
  const plan = resolveExport(mimeType, prefs[pref]);
  if (plan === null) return { kind: 'unsupported', reason: 'native-unsupported' };
  return {
    kind: 'native',
    mimeType,
    exportFormat: plan.format,
    exportMime: plan.mimeType,
    extension: plan.extension,
  };
}

/** Pair export settings: defaults for omitted types; each checked with resolveExport. */
export function validateGoogleExport(prefs: Partial<GoogleExportPrefs>): GoogleExportPrefs {
  const merged: GoogleExportPrefs = { ...DEFAULT_GOOGLE_EXPORT };
  for (const key of Object.keys(merged) as Array<keyof GoogleExportPrefs>) {
    const value = prefs[key];
    if (value !== undefined) merged[key] = value;
  }
  for (const [mime, key] of Object.entries(PREF_BY_MIME)) resolveExport(mime, merged[key]);
  return merged;
}

/** A Drive file as the engine sees it; `prefs` decide how a native file exports. */
export function toRemoteItem(file: DriveFile, prefs: GoogleExportPrefs): RemoteItem {
  const mimeType = file.mimeType ?? '';
  const base = {
    id: file.id ?? '',
    name: file.name ?? '',
    parentId: file.parents?.[0] ?? null,
    mimeType: file.mimeType ?? 'application/octet-stream',
    size: file.size ? Number(file.size) : null,
    modifiedTime: file.modifiedTime ?? '',
    createdTime: file.createdTime ?? '',
    hash:
      typeof file.md5Checksum === 'string'
        ? { kind: 'md5' as const, value: file.md5Checksum }
        : null,
    version: null,
    trashed: file.trashed === true,
    canEdit: file.capabilities?.canEdit ?? false,
    canTrash: file.capabilities?.canTrash ?? false,
    canAddChildren: file.capabilities?.canAddChildren !== false,
    native: null,
  };
  if (mimeType === GOOGLE_MIME.folder) return { ...base, kind: 'folder' };
  if (mimeType === GOOGLE_MIME.shortcut) {
    return { ...base, kind: 'unsupported', unsupported: 'shortcut' };
  }
  const kind = classifyRemote(file, prefs);
  if (kind.kind === 'unsupported') {
    return { ...base, kind: 'unsupported', unsupported: kind.reason };
  }
  if (kind.kind === 'binary') return { ...base, kind: 'file' };
  return {
    ...base,
    kind: 'file',
    native: {
      mimeType: kind.mimeType,
      exportFormat: kind.exportFormat,
      exportMime: kind.exportMime,
    },
  };
}
```

`src/sync/remote/sync-remote.ts` (create):

```ts
import type { Readable } from 'node:stream';
import type { ExportPlan } from '../../files/export-formats.js';
import type { NativeInfo } from '../types.js';

/*
 * The sync engine's only view of a cloud drive (OneDrive sync spec §2.1). Implementations
 * own transport, retries and error mapping; the engine keeps every decision and audit record.
 */

export type HashKind = 'md5' | 'quickXor';

export interface ContentHash {
  kind: HashKind;
  value: string;
}

/** Why a remote item is never synced (reported as `ignored`). */
export type RemoteUnsupported =
  'native-unsupported' | 'shortcut' | 'onenote' | 'special' | 'shared';

export interface RemoteItem {
  id: string;
  name: string;
  /** First parent; null for the drive root. */
  parentId: string | null;
  kind: 'file' | 'folder' | 'unsupported';
  unsupported?: RemoteUnsupported;
  mimeType: string;
  size: number | null;
  /** Google: modifiedTime. OneDrive: item lastModifiedDateTime (renames and moves bump it). */
  modifiedTime: string;
  createdTime: string;
  hash: ContentHash | null;
  /** OneDrive eTag, sent as If-Match; null on Google. */
  version: string | null;
  /** Google trashed flag; always false on OneDrive (deleted items are 404). */
  trashed: boolean;
  canEdit: boolean;
  canTrash: boolean;
  /** Unknown counts as allowed (Drive may omit the capability). */
  canAddChildren: boolean;
  /** Google-native file that exports; null elsewhere. */
  native: NativeInfo | null;
}

/** A native file re-read for an export (Google only); the remote keeps what the export needs. */
export interface NativeSource {
  readonly item: RemoteItem;
}

/** Opens a content stream; called again when the remote retries the consumer. */
export type OpenStream = () => Promise<Readable>;

export interface DeletionFeed {
  /** Cursor for "from now on", without enumerating. */
  start(): Promise<string>;
  /** Ids reported deleted since `cursor`, and the next cursor; an expired cursor → `expired`. */
  read(cursor: string): Promise<{ deletedIds: string[]; cursor: string } | { expired: true }>;
}

export interface SyncRemote {
  readonly provider: 'google' | 'microsoft';
  /** The hash kind this remote reports for files. */
  readonly hashKind: HashKind;
  /** Default pair root when the caller gives none. */
  readonly rootId: string;
  /** The resolved account alias (stored as `pair.account`, used in audit records). */
  readonly account: string;
  /** null when the item does not exist or cannot be read (404/403); other errors throw. */
  get(id: string, signal?: AbortSignal): Promise<RemoteItem | null>;
  /** Like `get`, but a missing or unreadable item throws the provider's error. */
  read(id: string, signal?: AbortSignal): Promise<RemoteItem>;
  listChildren(
    folderId: string,
    pageToken: string | undefined,
    signal?: AbortSignal,
  ): Promise<{ items: RemoteItem[]; next?: string }>;
  /** Children whose name folds to `name`'s fold key; the engine decides what to do. */
  findChildren(parentId: string, name: string, kind?: 'folder'): Promise<RemoteItem[]>;
  createFolder(parentId: string, name: string): Promise<RemoteItem>;
  uploadNew(parentId: string, name: string, localPath: string): Promise<RemoteItem>;
  replaceContent(item: RemoteItem, localPath: string): Promise<RemoteItem>;
  /**
   * Runs `consume` with an opener for the file's content inside one retried operation, so
   * `consume` must open the stream itself. Verification is the caller's.
   */
  download<T>(id: string, consume: (open: OpenStream) => Promise<T>): Promise<T>;
  /** Google only: re-reads a native file with what its export needs. */
  readNative(id: string): Promise<NativeSource>;
  /** Google only: like `download`, for the export of `source` in `plan`'s format. */
  exportNative<T>(
    source: NativeSource,
    plan: ExportPlan,
    consume: (open: OpenStream) => Promise<T>,
  ): Promise<T>;
  /** Moves the item to the provider's trash / recycle bin. */
  trash(item: RemoteItem): Promise<void>;
  /** OneDrive only; Google returns null. */
  deletionFeed(): DeletionFeed | null;
}
```

`src/sync/types.ts` (modify):

```diff
diff --git a/src/sync/types.ts b/src/sync/types.ts
index ed84fc4..aaddb83 100644
--- a/src/sync/types.ts
+++ b/src/sync/types.ts
@@ -1,4 +1,5 @@
 import type { ExportFormat } from '../files/export-formats.js';
+import type { RemoteUnsupported } from './remote/sync-remote.js';
 
 /** Pair names: lower-case letters, digits and dashes (spec §3). */
 export const PAIR_NAME = /^[a-z0-9-]{1,40}$/;
@@ -121,8 +122,7 @@ export interface RemoteEntry {
   native: NativeInfo | null;
 }
 
-export type RemoteIgnoreReason =
-  'native-unsupported' | 'shortcut' | 'unrepresentable' | 'ignored-name';
+export type RemoteIgnoreReason = RemoteUnsupported | 'unrepresentable' | 'ignored-name';
 
 export interface RemoteIgnored {
   id: string;
```

- [ ] **Step 4: Run it and watch it pass.**

Run: `npx vitest run src/sync/__tests__/google-remote.test.ts`

Expected: PASS (no type errors; every test in the file passes).

- [ ] **Step 5: Format and run the whole check.**

Run: `npx prettier --write src/sync/__tests__/google-remote.test.ts src/sync/__tests__/remote-scanner.test.ts src/sync/pair-admin.ts src/sync/remote-probe.ts src/sync/remote-scanner.ts src/sync/remote/google-remote.ts src/sync/remote/sync-remote.ts src/sync/types.ts` then `npm run check`

Expected: exit 0, `Test Files  124 passed (124); Tests  1332 passed | 6 skipped (1338)`.

- [ ] **Step 6: Commit.**

```bash
git add src/sync/__tests__/google-remote.test.ts src/sync/__tests__/remote-scanner.test.ts src/sync/pair-admin.ts src/sync/remote-probe.ts src/sync/remote-scanner.ts src/sync/remote/google-remote.ts src/sync/remote/sync-remote.ts src/sync/types.ts
git commit -F - <<'MSG'
refactor(sync): add the SyncRemote port types and move Drive classification

Introduce src/sync/remote/sync-remote.ts (HashKind, ContentHash, RemoteUnsupported,
RemoteItem, SyncRemote, DeletionFeed) and src/sync/remote/google-remote.ts with
classifyRemote, validateGoogleExport and toRemoteItem. remote-kinds.ts is gone;
exportKey moves to remote-scanner.ts. No behaviour change.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
MSG
```

### Task 2: GoogleSyncRemote reads, pinned to the Drive calls

**Spec:** §2.2 ("A test pins the issued Drive calls"), §2.1 `get`/`listChildren`/`findChildren`. Commit `ad64355` on the reference branch.

**Files:**
- Test (create): `src/sync/__tests__/fake-remote.ts`
- Test: `src/sync/__tests__/google-remote.test.ts`
- Modify: `src/sync/remote/google-remote.ts`

- [ ] **Step 1: Write the failing test (and its setup).**

`src/sync/__tests__/fake-remote.ts` (create):

```ts
import { OperationRunner } from '../../core/operation.js';
import type { DriveAdapter } from '../../drive/drive-adapter.js';
import { createAudit, createRunner, noSleep, silentLogger } from '../../files/__tests__/fakes.js';
import type { Logger } from '../../logger.js';
import { GoogleSyncRemote } from '../remote/google-remote.js';
import { DEFAULT_GOOGLE_EXPORT, type GoogleExportPrefs } from '../types.js';

/** A GoogleSyncRemote for account `emco` over a fake Drive adapter (no sleeps between retries). */
export function googleRemoteOver(
  drive: DriveAdapter,
  opts: { prefs?: GoogleExportPrefs; logger?: Logger } = {},
): GoogleSyncRemote {
  const ops = new OperationRunner({
    runner: createRunner(drive),
    audit: createAudit(),
    retry: noSleep,
    logger: opts.logger ?? silentLogger(),
  });
  return new GoogleSyncRemote(ops, 'emco', opts.prefs ?? DEFAULT_GOOGLE_EXPORT);
}
```

`src/sync/__tests__/google-remote.test.ts` (modify):

```diff
diff --git a/src/sync/__tests__/google-remote.test.ts b/src/sync/__tests__/google-remote.test.ts
index dfb5ec5..e3310d8 100644
--- a/src/sync/__tests__/google-remote.test.ts
+++ b/src/sync/__tests__/google-remote.test.ts
@@ -1,11 +1,106 @@
 import { describe, expect, it } from 'vitest';
-import { ValidationError } from '../../errors.js';
+import { NotFoundError, QuotaExceededError, ValidationError } from '../../errors.js';
+import { createFakeDrive, httpError } from '../../files/__tests__/fakes.js';
 import { GOOGLE_MIME } from '../../files/export-formats.js';
 import { classifyRemote, toRemoteItem, validateGoogleExport } from '../remote/google-remote.js';
 import { DEFAULT_GOOGLE_EXPORT } from '../types.js';
 import { binary, folder } from './drive-tree.js';
+import { googleRemoteOver } from './fake-remote.js';
 import { DOCX_MIME } from './fixtures.js';
 
+const FILE_FIELDS =
+  'id, name, mimeType, md5Checksum, size, modifiedTime, createdTime, parents, trashed, capabilities(canEdit, canTrash, canAddChildren)';
+const LIST_FIELDS = `nextPageToken, files(${FILE_FIELDS})`;
+const FOLDER_Q =
+  "'P\\'1' in parents and trashed = false and mimeType = 'application/vnd.google-apps.folder'";
+
+describe('GoogleSyncRemote reads (pinned to the Drive calls sync made before the port)', () => {
+  it('read and get: one getFile with the sync fields; get maps 404/403 to null', async () => {
+    const drive = createFakeDrive();
+    drive.getFile.mockResolvedValueOnce(binary('r', 'a.pdf', 'P'));
+    const remote = googleRemoteOver(drive);
+    expect(await remote.read('r')).toMatchObject({ id: 'r', parentId: 'P', kind: 'file' });
+    expect(drive.getFile).toHaveBeenCalledWith('r', FILE_FIELDS);
+    drive.getFile.mockRejectedValueOnce(httpError(404, 'notFound'));
+    expect(await remote.get('gone')).toBeNull();
+    drive.getFile.mockRejectedValueOnce(httpError(403, 'forbidden'));
+    expect(await remote.get('denied')).toBeNull();
+    drive.getFile.mockRejectedValueOnce(httpError(404, 'notFound'));
+    await expect(remote.read('gone')).rejects.toBeInstanceOf(NotFoundError);
+    drive.getFile.mockRejectedValueOnce(httpError(403, 'storageQuotaExceeded'));
+    await expect(remote.get('q')).rejects.toBeInstanceOf(QuotaExceededError);
+  });
+
+  it('listChildren: the children query, page size 1000 and the list fields', async () => {
+    const drive = createFakeDrive();
+    drive.listFiles
+      .mockResolvedValueOnce({ files: [binary('a', 'a.pdf', 'P')], nextPageToken: 't2' })
+      .mockResolvedValueOnce({ files: [folder('f', 'docs', 'P')] });
+    const remote = googleRemoteOver(drive);
+    const first = await remote.listChildren("P'1", undefined);
+    expect(first.items.map((i) => i.id)).toEqual(['a']);
+    expect(first.next).toBe('t2');
+    const second = await remote.listChildren("P'1", 't2');
+    expect(second).toEqual({ items: [expect.objectContaining({ id: 'f', kind: 'folder' })] });
+    expect(drive.listFiles.mock.calls.map((c) => c[0])).toEqual([
+      { q: "'P\\'1' in parents and trashed = false", pageSize: 1000, fields: LIST_FIELDS },
+      {
+        q: "'P\\'1' in parents and trashed = false",
+        pageSize: 1000,
+        pageToken: 't2',
+        fields: LIST_FIELDS,
+      },
+    ]);
+  });
+
+  it('findChildren folders: the folder query, paged, id and name only, fold-matched', async () => {
+    const drive = createFakeDrive();
+    drive.listFiles
+      .mockResolvedValueOnce({ files: [{ id: 'f1', name: 'Docs' }], nextPageToken: 'n' })
+      .mockResolvedValueOnce({
+        files: [
+          { id: 'f2', name: 'other' },
+          { id: 'f3', name: 'docs' },
+        ],
+      });
+    const found = await googleRemoteOver(drive).findChildren("P'1", 'docs', 'folder');
+    expect(found.map((f) => [f.id, f.name, f.kind, f.parentId])).toEqual([
+      ['f1', 'Docs', 'folder', "P'1"],
+      ['f3', 'docs', 'folder', "P'1"],
+    ]);
+    expect(drive.listFiles.mock.calls.map((c) => c[0])).toEqual([
+      { q: FOLDER_Q, pageSize: 1000, fields: 'nextPageToken, files(id, name)' },
+      { q: FOLDER_Q, pageSize: 1000, pageToken: 'n', fields: 'nextPageToken, files(id, name)' },
+    ]);
+  });
+
+  it('findChildren files: one page of the name query with the list fields', async () => {
+    const drive = createFakeDrive();
+    drive.listFiles.mockResolvedValueOnce({
+      files: [binary('a', "it's.pdf", 'P'), binary('b', 'other.pdf', 'P')],
+      nextPageToken: 'ignored',
+    });
+    const found = await googleRemoteOver(drive).findChildren('P', "it's.pdf");
+    expect(found.map((f) => f.id)).toEqual(['a']);
+    expect(drive.listFiles).toHaveBeenCalledTimes(1);
+    expect(drive.listFiles).toHaveBeenCalledWith({
+      q: "'P' in parents and trashed = false and name = 'it\\'s.pdf'",
+      pageSize: 100,
+      fields: LIST_FIELDS,
+    });
+  });
+
+  it('is the Google remote with md5 hashes', () => {
+    const remote = googleRemoteOver(createFakeDrive());
+    expect([remote.provider, remote.hashKind, remote.rootId, remote.account]).toEqual([
+      'google',
+      'md5',
+      'root',
+      'emco',
+    ]);
+  });
+});
+
 describe('classifyRemote', () => {
   it('binary files', () => {
     expect(classifyRemote({ mimeType: 'application/pdf' }, DEFAULT_GOOGLE_EXPORT)).toEqual({
```

- [ ] **Step 2: Run it and watch it fail.**

Run: `npx vitest run src/sync/__tests__/google-remote.test.ts`

Expected: FAIL. 5 failed, first error `TypeError: GoogleSyncRemote is not a constructor`.

- [ ] **Step 3: Implement.**

`src/sync/remote/google-remote.ts` (modify):

```diff
diff --git a/src/sync/remote/google-remote.ts b/src/sync/remote/google-remote.ts
index 135c3c5..f60b670 100644
--- a/src/sync/remote/google-remote.ts
+++ b/src/sync/remote/google-remote.ts
@@ -1,13 +1,30 @@
+import type { OperationRunner } from '../../core/operation.js';
 import type { DriveFile } from '../../drive/drive-adapter.js';
+import { NotFoundError, PermissionDeniedError } from '../../errors.js';
 import {
   GOOGLE_MIME,
   isGoogleNative,
   resolveExport,
   type ExportFormat,
 } from '../../files/export-formats.js';
+import { escapeQueryValue } from '../../files/query.js';
+import { foldKey } from '../paths.js';
 import { DEFAULT_GOOGLE_EXPORT, type GoogleExportPrefs } from '../types.js';
 import type { RemoteItem } from './sync-remote.js';
 
+/** Drive fields every sync read requests (spec §4). */
+export const SYNC_FILE_FIELDS =
+  'id, name, mimeType, md5Checksum, size, modifiedTime, createdTime, parents, trashed, capabilities(canEdit, canTrash, canAddChildren)';
+export const SYNC_LIST_FIELDS = `nextPageToken, files(${SYNC_FILE_FIELDS})`;
+export const SYNC_PAGE_SIZE = 1000;
+const FOLDER_LIST_FIELDS = 'nextPageToken, files(id, name)';
+const NAME_PAGE_SIZE = 100;
+
+/** A folder's non-trashed children. */
+export function childrenQuery(folderId: string): string {
+  return `'${escapeQueryValue(folderId)}' in parents and trashed = false`;
+}
+
 /**
  * The only sync module that knows Drive shapes: Google-native, folder and shortcut MIME
  * types, `resolveExport` (addendum §4.1).
@@ -99,3 +116,90 @@ export function toRemoteItem(file: DriveFile, prefs: GoogleExportPrefs): RemoteI
     },
   };
 }
+
+/**
+ * SyncRemote over the Drive adapter (OneDrive sync spec §2.2). Every call goes through the
+ * OperationRunner with the operation kind and target the engine used before the port.
+ */
+export class GoogleSyncRemote {
+  readonly provider = 'google';
+  readonly hashKind = 'md5';
+  readonly rootId = 'root';
+
+  constructor(
+    private readonly ops: OperationRunner,
+    readonly account: string,
+    private readonly prefs: GoogleExportPrefs,
+  ) {}
+
+  private item(file: DriveFile): RemoteItem {
+    return toRemoteItem(file, this.prefs);
+  }
+
+  async read(id: string): Promise<RemoteItem> {
+    const file = await this.ops.exec(this.account, 'idempotent', id, (ctx) =>
+      ctx.drive.getFile(id, SYNC_FILE_FIELDS),
+    );
+    return this.item(file);
+  }
+
+  async get(id: string): Promise<RemoteItem | null> {
+    try {
+      return await this.read(id);
+    } catch (err) {
+      if (err instanceof NotFoundError || err instanceof PermissionDeniedError) return null;
+      throw err;
+    }
+  }
+
+  async listChildren(
+    folderId: string,
+    pageToken: string | undefined,
+  ): Promise<{ items: RemoteItem[]; next?: string }> {
+    const page = await this.ops.exec(this.account, 'idempotent', folderId, (ctx) =>
+      ctx.drive.listFiles({
+        q: childrenQuery(folderId),
+        pageSize: SYNC_PAGE_SIZE,
+        ...(pageToken ? { pageToken } : {}),
+        fields: SYNC_LIST_FIELDS,
+      }),
+    );
+    const items = (page.files ?? []).map((f) => this.item(f));
+    return page.nextPageToken ? { items, next: page.nextPageToken } : { items };
+  }
+
+  /**
+   * Folders: every page of the parent's folders (id and name only). Files: one page of
+   * the exact-name query, as the duplicate-upload check always did.
+   */
+  async findChildren(parentId: string, name: string, kind?: 'folder'): Promise<RemoteItem[]> {
+    const fold = foldKey(name);
+    const found: RemoteItem[] = [];
+    const parents = `'${escapeQueryValue(parentId)}' in parents and trashed = false`;
+    if (kind !== 'folder') {
+      const q = `${parents} and name = '${escapeQueryValue(name)}'`;
+      const list = await this.ops.exec(this.account, 'idempotent', parentId, (ctx) =>
+        ctx.drive.listFiles({ q, pageSize: NAME_PAGE_SIZE, fields: SYNC_LIST_FIELDS }),
+      );
+      for (const f of list.files ?? []) found.push(this.item(f));
+    } else {
+      const q = `${parents} and mimeType = '${GOOGLE_MIME.folder}'`;
+      let pageToken: string | undefined;
+      do {
+        const page = await this.ops.exec(this.account, 'idempotent', parentId, (ctx) =>
+          ctx.drive.listFiles({
+            q,
+            pageSize: SYNC_PAGE_SIZE,
+            ...(pageToken ? { pageToken } : {}),
+            fields: FOLDER_LIST_FIELDS,
+          }),
+        );
+        for (const f of page.files ?? []) {
+          found.push(this.item({ mimeType: GOOGLE_MIME.folder, parents: [parentId], ...f }));
+        }
+        pageToken = page.nextPageToken ?? undefined;
+      } while (pageToken);
+    }
+    return found.filter((f) => foldKey(f.name) === fold);
+  }
+}
```

- [ ] **Step 4: Run it and watch it pass.**

Run: `npx vitest run src/sync/__tests__/google-remote.test.ts`

Expected: PASS (no type errors; every test in the file passes).

- [ ] **Step 5: Format and run the whole check.**

Run: `npx prettier --write src/sync/__tests__/fake-remote.ts src/sync/__tests__/google-remote.test.ts src/sync/remote/google-remote.ts` then `npm run check`

Expected: exit 0, `Test Files  124 passed (124); Tests  1337 passed | 6 skipped (1343)`.

- [ ] **Step 6: Commit.**

```bash
git add src/sync/__tests__/fake-remote.ts src/sync/__tests__/google-remote.test.ts src/sync/remote/google-remote.ts
git commit -F - <<'MSG'
feat(sync): GoogleSyncRemote reads (get, read, listChildren, findChildren)

The Drive calls are pinned by tests to the fields, queries and page sizes the
engine used before the port.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
MSG
```

### Task 3: GoogleSyncRemote writes, downloads and native exports

**Spec:** §2.1, §2.2 (`replaceContent` keeps today's update, `trash` sets trashed=true). Commit `e5a20be` on the reference branch.

**Files:**
- Test: `src/sync/__tests__/google-remote.test.ts`
- Modify: `src/sync/remote/google-remote.ts`

- [ ] **Step 1: Write the failing test (and its setup).**

`src/sync/__tests__/google-remote.test.ts` (modify):

```diff
diff --git a/src/sync/__tests__/google-remote.test.ts b/src/sync/__tests__/google-remote.test.ts
index e3310d8..61dfa8e 100644
--- a/src/sync/__tests__/google-remote.test.ts
+++ b/src/sync/__tests__/google-remote.test.ts
@@ -1,8 +1,24 @@
-import { describe, expect, it } from 'vitest';
+import { mkdtemp, rm, writeFile } from 'node:fs/promises';
+import os from 'node:os';
+import path from 'node:path';
+import { Readable } from 'node:stream';
+import { afterEach, beforeEach, describe, expect, it } from 'vitest';
+import { OperationRunner } from '../../core/operation.js';
 import { NotFoundError, QuotaExceededError, ValidationError } from '../../errors.js';
-import { createFakeDrive, httpError } from '../../files/__tests__/fakes.js';
+import {
+  createAudit,
+  createFakeDrive,
+  createRunner,
+  httpError,
+  noSleep,
+} from '../../files/__tests__/fakes.js';
 import { GOOGLE_MIME } from '../../files/export-formats.js';
-import { classifyRemote, toRemoteItem, validateGoogleExport } from '../remote/google-remote.js';
+import {
+  GoogleSyncRemote,
+  classifyRemote,
+  toRemoteItem,
+  validateGoogleExport,
+} from '../remote/google-remote.js';
 import { DEFAULT_GOOGLE_EXPORT } from '../types.js';
 import { binary, folder } from './drive-tree.js';
 import { googleRemoteOver } from './fake-remote.js';
@@ -90,7 +106,7 @@ describe('GoogleSyncRemote reads (pinned to the Drive calls sync made before the
     });
   });
 
-  it('is the Google remote with md5 hashes', () => {
+  it('is the Google remote with md5 hashes and no deletion feed', () => {
     const remote = googleRemoteOver(createFakeDrive());
     expect([remote.provider, remote.hashKind, remote.rootId, remote.account]).toEqual([
       'google',
@@ -98,6 +114,113 @@ describe('GoogleSyncRemote reads (pinned to the Drive calls sync made before the
       'root',
       'emco',
     ]);
+    expect(remote.deletionFeed()).toBeNull();
+  });
+
+  it('open resolves the account alias through the runner without a Drive call', async () => {
+    const drive = createFakeDrive();
+    const runner = createRunner(drive);
+    const ops = new OperationRunner({ runner, audit: createAudit(), retry: noSleep });
+    const remote = await GoogleSyncRemote.open(ops, undefined, DEFAULT_GOOGLE_EXPORT);
+    expect(remote.account).toBe('emco');
+    expect(runner.refs).toEqual([undefined]);
+  });
+});
+
+describe('GoogleSyncRemote writes and content (pinned)', () => {
+  let dir: string;
+  beforeEach(async () => {
+    dir = await mkdtemp(path.join(os.tmpdir(), 'sync-gremote-'));
+  });
+  afterEach(async () => {
+    await rm(dir, { recursive: true, force: true });
+  });
+
+  it('createFolder: folder MIME type, the parent, id and name fields', async () => {
+    const drive = createFakeDrive();
+    drive.createFile.mockResolvedValueOnce({ id: 'f9', name: 'docs' });
+    const created = await googleRemoteOver(drive).createFolder('P', 'docs');
+    expect(created).toMatchObject({ id: 'f9', name: 'docs', kind: 'folder', parentId: 'P' });
+    expect(drive.createFile).toHaveBeenCalledWith({
+      requestBody: { name: 'docs', mimeType: GOOGLE_MIME.folder, parents: ['P'] },
+      fields: 'id, name',
+    });
+  });
+
+  it('uploadNew creates the file with media and sync fields', async () => {
+    const drive = createFakeDrive();
+    drive.createFile.mockResolvedValueOnce({ id: 'n1', md5Checksum: 'm' });
+    const abs = path.join(dir, 'a.pdf');
+    await writeFile(abs, 'x');
+    const item = await googleRemoteOver(drive).uploadNew('P', 'a.pdf', abs);
+    expect(item).toMatchObject({ id: 'n1', hash: { kind: 'md5', value: 'm' }, parentId: null });
+    const call = drive.createFile.mock.calls[0]?.[0];
+    expect(call?.requestBody).toEqual({ name: 'a.pdf', parents: ['P'] });
+    expect(call?.media?.mimeType).toBe('application/pdf');
+    expect(call?.fields).toBe(FILE_FIELDS);
+  });
+
+  it('replaceContent sends new media for the same fileId', async () => {
+    const drive = createFakeDrive();
+    drive.updateFile.mockResolvedValueOnce({ id: 'r1' });
+    const abs = path.join(dir, 'a.txt');
+    await writeFile(abs, 'x');
+    const remote = googleRemoteOver(drive);
+    await remote.replaceContent(toRemoteItem({ id: 'r1' }, DEFAULT_GOOGLE_EXPORT), abs);
+    const call = drive.updateFile.mock.calls[0]?.[0];
+    expect(call).toMatchObject({ fileId: 'r1', fields: FILE_FIELDS });
+    expect(call?.media?.mimeType).toBe('text/plain');
+  });
+
+  it('trash sets trashed=true with id and trashed fields', async () => {
+    const drive = createFakeDrive();
+    drive.updateFile.mockResolvedValueOnce({ id: 'r1', trashed: true });
+    await googleRemoteOver(drive).trash(toRemoteItem({ id: 'r1' }, DEFAULT_GOOGLE_EXPORT));
+    expect(drive.updateFile).toHaveBeenCalledWith({
+      fileId: 'r1',
+      requestBody: { trashed: true },
+      fields: 'id, trashed',
+    });
+  });
+
+  it('download reruns the consumer, which opens the media stream, on a retryable error', async () => {
+    const drive = createFakeDrive();
+    drive.downloadMedia.mockImplementation(async () => Readable.from([Buffer.from('abc')]));
+    let attempts = 0;
+    const text = await googleRemoteOver(drive).download('r1', async (open) => {
+      const stream = await open();
+      if (++attempts === 1) throw httpError(503, 'backendError');
+      let out = '';
+      for await (const chunk of stream) out += String(chunk);
+      return out;
+    });
+    expect(text).toBe('abc');
+    expect(attempts).toBe(2);
+    expect(drive.downloadMedia.mock.calls).toEqual([['r1'], ['r1']]);
+  });
+
+  it('readNative reads the export fields; exportNative exports with them', async () => {
+    const drive = createFakeDrive();
+    drive.getFile.mockResolvedValueOnce({
+      id: 'g1',
+      name: 'Plan',
+      mimeType: GOOGLE_MIME.document,
+      exportLinks: { [DOCX_MIME]: 'https://docs.google.com/x' },
+      webViewLink: 'https://docs.google.com/view',
+    });
+    drive.exportMedia.mockRejectedValueOnce(httpError(403, 'exportSizeLimitExceeded'));
+    drive.fetchExportLink.mockResolvedValueOnce(Readable.from([Buffer.from('big')]));
+    const remote = googleRemoteOver(drive);
+    const source = await remote.readNative('g1');
+    expect(source.item).toMatchObject({ id: 'g1', native: { exportFormat: 'docx' } });
+    expect(drive.getFile).toHaveBeenCalledWith('g1', `${FILE_FIELDS}, exportLinks, webViewLink`);
+    const plan = { format: 'docx' as const, extension: 'docx', mimeType: DOCX_MIME };
+    const stream = await remote.exportNative(source, plan, (open) => open());
+    let out = '';
+    for await (const chunk of stream) out += String(chunk);
+    expect(out).toBe('big');
+    expect(drive.exportMedia).toHaveBeenCalledWith('g1', DOCX_MIME);
+    expect(drive.fetchExportLink).toHaveBeenCalledWith('https://docs.google.com/x');
   });
 });
```

- [ ] **Step 2: Run it and watch it fail.**

Run: `npx vitest run src/sync/__tests__/google-remote.test.ts`

Expected: FAIL. 8 failed: `TypeError: remote.deletionFeed is not a function`, `TypeError: GoogleSyncRemote.open is not a function`, `TypeError: googleRemoteOver(...).createFolder is not a function`, …

- [ ] **Step 3: Implement.**

`src/sync/remote/google-remote.ts` (modify):

```diff
diff --git a/src/sync/remote/google-remote.ts b/src/sync/remote/google-remote.ts
index f60b670..792a398 100644
--- a/src/sync/remote/google-remote.ts
+++ b/src/sync/remote/google-remote.ts
@@ -1,21 +1,33 @@
+import { createReadStream } from 'node:fs';
 import type { OperationRunner } from '../../core/operation.js';
 import type { DriveFile } from '../../drive/drive-adapter.js';
-import { NotFoundError, PermissionDeniedError } from '../../errors.js';
+import { NotFoundError, PermissionDeniedError, ValidationError } from '../../errors.js';
 import {
   GOOGLE_MIME,
   isGoogleNative,
   resolveExport,
   type ExportFormat,
+  type ExportPlan,
 } from '../../files/export-formats.js';
+import { openExport } from '../../files/export-stream.js';
 import { escapeQueryValue } from '../../files/query.js';
+import { uploadMimeType } from '../../files/upload-mime.js';
 import { foldKey } from '../paths.js';
 import { DEFAULT_GOOGLE_EXPORT, type GoogleExportPrefs } from '../types.js';
-import type { RemoteItem } from './sync-remote.js';
+import type {
+  DeletionFeed,
+  NativeSource,
+  OpenStream,
+  RemoteItem,
+  SyncRemote,
+} from './sync-remote.js';
 
 /** Drive fields every sync read requests (spec §4). */
 export const SYNC_FILE_FIELDS =
   'id, name, mimeType, md5Checksum, size, modifiedTime, createdTime, parents, trashed, capabilities(canEdit, canTrash, canAddChildren)';
 export const SYNC_LIST_FIELDS = `nextPageToken, files(${SYNC_FILE_FIELDS})`;
+/** The export re-read also needs the 10 MB fallback link and the web link (addendum §4.3). */
+export const SYNC_EXPORT_FIELDS = `${SYNC_FILE_FIELDS}, exportLinks, webViewLink`;
 export const SYNC_PAGE_SIZE = 1000;
 const FOLDER_LIST_FIELDS = 'nextPageToken, files(id, name)';
 const NAME_PAGE_SIZE = 100;
@@ -121,10 +133,11 @@ export function toRemoteItem(file: DriveFile, prefs: GoogleExportPrefs): RemoteI
  * SyncRemote over the Drive adapter (OneDrive sync spec §2.2). Every call goes through the
  * OperationRunner with the operation kind and target the engine used before the port.
  */
-export class GoogleSyncRemote {
+export class GoogleSyncRemote implements SyncRemote {
   readonly provider = 'google';
   readonly hashKind = 'md5';
   readonly rootId = 'root';
+  private readonly nativeFiles = new WeakMap<NativeSource, DriveFile>();
 
   constructor(
     private readonly ops: OperationRunner,
@@ -132,6 +145,18 @@ export class GoogleSyncRemote {
     private readonly prefs: GoogleExportPrefs,
   ) {}
 
+  /** For an account reference (alias, email or default): resolves the alias, no Drive call. */
+  static async open(
+    ops: OperationRunner,
+    accountRef: string | undefined,
+    prefs: GoogleExportPrefs,
+  ): Promise<GoogleSyncRemote> {
+    const alias = await ops.exec(accountRef, 'idempotent', undefined, async (ctx) => {
+      return ctx.account.alias;
+    });
+    return new GoogleSyncRemote(ops, alias, prefs);
+  }
+
   private item(file: DriveFile): RemoteItem {
     return toRemoteItem(file, this.prefs);
   }
@@ -202,4 +227,91 @@ export class GoogleSyncRemote {
     }
     return found.filter((f) => foldKey(f.name) === fold);
   }
+
+  async createFolder(parentId: string, name: string): Promise<RemoteItem> {
+    const created = await this.ops.exec(this.account, 'create', parentId, (ctx) =>
+      ctx.drive.createFile({
+        requestBody: { name, mimeType: GOOGLE_MIME.folder, parents: [parentId] },
+        fields: 'id, name',
+      }),
+    );
+    return this.item({ mimeType: GOOGLE_MIME.folder, parents: [parentId], ...created });
+  }
+
+  async uploadNew(parentId: string, name: string, localPath: string): Promise<RemoteItem> {
+    const file = await this.ops.exec(this.account, 'create', parentId, async (ctx) => {
+      const body = createReadStream(localPath);
+      try {
+        return await ctx.drive.createFile({
+          requestBody: { name, parents: [parentId] },
+          media: { mimeType: uploadMimeType(localPath), body },
+          fields: SYNC_FILE_FIELDS,
+        });
+      } catch (err) {
+        body.destroy();
+        throw err;
+      }
+    });
+    return this.item(file);
+  }
+
+  /** New content for the same fileId (Drive keeps a revision). */
+  async replaceContent(item: RemoteItem, localPath: string): Promise<RemoteItem> {
+    const file = await this.ops.exec(this.account, 'mutate', item.id, async (ctx) => {
+      const body = createReadStream(localPath);
+      try {
+        return await ctx.drive.updateFile({
+          fileId: item.id,
+          media: { mimeType: uploadMimeType(localPath), body },
+          fields: SYNC_FILE_FIELDS,
+        });
+      } catch (err) {
+        body.destroy();
+        throw err;
+      }
+    });
+    return this.item(file);
+  }
+
+  download<T>(id: string, consume: (open: OpenStream) => Promise<T>): Promise<T> {
+    return this.ops.exec(this.account, 'idempotent', id, (ctx) =>
+      consume(() => ctx.drive.downloadMedia(id)),
+    );
+  }
+
+  /** Re-reads a native file with the 10 MB fallback link and the web link (addendum §4.3). */
+  async readNative(id: string): Promise<NativeSource> {
+    const file = await this.ops.exec(this.account, 'idempotent', id, (ctx) =>
+      ctx.drive.getFile(id, SYNC_EXPORT_FIELDS),
+    );
+    const source: NativeSource = { item: this.item(file) };
+    this.nativeFiles.set(source, file);
+    return source;
+  }
+
+  exportNative<T>(
+    source: NativeSource,
+    plan: ExportPlan,
+    consume: (open: OpenStream) => Promise<T>,
+  ): Promise<T> {
+    const file = this.nativeFiles.get(source);
+    if (!file) throw new ValidationError('Internal: export source was not read by this remote');
+    return this.ops.exec(this.account, 'idempotent', source.item.id, (ctx) =>
+      consume(() => openExport(ctx.drive, file, plan, this.ops.log)),
+    );
+  }
+
+  async trash(item: RemoteItem): Promise<void> {
+    await this.ops.exec(this.account, 'idempotent', item.id, (ctx) =>
+      ctx.drive.updateFile({
+        fileId: item.id,
+        requestBody: { trashed: true },
+        fields: 'id, trashed',
+      }),
+    );
+  }
+
+  deletionFeed(): DeletionFeed | null {
+    return null;
+  }
 }
```

- [ ] **Step 4: Run it and watch it pass.**

Run: `npx vitest run src/sync/__tests__/google-remote.test.ts`

Expected: PASS (no type errors; every test in the file passes).

- [ ] **Step 5: Format and run the whole check.**

Run: `npx prettier --write src/sync/__tests__/google-remote.test.ts src/sync/remote/google-remote.ts` then `npm run check`

Expected: exit 0, `Test Files  124 passed (124); Tests  1344 passed | 6 skipped (1350)`.

- [ ] **Step 6: Commit.**

```bash
git add src/sync/__tests__/google-remote.test.ts src/sync/remote/google-remote.ts
git commit -F - <<'MSG'
feat(sync): GoogleSyncRemote writes, downloads and native exports

createFolder, uploadNew, replaceContent, trash, download, readNative/exportNative
and a null deletionFeed, each pinned to today's Drive calls. download and
exportNative run the consumer inside the retried operation, as the executor did.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
MSG
```

### Task 4: The remote scan walks RemoteItems; SyncEnv gets the remote factory

**Spec:** §2.1 (remote-scanner consumes `RemoteItem`), §2.3 `remote-scanner.ts`, `scan-select.ts`. Commit `f21fc43` on the reference branch.

**Files:**
- Test: `src/sync/__tests__/drive-tree.ts`
- Test: `src/sync/__tests__/remote-scanner.test.ts`
- Modify: `src/sync/executor.ts`
- Modify: `src/sync/pair-admin.ts`
- Modify: `src/sync/remote-probe.ts`
- Modify: `src/sync/remote-scanner.ts`
- Modify: `src/sync/scan-select.ts`
- Modify: `src/sync/sync-service.ts`

- [ ] **Step 1: Write the failing test (and its setup).**

`src/sync/__tests__/drive-tree.ts` (modify):

```diff
diff --git a/src/sync/__tests__/drive-tree.ts b/src/sync/__tests__/drive-tree.ts
index 6bdd3f2..a31feda 100644
--- a/src/sync/__tests__/drive-tree.ts
+++ b/src/sync/__tests__/drive-tree.ts
@@ -1,6 +1,9 @@
-import type { DriveFile, DriveFileList } from '../../drive/drive-adapter.js';
+import type { DriveFile } from '../../drive/drive-adapter.js';
 import { GOOGLE_MIME } from '../../files/export-formats.js';
+import { toRemoteItem } from '../remote/google-remote.js';
+import type { RemoteItem } from '../remote/sync-remote.js';
 import type { FolderLister } from '../remote-scanner.js';
+import { DEFAULT_GOOGLE_EXPORT, type GoogleExportPrefs } from '../types.js';
 
 export function folder(id: string, name: string, parent: string): DriveFile {
   return { id, name, mimeType: GOOGLE_MIME.folder, parents: [parent] };
@@ -21,16 +24,19 @@ export function binary(id: string, name: string, parent: string, extra: DriveFil
   };
 }
 
-/** A FolderLister over an in-memory tree; folders listed in `failing` throw `failWith`. */
+/**
+ * A FolderLister over an in-memory Drive tree (items mapped like GoogleSyncRemote does);
+ * folders listed in `failing` throw `failWith`.
+ */
 export function treeLister(
   files: DriveFile[],
-  opts: { failing?: string[]; failWith?: Error; pageSize?: number } = {},
+  opts: { failing?: string[]; failWith?: Error; pageSize?: number; prefs?: GoogleExportPrefs } = {},
 ): FolderLister & { calls: string[] } {
   const calls: string[] = [];
-  const lister = async (
+  const listChildren = async (
     folderId: string,
     pageToken: string | undefined,
-  ): Promise<DriveFileList> => {
+  ): Promise<{ items: RemoteItem[]; next?: string }> => {
     calls.push(folderId);
     if (opts.failing?.includes(folderId)) throw opts.failWith ?? new Error('listing failed');
     const children = files.filter((f) => f.parents?.includes(folderId) && !f.trashed);
@@ -38,7 +44,8 @@ export function treeLister(
     const start = pageToken ? Number(pageToken) : 0;
     const page = children.slice(start, start + size);
     const next = start + size < children.length ? String(start + size) : undefined;
-    return { files: page, ...(next ? { nextPageToken: next } : {}) };
+    const items = page.map((f) => toRemoteItem(f, opts.prefs ?? DEFAULT_GOOGLE_EXPORT));
+    return { items, ...(next ? { next } : {}) };
   };
-  return Object.assign(lister, { calls });
+  return { listChildren, calls };
 }
```

`src/sync/__tests__/remote-scanner.test.ts` (modify):

```diff
diff --git a/src/sync/__tests__/remote-scanner.test.ts b/src/sync/__tests__/remote-scanner.test.ts
index daeb037..7d3f2b7 100644
--- a/src/sync/__tests__/remote-scanner.test.ts
+++ b/src/sync/__tests__/remote-scanner.test.ts
@@ -1,7 +1,8 @@
 import { describe, expect, it } from 'vitest';
 import { NotFoundError, ReauthRequiredError } from '../../errors.js';
 import { GOOGLE_MIME } from '../../files/export-formats.js';
-import { childrenQuery, exportKey, scanRemote } from '../remote-scanner.js';
+import { childrenQuery } from '../remote/google-remote.js';
+import { exportKey, scanRemote } from '../remote-scanner.js';
 import { DEFAULT_GOOGLE_EXPORT } from '../types.js';
 import { binary, folder, treeLister } from './drive-tree.js';
 
@@ -90,13 +91,20 @@ describe('scanRemote', () => {
   it('keys Google-native files by their export name; unsupported types are ignored', async () => {
     const scan = await scanRemote(
       ROOT,
-      treeLister([
-        { id: 'g', name: 'Plan', mimeType: GOOGLE_MIME.document, parents: [ROOT] },
-        { id: 's', name: 'Budget', mimeType: GOOGLE_MIME.spreadsheet, parents: [ROOT] },
-        { id: 'f', name: 'Survey', mimeType: 'application/vnd.google-apps.form', parents: [ROOT] },
-        { id: 'l', name: 'x'.repeat(252), mimeType: GOOGLE_MIME.document, parents: [ROOT] },
-      ]),
-      { ...DEFAULT_GOOGLE_EXPORT, spreadsheet: 'csv' },
+      treeLister(
+        [
+          { id: 'g', name: 'Plan', mimeType: GOOGLE_MIME.document, parents: [ROOT] },
+          { id: 's', name: 'Budget', mimeType: GOOGLE_MIME.spreadsheet, parents: [ROOT] },
+          {
+            id: 'f',
+            name: 'Survey',
+            mimeType: 'application/vnd.google-apps.form',
+            parents: [ROOT],
+          },
+          { id: 'l', name: 'x'.repeat(252), mimeType: GOOGLE_MIME.document, parents: [ROOT] },
+        ],
+        { prefs: { ...DEFAULT_GOOGLE_EXPORT, spreadsheet: 'csv' } },
+      ),
     );
     expect(
       scan.entries.map((e) => [e.id, e.key, e.name, e.md5, e.size, e.native?.exportFormat]),
```

- [ ] **Step 2: Run it and watch it fail.**

Run: `npx vitest run src/sync/__tests__/remote-scanner.test.ts`

Expected: FAIL. 8 failed, `TypeError: list is not a function` (the helper now returns `{ listChildren }`).

- [ ] **Step 3: Implement.**

`src/sync/executor.ts` (modify):

```diff
diff --git a/src/sync/executor.ts b/src/sync/executor.ts
index b6b0860..163cad6 100644
--- a/src/sync/executor.ts
+++ b/src/sync/executor.ts
@@ -31,7 +31,7 @@ import { exportNew, exportOver, exportReplace, type ExportHost } from './exec-ex
 import { md5File } from './local-scanner.js';
 import { absInside, baseName, parentKey, prepareParent } from './paths.js';
 import { RemoteFolders } from './remote-folders.js';
-import { SYNC_LIST_FIELDS } from './remote-scanner.js';
+import { SYNC_LIST_FIELDS } from './remote/google-remote.js';
 import {
   downloadReplace,
   moveLocal,
```

`src/sync/pair-admin.ts` (modify):

```diff
diff --git a/src/sync/pair-admin.ts b/src/sync/pair-admin.ts
index 8b63ff7..8039d10 100644
--- a/src/sync/pair-admin.ts
+++ b/src/sync/pair-admin.ts
@@ -2,6 +2,7 @@ import { randomUUID } from 'node:crypto';
 import { constants } from 'node:fs';
 import { access, realpath, stat } from 'node:fs/promises';
 import path from 'node:path';
+import type { AuditSink } from '../audit/audit-log.js';
 import type { OperationRunner } from '../core/operation.js';
 import type { DriveFile } from '../drive/drive-adapter.js';
 import { NotFoundError, ValidationError } from '../errors.js';
@@ -18,6 +19,7 @@ import {
   type PairStore,
 } from './pair-store.js';
 import { validateGoogleExport } from './remote/google-remote.js';
+import type { SyncRemote } from './remote/sync-remote.js';
 import {
   PAIR_NAME,
   SYNC_FILE_FIELDS,
@@ -29,9 +31,14 @@ import {
 /** What the split service modules share (one per SyncService). */
 export interface SyncEnv {
   ops: OperationRunner;
+  audit: AuditSink;
   log: Logger;
   clock: () => Date;
   store: PairStore;
+  /** The remote of an existing pair (its account alias and export settings). */
+  remoteFor: (pair: Pair) => SyncRemote;
+  /** The remote for an account reference (alias, email or default) before a pair exists. */
+  openRemote: (accountRef: string | undefined, prefs: GoogleExportPrefs) => Promise<SyncRemote>;
   /** Throws when the account cannot be synced, before anything touches the user's folder. */
   assertSupportedAccount: (ref: string | undefined) => Promise<void>;
 }
```

`src/sync/remote-probe.ts` (modify):

```diff
diff --git a/src/sync/remote-probe.ts b/src/sync/remote-probe.ts
index 9a99b33..48e9f15 100644
--- a/src/sync/remote-probe.ts
+++ b/src/sync/remote-probe.ts
@@ -3,7 +3,7 @@ import { AppError, NotFoundError, PermissionDeniedError } from '../errors.js';
 import { GOOGLE_MIME } from '../files/export-formats.js';
 import { isAbortError } from './errors.js';
 import { baseName, isIgnoredName, isRepresentable } from './paths.js';
-import { classifyRemote } from './remote/google-remote.js';
+import { classifyRemote, toRemoteItem } from './remote/google-remote.js';
 import { toRemoteEntry } from './remote-scanner.js';
 import {
   DEFAULT_GOOGLE_EXPORT,
@@ -59,7 +59,7 @@ export async function probeRecord(
     const kind = classifyRemote(file, prefs);
     if (kind.kind === 'unsupported')
       return unknown('is a Google file type that cannot be exported');
-    const entry = toRemoteEntry(file, parentKey, parent, [parent], kind);
+    const entry = toRemoteEntry(toRemoteItem(file, prefs), parentKey, parent, [parent]);
     if (!isRepresentable(baseName(entry.key))) {
       return unknown('renamed in Drive to a name that cannot be synced');
     }
```

`src/sync/remote-scanner.ts` (modify):

```diff
diff --git a/src/sync/remote-scanner.ts b/src/sync/remote-scanner.ts
index 3ba9130..7adc893 100644
--- a/src/sync/remote-scanner.ts
+++ b/src/sync/remote-scanner.ts
@@ -1,30 +1,11 @@
-import type { DriveFile, DriveFileList } from '../drive/drive-adapter.js';
-import { GOOGLE_MIME } from '../files/export-formats.js';
-import { escapeQueryValue } from '../files/query.js';
-import { isAbortError } from './errors.js';
 import { ensureExtension } from '../files/filename.js';
+import { isAbortError } from './errors.js';
 import { baseName, foldKey, isIgnoredName, isRepresentable } from './paths.js';
-import { classifyRemote, type RemoteKind } from './remote/google-remote.js';
-import {
-  DEFAULT_GOOGLE_EXPORT,
-  SYNC_FILE_FIELDS,
-  type GoogleExportPrefs,
-  type RemoteEntry,
-  type RemoteScan,
-} from './types.js';
-
-export const SYNC_LIST_FIELDS = `nextPageToken, files(${SYNC_FILE_FIELDS})`;
-export const SYNC_PAGE_SIZE = 1000;
+import type { RemoteItem, SyncRemote } from './remote/sync-remote.js';
+import type { RemoteEntry, RemoteScan } from './types.js';
 
-/** Lists one page of a folder's non-trashed children. */
-export type FolderLister = (
-  folderId: string,
-  pageToken: string | undefined,
-) => Promise<DriveFileList>;
-
-export function childrenQuery(folderId: string): string {
-  return `'${escapeQueryValue(folderId)}' in parents and trashed = false`;
-}
+/** What the walk needs from the remote. */
+export type FolderLister = Pick<SyncRemote, 'listChildren'>;
 
 /** Local key of a native file's export: Drive name + extension unless present (NFC). */
 export function exportKey(parentKey: string, remoteName: string, extension: string): string {
@@ -37,62 +18,53 @@ function joinKey(parent: string, name: string): string {
   return parent === '' ? nfc : `${parent}/${nfc}`;
 }
 
+/** A remote file at `parentKeyValue`; a native file is keyed by its export name. */
 export function toRemoteEntry(
-  file: DriveFile,
+  item: RemoteItem,
   parentKeyValue: string,
   parentId: string,
   ancestorIds: string[],
-  kind: RemoteKind = { kind: 'binary' },
 ): RemoteEntry {
-  const name = file.name ?? '';
-  const native =
-    kind.kind === 'native'
-      ? { mimeType: kind.mimeType, exportFormat: kind.exportFormat, exportMime: kind.exportMime }
-      : null;
-  const key =
-    kind.kind === 'native'
-      ? exportKey(parentKeyValue, name, kind.extension)
-      : joinKey(parentKeyValue, name);
+  const { name, native } = item;
+  const key = native
+    ? exportKey(parentKeyValue, name, native.exportFormat)
+    : joinKey(parentKeyValue, name);
   return {
-    id: file.id ?? '',
+    id: item.id,
     key,
     foldKey: foldKey(key),
     name,
     parentId,
     ancestorIds,
-    mimeType: file.mimeType ?? 'application/octet-stream',
-    md5: native ? null : (file.md5Checksum ?? null),
-    size: native || !file.size ? null : Number(file.size),
-    modifiedTime: file.modifiedTime ?? '',
-    createdTime: file.createdTime ?? '',
-    canEdit: file.capabilities?.canEdit ?? false,
-    canTrash: file.capabilities?.canTrash ?? false,
+    mimeType: item.mimeType,
+    md5: native || item.hash?.kind !== 'md5' ? null : item.hash.value,
+    size: native ? null : item.size,
+    modifiedTime: item.modifiedTime,
+    createdTime: item.createdTime,
+    canEdit: item.canEdit,
+    canTrash: item.canTrash,
     native,
   };
 }
 
-async function listAll(list: FolderLister, folderId: string): Promise<DriveFile[]> {
-  const files: DriveFile[] = [];
+async function listAll(list: FolderLister, folderId: string): Promise<RemoteItem[]> {
+  const items: RemoteItem[] = [];
   let pageToken: string | undefined;
   do {
-    const page = await list(folderId, pageToken);
-    files.push(...(page.files ?? []));
-    pageToken = page.nextPageToken ?? undefined;
+    const page = await list.listChildren(folderId, pageToken);
+    items.push(...page.items);
+    pageToken = page.next;
   } while (pageToken);
-  return files;
+  return items;
 }
 
 /**
  * Breadth-first walk of the pair's Drive folder (spec §4 remote-scanner). Duplicate
- * folder names and failed listings become unknown subtrees. Google-native files are
- * classified by the Google remote and keyed by their export name; shortcuts, natives that
- * cannot be exported, unrepresentable and dot/part names are ignored and reported.
+ * folder names and failed listings become unknown subtrees. Native files (classified by
+ * the remote) are keyed by their export name; unsupported items (shortcuts, natives that
+ * cannot be exported), unrepresentable and dot/part names are ignored and reported.
  */
-export async function scanRemote(
-  rootId: string,
-  list: FolderLister,
-  prefs: GoogleExportPrefs = DEFAULT_GOOGLE_EXPORT,
-): Promise<RemoteScan> {
+export async function scanRemote(rootId: string, list: FolderLister): Promise<RemoteScan> {
   const scan: RemoteScan = {
     entries: [],
     ignored: [],
@@ -105,7 +77,7 @@ export async function scanRemote(
   ];
   for (let next = queue.shift(); next; next = queue.shift()) {
     const folder = next;
-    let children: DriveFile[];
+    let children: RemoteItem[];
     try {
       children = await listAll(list, folder.id);
     } catch (err) {
@@ -117,21 +89,20 @@ export async function scanRemote(
     }
     const folderFolds = new Map<string, number>();
     for (const f of children) {
-      if (f.mimeType === GOOGLE_MIME.folder) {
-        const fold = foldKey(f.name ?? '');
+      if (f.kind === 'folder') {
+        const fold = foldKey(f.name);
         folderFolds.set(fold, (folderFolds.get(fold) ?? 0) + 1);
       }
     }
     for (const f of children) {
-      const id = f.id ?? '';
-      const name = f.name ?? '';
+      const { id, name } = f;
       const representable = isRepresentable(name);
       const key = representable
         ? joinKey(folder.key, name)
         : folder.key === ''
           ? name
           : `${folder.key}/${name}`;
-      const isFolder = f.mimeType === GOOGLE_MIME.folder;
+      const isFolder = f.kind === 'folder';
       if (!representable) {
         scan.ignored.push({ id, path: key, reason: 'unrepresentable', isFolder });
       } else if (isIgnoredName(name)) {
@@ -144,15 +115,15 @@ export async function scanRemote(
           scan.folders.set(id, key);
           queue.push({ id, key, ancestors: [id, ...folder.ancestors] });
         }
-      } else if (f.mimeType === GOOGLE_MIME.shortcut) {
-        scan.ignored.push({ id, path: key, reason: 'shortcut', isFolder: false });
+      } else if (f.kind === 'unsupported') {
+        scan.ignored.push({
+          id,
+          path: key,
+          reason: f.unsupported ?? 'native-unsupported',
+          isFolder: false,
+        });
       } else {
-        const kind = classifyRemote(f, prefs);
-        if (kind.kind === 'unsupported') {
-          scan.ignored.push({ id, path: key, reason: kind.reason, isFolder: false });
-          continue;
-        }
-        const entry = toRemoteEntry(f, folder.key, folder.id, folder.ancestors, kind);
+        const entry = toRemoteEntry(f, folder.key, folder.id, folder.ancestors);
         if (!isRepresentable(baseName(entry.key))) {
           scan.ignored.push({ id, path: key, reason: 'unrepresentable', isFolder: false });
         } else {
```

`src/sync/scan-select.ts` (modify):

```diff
diff --git a/src/sync/scan-select.ts b/src/sync/scan-select.ts
index c9b530b..0513828 100644
--- a/src/sync/scan-select.ts
+++ b/src/sync/scan-select.ts
@@ -13,7 +13,7 @@ import {
   validateRelPath,
 } from './paths.js';
 import { probeRecords } from './remote-probe.js';
-import { SYNC_LIST_FIELDS, SYNC_PAGE_SIZE, childrenQuery, scanRemote } from './remote-scanner.js';
+import { scanRemote } from './remote-scanner.js';
 import { hashTargets, onDiskProbeKeys, type PlanInput } from './resolve.js';
 import type { LocalScan, Pair, PairFile, RemoteScan } from './types.js';
 
@@ -74,21 +74,9 @@ async function readPreview(abs: string, chars: number): Promise<string | undefin
   }
 }
 
-/** Breadth-first scan of the pair's Drive folder (no local work). */
+/** Breadth-first scan of the pair's remote folder (no local work). */
 export function scanRemoteTree(env: SyncEnv, pair: Pair): Promise<RemoteScan> {
-  return scanRemote(
-    pair.remoteFolderId,
-    (folderId, pageToken) =>
-      env.ops.exec(pair.account, 'idempotent', folderId, (ctx) =>
-        ctx.drive.listFiles({
-          q: childrenQuery(folderId),
-          pageSize: SYNC_PAGE_SIZE,
-          ...(pageToken ? { pageToken } : {}),
-          fields: SYNC_LIST_FIELDS,
-        }),
-      ),
-    pair.googleExport,
-  );
+  return scanRemote(pair.remoteFolderId, env.remoteFor(pair));
 }
 
 export async function scanBoth(
```

`src/sync/sync-service.ts` (modify):

```diff
diff --git a/src/sync/sync-service.ts b/src/sync/sync-service.ts
index 3889fc5..1f6a0dd 100644
--- a/src/sync/sync-service.ts
+++ b/src/sync/sync-service.ts
@@ -14,6 +14,8 @@ import {
   type SyncEnv,
 } from './pair-admin.js';
 import type { PairStore } from './pair-store.js';
+import { GoogleSyncRemote } from './remote/google-remote.js';
+import type { SyncRemote } from './remote/sync-remote.js';
 import { absInside } from './paths.js';
 import { plan as makePlan } from './planner.js';
 import { buildReport, type ReportOptions } from './report.js';
@@ -88,9 +90,13 @@ export class SyncService {
     this.clock = deps.clock ?? ((): Date => new Date());
     this.env = {
       ops: this.ops,
+      audit: deps.audit,
       log: this.log,
       clock: this.clock,
       store: deps.store,
+      remoteFor: (pair): SyncRemote =>
+        new GoogleSyncRemote(this.ops, pair.account, pair.googleExport),
+      openRemote: (ref, prefs): Promise<SyncRemote> => GoogleSyncRemote.open(this.ops, ref, prefs),
       assertSupportedAccount:
         deps.assertSupportedAccount ?? ((): Promise<void> => Promise.resolve()),
     };
```

- [ ] **Step 4: Run it and watch it pass.**

Run: `npx vitest run src/sync/__tests__/remote-scanner.test.ts`

Expected: PASS (no type errors; every test in the file passes).

- [ ] **Step 5: Format and run the whole check.**

Run: `npx prettier --write src/sync/__tests__/drive-tree.ts src/sync/__tests__/remote-scanner.test.ts src/sync/executor.ts src/sync/pair-admin.ts src/sync/remote-probe.ts src/sync/remote-scanner.ts src/sync/scan-select.ts src/sync/sync-service.ts` then `npm run check`

Expected: exit 0, `Test Files  124 passed (124); Tests  1344 passed | 6 skipped (1350)`.

- [ ] **Step 6: Commit.**

```bash
git add src/sync/__tests__/drive-tree.ts src/sync/__tests__/remote-scanner.test.ts src/sync/executor.ts src/sync/pair-admin.ts src/sync/remote-probe.ts src/sync/remote-scanner.ts src/sync/scan-select.ts src/sync/sync-service.ts
git commit -F - <<'MSG'
refactor(sync): scan the remote tree through SyncRemote.listChildren

scanRemote walks RemoteItems: folders by kind, ignored entries by unsupported;
the Drive query and MIME checks live in GoogleSyncRemote. SyncEnv gains audit,
remoteFor(pair) and openRemote(ref, prefs).

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
MSG
```

### Task 5: The probe reads through SyncRemote.get

**Spec:** §2.3 `remote-probe.ts` (`FileGetter` becomes `SyncRemote.get`), §4.1 "Google: unchanged". Commit `df63eed` on the reference branch.

**Files:**
- Test: `src/sync/__tests__/remote-probe.test.ts`
- Modify: `src/sync/remote-probe.ts`
- Modify: `src/sync/scan-select.ts`

- [ ] **Step 1: Write the failing test (and its setup).**

`src/sync/__tests__/remote-probe.test.ts` (modify):

```diff
diff --git a/src/sync/__tests__/remote-probe.test.ts b/src/sync/__tests__/remote-probe.test.ts
index 98a2042..e483c7e 100644
--- a/src/sync/__tests__/remote-probe.test.ts
+++ b/src/sync/__tests__/remote-probe.test.ts
@@ -6,10 +6,12 @@ import {
   PermissionDeniedError,
   QuotaExceededError,
 } from '../../errors.js';
+import { createFakeDrive } from '../../files/__tests__/fakes.js';
 import { GOOGLE_MIME } from '../../files/export-formats.js';
-import { probeRecord, probeRecords, type FileGetter } from '../remote-probe.js';
+import { probeRecord, probeRecords, type ItemGetter } from '../remote-probe.js';
 import type { RemoteScan } from '../types.js';
 import { binary } from './drive-tree.js';
+import { googleRemoteOver } from './fake-remote.js';
 
 const ROOT = 'root';
 
@@ -27,13 +29,16 @@ function scan(overrides: Partial<RemoteScan> = {}): RemoteScan {
   };
 }
 
-function getter(files: Record<string, DriveFile | Error>): FileGetter {
-  return async (id) => {
+/** A GoogleSyncRemote whose Drive serves `files` (missing ids are 404). */
+function getter(files: Record<string, DriveFile | Error>): ItemGetter {
+  const drive = createFakeDrive();
+  drive.getFile.mockImplementation(async (id) => {
     const f = files[id];
     if (f === undefined) throw new NotFoundError(id);
     if (f instanceof Error) throw f;
     return f;
-  };
+  });
+  return googleRemoteOver(drive);
 }
 
 describe('probeRecord', () => {
```

- [ ] **Step 2: Run it and watch it fail.**

Run: `npx vitest run src/sync/__tests__/remote-probe.test.ts`

Expected: FAIL. 8 failed, e.g. `AssertionError: expected { state: 'unknown', …(1) } to deeply equal { state: 'trashed' }` (the old probe calls the remote as a function).

- [ ] **Step 3: Implement.**

`src/sync/remote-probe.ts` (modify):

```diff
diff --git a/src/sync/remote-probe.ts b/src/sync/remote-probe.ts
index 48e9f15..b79666e 100644
--- a/src/sync/remote-probe.ts
+++ b/src/sync/remote-probe.ts
@@ -1,19 +1,12 @@
-import type { DriveFile } from '../drive/drive-adapter.js';
-import { AppError, NotFoundError, PermissionDeniedError } from '../errors.js';
-import { GOOGLE_MIME } from '../files/export-formats.js';
+import { AppError } from '../errors.js';
 import { isAbortError } from './errors.js';
 import { baseName, isIgnoredName, isRepresentable } from './paths.js';
-import { classifyRemote, toRemoteItem } from './remote/google-remote.js';
+import type { RemoteItem, SyncRemote } from './remote/sync-remote.js';
 import { toRemoteEntry } from './remote-scanner.js';
-import {
-  DEFAULT_GOOGLE_EXPORT,
-  SYNC_FILE_FIELDS,
-  type GoogleExportPrefs,
-  type Probe,
-  type RemoteScan,
-} from './types.js';
+import type { Probe, RemoteScan } from './types.js';
 
-export type FileGetter = (fileId: string, fields: string) => Promise<DriveFile>;
+/** What a probe needs from the remote. */
+export type ItemGetter = Pick<SyncRemote, 'get'>;
 
 const MAX_DEPTH = 32;
 
@@ -21,11 +14,9 @@ function unknown(reason: string): Probe {
   return { state: 'unknown', reason };
 }
 
-function failure(err: unknown, what: string): Probe {
+/** A failed read other than 404/403 (those make `get` return null). */
+function failure(err: unknown): Probe {
   if (isAbortError(err)) throw err;
-  if (err instanceof NotFoundError || err instanceof PermissionDeniedError) {
-    return what === 'file' ? { state: 'unavailable' } : unknown('a parent folder cannot be read');
-  }
   return unknown(err instanceof AppError ? err.message : 'probe failed');
 }
 
@@ -33,33 +24,32 @@ function failure(err: unknown, what: string): Probe {
 export async function probeRecord(
   remoteId: string,
   scan: RemoteScan,
-  get: FileGetter,
-  prefs: GoogleExportPrefs = DEFAULT_GOOGLE_EXPORT,
+  remote: ItemGetter,
 ): Promise<Probe> {
-  let file: DriveFile;
+  let file: RemoteItem | null;
   try {
-    file = await get(remoteId, SYNC_FILE_FIELDS);
+    file = await remote.get(remoteId);
   } catch (err) {
-    return failure(err, 'file');
+    return failure(err);
   }
+  if (file === null) return { state: 'unavailable' };
   if (file.trashed) return { state: 'trashed' };
-  const parent = file.parents?.[0];
+  const parent = file.parentId;
   if (!parent) return { state: 'moved-out' };
   if (scan.unknownFolderIds.includes(parent)) return unknown('inside an ambiguous Drive folder');
   const parentKey = scan.folders.get(parent);
   if (parentKey !== undefined) {
-    const name = file.name ?? '';
-    const mime = file.mimeType ?? '';
+    const name = file.name;
     if (!isRepresentable(name) || isIgnoredName(name)) {
       return unknown('renamed in Drive to a name that cannot be synced');
     }
-    if (mime === GOOGLE_MIME.shortcut || mime === GOOGLE_MIME.folder) {
+    if (file.kind === 'folder' || file.unsupported === 'shortcut') {
       return unknown('is no longer a regular file');
     }
-    const kind = classifyRemote(file, prefs);
-    if (kind.kind === 'unsupported')
+    if (file.kind === 'unsupported') {
       return unknown('is a Google file type that cannot be exported');
-    const entry = toRemoteEntry(toRemoteItem(file, prefs), parentKey, parent, [parent]);
+    }
+    const entry = toRemoteEntry(file, parentKey, parent, [parent]);
     if (!isRepresentable(baseName(entry.key))) {
       return unknown('renamed in Drive to a name that cannot be synced');
     }
@@ -67,13 +57,14 @@ export async function probeRecord(
   }
   let current = parent;
   for (let depth = 0; depth < MAX_DEPTH; depth++) {
-    let folder: DriveFile;
+    let folder: RemoteItem | null;
     try {
-      folder = await get(current, 'id, parents');
+      folder = await remote.get(current);
     } catch (err) {
-      return failure(err, 'folder');
+      return failure(err);
     }
-    const up = folder.parents?.[0];
+    if (folder === null) return unknown('a parent folder cannot be read');
+    const up = folder.parentId;
     if (!up) return { state: 'moved-out' };
     if (scan.folders.has(up) || scan.unknownFolderIds.includes(up)) {
       return unknown('inside a Drive folder that was not scanned');
@@ -87,10 +78,9 @@ export async function probeRecord(
 export async function probeRecords(
   remoteIds: readonly string[],
   scan: RemoteScan,
-  get: FileGetter,
-  prefs: GoogleExportPrefs = DEFAULT_GOOGLE_EXPORT,
+  remote: ItemGetter,
 ): Promise<Map<string, Probe>> {
   const probes = new Map<string, Probe>();
-  for (const id of remoteIds) probes.set(id, await probeRecord(id, scan, get, prefs));
+  for (const id of remoteIds) probes.set(id, await probeRecord(id, scan, remote));
   return probes;
 }
```

`src/sync/scan-select.ts` (modify):

```diff
diff --git a/src/sync/scan-select.ts b/src/sync/scan-select.ts
index 0513828..7afacef 100644
--- a/src/sync/scan-select.ts
+++ b/src/sync/scan-select.ts
@@ -106,13 +106,7 @@ export async function gatherInput(
   for (const name of failed) local.unknownSubtrees.push(toKey(name));
   const seen = new Set([...remote.entries.map((e) => e.id), ...remote.ignored.map((i) => i.id)]);
   const missing = records.map((r) => r.remoteId).filter((id) => !seen.has(id));
-  const probes = await probeRecords(
-    missing,
-    remote,
-    (id, fields) =>
-      env.ops.exec(pair.account, 'idempotent', id, (ctx) => ctx.drive.getFile(id, fields)),
-    pair.googleExport,
-  );
+  const probes = await probeRecords(missing, remote, env.remoteFor(pair));
   return { input: { ...base, probes, md5s }, local, remote };
 }
```

- [ ] **Step 4: Run it and watch it pass.**

Run: `npx vitest run src/sync/__tests__/remote-probe.test.ts`

Expected: PASS (no type errors; every test in the file passes).

- [ ] **Step 5: Format and run the whole check.**

Run: `npx prettier --write src/sync/__tests__/remote-probe.test.ts src/sync/remote-probe.ts src/sync/scan-select.ts` then `npm run check`

Expected: exit 0, `Test Files  124 passed (124); Tests  1344 passed | 6 skipped (1350)`.

- [ ] **Step 6: Commit.**

```bash
git add src/sync/__tests__/remote-probe.test.ts src/sync/remote-probe.ts src/sync/scan-select.ts
git commit -F - <<'MSG'
refactor(sync): probe missing records through SyncRemote.get

get returns null on 404/403, which the probe maps to unavailable (file) or
'a parent folder cannot be read' (parent walk), as before. The parent walk now
reads the sync fields instead of 'id, parents'.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
MSG
```

### Task 6: Executor re-reads and remote trash; remoteUnchangedSince on RemoteItem

**Spec:** §2.3 `executor.ts` (`readRemote`, trash-remote), `content-compare.ts` (`remoteUnchangedSince` on `RemoteItem`). Commit `b1d8645` on the reference branch.

**Files:**
- Test: `src/sync/__tests__/content-compare.test.ts`
- Test: `src/sync/__tests__/executor.test.ts`
- Modify: `src/sync/content-compare.ts`
- Modify: `src/sync/exec-export.ts`
- Modify: `src/sync/executor.ts`
- Modify: `src/sync/release.ts`
- Modify: `src/sync/sync-service.ts`

- [ ] **Step 1: Write the failing test (and its setup).**

`src/sync/__tests__/content-compare.test.ts` (modify):

```diff
diff --git a/src/sync/__tests__/content-compare.test.ts b/src/sync/__tests__/content-compare.test.ts
index a3e9218..7a2e06f 100644
--- a/src/sync/__tests__/content-compare.test.ts
+++ b/src/sync/__tests__/content-compare.test.ts
@@ -1,7 +1,13 @@
 import { describe, expect, it } from 'vitest';
+import type { DriveFile } from '../../drive/drive-adapter.js';
 import { localMatchesRemote, remoteChanged, remoteUnchangedSince } from '../content-compare.js';
+import { toRemoteItem } from '../remote/google-remote.js';
+import type { RemoteItem } from '../remote/sync-remote.js';
+import { DEFAULT_GOOGLE_EXPORT } from '../types.js';
 import { nativeEntry, nativeRecord, record, remoteEntry } from './fixtures.js';
 
+const item = (file: DriveFile): RemoteItem => toRemoteItem(file, DEFAULT_GOOGLE_EXPORT);
+
 const LATER = '2026-11-04T00:00:00.000Z';
 
 describe('remoteChanged', () => {
@@ -34,16 +40,17 @@ describe('remoteChanged', () => {
 describe('remoteUnchangedSince', () => {
   it('binary needs md5 and modifiedTime equal', () => {
     const r = remoteEntry('r1', 'a.pdf');
-    expect(remoteUnchangedSince(r, { md5Checksum: r.md5, modifiedTime: r.modifiedTime })).toBe(
-      true,
+    const md5Checksum = r.md5 ?? undefined;
+    expect(remoteUnchangedSince(r, item({ md5Checksum, modifiedTime: r.modifiedTime }))).toBe(true);
+    expect(remoteUnchangedSince(r, item({ md5Checksum: 'x', modifiedTime: r.modifiedTime }))).toBe(
+      false,
     );
-    expect(remoteUnchangedSince(r, { md5Checksum: 'x', modifiedTime: r.modifiedTime })).toBe(false);
-    expect(remoteUnchangedSince(r, { md5Checksum: r.md5, modifiedTime: LATER })).toBe(false);
+    expect(remoteUnchangedSince(r, item({ md5Checksum, modifiedTime: LATER }))).toBe(false);
   });
   it('native needs modifiedTime equal', () => {
     const r = nativeEntry('g1', 'Plan.docx');
-    expect(remoteUnchangedSince(r, { modifiedTime: r.modifiedTime })).toBe(true);
-    expect(remoteUnchangedSince(r, { modifiedTime: LATER })).toBe(false);
+    expect(remoteUnchangedSince(r, item({ modifiedTime: r.modifiedTime }))).toBe(true);
+    expect(remoteUnchangedSince(r, item({ modifiedTime: LATER }))).toBe(false);
   });
 });
 describe('localMatchesRemote', () => {
```

`src/sync/__tests__/executor.test.ts` (modify):

```diff
diff --git a/src/sync/__tests__/executor.test.ts b/src/sync/__tests__/executor.test.ts
index 6a1dbfb..b3af496 100644
--- a/src/sync/__tests__/executor.test.ts
+++ b/src/sync/__tests__/executor.test.ts
@@ -16,6 +16,8 @@ import {
   type FakeDrive,
 } from '../../files/__tests__/fakes.js';
 import { Executor, conflictName } from '../executor.js';
+import { GoogleSyncRemote } from '../remote/google-remote.js';
+import { DEFAULT_GOOGLE_EXPORT } from '../types.js';
 import { foldKey } from '../paths.js';
 import { buildReport } from '../report.js';
 import type { DriveFile } from '../../drive/drive-adapter.js';
@@ -89,6 +91,7 @@ function executor(
   return new Executor(
     {
       ops,
+      remote: new GoogleSyncRemote(ops, 'emco', DEFAULT_GOOGLE_EXPORT),
       audit,
       logger: silentLogger(),
       clock: () => NOW,
```

- [ ] **Step 2: Run it and watch it fail.**

Run: `npx vitest run src/sync/__tests__/content-compare.test.ts`

Expected: FAIL. 1 failed, `AssertionError: expected false to be true` (the old function reads `md5Checksum`).

- [ ] **Step 3: Implement.**

`src/sync/content-compare.ts` (modify):

```diff
diff --git a/src/sync/content-compare.ts b/src/sync/content-compare.ts
index 5c4ae44..87c2ca2 100644
--- a/src/sync/content-compare.ts
+++ b/src/sync/content-compare.ts
@@ -1,7 +1,12 @@
-import type { DriveFile } from '../drive/drive-adapter.js';
 import { ValidationError } from '../errors.js';
+import type { RemoteItem } from './remote/sync-remote.js';
 import type { RemoteEntry, SyncRecord } from './types.js';
 
+/** The item's md5, or null when it reports none (or another hash kind). */
+export function md5Of(item: RemoteItem): string | null {
+  return item.hash?.kind === 'md5' ? item.hash.value : null;
+}
+
 /** R content vs the record: binary md5 (else size + modifiedTime, `weak`); native modifiedTime. */
 export function remoteChanged(
   record: SyncRecord,
@@ -20,9 +25,9 @@ export function remoteChanged(
 }
 
 /** Executor re-verification: binary md5 and modifiedTime equal; native modifiedTime equal. */
-export function remoteUnchangedSince(planned: RemoteEntry, current: DriveFile): boolean {
-  if ((current.modifiedTime ?? '') !== planned.modifiedTime) return false;
-  return planned.native !== null || (current.md5Checksum ?? null) === planned.md5;
+export function remoteUnchangedSince(planned: RemoteEntry, current: RemoteItem): boolean {
+  if (current.modifiedTime !== planned.modifiedTime) return false;
+  return planned.native !== null || md5Of(current) === planned.md5;
 }
 
 /**
```

`src/sync/exec-export.ts` (modify):

```diff
diff --git a/src/sync/exec-export.ts b/src/sync/exec-export.ts
index 2d43f79..2ec34a2 100644
--- a/src/sync/exec-export.ts
+++ b/src/sync/exec-export.ts
@@ -17,6 +17,7 @@ import {
   type LocalFields,
 } from './exec-records.js';
 import { absInside, prepareParent } from './paths.js';
+import { toRemoteItem } from './remote/google-remote.js';
 import {
   downloadReplace,
   moveLocal,
@@ -62,7 +63,8 @@ async function reread(host: ExportHost, remote: RemoteEntry): Promise<DriveFile>
   const current = await host.ops.exec(host.file.pair.account, 'idempotent', remote.id, (ctx) =>
     ctx.drive.getFile(remote.id, SYNC_EXPORT_FIELDS),
   );
-  if (current.trashed || !remoteUnchangedSince(remote, current)) {
+  const item = toRemoteItem(current, host.file.pair.googleExport);
+  if (item.trashed || !remoteUnchangedSince(remote, item)) {
     throw new TargetChangedError(`${remote.key} changed in Drive since planning`);
   }
   return current;
```

`src/sync/executor.ts` (modify):

```diff
diff --git a/src/sync/executor.ts b/src/sync/executor.ts
index 163cad6..bd81275 100644
--- a/src/sync/executor.ts
+++ b/src/sync/executor.ts
@@ -32,6 +32,7 @@ import { md5File } from './local-scanner.js';
 import { absInside, baseName, parentKey, prepareParent } from './paths.js';
 import { RemoteFolders } from './remote-folders.js';
 import { SYNC_LIST_FIELDS } from './remote/google-remote.js';
+import type { RemoteItem, SyncRemote } from './remote/sync-remote.js';
 import {
   downloadReplace,
   moveLocal,
@@ -41,7 +42,6 @@ import {
 } from './transfer.js';
 import type { LocalTrash } from './trash.js';
 import {
-  SYNC_FILE_FIELDS,
   type Action,
   type ActionKind,
   type ActionOutcome,
@@ -68,6 +68,8 @@ export { conflictName } from './exec-records.js';
 
 export interface ExecutorDeps {
   ops: OperationRunner;
+  /** The pair's remote; every remote read and write goes through it. */
+  remote: SyncRemote;
   audit: AuditSink;
   logger: Logger;
   clock: () => Date;
@@ -234,15 +236,9 @@ export class Executor {
     return { name, md5, size: info.size, mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs };
   }
 
-  private readRemote(id: string): Promise<DriveFile> {
-    return this.deps.ops.exec(this.pair.account, 'idempotent', id, (ctx) =>
-      ctx.drive.getFile(id, SYNC_FILE_FIELDS),
-    );
-  }
-
   /** Re-reads R and throws TargetChangedError unless it still matches the plan (spec §7). */
-  private async verifyRemote(planned: RemoteEntry): Promise<DriveFile> {
-    const current = await this.readRemote(planned.id);
+  private async verifyRemote(planned: RemoteEntry): Promise<RemoteItem> {
+    const current = await this.deps.remote.read(planned.id);
     if (current.trashed || !remoteUnchangedSince(planned, current)) {
       throw new TargetChangedError(`${planned.key} changed in Drive since planning`);
     }
@@ -520,21 +516,12 @@ export class Executor {
       },
     );
     if (back) throw new TargetChangedError(`${action.key} exists locally again`);
-    const current = await this.readRemote(remote.id);
+    const current = await this.deps.remote.read(remote.id);
     if (!current.trashed) {
-      if (
-        !remoteUnchangedSince(remote, current) ||
-        (current.parents?.[0] ?? '') !== remote.parentId
-      ) {
+      if (!remoteUnchangedSince(remote, current) || (current.parentId ?? '') !== remote.parentId) {
         throw new TargetChangedError(`${action.key} changed or moved in Drive since planning`);
       }
-      await this.deps.ops.exec(this.pair.account, 'idempotent', remote.id, (ctx) =>
-        ctx.drive.updateFile({
-          fileId: remote.id,
-          requestBody: { trashed: true },
-          fields: 'id, trashed',
-        }),
-      );
+      await this.deps.remote.trash(current);
     }
     await this.commit(action, () => dropRecord(this.file, record.remoteId));
     await this.audit('sync_trash_remote', action, remote.id);
```

`src/sync/release.ts` (modify):

```diff
diff --git a/src/sync/release.ts b/src/sync/release.ts
index b2a71b4..09cba77 100644
--- a/src/sync/release.ts
+++ b/src/sync/release.ts
@@ -9,6 +9,7 @@ import { isAbortError, messageOf, PersistenceError, TargetChangedError } from '.
 import { md5File } from './local-scanner.js';
 import { absInside, baseName, foldKey, parentKey, toKey, validateRelPath } from './paths.js';
 import { TYPE_CHANGED } from './plan-tracked.js';
+import { toRemoteItem } from './remote/google-remote.js';
 import {
   buildContext,
   isUnknownKey,
@@ -174,14 +175,15 @@ const KEEP_DIR = ['ENOTEMPTY', 'EEXIST', 'ENOENT', 'ENOTDIR'];
 
 /** R must still be present-same: not trashed, content unchanged, same name and parent. */
 async function verifyRemote(deps: ReleaseDeps, pair: Pair, planned: RemoteEntry): Promise<void> {
-  const current = await deps.ops.exec(pair.account, 'idempotent', planned.id, (ctx) =>
+  const file = await deps.ops.exec(pair.account, 'idempotent', planned.id, (ctx) =>
     ctx.drive.getFile(planned.id, SYNC_FILE_FIELDS),
   );
+  const current = toRemoteItem(file, pair.googleExport);
   if (
     current.trashed ||
     !remoteUnchangedSince(planned, current) ||
-    (current.name ?? '') !== planned.name ||
-    (current.parents?.[0] ?? '') !== planned.parentId
+    current.name !== planned.name ||
+    (current.parentId ?? '') !== planned.parentId
   ) {
     throw new TargetChangedError(
       `${planned.key} changed, moved or was trashed in Drive since the scan`,
```

`src/sync/sync-service.ts` (modify):

```diff
diff --git a/src/sync/sync-service.ts b/src/sync/sync-service.ts
index 1f6a0dd..9ff0129 100644
--- a/src/sync/sync-service.ts
+++ b/src/sync/sync-service.ts
@@ -206,6 +206,7 @@ export class SyncService {
       const executor = new Executor(
         {
           ops: this.ops,
+          remote: this.env.remoteFor(file.pair),
           audit: this.deps.audit,
           logger: this.log,
           clock: this.clock,
```

- [ ] **Step 4: Run it and watch it pass.**

Run: `npx vitest run src/sync/__tests__/content-compare.test.ts`

Expected: PASS (no type errors; every test in the file passes).

- [ ] **Step 5: Format and run the whole check.**

Run: `npx prettier --write src/sync/__tests__/content-compare.test.ts src/sync/__tests__/executor.test.ts src/sync/content-compare.ts src/sync/exec-export.ts src/sync/executor.ts src/sync/release.ts src/sync/sync-service.ts` then `npm run check`

Expected: exit 0, `Test Files  124 passed (124); Tests  1344 passed | 6 skipped (1350)`.

- [ ] **Step 6: Commit.**

```bash
git add src/sync/__tests__/content-compare.test.ts src/sync/__tests__/executor.test.ts src/sync/content-compare.ts src/sync/exec-export.ts src/sync/executor.ts src/sync/release.ts src/sync/sync-service.ts
git commit -F - <<'MSG'
refactor(sync): executor re-reads and remote trash go through SyncRemote

ExecutorDeps gains the pair's remote. remoteUnchangedSince compares a RemoteItem
(md5Of reads its md5 hash). Release and the export re-read convert with
toRemoteItem until they move onto the port.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
MSG
```

### Task 7: Uploads, replaceContent and the duplicate check

**Spec:** §2.3 `executor.ts` (`findDuplicateUpload`, the upload checks), `transfer.ts` (`uploadNew`, `updateContent`), `exec-records.ts` (`fromDrive` becomes `fromRemote`). Commit `4190dc9` on the reference branch.

**Files:**
- Test (create): `src/sync/__tests__/exec-records.test.ts`
- Test: `src/sync/__tests__/transfer.test.ts`
- Modify: `src/sync/exec-records.ts`
- Modify: `src/sync/executor.ts`
- Modify: `src/sync/transfer.ts`

- [ ] **Step 1: Write the failing test (and its setup).**

`src/sync/__tests__/exec-records.test.ts` (create):

```ts
import { describe, expect, it } from 'vitest';
import { fromRemote } from '../exec-records.js';
import { toRemoteItem } from '../remote/google-remote.js';
import { DEFAULT_GOOGLE_EXPORT } from '../types.js';
import { binary } from './drive-tree.js';

describe('fromRemote', () => {
  it('takes the uploaded file fields, md5 and first parent', () => {
    const item = toRemoteItem(binary('n1', 'a.pdf', 'P'), DEFAULT_GOOGLE_EXPORT);
    expect(fromRemote(item, 'fallback')).toEqual({
      id: 'n1',
      name: 'a.pdf',
      parentId: 'P',
      md5: 'md5-n1',
      size: 10,
      modifiedTime: '2026-11-02T00:00:00.000Z',
      native: null,
    });
  });
  it('falls back to the upload parent when Drive returns no parents', () => {
    const item = toRemoteItem({ id: 'n1' }, DEFAULT_GOOGLE_EXPORT);
    expect(fromRemote(item, 'P')).toMatchObject({ parentId: 'P', md5: null, size: null });
  });
});
```

`src/sync/__tests__/transfer.test.ts` (modify):

```diff
diff --git a/src/sync/__tests__/transfer.test.ts b/src/sync/__tests__/transfer.test.ts
index 4bd2ca1..d7504ac 100644
--- a/src/sync/__tests__/transfer.test.ts
+++ b/src/sync/__tests__/transfer.test.ts
@@ -4,18 +4,14 @@ import os from 'node:os';
 import path from 'node:path';
 import { Readable } from 'node:stream';
 import { afterEach, beforeEach, describe, expect, it } from 'vitest';
-import { createFakeDrive } from '../../files/__tests__/fakes.js';
 import { ChecksumMismatchError, CollisionError, TargetChangedError } from '../errors.js';
 import {
   downloadReplace,
   moveLocal,
   placeExclusive,
   syncDir,
-  updateContent,
-  uploadNew,
   type StatExpect,
 } from '../transfer.js';
-import { SYNC_FILE_FIELDS } from '../types.js';
 
 const md5 = (s: string): string => createHash('md5').update(s).digest('hex');
 const source = (s: string) => async (): Promise<Readable> => Readable.from([Buffer.from(s)]);
@@ -171,33 +167,6 @@ describe('moveLocal', () => {
   });
 });
 
-describe('Drive transfers', () => {
-  it('uploadNew creates the file with media and sync fields', async () => {
-    const drive = createFakeDrive();
-    drive.createFile.mockResolvedValueOnce({ id: 'n1' });
-    const abs = path.join(dir, 'a.pdf');
-    await writeFile(abs, 'x');
-    await expect(uploadNew(drive, { abs, name: 'a.pdf', parentId: 'P' })).resolves.toEqual({
-      id: 'n1',
-    });
-    const call = drive.createFile.mock.calls[0]?.[0];
-    expect(call?.requestBody).toEqual({ name: 'a.pdf', parents: ['P'] });
-    expect(call?.media?.mimeType).toBe('application/pdf');
-    expect(call?.fields).toBe(SYNC_FILE_FIELDS);
-  });
-
-  it('updateContent sends new media for the same fileId', async () => {
-    const drive = createFakeDrive();
-    drive.updateFile.mockResolvedValueOnce({ id: 'r1' });
-    const abs = path.join(dir, 'a.txt');
-    await writeFile(abs, 'x');
-    await updateContent(drive, { fileId: 'r1', abs });
-    const call = drive.updateFile.mock.calls[0]?.[0];
-    expect(call).toMatchObject({ fileId: 'r1', fields: SYNC_FILE_FIELDS });
-    expect(call?.media?.mimeType).toBe('text/plain');
-  });
-});
-
 describe('moveLocal on folding volumes (review regressions)', () => {
   it('never deletes the only copy when the volume folds the two names (ß → SS)', async () => {
     const from = path.join(dir, 'straße.pdf');
```

- [ ] **Step 2: Run it and watch it fail.**

Run: `npx vitest run src/sync/__tests__/exec-records.test.ts`

Expected: FAIL. 2 failed, `TypeError: fromRemote is not a function`.

- [ ] **Step 3: Implement.**

`src/sync/exec-records.ts` (modify):

```diff
diff --git a/src/sync/exec-records.ts b/src/sync/exec-records.ts
index 9344f10..5e77251 100644
--- a/src/sync/exec-records.ts
+++ b/src/sync/exec-records.ts
@@ -1,6 +1,7 @@
-import type { DriveFile } from '../drive/drive-adapter.js';
 import { ValidationError } from '../errors.js';
+import { md5Of } from './content-compare.js';
 import { foldKey } from './paths.js';
+import type { RemoteItem } from './remote/sync-remote.js';
 import type { StatExpect } from './transfer.js';
 import type { LocalEntry, PairFile, RemoteEntry, SelectionChange, SyncRecord } from './types.js';
 
@@ -34,14 +35,15 @@ export function fromEntry(e: RemoteEntry): RemoteFields {
   };
 }
 
-export function fromDrive(f: DriveFile, fallbackParent: string): RemoteFields {
+/** Record fields from an upload's result; `fallbackParent` when the remote names none. */
+export function fromRemote(item: RemoteItem, fallbackParent: string): RemoteFields {
   return {
-    id: f.id ?? '',
-    name: f.name ?? '',
-    parentId: f.parents?.[0] ?? fallbackParent,
-    md5: f.md5Checksum ?? null,
-    size: f.size ? Number(f.size) : null,
-    modifiedTime: f.modifiedTime ?? '',
+    id: item.id,
+    name: item.name,
+    parentId: item.parentId ?? fallbackParent,
+    md5: md5Of(item),
+    size: item.size,
+    modifiedTime: item.modifiedTime,
     // Uploads are binary files.
     native: null,
   };
```

`src/sync/executor.ts` (modify):

```diff
diff --git a/src/sync/executor.ts b/src/sync/executor.ts
index bd81275..b844f3b 100644
--- a/src/sync/executor.ts
+++ b/src/sync/executor.ts
@@ -2,11 +2,9 @@ import { lstat } from 'node:fs/promises';
 import path from 'node:path';
 import type { AuditOp, AuditSink } from '../audit/audit-log.js';
 import type { OperationRunner } from '../core/operation.js';
-import type { DriveFile } from '../drive/drive-adapter.js';
 import { AppError, ExportTooLargeError, hasErrorCode } from '../errors.js';
-import { escapeQueryValue } from '../files/query.js';
 import type { Logger } from '../logger.js';
-import { remoteUnchangedSince } from './content-compare.js';
+import { md5Of, remoteUnchangedSince } from './content-compare.js';
 import {
   CollisionError,
   LocalEditKeptError,
@@ -19,8 +17,8 @@ import {
   applySelection,
   conflictName,
   dropRecord,
-  fromDrive,
   fromEntry,
+  fromRemote,
   makeRecord,
   need,
   putRecord,
@@ -31,15 +29,8 @@ import { exportNew, exportOver, exportReplace, type ExportHost } from './exec-ex
 import { md5File } from './local-scanner.js';
 import { absInside, baseName, parentKey, prepareParent } from './paths.js';
 import { RemoteFolders } from './remote-folders.js';
-import { SYNC_LIST_FIELDS } from './remote/google-remote.js';
 import type { RemoteItem, SyncRemote } from './remote/sync-remote.js';
-import {
-  downloadReplace,
-  moveLocal,
-  placeExclusive,
-  updateContent,
-  uploadNew,
-} from './transfer.js';
+import { downloadReplace, moveLocal, placeExclusive } from './transfer.js';
 import type { LocalTrash } from './trash.js';
 import {
   type Action,
@@ -292,18 +283,16 @@ export class Executor {
     const parentId = await this.folders.folderFor(parentKey(action.key));
     const abs = absInside(this.pair.localDir, local.name);
     const name = baseName(action.key);
-    let uploaded: DriveFile;
+    let uploaded: RemoteItem;
     try {
-      uploaded = await this.deps.ops.exec(this.pair.account, 'create', parentId, (ctx) =>
-        uploadNew(ctx.drive, { abs, name, parentId }),
-      );
+      uploaded = await this.deps.remote.uploadNew(parentId, name, abs);
     } catch (err) {
       if (isAbortError(err)) throw err;
       const adopted = await this.findDuplicateUpload(parentId, name, planned);
       if (!adopted) throw err;
       uploaded = adopted;
     }
-    const remote = fromDrive(uploaded, parentId);
+    const remote = fromRemote(uploaded, parentId);
     const warning =
       remote.md5 !== null && remote.md5 !== planned ? 'changed-during-upload' : undefined;
     await this.commit(action, () =>
@@ -322,19 +311,16 @@ export class Executor {
     parentId: string,
     name: string,
     md5: string,
-  ): Promise<DriveFile | null> {
-    const q = `'${escapeQueryValue(parentId)}' in parents and trashed = false and name = '${escapeQueryValue(name)}'`;
+  ): Promise<RemoteItem | null> {
     try {
-      const list = await this.deps.ops.exec(this.pair.account, 'idempotent', parentId, (ctx) =>
-        ctx.drive.listFiles({ q, pageSize: 100, fields: SYNC_LIST_FIELDS }),
-      );
+      const list = await this.deps.remote.findChildren(parentId, name);
       const now = this.deps.clock().getTime();
       return (
-        (list.files ?? []).find(
+        list.find(
           (f) =>
-            f.md5Checksum === md5 &&
+            md5Of(f) === md5 &&
             f.name === name &&
-            Math.abs(now - Date.parse(f.createdTime ?? '')) <= DUPLICATE_WINDOW_MS,
+            Math.abs(now - Date.parse(f.createdTime)) <= DUPLICATE_WINDOW_MS,
         ) ?? null
       );
     } catch (err) {
@@ -347,12 +333,10 @@ export class Executor {
     const local = need(action.local, 'local');
     const planned = need(action.localMd5, 'local md5');
     const remote = need(action.remote, 'remote');
-    await this.verifyRemote(remote);
+    const current = await this.verifyRemote(remote);
     const abs = absInside(this.pair.localDir, local.name);
-    const updated = await this.deps.ops.exec(this.pair.account, 'mutate', remote.id, (ctx) =>
-      updateContent(ctx.drive, { fileId: remote.id, abs }),
-    );
-    const fields = fromDrive(updated, remote.parentId);
+    const updated = await this.deps.remote.replaceContent(current, abs);
+    const fields = fromRemote(updated, remote.parentId);
     const warning =
       fields.md5 !== null && fields.md5 !== planned ? 'changed-during-upload' : undefined;
     await this.commit(action, () =>
@@ -483,11 +467,9 @@ export class Executor {
       );
       return { conflictCopy };
     }
-    await this.verifyRemote(remote);
-    const updated = await this.deps.ops.exec(this.pair.account, 'mutate', remote.id, (ctx) =>
-      updateContent(ctx.drive, { fileId: remote.id, abs }),
-    );
-    const fields = fromDrive(updated, remote.parentId);
+    const current = await this.verifyRemote(remote);
+    const updated = await this.deps.remote.replaceContent(current, abs);
+    const fields = fromRemote(updated, remote.parentId);
     await this.commit(action, () =>
       putRecord(
         this.file,
```

`src/sync/transfer.ts` (modify):

```diff
diff --git a/src/sync/transfer.ts b/src/sync/transfer.ts
index 8edac9a..1127e17 100644
--- a/src/sync/transfer.ts
+++ b/src/sync/transfer.ts
@@ -1,14 +1,10 @@
 import { createHash, randomUUID } from 'node:crypto';
-import { createReadStream } from 'node:fs';
 import { link as fsLink, lstat, open, readdir, rename, rm, unlink } from 'node:fs/promises';
 import path from 'node:path';
 import type { Readable } from 'node:stream';
-import type { DriveAdapter, DriveFile } from '../drive/drive-adapter.js';
 import { hasErrorCode } from '../errors.js';
-import { uploadMimeType } from '../files/upload-mime.js';
 import { ChecksumMismatchError, CollisionError, TargetChangedError } from './errors.js';
 import { PART_SUFFIX } from './paths.js';
-import { SYNC_FILE_FIELDS } from './types.js';
 import { renameReplacing } from '../files/rename-replacing.js';
 
 export type LinkFn = (existingPath: string, newPath: string) => Promise<void>;
@@ -218,38 +214,3 @@ export async function moveLocal(
   }
   await unlink(from);
 }
-
-export async function uploadNew(
-  drive: DriveAdapter,
-  input: { abs: string; name: string; parentId: string },
-): Promise<DriveFile> {
-  const body = createReadStream(input.abs);
-  try {
-    return await drive.createFile({
-      requestBody: { name: input.name, parents: [input.parentId] },
-      media: { mimeType: uploadMimeType(input.abs), body },
-      fields: SYNC_FILE_FIELDS,
-    });
-  } catch (err) {
-    body.destroy();
-    throw err;
-  }
-}
-
-/** New content for the same fileId (Drive keeps a revision). */
-export async function updateContent(
-  drive: DriveAdapter,
-  input: { fileId: string; abs: string },
-): Promise<DriveFile> {
-  const body = createReadStream(input.abs);
-  try {
-    return await drive.updateFile({
-      fileId: input.fileId,
-      media: { mimeType: uploadMimeType(input.abs), body },
-      fields: SYNC_FILE_FIELDS,
-    });
-  } catch (err) {
-    body.destroy();
-    throw err;
-  }
-}
```

- [ ] **Step 4: Run it and watch it pass.**

Run: `npx vitest run src/sync/__tests__/exec-records.test.ts`

Expected: PASS (no type errors; every test in the file passes).

- [ ] **Step 5: Format and run the whole check.**

Run: `npx prettier --write src/sync/__tests__/exec-records.test.ts src/sync/__tests__/transfer.test.ts src/sync/exec-records.ts src/sync/executor.ts src/sync/transfer.ts` then `npm run check`

Expected: exit 0, `Test Files  125 passed (125); Tests  1344 passed | 6 skipped (1350) (2 tests added, the 2 moved transfer tests removed)`.

- [ ] **Step 6: Commit.**

```bash
git add src/sync/__tests__/exec-records.test.ts src/sync/__tests__/transfer.test.ts src/sync/exec-records.ts src/sync/executor.ts src/sync/transfer.ts
git commit -F - <<'MSG'
refactor(sync): uploads and the duplicate check go through SyncRemote

upload-new uses uploadNew, update-remote and conflict use replaceContent with the
re-read item, findDuplicateUpload uses findChildren. exec-records.fromDrive
becomes fromRemote. transfer.ts no longer touches Drive; its upload tests moved
to google-remote.test.ts.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
MSG
```

### Task 8: Upload folders through findChildren and createFolder

**Spec:** §2.3 `remote-folders.ts` (`ensureRemoteFolder`), §2.1 `findChildren` ("the engine decides"). Commit `fcf2977` on the reference branch.

**Files:**
- Test (create): `src/sync/__tests__/remote-folders.test.ts`
- Modify: `src/sync/remote-folders.ts`

- [ ] **Step 1: Write the failing test (and its setup).**

`src/sync/__tests__/remote-folders.test.ts` (create):

```ts
import { describe, expect, it } from 'vitest';
import { ValidationError } from '../../errors.js';
import { createAudit, silentLogger } from '../../files/__tests__/fakes.js';
import { RemoteFolders } from '../remote-folders.js';
import { googleRemoteOver } from './fake-remote.js';
import { ROOT_ID, makePair } from './fixtures.js';
import { memoryDrive } from './memory-drive.js';

function folders(caseInsensitive: boolean) {
  const mem = memoryDrive(ROOT_ID);
  const audit = createAudit();
  const remote = googleRemoteOver(mem.drive);
  const pair = makePair({ caseInsensitive });
  const made = new RemoteFolders(
    { remote, audit, logger: silentLogger() },
    pair,
    new Map([[ROOT_ID, '']]),
  );
  return { mem, audit, made };
}

describe('RemoteFolders through SyncRemote', () => {
  it('reuses one existing folder by fold key on a case-insensitive volume', async () => {
    const { mem, made } = folders(true);
    mem.addFolder('d1', 'Docs', ROOT_ID);
    expect(await made.folderFor('docs')).toBe('d1');
    expect(mem.drive.createFile).not.toHaveBeenCalled();
  });

  it('needs the exact NFC name on a case-sensitive volume, else creates and audits', async () => {
    const { mem, audit, made } = folders(false);
    mem.addFolder('d1', 'Docs', ROOT_ID);
    const id = await made.folderFor('docs/inner');
    expect(id).not.toBe('d1');
    expect(mem.childrenOf(ROOT_ID).map((f) => f.name)).toEqual(['Docs', 'docs']);
    expect(audit.entries.map((e) => [e.op, e.name, e.details])).toEqual([
      ['create_folder', 'docs', { pair: 'docs', parentId: ROOT_ID }],
      ['create_folder', 'inner', { pair: 'docs', parentId: mem.childrenOf(ROOT_ID)[1]?.id }],
    ]);
  });

  it('refuses several same-name folders', async () => {
    const { mem, made } = folders(true);
    mem.addFolder('d1', 'Docs', ROOT_ID);
    mem.addFolder('d2', 'docs', ROOT_ID);
    await expect(made.folderFor('docs')).rejects.toThrow(ValidationError);
    await expect(made.folderFor('docs')).rejects.toThrow('Several Drive folders named "docs"');
  });
});
```

- [ ] **Step 2: Run it and watch it fail.**

Run: `npx vitest run src/sync/__tests__/remote-folders.test.ts`

Expected: FAIL. 3 failed, `TypeError: Cannot read properties of undefined (reading 'exec')` and `expected error to be instance of ValidationError`.

- [ ] **Step 3: Implement.**

`src/sync/remote-folders.ts` (modify):

```diff
diff --git a/src/sync/remote-folders.ts b/src/sync/remote-folders.ts
index 80a17c6..6c876a9 100644
--- a/src/sync/remote-folders.ts
+++ b/src/sync/remote-folders.ts
@@ -1,21 +1,18 @@
 import type { AuditSink } from '../audit/audit-log.js';
-import type { OperationRunner } from '../core/operation.js';
-import type { DriveFile } from '../drive/drive-adapter.js';
 import { ValidationError } from '../errors.js';
-import { GOOGLE_MIME } from '../files/export-formats.js';
-import { escapeQueryValue } from '../files/query.js';
 import type { Logger } from '../logger.js';
 import { isAbortError, messageOf } from './errors.js';
 import { baseName, foldKey, parentKey } from './paths.js';
+import type { SyncRemote } from './remote/sync-remote.js';
 import type { Action, Pair } from './types.js';
 
 export interface RemoteFolderDeps {
-  ops: OperationRunner;
+  remote: SyncRemote;
   audit: AuditSink;
   logger: Logger;
 }
 
-/** Drive folders for uploads: scanned ids first, then reuse-or-create (spec §4). */
+/** Remote folders for uploads: scanned ids first, then reuse-or-create (spec §4). */
 export class RemoteFolders {
   private readonly folderIds = new Map<string, string>();
   private readonly folderErrors = new Map<string, string>();
@@ -59,38 +56,18 @@ export class RemoteFolders {
 
   /** Reuses exactly one non-trashed same-name folder; several → refuse (spec §4). */
   private async ensureRemoteFolder(parentId: string, name: string): Promise<string> {
-    const q = `'${escapeQueryValue(parentId)}' in parents and trashed = false and mimeType = '${GOOGLE_MIME.folder}'`;
-    const folders: DriveFile[] = [];
-    let pageToken: string | undefined;
-    do {
-      const page = await this.deps.ops.exec(this.pair.account, 'idempotent', parentId, (ctx) =>
-        ctx.drive.listFiles({
-          q,
-          pageSize: 1000,
-          ...(pageToken ? { pageToken } : {}),
-          fields: 'nextPageToken, files(id, name)',
-        }),
-      );
-      folders.push(...(page.files ?? []));
-      pageToken = page.nextPageToken ?? undefined;
-    } while (pageToken);
-    const same = folders.filter((f) =>
-      this.pair.caseInsensitive
-        ? foldKey(f.name ?? '') === foldKey(name)
-        : (f.name ?? '').normalize('NFC') === name.normalize('NFC'),
-    );
+    // findChildren already matched the fold key; a case-sensitive volume needs the NFC name.
+    const folders = await this.deps.remote.findChildren(parentId, name, 'folder');
+    const same = this.pair.caseInsensitive
+      ? folders
+      : folders.filter((f) => f.name.normalize('NFC') === name.normalize('NFC'));
     if (same.length > 1)
       throw new ValidationError(
         `Several Drive folders named "${name}"; resolve the duplicate first`,
       );
     const existing = same[0]?.id;
     if (existing) return existing;
-    const created = await this.deps.ops.exec(this.pair.account, 'create', parentId, (ctx) =>
-      ctx.drive.createFile({
-        requestBody: { name, mimeType: GOOGLE_MIME.folder, parents: [parentId] },
-        fields: 'id, name',
-      }),
-    );
+    const created = await this.deps.remote.createFolder(parentId, name);
     const id = created.id;
     if (!id) throw new ValidationError('Internal: folder id missing for sync action');
     try {
```

- [ ] **Step 4: Run it and watch it pass.**

Run: `npx vitest run src/sync/__tests__/remote-folders.test.ts`

Expected: PASS (no type errors; every test in the file passes).

- [ ] **Step 5: Format and run the whole check.**

Run: `npx prettier --write src/sync/__tests__/remote-folders.test.ts src/sync/remote-folders.ts` then `npm run check`

Expected: exit 0, `Test Files  126 passed (126); Tests  1347 passed | 6 skipped (1353)`.

- [ ] **Step 6: Commit.**

```bash
git add src/sync/__tests__/remote-folders.test.ts src/sync/remote-folders.ts
git commit -F - <<'MSG'
refactor(sync): upload folders are found and created through SyncRemote

ensureRemoteFolder uses findChildren(parent, name, 'folder') and createFolder;
the reuse rule (fold key on case-insensitive volumes, NFC name otherwise, refuse
several) and the create_folder audit record stay in the engine.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
MSG
```

### Task 9: Downloads and native exports; ExecutorDeps drops the OperationRunner

**Spec:** §2.3 `executor.ts`, `exec-export.ts`; §2.1 `download`, `exportNative`. Commit `1a6baf2` on the reference branch.

**Files:**
- Test: `src/sync/__tests__/executor.test.ts`
- Modify: `src/sync/exec-export.ts`
- Modify: `src/sync/executor.ts`
- Modify: `src/sync/remote/google-remote.ts`
- Modify: `src/sync/sync-service.ts`

- [ ] **Step 1: Write the failing test (and its setup).**

`src/sync/__tests__/executor.test.ts` (modify):

```diff
diff --git a/src/sync/__tests__/executor.test.ts b/src/sync/__tests__/executor.test.ts
index b3af496..02a2608 100644
--- a/src/sync/__tests__/executor.test.ts
+++ b/src/sync/__tests__/executor.test.ts
@@ -16,13 +16,12 @@ import {
   type FakeDrive,
 } from '../../files/__tests__/fakes.js';
 import { Executor, conflictName } from '../executor.js';
-import { GoogleSyncRemote } from '../remote/google-remote.js';
+import { GoogleSyncRemote, SYNC_EXPORT_FIELDS } from '../remote/google-remote.js';
 import { DEFAULT_GOOGLE_EXPORT } from '../types.js';
 import { foldKey } from '../paths.js';
 import { buildReport } from '../report.js';
 import type { DriveFile } from '../../drive/drive-adapter.js';
 import { GOOGLE_MIME } from '../../files/export-formats.js';
-import { SYNC_EXPORT_FIELDS } from '../exec-export.js';
 import type { Action, LocalEntry, PairFile, Plan, RemoteEntry, SyncRecord } from '../types.js';
 import type { LocalTrash } from '../trash.js';
 import {
@@ -90,7 +89,6 @@ function executor(
   });
   return new Executor(
     {
-      ops,
       remote: new GoogleSyncRemote(ops, 'emco', DEFAULT_GOOGLE_EXPORT),
       audit,
       logger: silentLogger(),
```

- [ ] **Step 2: Run it and watch it fail.**

Run: `npx tsc --noEmit`

Expected: FAIL. `src/sync/__tests__/executor.test.ts(91,5): error TS2345: … Property 'ops' is missing in type '{ remote: GoogleSyncRemote; … }' but required in type 'ExecutorDeps'.`

- [ ] **Step 3: Implement.**

`src/sync/exec-export.ts` (modify):

```diff
diff --git a/src/sync/exec-export.ts b/src/sync/exec-export.ts
index 2ec34a2..59cdfed 100644
--- a/src/sync/exec-export.ts
+++ b/src/sync/exec-export.ts
@@ -1,10 +1,6 @@
 import path from 'node:path';
 import type { AuditOp } from '../audit/audit-log.js';
-import type { OperationRunner } from '../core/operation.js';
-import type { DriveFile } from '../drive/drive-adapter.js';
 import type { ExportPlan } from '../files/export-formats.js';
-import { openExport } from '../files/export-stream.js';
-import type { Logger } from '../logger.js';
 import { remoteUnchangedSince } from './content-compare.js';
 import { CollisionError, LocalEditKeptError, TargetChangedError } from './errors.js';
 import {
@@ -17,7 +13,7 @@ import {
   type LocalFields,
 } from './exec-records.js';
 import { absInside, prepareParent } from './paths.js';
-import { toRemoteItem } from './remote/google-remote.js';
+import type { NativeSource, SyncRemote } from './remote/sync-remote.js';
 import {
   downloadReplace,
   moveLocal,
@@ -26,23 +22,14 @@ import {
   type StatExpect,
   type Written,
 } from './transfer.js';
-import {
-  SYNC_FILE_FIELDS,
-  type Action,
-  type ActionOutcome,
-  type PairFile,
-  type RemoteEntry,
-} from './types.js';
+import type { Action, ActionOutcome, PairFile, RemoteEntry } from './types.js';
 
-/** The export re-read also needs the 10 MB fallback link and the web link (addendum §4.3). */
-export const SYNC_EXPORT_FIELDS = `${SYNC_FILE_FIELDS}, exportLinks, webViewLink`;
 const MAX_LOCAL_EDIT_NAMES = 100;
 
 /** What the export actions need from the Executor. */
 export interface ExportHost {
   file: PairFile;
-  ops: OperationRunner;
-  logger: Logger;
+  remote: SyncRemote;
   clock: () => Date;
   commit(action: Action, mutate: () => void): Promise<void>;
   audit(op: AuditOp, action: Action, remoteId: string): Promise<void>;
@@ -59,12 +46,9 @@ function planOf(remote: RemoteEntry): ExportPlan {
 }
 
 /** Re-read right before an export; doubles as re-verification (changed/trashed → skip). */
-async function reread(host: ExportHost, remote: RemoteEntry): Promise<DriveFile> {
-  const current = await host.ops.exec(host.file.pair.account, 'idempotent', remote.id, (ctx) =>
-    ctx.drive.getFile(remote.id, SYNC_EXPORT_FIELDS),
-  );
-  const item = toRemoteItem(current, host.file.pair.googleExport);
-  if (item.trashed || !remoteUnchangedSince(remote, item)) {
+async function reread(host: ExportHost, remote: RemoteEntry): Promise<NativeSource> {
+  const current = await host.remote.readNative(remote.id);
+  if (current.item.trashed || !remoteUnchangedSince(remote, current.item)) {
     throw new TargetChangedError(`${remote.key} changed in Drive since planning`);
   }
   return current;
@@ -78,11 +62,8 @@ export async function exportOver(
   remote: RemoteEntry,
 ): Promise<{ md5: string; size: number }> {
   const current = await reread(host, remote);
-  return host.ops.exec(host.file.pair.account, 'idempotent', remote.id, (ctx) =>
-    downloadReplace(abs, () => openExport(ctx.drive, current, planOf(remote), host.logger), {
-      expect,
-      expectedMd5: null,
-    }),
+  return host.remote.exportNative(current, planOf(remote), (open) =>
+    downloadReplace(abs, open, { expect, expectedMd5: null }),
   );
 }
 
@@ -128,9 +109,7 @@ export async function exportNew(host: ExportHost, action: Action): Promise<Parti
   const remote = need(action.remote, 'remote');
   const current = await reread(host, remote);
   const abs = await prepareParent(host.file.pair.localDir, action.key);
-  const source = await host.ops.exec(host.file.pair.account, 'idempotent', remote.id, (ctx) =>
-    openExport(ctx.drive, current, planOf(remote), host.logger),
-  );
+  const source = await host.remote.exportNative(current, planOf(remote), (open) => open());
   let kept: string | null = null;
   try {
     if (action.localEdit) kept = await moveLocalEditAside(host, action);
```

`src/sync/executor.ts` (modify):

```diff
diff --git a/src/sync/executor.ts b/src/sync/executor.ts
index b844f3b..fe89775 100644
--- a/src/sync/executor.ts
+++ b/src/sync/executor.ts
@@ -1,7 +1,6 @@
 import { lstat } from 'node:fs/promises';
 import path from 'node:path';
 import type { AuditOp, AuditSink } from '../audit/audit-log.js';
-import type { OperationRunner } from '../core/operation.js';
 import { AppError, ExportTooLargeError, hasErrorCode } from '../errors.js';
 import type { Logger } from '../logger.js';
 import { md5Of, remoteUnchangedSince } from './content-compare.js';
@@ -58,7 +57,6 @@ const MAX_CONFLICT_NAMES = 100;
 export { conflictName } from './exec-records.js';
 
 export interface ExecutorDeps {
-  ops: OperationRunner;
   /** The pair's remote; every remote read and write goes through it. */
   remote: SyncRemote;
   audit: AuditSink;
@@ -203,8 +201,7 @@ export class Executor {
   private host(): ExportHost {
     return {
       file: this.file,
-      ops: this.deps.ops,
-      logger: this.deps.logger,
+      remote: this.deps.remote,
       clock: this.deps.clock,
       commit: (action, mutate) => this.commit(action, mutate),
       audit: (op, action, remoteId) => this.audit(op, action, remoteId),
@@ -380,11 +377,8 @@ export class Executor {
     // N6: a Google-native file is re-read and exported instead of downloaded.
     const written = remote.native
       ? await exportOver(this.host(), to, expect, remote)
-      : await this.deps.ops.exec(this.pair.account, 'idempotent', remote.id, (ctx) =>
-          downloadReplace(to, () => ctx.drive.downloadMedia(remote.id), {
-            expect,
-            expectedMd5: remote.md5,
-          }),
+      : await this.deps.remote.download(remote.id, (open) =>
+          downloadReplace(to, open, { expect, expectedMd5: remote.md5 }),
         );
     const after = await this.statFields(action.key, written.md5);
     putRecord(this.file, makeRecord(action.key, after, fromEntry(remote)));
@@ -396,15 +390,10 @@ export class Executor {
   private async downloadNew(action: Action): Promise<Partial<ActionOutcome>> {
     const remote = need(action.remote, 'remote');
     const abs = await prepareParent(this.pair.localDir, action.key);
-    const written = await this.deps.ops.exec(this.pair.account, 'idempotent', remote.id, (ctx) =>
-      placeExclusive(
-        path.dirname(abs),
-        () => path.basename(abs),
-        () => ctx.drive.downloadMedia(remote.id),
-        {
-          expectedMd5: remote.md5,
-        },
-      ),
+    const written = await this.deps.remote.download(remote.id, (open) =>
+      placeExclusive(path.dirname(abs), () => path.basename(abs), open, {
+        expectedMd5: remote.md5,
+      }),
     );
     const local = await this.statFields(action.key, written.md5);
     await this.commit(action, () =>
@@ -418,11 +407,8 @@ export class Executor {
     const local = need(action.local, 'local');
     const remote = need(action.remote, 'remote');
     const abs = absInside(this.pair.localDir, local.name);
-    const written = await this.deps.ops.exec(this.pair.account, 'idempotent', remote.id, (ctx) =>
-      downloadReplace(abs, () => ctx.drive.downloadMedia(remote.id), {
-        expect: statOf(local),
-        expectedMd5: remote.md5,
-      }),
+    const written = await this.deps.remote.download(remote.id, (open) =>
+      downloadReplace(abs, open, { expect: statOf(local), expectedMd5: remote.md5 }),
     );
     const after = await this.statFields(local.name, written.md5);
     await this.commit(action, () =>
@@ -440,16 +426,11 @@ export class Executor {
     const abs = absInside(this.pair.localDir, local.name);
     const at = this.deps.clock();
     const base = path.basename(abs);
-    const copy = await this.deps.ops.exec(this.pair.account, 'idempotent', remote.id, (ctx) =>
-      placeExclusive(
-        path.dirname(abs),
-        (i) => conflictName(base, at, i),
-        () => ctx.drive.downloadMedia(remote.id),
-        {
-          expectedMd5: remote.md5,
-          maxAttempts: MAX_CONFLICT_NAMES,
-        },
-      ),
+    const copy = await this.deps.remote.download(remote.id, (open) =>
+      placeExclusive(path.dirname(abs), (i) => conflictName(base, at, i), open, {
+        expectedMd5: remote.md5,
+        maxAttempts: MAX_CONFLICT_NAMES,
+      }),
     );
     const conflictCopy = path.relative(this.pair.localDir, copy.path).split(path.sep).join('/');
     await this.audit('sync_conflict', action, remote.id);
```

`src/sync/remote/google-remote.ts` (modify):

```diff
diff --git a/src/sync/remote/google-remote.ts b/src/sync/remote/google-remote.ts
index 792a398..1114819 100644
--- a/src/sync/remote/google-remote.ts
+++ b/src/sync/remote/google-remote.ts
@@ -137,7 +137,7 @@ export class GoogleSyncRemote implements SyncRemote {
   readonly provider = 'google';
   readonly hashKind = 'md5';
   readonly rootId = 'root';
-  private readonly nativeFiles = new WeakMap<NativeSource, DriveFile>();
+  private readonly nativeFiles = new WeakMap<NativeSource, { id: string; file: DriveFile }>();
 
   constructor(
     private readonly ops: OperationRunner,
@@ -285,7 +285,7 @@ export class GoogleSyncRemote implements SyncRemote {
       ctx.drive.getFile(id, SYNC_EXPORT_FIELDS),
     );
     const source: NativeSource = { item: this.item(file) };
-    this.nativeFiles.set(source, file);
+    this.nativeFiles.set(source, { id, file });
     return source;
   }
 
@@ -294,10 +294,10 @@ export class GoogleSyncRemote implements SyncRemote {
     plan: ExportPlan,
     consume: (open: OpenStream) => Promise<T>,
   ): Promise<T> {
-    const file = this.nativeFiles.get(source);
-    if (!file) throw new ValidationError('Internal: export source was not read by this remote');
-    return this.ops.exec(this.account, 'idempotent', source.item.id, (ctx) =>
-      consume(() => openExport(ctx.drive, file, plan, this.ops.log)),
+    const read = this.nativeFiles.get(source);
+    if (!read) throw new ValidationError('Internal: export source was not read by this remote');
+    return this.ops.exec(this.account, 'idempotent', read.id, (ctx) =>
+      consume(() => openExport(ctx.drive, read.file, plan, this.ops.log)),
     );
   }
```

`src/sync/sync-service.ts` (modify):

```diff
diff --git a/src/sync/sync-service.ts b/src/sync/sync-service.ts
index 9ff0129..ec85ecd 100644
--- a/src/sync/sync-service.ts
+++ b/src/sync/sync-service.ts
@@ -205,7 +205,6 @@ export class SyncService {
       await this.removeStaleParts(file.pair, local);
       const executor = new Executor(
         {
-          ops: this.ops,
           remote: this.env.remoteFor(file.pair),
           audit: this.deps.audit,
           logger: this.log,
```

- [ ] **Step 4: Run it and watch it pass.**

Run: `npx tsc --noEmit && npx vitest run src/sync/__tests__/executor.test.ts`

Expected: PASS (no type errors; every test in the file passes).

- [ ] **Step 5: Format and run the whole check.**

Run: `npx prettier --write src/sync/__tests__/executor.test.ts src/sync/exec-export.ts src/sync/executor.ts src/sync/remote/google-remote.ts src/sync/sync-service.ts` then `npm run check`

Expected: exit 0, `Test Files  126 passed (126); Tests  1347 passed | 6 skipped (1353)`.

- [ ] **Step 6: Commit.**

```bash
git add src/sync/__tests__/executor.test.ts src/sync/exec-export.ts src/sync/executor.ts src/sync/remote/google-remote.ts src/sync/sync-service.ts
git commit -F - <<'MSG'
refactor(sync): downloads and native exports go through SyncRemote

Downloads run placeExclusive/downloadReplace inside remote.download, so a retry
reopens the stream as before. The export re-read is readNative and the export is
exportNative. ExecutorDeps and ExportHost no longer carry the OperationRunner.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
MSG
```

### Task 10: Release re-reads the remote copy through the port

**Spec:** §2.3 `release.ts` (`verifyRemote`; `verifyLocal` and `check()` are stage 2). Commit `2ae858a` on the reference branch.

**Files:**
- Test: `src/sync/__tests__/release.test.ts`
- Modify: `src/sync/release.ts`
- Modify: `src/sync/sync-service.ts`

- [ ] **Step 1: Write the failing test (and its setup).**

`src/sync/__tests__/release.test.ts` (modify):

```diff
diff --git a/src/sync/__tests__/release.test.ts b/src/sync/__tests__/release.test.ts
index a038e63..9d21ef3 100644
--- a/src/sync/__tests__/release.test.ts
+++ b/src/sync/__tests__/release.test.ts
@@ -1,6 +1,17 @@
 import { describe, expect, it } from 'vitest';
-import { selectReleasable, type ReleaseSelection } from '../release.js';
-import { localEntry, nativeEntry, nativeRecord, record, remoteEntry } from './fixtures.js';
+import { createAudit, createFakeDrive, silentLogger } from '../../files/__tests__/fakes.js';
+import { applyRelease, selectReleasable, type ReleaseSelection } from '../release.js';
+import { binary } from './drive-tree.js';
+import { googleRemoteOver } from './fake-remote.js';
+import {
+  localEntry,
+  makePairFile,
+  nativeEntry,
+  nativeRecord,
+  record,
+  refuseTrash,
+  remoteEntry,
+} from './fixtures.js';
 import { planInput, type InputOptions } from './plan-input.js';
 
 const A = record('r1', 'a.pdf');
@@ -137,3 +148,34 @@ describe('selectReleasable (spec §10, addendum §3)', () => {
     expect(r).toEqual({ eligible: [], skipped: [] });
   });
 });
+
+describe('applyRelease re-reads R through the remote', () => {
+  it('refuses a file moved in Drive since the scan; nothing is saved or trashed', async () => {
+    const drive = createFakeDrive();
+    drive.getFile.mockResolvedValueOnce({
+      ...binary('r1', 'a.pdf', 'elsewhere'),
+      md5Checksum: RA.md5 ?? undefined,
+      modifiedTime: RA.modifiedTime,
+    });
+    const saves: unknown[] = [];
+    const file = makePairFile({}, [A]);
+    const out = await applyRelease(
+      {
+        remote: googleRemoteOver(drive),
+        audit: createAudit(),
+        logger: silentLogger(),
+        trash: refuseTrash,
+        save: async (f) => {
+          saves.push(f);
+        },
+      },
+      file,
+      [{ record: A, remote: RA, kind: 'deleted', localName: null }],
+    );
+    expect(out.failed).toEqual([
+      { path: 'a.pdf', reason: 'a.pdf changed, moved or was trashed in Drive since the scan' },
+    ]);
+    expect(saves).toEqual([]);
+    expect(drive.getFile).toHaveBeenCalledWith('r1', expect.stringContaining('md5Checksum'));
+  });
+});
```

- [ ] **Step 2: Run it and watch it fail.**

Run: `npx vitest run src/sync/__tests__/release.test.ts`

Expected: FAIL. 1 failed: `out.failed` holds `Cannot read properties of undefined (reading 'exec')` instead of the moved-in-Drive reason.

- [ ] **Step 3: Implement.**

`src/sync/release.ts` (modify):

```diff
diff --git a/src/sync/release.ts b/src/sync/release.ts
index 09cba77..c3b6c8f 100644
--- a/src/sync/release.ts
+++ b/src/sync/release.ts
@@ -1,7 +1,6 @@
 import { lstat, readdir, rmdir } from 'node:fs/promises';
 import path from 'node:path';
 import type { AuditSink } from '../audit/audit-log.js';
-import type { OperationRunner } from '../core/operation.js';
 import { AppError, hasErrorCode } from '../errors.js';
 import type { Logger } from '../logger.js';
 import { localMatchesRemote, remoteChanged, remoteUnchangedSince } from './content-compare.js';
@@ -9,7 +8,7 @@ import { isAbortError, messageOf, PersistenceError, TargetChangedError } from '.
 import { md5File } from './local-scanner.js';
 import { absInside, baseName, foldKey, parentKey, toKey, validateRelPath } from './paths.js';
 import { TYPE_CHANGED } from './plan-tracked.js';
-import { toRemoteItem } from './remote/google-remote.js';
+import type { SyncRemote } from './remote/sync-remote.js';
 import {
   buildContext,
   isUnknownKey,
@@ -20,13 +19,7 @@ import {
   type PlanInput,
 } from './resolve.js';
 import type { LocalTrash } from './trash.js';
-import {
-  SYNC_FILE_FIELDS,
-  type Pair,
-  type PairFile,
-  type RemoteEntry,
-  type SyncRecord,
-} from './types.js';
+import type { Pair, PairFile, RemoteEntry, SyncRecord } from './types.js';
 
 export type ReleaseStatus =
   | 'released'
@@ -163,7 +156,8 @@ export async function withoutTrash(
 }
 
 export interface ReleaseDeps {
-  ops: OperationRunner;
+  /** The pair's remote. */
+  remote: SyncRemote;
   audit: AuditSink;
   logger: Logger;
   trash: LocalTrash;
@@ -174,11 +168,8 @@ export interface ReleaseDeps {
 const KEEP_DIR = ['ENOTEMPTY', 'EEXIST', 'ENOENT', 'ENOTDIR'];
 
 /** R must still be present-same: not trashed, content unchanged, same name and parent. */
-async function verifyRemote(deps: ReleaseDeps, pair: Pair, planned: RemoteEntry): Promise<void> {
-  const file = await deps.ops.exec(pair.account, 'idempotent', planned.id, (ctx) =>
-    ctx.drive.getFile(planned.id, SYNC_FILE_FIELDS),
-  );
-  const current = toRemoteItem(file, pair.googleExport);
+async function verifyRemote(deps: ReleaseDeps, planned: RemoteEntry): Promise<void> {
+  const current = await deps.remote.read(planned.id);
   if (
     current.trashed ||
     !remoteUnchangedSince(planned, current) ||
@@ -285,7 +276,7 @@ export async function applyRelease(
     let name: string | null = null;
     let abs = '';
     try {
-      await verifyRemote(deps, pair, c.remote);
+      await verifyRemote(deps, c.remote);
       if (c.kind === 'present') {
         name = c.localName ?? key;
         abs = absInside(pair.localDir, name);
```

`src/sync/sync-service.ts` (modify):

```diff
diff --git a/src/sync/sync-service.ts b/src/sync/sync-service.ts
index ec85ecd..cf3e0a0 100644
--- a/src/sync/sync-service.ts
+++ b/src/sync/sync-service.ts
@@ -278,7 +278,7 @@ export class SyncService {
       }
       const done = await applyRelease(
         {
-          ops: this.ops,
+          remote: this.env.remoteFor(file.pair),
           audit: this.deps.audit,
           logger: this.log,
           trash: this.deps.trash,
```

- [ ] **Step 4: Run it and watch it pass.**

Run: `npx vitest run src/sync/__tests__/release.test.ts`

Expected: PASS (no type errors; every test in the file passes).

- [ ] **Step 5: Format and run the whole check.**

Run: `npx prettier --write src/sync/__tests__/release.test.ts src/sync/release.ts src/sync/sync-service.ts` then `npm run check`

Expected: exit 0, `Test Files  126 passed (126); Tests  1348 passed | 6 skipped (1354)`.

- [ ] **Step 6: Commit.**

```bash
git add src/sync/__tests__/release.test.ts src/sync/release.ts src/sync/sync-service.ts
git commit -F - <<'MSG'
refactor(sync): release re-reads the remote copy through SyncRemote

ReleaseDeps carries the pair's remote instead of the OperationRunner; verifyRemote
reads the RemoteItem (name, first parent, trashed, content) as before.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
MSG
```

### Task 11: Pair roots: remoteRootProblem, checkRoots and createPair

**Spec:** §2.3 `pair-admin.ts` (`remoteRootProblem`, folder creation), §4.4 (`kind`, `canAddChildren`, `trashed`). Commit `8914c45` on the reference branch.

**Files:**
- Test (create): `src/sync/__tests__/pair-admin.test.ts`
- Modify: `src/sync/pair-admin.ts`
- Modify: `src/sync/sync-service.ts`

- [ ] **Step 1: Write the failing test (and its setup).**

`src/sync/__tests__/pair-admin.test.ts` (create):

```ts
import { describe, expect, it } from 'vitest';
import { GOOGLE_MIME } from '../../files/export-formats.js';
import { remoteRootProblem } from '../pair-admin.js';
import { toRemoteItem } from '../remote/google-remote.js';
import type { RemoteItem } from '../remote/sync-remote.js';
import { DEFAULT_GOOGLE_EXPORT } from '../types.js';
import { binary, folder } from './drive-tree.js';

const root = (overrides: Partial<RemoteItem> = {}): RemoteItem => ({
  ...toRemoteItem(folder('R', 'Sync', 'my-drive'), DEFAULT_GOOGLE_EXPORT),
  ...overrides,
});

describe('remoteRootProblem on a RemoteItem', () => {
  it('accepts a writable folder, also when Drive omits canAddChildren', () => {
    expect(remoteRootProblem(root())).toBeNull();
    expect(
      remoteRootProblem(
        toRemoteItem({ id: 'R', mimeType: GOOGLE_MIME.folder }, DEFAULT_GOOGLE_EXPORT),
      ),
    ).toBeNull();
  });
  it('names what is wrong', () => {
    expect(remoteRootProblem(toRemoteItem(binary('f', 'a.pdf', 'P'), DEFAULT_GOOGLE_EXPORT))).toBe(
      'is not a folder',
    );
    expect(remoteRootProblem(root({ trashed: true }))).toBe('is in the Drive trash');
    expect(remoteRootProblem(root({ canAddChildren: false }))).toBe('does not allow adding files');
  });
});
```

- [ ] **Step 2: Run it and watch it fail.**

Run: `npx vitest run src/sync/__tests__/pair-admin.test.ts`

Expected: FAIL. 1 failed, `AssertionError: expected null to be 'does not allow adding files'`.

- [ ] **Step 3: Implement.**

`src/sync/pair-admin.ts` (modify):

```diff
diff --git a/src/sync/pair-admin.ts b/src/sync/pair-admin.ts
index 8039d10..1d59b20 100644
--- a/src/sync/pair-admin.ts
+++ b/src/sync/pair-admin.ts
@@ -3,11 +3,8 @@ import { constants } from 'node:fs';
 import { access, realpath, stat } from 'node:fs/promises';
 import path from 'node:path';
 import type { AuditSink } from '../audit/audit-log.js';
-import type { OperationRunner } from '../core/operation.js';
-import type { DriveFile } from '../drive/drive-adapter.js';
 import { NotFoundError, ValidationError } from '../errors.js';
 import { expandHome } from '../files/destination.js';
-import { GOOGLE_MIME } from '../files/export-formats.js';
 import type { Logger } from '../logger.js';
 import { SyncRootError } from './errors.js';
 import {
@@ -19,18 +16,11 @@ import {
   type PairStore,
 } from './pair-store.js';
 import { validateGoogleExport } from './remote/google-remote.js';
-import type { SyncRemote } from './remote/sync-remote.js';
-import {
-  PAIR_NAME,
-  SYNC_FILE_FIELDS,
-  type GoogleExportPrefs,
-  type Pair,
-  type PairFile,
-} from './types.js';
+import type { RemoteItem, SyncRemote } from './remote/sync-remote.js';
+import { PAIR_NAME, type GoogleExportPrefs, type Pair, type PairFile } from './types.js';
 
 /** What the split service modules share (one per SyncService). */
 export interface SyncEnv {
-  ops: OperationRunner;
   audit: AuditSink;
   log: Logger;
   clock: () => Date;
@@ -90,11 +80,11 @@ export function summarize(file: PairFile): PairSummary {
   };
 }
 
-/** Why a Drive folder cannot be a pair root, or null (spec §5 step 2). */
-export function remoteRootProblem(file: DriveFile): string | null {
-  if (file.mimeType !== GOOGLE_MIME.folder) return 'is not a folder';
-  if (file.trashed) return 'is in the Drive trash';
-  if (file.capabilities?.canAddChildren === false) return 'does not allow adding files';
+/** Why a remote folder cannot be a pair root, or null (spec §5 step 2). */
+export function remoteRootProblem(item: RemoteItem): string | null {
+  if (item.kind !== 'folder') return 'is not a folder';
+  if (item.trashed) return 'is in the Drive trash';
+  if (!item.canAddChildren) return 'does not allow adding files';
   return null;
 }
 
@@ -134,7 +124,7 @@ export async function createPair(env: SyncEnv, input: CreatePairInput): Promise<
     await writeMarker(localDir, input.name, id);
     let remote: { folderId: string; alias: string };
     try {
-      remote = await resolveRemoteRoot(env, input);
+      remote = await resolveRemoteRoot(env, input, googleExport);
       checkOverlap(existing, { name: input.name, localDir, remoteFolderId: remote.folderId });
     } catch (err) {
       await removeMarker(localDir, input.name);
@@ -163,32 +153,34 @@ export async function createPair(env: SyncEnv, input: CreatePairInput): Promise<
   });
 }
 
-function resolveRemoteRoot(
+async function resolveRemoteRoot(
   env: SyncEnv,
   input: CreatePairInput,
+  googleExport: GoogleExportPrefs,
 ): Promise<{ folderId: string; alias: string }> {
+  const remote = await env.openRemote(input.account, googleExport);
   const folderId = input.remoteFolderId;
   if (folderId) {
-    return env.ops.exec(input.account, 'idempotent', folderId, async (ctx) => {
-      const root = await ctx.drive.getFile(folderId, SYNC_FILE_FIELDS);
-      const problem = remoteRootProblem(root);
-      if (problem) throw new ValidationError(`Drive folder ${folderId} ${problem}`);
-      return { folderId, alias: ctx.account.alias };
-    });
+    const root = await remote.read(folderId);
+    const problem = remoteRootProblem(root);
+    if (problem) throw new ValidationError(`Drive folder ${folderId} ${problem}`);
+    return { folderId, alias: remote.account };
   }
-  const parentId = input.remoteParentId ?? 'root';
-  return env.ops.exec(input.account, 'create', input.remoteParentId, async (ctx) => {
-    const folder = await ctx.drive.createFile({
-      requestBody: {
-        name: input.remoteFolderName ?? '',
-        mimeType: GOOGLE_MIME.folder,
-        parents: [parentId],
-      },
-      fields: 'id, name',
+  const parentId = input.remoteParentId ?? remote.rootId;
+  const folder = await remote.createFolder(parentId, input.remoteFolderName ?? '');
+  const details = { parentId, pair: input.name };
+  try {
+    await env.audit.record({
+      account: remote.account,
+      op: 'create_folder',
+      fileId: folder.id,
+      ...(folder.name ? { name: folder.name } : {}),
+      details,
     });
-    await env.ops.audit(ctx, 'create_folder', folder, { parentId, pair: input.name });
-    return { folderId: folder.id ?? '', alias: ctx.account.alias };
-  });
+  } catch (err) {
+    env.log.warn('Audit log write failed', { op: 'create_folder', fileId: folder.id, error: err });
+  }
+  return { folderId: folder.id, alias: remote.account };
 }
 
 export async function listPairs(env: SyncEnv): Promise<PairSummary[]> {
@@ -260,11 +252,9 @@ export async function checkRoots(env: SyncEnv, pair: Pair): Promise<void> {
   if ((await probeCaseInsensitive(pair.localDir, pair.name)) !== pair.caseInsensitive) {
     throw new SyncRootError(`Case sensitivity of ${pair.localDir} changed; ${hint}`);
   }
-  let root: DriveFile;
+  let root: RemoteItem;
   try {
-    root = await env.ops.exec(pair.account, 'idempotent', pair.remoteFolderId, (ctx) =>
-      ctx.drive.getFile(pair.remoteFolderId, SYNC_FILE_FIELDS),
-    );
+    root = await env.remoteFor(pair).read(pair.remoteFolderId);
   } catch (err) {
     if (err instanceof NotFoundError) {
       throw new SyncRootError(`The Drive folder ${pair.remoteFolderId} no longer exists`, {
```

`src/sync/sync-service.ts` (modify):

```diff
diff --git a/src/sync/sync-service.ts b/src/sync/sync-service.ts
index cf3e0a0..d7f2a52 100644
--- a/src/sync/sync-service.ts
+++ b/src/sync/sync-service.ts
@@ -89,7 +89,6 @@ export class SyncService {
     this.log = deps.logger ?? defaultLogger;
     this.clock = deps.clock ?? ((): Date => new Date());
     this.env = {
-      ops: this.ops,
       audit: deps.audit,
       log: this.log,
       clock: this.clock,
```

- [ ] **Step 4: Run it and watch it pass.**

Run: `npx vitest run src/sync/__tests__/pair-admin.test.ts`

Expected: PASS (no type errors; every test in the file passes).

- [ ] **Step 5: Format and run the whole check.**

Run: `npx prettier --write src/sync/__tests__/pair-admin.test.ts src/sync/pair-admin.ts src/sync/sync-service.ts` then `npm run check`

Expected: exit 0, `Test Files  127 passed (127); Tests  1350 passed | 6 skipped (1356)`.

- [ ] **Step 6: Commit.**

```bash
git add src/sync/__tests__/pair-admin.test.ts src/sync/pair-admin.ts src/sync/sync-service.ts
git commit -F - <<'MSG'
refactor(sync): pair roots are checked and created through SyncRemote

remoteRootProblem reads a RemoteItem; checkRoots uses remoteFor(pair).read and
sync_create_pair uses openRemote, read or createFolder, and records the
create_folder audit entry itself. SyncEnv no longer carries the OperationRunner.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
MSG
```

### Task 12: Boundary test: no Drive shapes outside src/sync/remote/

**Spec:** §2 ("All of that moves behind one port"), §8 item 1. Commit `bb95108` on the reference branch.

**Files:**
- Test: `src/sync/__tests__/no-googleapis.test.ts`
- Modify: `src/sync/types.ts`

- [ ] **Step 1: Write the failing test (and its setup).**

`src/sync/__tests__/no-googleapis.test.ts` (modify):

```diff
diff --git a/src/sync/__tests__/no-googleapis.test.ts b/src/sync/__tests__/no-googleapis.test.ts
index b1499f8..fb073a9 100644
--- a/src/sync/__tests__/no-googleapis.test.ts
+++ b/src/sync/__tests__/no-googleapis.test.ts
@@ -32,3 +32,34 @@ describe('provider boundary (addendum §4.4)', () => {
     expect(offenders).toEqual([]);
   });
 });
+
+/** Drive shapes the engine must leave to src/sync/remote/ (OneDrive sync spec §2). */
+const DRIVE_ONLY = [
+  /drive\/drive-adapter\.js/,
+  /files\/query\.js/,
+  /files\/export-stream\.js/,
+  /\bGOOGLE_MIME\b/,
+  /\bisGoogleNative\b/,
+  /\bresolveExport\b/,
+  /\bctx\.drive\b/,
+  /\bmd5Checksum\b/,
+  /\bin parents\b/,
+];
+
+describe('SyncRemote boundary (OneDrive sync spec §2.3)', () => {
+  it('no sync engine file outside src/sync/remote/ touches Drive shapes or queries', async () => {
+    const files = (await readdir(SYNC_DIR, { recursive: true })).filter(
+      (f) =>
+        f.endsWith('.ts') &&
+        !f.split(path.sep).includes('__tests__') &&
+        !f.startsWith(`remote${path.sep}`),
+    );
+    expect(files.length).toBeGreaterThan(20);
+    const offenders: string[] = [];
+    for (const f of files) {
+      const text = await readFile(path.join(SYNC_DIR, f), 'utf8');
+      for (const pattern of DRIVE_ONLY) if (pattern.test(text)) offenders.push(`${f}: ${pattern}`);
+    }
+    expect(offenders).toEqual([]);
+  });
+});
```

- [ ] **Step 2: Run it and watch it fail.**

Run: `npx vitest run src/sync/__tests__/no-googleapis.test.ts`

Expected: FAIL. 1 failed, `expected [ 'types.ts: /\bmd5Checksum\b/' ] to deeply equal []`.

- [ ] **Step 3: Implement.**

`src/sync/types.ts` (modify):

```diff
diff --git a/src/sync/types.ts b/src/sync/types.ts
index aaddb83..e9c5a5b 100644
--- a/src/sync/types.ts
+++ b/src/sync/types.ts
@@ -4,10 +4,6 @@ import type { RemoteUnsupported } from './remote/sync-remote.js';
 /** Pair names: lower-case letters, digits and dashes (spec §3). */
 export const PAIR_NAME = /^[a-z0-9-]{1,40}$/;
 
-/** Drive fields every sync read requests (spec §4). */
-export const SYNC_FILE_FIELDS =
-  'id, name, mimeType, md5Checksum, size, modifiedTime, createdTime, parents, trashed, capabilities(canEdit, canTrash, canAddChildren)';
-
 export interface GoogleExportPrefs {
   document: ExportFormat;
   spreadsheet: ExportFormat;
```

- [ ] **Step 4: Run it and watch it pass.**

Run: `npx vitest run src/sync/__tests__/no-googleapis.test.ts`

Expected: PASS (no type errors; every test in the file passes).

- [ ] **Step 5: Format and run the whole check.**

Run: `npx prettier --write src/sync/__tests__/no-googleapis.test.ts src/sync/types.ts` then `npm run check`

Expected: exit 0, `Test Files  127 passed (127); Tests  1351 passed | 6 skipped (1357)`.

- [ ] **Step 6: Commit.**

```bash
git add src/sync/__tests__/no-googleapis.test.ts src/sync/types.ts
git commit -F - <<'MSG'
test(sync): pin the SyncRemote boundary

No sync engine file outside src/sync/remote/ imports the Drive adapter, builds a
Drive query or reads Drive shapes. The last Drive field list leaves types.ts.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
MSG
```

### End of Chunk 1

- [x] Google live sync E2E (spec §8 item 1): passed on `88519d2` (run by the coordinator).

## Chunk 2: Hashes and pair file v2

Spec §8 item 2 (§3.1–§3.3, §4.5), still Google only, plus the review fixes for Chunk 1 (Tasks 20–22, committed after the stage-2 work). Starting point: Chunk 1 done, **1351 passed, 6 skipped (1357)**, 127 files, at `88519d2`; the Google live sync E2E passed on that commit.

Decisions (keep consistent):

1. `LocalDigests.remote` is `ContentHash | null`; null means "not computed" (a stat-unchanged tracked file on a remote whose kind is not md5, when `hashTargets` did not ask for it). `sameContent` returns null for it, so such a file is never adopted or released by content.
2. Digesters are injectable (`DigesterFactory`; `SyncServiceDeps.digesters` → `SyncEnv.digesters` → executor, release, `hashLocal`, `writeTemp`). The default knows md5 only and throws `No <kind> digest is available in this build`; Chunk 3 adds quickXor to the default.
3. On Google, `remote` is always `{ kind: 'md5', value: md5 }`, so plans and actions are unchanged. The only Google-visible changes are the ones the spec asks for: the planId hashes `md5:<value>` (a planId from an older binary no longer matches), a changed-during-upload record keeps the local md5, the duplicate-upload check also requires the size, and downloads fail on a size mismatch.
4. `Action.localDigests` is optional; the executor falls back to the md5 (`plannedDigests`) for actions built without it (tests).
5. The pair file schema reads version 1 through a separate schema and maps `remoteMd5`; `remoteCursor`/`remoteDeletedIds` default to null/[] for version 1. A version above 2 is refused before parsing.
6. Tests keep `md5`/`remoteMd5` shorthands in `fixtures.ts` (`remoteEntry`, `record`) and `md5s` in `plan-input.ts`; new helpers `md5Hash` (fixtures) and `md5Digests` (plan-input).

### Task 13: ContentHash replaces md5 in entries, records and the pair file (v2)

**Spec:** §3.2 last bullet (`remoteHash`, `RemoteEntry.hash`, planId `kind:value`), §4.5 (version 2, v1 migration). Commit `1a8e166` on the reference branch.

**Files:**
- Test: `src/sync/__tests__/content-compare.test.ts`
- Test: `src/sync/__tests__/exec-records.test.ts`
- Test: `src/sync/__tests__/executor.test.ts`
- Test: `src/sync/__tests__/fixtures.ts`
- Test: `src/sync/__tests__/pair-store.test.ts`
- Test: `src/sync/__tests__/plan-remote-only.test.ts`
- Test: `src/sync/__tests__/plan-tracked.test.ts`
- Test: `src/sync/__tests__/release.test.ts`
- Test: `src/sync/__tests__/remote-probe.test.ts`
- Test: `src/sync/__tests__/remote-scanner.test.ts`
- Test: `src/sync/__tests__/sync-service.pairs.test.ts`
- Modify: `src/sync/content-compare.ts`
- Modify: `src/sync/exec-records.ts`
- Modify: `src/sync/executor.ts`
- Modify: `src/sync/pair-admin.ts`
- Modify: `src/sync/pair-store.ts`
- Modify: `src/sync/plan-remote-only.ts`
- Modify: `src/sync/plan-shared.ts`
- Modify: `src/sync/plan-tracked.ts`
- Modify: `src/sync/planner.ts`
- Modify: `src/sync/remote-scanner.ts`
- Modify: `src/sync/types.ts`

- [ ] **Step 1: Write the failing test (and its setup).**

`src/sync/__tests__/content-compare.test.ts` (modify):

```diff
diff --git a/src/sync/__tests__/content-compare.test.ts b/src/sync/__tests__/content-compare.test.ts
index 7a2e06f..8dde3b0 100644
--- a/src/sync/__tests__/content-compare.test.ts
+++ b/src/sync/__tests__/content-compare.test.ts
@@ -40,7 +40,7 @@ describe('remoteChanged', () => {
 describe('remoteUnchangedSince', () => {
   it('binary needs md5 and modifiedTime equal', () => {
     const r = remoteEntry('r1', 'a.pdf');
-    const md5Checksum = r.md5 ?? undefined;
+    const md5Checksum = r.hash?.value;
     expect(remoteUnchangedSince(r, item({ md5Checksum, modifiedTime: r.modifiedTime }))).toBe(true);
     expect(remoteUnchangedSince(r, item({ md5Checksum: 'x', modifiedTime: r.modifiedTime }))).toBe(
       false,
@@ -58,7 +58,7 @@ describe('localMatchesRemote', () => {
     const r = remoteEntry('r1', 'a.pdf');
     expect(localMatchesRemote('md5-r1', null, r)).toBe(true);
     expect(localMatchesRemote('other', null, r)).toBe(false);
-    expect(localMatchesRemote('md5-r1', null, { ...r, md5: null })).toBe(false);
+    expect(localMatchesRemote('md5-r1', null, { ...r, hash: null })).toBe(false);
   });
   it('native: local md5 = md5 of the last export (record required)', () => {
     const k = nativeRecord('g1', 'Plan.docx', { localMd5: 'export-md5' });
```

`src/sync/__tests__/exec-records.test.ts` (modify):

```diff
diff --git a/src/sync/__tests__/exec-records.test.ts b/src/sync/__tests__/exec-records.test.ts
index ffb3500..c1ddcd4 100644
--- a/src/sync/__tests__/exec-records.test.ts
+++ b/src/sync/__tests__/exec-records.test.ts
@@ -5,13 +5,13 @@ import { DEFAULT_GOOGLE_EXPORT } from '../types.js';
 import { binary } from './drive-tree.js';
 
 describe('fromRemote', () => {
-  it('takes the uploaded file fields, md5 and first parent', () => {
+  it('takes the uploaded file fields, hash and first parent', () => {
     const item = toRemoteItem(binary('n1', 'a.pdf', 'P'), DEFAULT_GOOGLE_EXPORT);
     expect(fromRemote(item, 'fallback')).toEqual({
       id: 'n1',
       name: 'a.pdf',
       parentId: 'P',
-      md5: 'md5-n1',
+      hash: { kind: 'md5', value: 'md5-n1' },
       size: 10,
       modifiedTime: '2026-11-02T00:00:00.000Z',
       native: null,
@@ -19,6 +19,6 @@ describe('fromRemote', () => {
   });
   it('falls back to the upload parent when Drive returns no parents', () => {
     const item = toRemoteItem({ id: 'n1' }, DEFAULT_GOOGLE_EXPORT);
-    expect(fromRemote(item, 'P')).toMatchObject({ parentId: 'P', md5: null, size: null });
+    expect(fromRemote(item, 'P')).toMatchObject({ parentId: 'P', hash: null, size: null });
   });
 });
```

`src/sync/__tests__/executor.test.ts` (modify):

```diff
diff --git a/src/sync/__tests__/executor.test.ts b/src/sync/__tests__/executor.test.ts
index 02a2608..570b5f4 100644
--- a/src/sync/__tests__/executor.test.ts
+++ b/src/sync/__tests__/executor.test.ts
@@ -239,7 +239,7 @@ describe('Executor', () => {
     expect(out[0]?.warning).toBe('changed-during-upload');
     expect(file.records[0]).toMatchObject({
       localMd5: 'other',
-      remoteMd5: 'other',
+      remoteHash: { kind: 'md5', value: 'other' },
       localSize: l.size,
     });
   });
@@ -287,7 +287,7 @@ describe('Executor', () => {
     const r = remote('r1', 'a.pdf', 'R');
     drive.getFile.mockResolvedValueOnce({
       id: 'r1',
-      md5Checksum: r.md5,
+      md5Checksum: r.hash?.value,
       modifiedTime: r.modifiedTime,
     });
     drive.updateFile.mockResolvedValueOnce({
@@ -308,7 +308,7 @@ describe('Executor', () => {
     expect(drive.updateFile.mock.calls[0]?.[0]).toMatchObject({ fileId: 'r1' });
     expect(file.records[0]).toMatchObject({
       localMd5: md5('local edit'),
-      remoteMd5: md5('local edit'),
+      remoteHash: { kind: 'md5', value: md5('local edit') },
       remoteModifiedTime: 'new',
     });
   });
@@ -369,11 +369,11 @@ describe('Executor', () => {
     expect(file.records[0]).toMatchObject({
       path: 'sub/b.pdf',
       localMd5: md5('new'),
-      remoteMd5: md5('new'),
+      remoteHash: { kind: 'md5', value: md5('new') },
       remoteParentId: 'F',
     });
     expect(saves).toHaveLength(2);
-    expect(saves[0]?.records[0]).toMatchObject({ path: 'sub/b.pdf', remoteMd5: k.remoteMd5 });
+    expect(saves[0]?.records[0]).toMatchObject({ path: 'sub/b.pdf', remoteHash: k.remoteHash });
   });
 
   it('places the conflict copy before uploading L (spec §6.9)', async () => {
@@ -382,7 +382,7 @@ describe('Executor', () => {
     serve('remote edit');
     drive.getFile.mockResolvedValueOnce({
       id: 'r1',
-      md5Checksum: r.md5,
+      md5Checksum: r.hash?.value,
       modifiedTime: r.modifiedTime,
     });
     drive.updateFile.mockResolvedValueOnce({
@@ -410,7 +410,7 @@ describe('Executor', () => {
     );
     expect(file.records[0]).toMatchObject({
       localMd5: md5('local edit'),
-      remoteMd5: md5('local edit'),
+      remoteHash: { kind: 'md5', value: md5('local edit') },
     });
     expect(file.pair.selection).toEqual(['a.pdf']);
   });
@@ -573,7 +573,7 @@ describe('Executor (review regressions)', () => {
     const k = record('r1', 'a.pdf');
     drive.getFile.mockResolvedValueOnce({
       id: 'r1',
-      md5Checksum: r.md5,
+      md5Checksum: r.hash?.value,
       modifiedTime: '2026-11-03T09:00:00.000Z',
       parents: [ROOT_ID],
     });
@@ -589,7 +589,7 @@ describe('Executor (review regressions)', () => {
     const r = remote('r2', 'moved.pdf', 'M');
     drive.getFile.mockResolvedValueOnce({
       id: 'r2',
-      md5Checksum: r.md5,
+      md5Checksum: r.hash?.value,
       modifiedTime: r.modifiedTime,
       parents: ['ELSEWHERE'],
     });
@@ -684,7 +684,7 @@ describe('Executor exports (Google-native)', () => {
         path: 'Plan.docx',
         remoteName: 'Plan',
         localMd5: md5('DOCX v1'),
-        remoteMd5: null,
+        remoteHash: null,
         native: { mimeType: GOOGLE_MIME.document, exportFormat: 'docx' },
       },
     ]);
```

`src/sync/__tests__/fixtures.ts` (modify):

```diff
diff --git a/src/sync/__tests__/fixtures.ts b/src/sync/__tests__/fixtures.ts
index aed1fa7..1836b4a 100644
--- a/src/sync/__tests__/fixtures.ts
+++ b/src/sync/__tests__/fixtures.ts
@@ -5,6 +5,17 @@ import type { LocalTrash } from '../trash.js';
 import type { LocalEntry, Pair, PairFile, RemoteEntry, SyncRecord } from '../types.js';
 import { DEFAULT_GOOGLE_EXPORT } from '../types.js';
 import { foldKey } from '../paths.js';
+import type { ContentHash } from '../remote/sync-remote.js';
+
+/** An md5 ContentHash (null stays null). */
+export function md5Hash(value: string | null): ContentHash | null {
+  return value === null ? null : { kind: 'md5', value };
+}
+
+/** Test shorthand: `md5` sets an md5 `hash`. */
+export type RemoteEntryOverrides = Partial<RemoteEntry> & { md5?: string | null };
+/** Test shorthand: `remoteMd5` sets an md5 `remoteHash`. */
+export type RecordOverrides = Partial<SyncRecord> & { remoteMd5?: string | null };
 
 /** LocalTrash for tests that must never trash anything. */
 export const refuseTrash: LocalTrash = {
@@ -46,7 +57,7 @@ export function makePair(overrides: Partial<Pair> = {}): Pair {
 }
 
 export function makePairFile(pair: Partial<Pair> = {}, records: SyncRecord[] = []): PairFile {
-  return { version: 1, pair: makePair(pair), records };
+  return { version: 2, pair: makePair(pair), records };
 }
 
 export function localEntry(name: string, overrides: Partial<LocalEntry> = {}): LocalEntry {
@@ -66,10 +77,11 @@ export function localEntry(name: string, overrides: Partial<LocalEntry> = {}): L
 export function remoteEntry(
   id: string,
   key: string,
-  overrides: Partial<RemoteEntry> = {},
+  overrides: RemoteEntryOverrides = {},
 ): RemoteEntry {
   const nfc = key.normalize('NFC');
   const slash = nfc.lastIndexOf('/');
+  const { md5, ...rest } = overrides;
   return {
     id,
     key: nfc,
@@ -78,25 +90,22 @@ export function remoteEntry(
     parentId: slash === -1 ? ROOT_ID : `folder:${nfc.slice(0, slash)}`,
     ancestorIds: slash === -1 ? [ROOT_ID] : [`folder:${nfc.slice(0, slash)}`, ROOT_ID],
     mimeType: 'application/pdf',
-    md5: `md5-${id}`,
+    hash: md5Hash(md5 === undefined ? `md5-${id}` : md5),
     size: 10,
     modifiedTime: '2026-11-02T00:00:00.000Z',
     createdTime: '2026-11-01T00:00:00.000Z',
     canEdit: true,
     canTrash: true,
     native: null,
-    ...overrides,
+    ...rest,
   };
 }
 
 /** A record in sync with `localEntry(key)` and `remoteEntry(remoteId, key)`. */
-export function record(
-  remoteId: string,
-  key: string,
-  overrides: Partial<SyncRecord> = {},
-): SyncRecord {
+export function record(remoteId: string, key: string, overrides: RecordOverrides = {}): SyncRecord {
   const nfc = key.normalize('NFC');
   const slash = nfc.lastIndexOf('/');
+  const { remoteMd5, ...rest } = overrides;
   return {
     remoteId,
     path: nfc,
@@ -107,14 +116,14 @@ export function record(
     localSize: 10,
     localMtimeMs: 1000,
     localCtimeMs: 1000,
-    remoteMd5: `md5-${remoteId}`,
+    remoteHash: md5Hash(remoteMd5 === undefined ? `md5-${remoteId}` : remoteMd5),
     remoteSize: 10,
     remoteModifiedTime: '2026-11-02T00:00:00.000Z',
     native: null,
     remoteOnly: false,
     restorePending: false,
     remoteTrashed: false,
-    ...overrides,
+    ...rest,
   };
 }
 
@@ -124,7 +133,7 @@ export const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordproc
 export function nativeEntry(
   id: string,
   key: string,
-  overrides: Partial<RemoteEntry> = {},
+  overrides: RemoteEntryOverrides = {},
 ): RemoteEntry {
   const base = key.slice(key.lastIndexOf('/') + 1);
   return remoteEntry(id, key, {
@@ -141,7 +150,7 @@ export function nativeEntry(
 export function nativeRecord(
   remoteId: string,
   key: string,
-  overrides: Partial<SyncRecord> = {},
+  overrides: RecordOverrides = {},
 ): SyncRecord {
   const base = key.slice(key.lastIndexOf('/') + 1);
   return record(remoteId, key, {
```

`src/sync/__tests__/pair-store.test.ts` (modify):

```diff
diff --git a/src/sync/__tests__/pair-store.test.ts b/src/sync/__tests__/pair-store.test.ts
index 2a11df8..ffe4426 100644
--- a/src/sync/__tests__/pair-store.test.ts
+++ b/src/sync/__tests__/pair-store.test.ts
@@ -52,6 +52,32 @@ describe('PairStore', () => {
     expect((await store().load('docs')).pair.nativeBaselineDone).toBe(false);
   });
 
+  it('loads a version-1 file (remoteMd5) as version 2 and saves it as version 2', async () => {
+    const file = makePairFile({}, [record('r1', 'a.pdf'), record('r2', 'b.pdf')]);
+    const v1 = {
+      ...file,
+      version: 1,
+      records: file.records.map(({ remoteHash, ...r }, i) => ({
+        ...r,
+        remoteMd5: i === 0 ? (remoteHash?.value ?? null) : null,
+      })),
+    };
+    await mkdir(dir, { recursive: true });
+    await writeFile(path.join(dir, 'docs.json'), JSON.stringify(v1));
+    const s = store();
+    const loaded = await s.load('docs');
+    expect(loaded.version).toBe(2);
+    expect(loaded.records.map((r) => r.remoteHash)).toEqual([
+      { kind: 'md5', value: 'md5-r1' },
+      null,
+    ]);
+    expect(loaded.records[0]).not.toHaveProperty('remoteMd5');
+    await s.save(loaded);
+    const saved = JSON.parse(await readFile(path.join(dir, 'docs.json'), 'utf8'));
+    expect(saved.version).toBe(2);
+    expect(saved.records[0].remoteHash).toEqual({ kind: 'md5', value: 'md5-r1' });
+  });
+
   it('tightens an existing sync dir to 0700', async () => {
     await mkdir(dir, { recursive: true });
     await chmod(dir, 0o755);
```

`src/sync/__tests__/plan-remote-only.test.ts` (modify):

```diff
diff --git a/src/sync/__tests__/plan-remote-only.test.ts b/src/sync/__tests__/plan-remote-only.test.ts
index d3e8e46..150faab 100644
--- a/src/sync/__tests__/plan-remote-only.test.ts
+++ b/src/sync/__tests__/plan-remote-only.test.ts
@@ -66,7 +66,11 @@ describe('remote-only records (spec §6.7)', () => {
     expect(
       run({ remote: [remoteEntry('r1', 'a.pdf', { md5: 'new', modifiedTime: NEWER })] }).actions,
     ).toMatchObject([
-      { kind: 'refresh', rule: 'O3', patch: { remoteMd5: 'new', remoteModifiedTime: NEWER } },
+      {
+        kind: 'refresh',
+        rule: 'O3',
+        patch: { remoteHash: { kind: 'md5', value: 'new' }, remoteModifiedTime: NEWER },
+      },
     ]);
   });
   it('a released Google Doc modified in Drive is never exported', () => {
```

`src/sync/__tests__/plan-tracked.test.ts` (modify):

```diff
diff --git a/src/sync/__tests__/plan-tracked.test.ts b/src/sync/__tests__/plan-tracked.test.ts
index 34550a8..c980e49 100644
--- a/src/sync/__tests__/plan-tracked.test.ts
+++ b/src/sync/__tests__/plan-tracked.test.ts
@@ -276,7 +276,7 @@ describe('binary tracked records (spec §6.4)', () => {
   it('warns weak-compare when Drive has no md5', () => {
     const result = run(
       { local: [L], remote: [remoteEntry('r1', 'a.pdf', { md5: null })] },
-      { ...K, remoteMd5: null },
+      { ...K, remoteHash: null },
     );
     expect(result.notes.map((n) => n.code)).toEqual(['weak-compare']);
   });
```

`src/sync/__tests__/release.test.ts` (modify):

```diff
diff --git a/src/sync/__tests__/release.test.ts b/src/sync/__tests__/release.test.ts
index 9d21ef3..d01dd9e 100644
--- a/src/sync/__tests__/release.test.ts
+++ b/src/sync/__tests__/release.test.ts
@@ -154,7 +154,7 @@ describe('applyRelease re-reads R through the remote', () => {
     const drive = createFakeDrive();
     drive.getFile.mockResolvedValueOnce({
       ...binary('r1', 'a.pdf', 'elsewhere'),
-      md5Checksum: RA.md5 ?? undefined,
+      md5Checksum: RA.hash?.value,
       modifiedTime: RA.modifiedTime,
     });
     const saves: unknown[] = [];
```

`src/sync/__tests__/remote-probe.test.ts` (modify):

```diff
diff --git a/src/sync/__tests__/remote-probe.test.ts b/src/sync/__tests__/remote-probe.test.ts
index e483c7e..cab9c45 100644
--- a/src/sync/__tests__/remote-probe.test.ts
+++ b/src/sync/__tests__/remote-probe.test.ts
@@ -68,7 +68,7 @@ describe('probeRecord', () => {
     const doc = { ...binary('r', 'Plan', 'f1'), mimeType: GOOGLE_MIME.document };
     expect(await probeRecord('r', scan(), getter({ r: doc }))).toMatchObject({
       state: 'present',
-      entry: { key: 'docs/Plan.docx', md5: null, native: { exportFormat: 'docx' } },
+      entry: { key: 'docs/Plan.docx', hash: null, native: { exportFormat: 'docx' } },
     });
     const form = { ...binary('r', 'Survey', 'f1'), mimeType: 'application/vnd.google-apps.form' };
     expect(await probeRecord('r', scan(), getter({ r: form }))).toEqual({
```

`src/sync/__tests__/remote-scanner.test.ts` (modify):

```diff
diff --git a/src/sync/__tests__/remote-scanner.test.ts b/src/sync/__tests__/remote-scanner.test.ts
index 7d3f2b7..d9ad0af 100644
--- a/src/sync/__tests__/remote-scanner.test.ts
+++ b/src/sync/__tests__/remote-scanner.test.ts
@@ -39,7 +39,7 @@ describe('scanRemote', () => {
     expect(scan.entries[1]).toMatchObject({
       canEdit: false,
       canTrash: false,
-      md5: 'md5-b',
+      hash: { kind: 'md5', value: 'md5-b' },
       size: 10,
     });
     expect([...scan.folders.entries()]).toEqual([
@@ -107,7 +107,7 @@ describe('scanRemote', () => {
       ),
     );
     expect(
-      scan.entries.map((e) => [e.id, e.key, e.name, e.md5, e.size, e.native?.exportFormat]),
+      scan.entries.map((e) => [e.id, e.key, e.name, e.hash, e.size, e.native?.exportFormat]),
     ).toEqual([
       ['s', 'Budget.csv', 'Budget', null, null, 'csv'],
       ['g', 'Plan.docx', 'Plan', null, null, 'docx'],
```

`src/sync/__tests__/sync-service.pairs.test.ts` (modify):

```diff
diff --git a/src/sync/__tests__/sync-service.pairs.test.ts b/src/sync/__tests__/sync-service.pairs.test.ts
index 97c4196..3dd0cef 100644
--- a/src/sync/__tests__/sync-service.pairs.test.ts
+++ b/src/sync/__tests__/sync-service.pairs.test.ts
@@ -261,7 +261,7 @@ describe('select', () => {
       localSize: 1,
       localMtimeMs: 1,
       localCtimeMs: 1,
-      remoteMd5: 'x',
+      remoteHash: { kind: 'md5', value: 'x' },
       remoteSize: 1,
       remoteModifiedTime: 't',
       native: null,
```

- [ ] **Step 2: Run it and watch it fail.**

Run: `npx vitest run src/sync/__tests__/pair-store.test.ts`

Expected: FAIL. 3 failed: `ValidationError: Sync pair file for "docs" is invalid` (the fixtures now write version 2) and `expected 1 to be 2`.

- [ ] **Step 3: Implement.**

`src/sync/content-compare.ts` (modify):

```diff
diff --git a/src/sync/content-compare.ts b/src/sync/content-compare.ts
index 87c2ca2..5a329fd 100644
--- a/src/sync/content-compare.ts
+++ b/src/sync/content-compare.ts
@@ -1,13 +1,30 @@
 import { ValidationError } from '../errors.js';
-import type { RemoteItem } from './remote/sync-remote.js';
+import type { ContentHash, RemoteItem } from './remote/sync-remote.js';
 import type { RemoteEntry, SyncRecord } from './types.js';
 
 /** The item's md5, or null when it reports none (or another hash kind). */
 export function md5Of(item: RemoteItem): string | null {
-  return item.hash?.kind === 'md5' ? item.hash.value : null;
+  return md5Value(item.hash);
 }
 
-/** R content vs the record: binary md5 (else size + modifiedTime, `weak`); native modifiedTime. */
+/** The value of an md5 hash; null for none or another kind. */
+export function md5Value(hash: ContentHash | null): string | null {
+  return hash?.kind === 'md5' ? hash.value : null;
+}
+
+/** Equal hashes, or both missing (record bookkeeping: did the remote's hash change?). */
+export function sameHashOrNone(a: ContentHash | null, b: ContentHash | null): boolean {
+  if (a === null || b === null) return a === b;
+  return a.kind === b.kind && a.value === b.value;
+}
+
+/** Both hashes known, of one kind and equal (null when either is missing or kinds differ). */
+function sameHash(a: ContentHash | null, b: ContentHash | null): boolean | null {
+  if (a === null || b === null || a.kind !== b.kind) return null;
+  return a.value === b.value;
+}
+
+/** R content vs the record: the hash (else size + modifiedTime, `weak`); native modifiedTime. */
 export function remoteChanged(
   record: SyncRecord,
   entry: RemoteEntry,
@@ -15,19 +32,20 @@ export function remoteChanged(
   if (entry.native !== null) {
     return { changed: entry.modifiedTime !== record.remoteModifiedTime, weak: false };
   }
-  if (entry.md5 !== null && record.remoteMd5 !== null) {
-    return { changed: entry.md5 !== record.remoteMd5, weak: false };
-  }
+  const same = sameHash(entry.hash, record.remoteHash);
+  if (same !== null) return { changed: !same, weak: false };
   return {
     changed: entry.size !== record.remoteSize || entry.modifiedTime !== record.remoteModifiedTime,
     weak: true,
   };
 }
 
-/** Executor re-verification: binary md5 and modifiedTime equal; native modifiedTime equal. */
+/** Executor re-verification: binary hash and modifiedTime equal; native modifiedTime equal. */
 export function remoteUnchangedSince(planned: RemoteEntry, current: RemoteItem): boolean {
   if (current.modifiedTime !== planned.modifiedTime) return false;
-  return planned.native !== null || md5Of(current) === planned.md5;
+  if (planned.native !== null) return true;
+  if (planned.hash === null || current.hash === null) return planned.hash === current.hash;
+  return sameHash(planned.hash, current.hash) === true;
 }
 
 /**
@@ -39,7 +57,7 @@ export function localMatchesRemote(
   record: SyncRecord | null,
   entry: RemoteEntry,
 ): boolean {
-  if (entry.native === null) return entry.md5 !== null && localMd5 === entry.md5;
+  if (entry.native === null) return md5Value(entry.hash) === localMd5;
   if (record === null) {
     throw new ValidationError(`Internal: comparing ${entry.key} needs its record`);
   }
```

`src/sync/exec-records.ts` (modify):

```diff
diff --git a/src/sync/exec-records.ts b/src/sync/exec-records.ts
index 5e77251..0149744 100644
--- a/src/sync/exec-records.ts
+++ b/src/sync/exec-records.ts
@@ -1,7 +1,6 @@
 import { ValidationError } from '../errors.js';
-import { md5Of } from './content-compare.js';
 import { foldKey } from './paths.js';
-import type { RemoteItem } from './remote/sync-remote.js';
+import type { ContentHash, RemoteItem } from './remote/sync-remote.js';
 import type { StatExpect } from './transfer.js';
 import type { LocalEntry, PairFile, RemoteEntry, SelectionChange, SyncRecord } from './types.js';
 
@@ -9,7 +8,7 @@ export interface RemoteFields {
   id: string;
   name: string;
   parentId: string;
-  md5: string | null;
+  hash: ContentHash | null;
   size: number | null;
   modifiedTime: string;
   native: SyncRecord['native'];
@@ -28,7 +27,7 @@ export function fromEntry(e: RemoteEntry): RemoteFields {
     id: e.id,
     name: e.name,
     parentId: e.parentId,
-    md5: e.md5,
+    hash: e.hash,
     size: e.size,
     modifiedTime: e.modifiedTime,
     native: e.native ? { mimeType: e.native.mimeType, exportFormat: e.native.exportFormat } : null,
@@ -41,7 +40,7 @@ export function fromRemote(item: RemoteItem, fallbackParent: string): RemoteFiel
     id: item.id,
     name: item.name,
     parentId: item.parentId ?? fallbackParent,
-    md5: md5Of(item),
+    hash: item.hash,
     size: item.size,
     modifiedTime: item.modifiedTime,
     // Uploads are binary files.
@@ -64,7 +63,7 @@ export function makeRecord(key: string, local: LocalFields, remote: RemoteFields
     localSize: local.size,
     localMtimeMs: local.mtimeMs,
     localCtimeMs: local.ctimeMs,
-    remoteMd5: remote.md5,
+    remoteHash: remote.hash,
     remoteSize: remote.size,
     remoteModifiedTime: remote.modifiedTime,
     native: remote.native,
```

`src/sync/executor.ts` (modify):

```diff
diff --git a/src/sync/executor.ts b/src/sync/executor.ts
index fe89775..fb2dd8a 100644
--- a/src/sync/executor.ts
+++ b/src/sync/executor.ts
@@ -3,7 +3,7 @@ import path from 'node:path';
 import type { AuditOp, AuditSink } from '../audit/audit-log.js';
 import { AppError, ExportTooLargeError, hasErrorCode } from '../errors.js';
 import type { Logger } from '../logger.js';
-import { md5Of, remoteUnchangedSince } from './content-compare.js';
+import { md5Of, md5Value, remoteUnchangedSince } from './content-compare.js';
 import {
   CollisionError,
   LocalEditKeptError,
@@ -290,12 +290,13 @@ export class Executor {
       uploaded = adopted;
     }
     const remote = fromRemote(uploaded, parentId);
+    const uploadedMd5 = md5Value(remote.hash);
     const warning =
-      remote.md5 !== null && remote.md5 !== planned ? 'changed-during-upload' : undefined;
+      uploadedMd5 !== null && uploadedMd5 !== planned ? 'changed-during-upload' : undefined;
     await this.commit(action, () =>
       putRecord(
         this.file,
-        makeRecord(action.key, this.localFields(local, remote.md5 ?? planned), remote),
+        makeRecord(action.key, this.localFields(local, uploadedMd5 ?? planned), remote),
         action.rebaseFrom,
       ),
     );
@@ -334,12 +335,13 @@ export class Executor {
     const abs = absInside(this.pair.localDir, local.name);
     const updated = await this.deps.remote.replaceContent(current, abs);
     const fields = fromRemote(updated, remote.parentId);
+    const updatedMd5 = md5Value(fields.hash);
     const warning =
-      fields.md5 !== null && fields.md5 !== planned ? 'changed-during-upload' : undefined;
+      updatedMd5 !== null && updatedMd5 !== planned ? 'changed-during-upload' : undefined;
     await this.commit(action, () =>
       putRecord(
         this.file,
-        makeRecord(action.key, this.localFields(local, fields.md5 ?? planned), fields),
+        makeRecord(action.key, this.localFields(local, updatedMd5 ?? planned), fields),
       ),
     );
     await this.audit('sync_update', action, remote.id);
@@ -378,7 +380,7 @@ export class Executor {
     const written = remote.native
       ? await exportOver(this.host(), to, expect, remote)
       : await this.deps.remote.download(remote.id, (open) =>
-          downloadReplace(to, open, { expect, expectedMd5: remote.md5 }),
+          downloadReplace(to, open, { expect, expectedMd5: md5Value(remote.hash) }),
         );
     const after = await this.statFields(action.key, written.md5);
     putRecord(this.file, makeRecord(action.key, after, fromEntry(remote)));
@@ -392,7 +394,7 @@ export class Executor {
     const abs = await prepareParent(this.pair.localDir, action.key);
     const written = await this.deps.remote.download(remote.id, (open) =>
       placeExclusive(path.dirname(abs), () => path.basename(abs), open, {
-        expectedMd5: remote.md5,
+        expectedMd5: md5Value(remote.hash),
       }),
     );
     const local = await this.statFields(action.key, written.md5);
@@ -408,7 +410,7 @@ export class Executor {
     const remote = need(action.remote, 'remote');
     const abs = absInside(this.pair.localDir, local.name);
     const written = await this.deps.remote.download(remote.id, (open) =>
-      downloadReplace(abs, open, { expect: statOf(local), expectedMd5: remote.md5 }),
+      downloadReplace(abs, open, { expect: statOf(local), expectedMd5: md5Value(remote.hash) }),
     );
     const after = await this.statFields(local.name, written.md5);
     await this.commit(action, () =>
@@ -428,7 +430,7 @@ export class Executor {
     const base = path.basename(abs);
     const copy = await this.deps.remote.download(remote.id, (open) =>
       placeExclusive(path.dirname(abs), (i) => conflictName(base, at, i), open, {
-        expectedMd5: remote.md5,
+        expectedMd5: md5Value(remote.hash),
         maxAttempts: MAX_CONFLICT_NAMES,
       }),
     );
@@ -439,7 +441,7 @@ export class Executor {
       await this.commit(action, () =>
         putRecord(this.file, {
           ...record,
-          remoteMd5: remote.md5,
+          remoteHash: remote.hash,
           remoteSize: remote.size,
           remoteModifiedTime: remote.modifiedTime,
           remoteName: remote.name,
@@ -451,16 +453,17 @@ export class Executor {
     const current = await this.verifyRemote(remote);
     const updated = await this.deps.remote.replaceContent(current, abs);
     const fields = fromRemote(updated, remote.parentId);
+    const updatedMd5 = md5Value(fields.hash);
     await this.commit(action, () =>
       putRecord(
         this.file,
-        makeRecord(action.key, this.localFields(local, fields.md5 ?? planned), fields),
+        makeRecord(action.key, this.localFields(local, updatedMd5 ?? planned), fields),
       ),
     );
     await this.audit('sync_update', action, remote.id);
     return {
       conflictCopy,
-      ...(fields.md5 !== null && fields.md5 !== planned
+      ...(updatedMd5 !== null && updatedMd5 !== planned
         ? { warning: 'changed-during-upload' }
         : {}),
     };
```

`src/sync/pair-admin.ts` (modify):

```diff
diff --git a/src/sync/pair-admin.ts b/src/sync/pair-admin.ts
index 1d59b20..ea61f74 100644
--- a/src/sync/pair-admin.ts
+++ b/src/sync/pair-admin.ts
@@ -147,7 +147,7 @@ export async function createPair(env: SyncEnv, input: CreatePairInput): Promise<
       firstAppliedRunAt: null,
       nativeBaselineDone: false,
     };
-    const file: PairFile = { version: 1, pair, records: [] };
+    const file: PairFile = { version: 2, pair, records: [] };
     await env.store.save(file);
     return summarize(file);
   });
```

`src/sync/pair-store.ts` (modify):

```diff
diff --git a/src/sync/pair-store.ts b/src/sync/pair-store.ts
index 537b1e5..ca1bf93 100644
--- a/src/sync/pair-store.ts
+++ b/src/sync/pair-store.ts
@@ -34,7 +34,9 @@ const pairSchema = z.object({
   nativeBaselineDone: z.boolean().default(false),
 });
 
-const recordSchema = z.object({
+const contentHash = z.object({ kind: z.enum(['md5', 'quickXor']), value: z.string() });
+
+const recordFields = {
   remoteId: z.string().min(1),
   path: z.string().min(1),
   localName: z.string().min(1),
@@ -44,21 +46,41 @@ const recordSchema = z.object({
   localSize: z.number(),
   localMtimeMs: z.number(),
   localCtimeMs: z.number(),
-  remoteMd5: z.string().nullable(),
   remoteSize: z.number().nullable(),
   remoteModifiedTime: z.string(),
   native: z.object({ mimeType: z.string(), exportFormat }).nullable(),
   remoteOnly: z.boolean(),
   restorePending: z.boolean(),
   remoteTrashed: z.boolean(),
-});
+};
 
 const pairFileSchema = z.object({
+  version: z.literal(2),
+  pair: pairSchema,
+  records: z.array(z.object({ ...recordFields, remoteHash: contentHash.nullable() })),
+});
+
+/** Version 1 (before OneDrive sync): `remoteMd5` instead of `remoteHash` (spec §4.5). */
+const pairFileV1Schema = z.object({
   version: z.literal(1),
   pair: pairSchema,
-  records: z.array(recordSchema),
+  records: z.array(z.object({ ...recordFields, remoteMd5: z.string().nullable() })),
 });
 
+/** Reads a stored pair file; version 1 is migrated in memory and saved as version 2. */
+function parsePairFile(json: unknown): ReturnType<typeof pairFileSchema.safeParse> {
+  const v1 = pairFileV1Schema.safeParse(json);
+  if (!v1.success) return pairFileSchema.safeParse(json);
+  return pairFileSchema.safeParse({
+    ...v1.data,
+    version: 2,
+    records: v1.data.records.map(({ remoteMd5, ...r }) => ({
+      ...r,
+      remoteHash: remoteMd5 === null ? null : { kind: 'md5', value: remoteMd5 },
+    })),
+  });
+}
+
 export interface PairStoreOptions {
   dir: string;
   isAlive?: (pid: number) => boolean;
@@ -120,7 +142,7 @@ export class PairStore {
     } catch (err) {
       throw new ValidationError(`Sync pair file for "${name}" is not valid JSON`, { cause: err });
     }
-    const parsed = pairFileSchema.safeParse(json);
+    const parsed = parsePairFile(json);
     if (!parsed.success) {
       throw new ValidationError(`Sync pair file for "${name}" is invalid: ${parsed.error.message}`);
     }
```

`src/sync/plan-remote-only.ts` (modify):

```diff
diff --git a/src/sync/plan-remote-only.ts b/src/sync/plan-remote-only.ts
index 8167443..8176440 100644
--- a/src/sync/plan-remote-only.ts
+++ b/src/sync/plan-remote-only.ts
@@ -1,4 +1,4 @@
-import { localMatchesRemote, remoteChanged } from './content-compare.js';
+import { localMatchesRemote, remoteChanged, sameHashOrNone } from './content-compare.js';
 import { foldKey } from './paths.js';
 import type { ActionBase, TrackedResult, TrackedScope } from './plan-shared.js';
 import { isExcluded, localState, type LocalResolution, type RemoteResolution } from './resolve.js';
@@ -13,7 +13,7 @@ function remotePatch(record: SyncRecord, remote: RemoteEntry): Partial<SyncRecor
   const patch: Partial<SyncRecord> = {};
   if (remote.name !== record.remoteName) patch.remoteName = remote.name;
   if (remote.parentId !== record.remoteParentId) patch.remoteParentId = remote.parentId;
-  if (remote.md5 !== record.remoteMd5) patch.remoteMd5 = remote.md5;
+  if (!sameHashOrNone(remote.hash, record.remoteHash)) patch.remoteHash = remote.hash;
   if (remote.size !== record.remoteSize) patch.remoteSize = remote.size;
   if (remote.native === null && remote.modifiedTime !== record.remoteModifiedTime) {
     patch.remoteModifiedTime = remote.modifiedTime;
```

`src/sync/plan-shared.ts` (modify):

```diff
diff --git a/src/sync/plan-shared.ts b/src/sync/plan-shared.ts
index 22d30da..361359b 100644
--- a/src/sync/plan-shared.ts
+++ b/src/sync/plan-shared.ts
@@ -1,3 +1,4 @@
+import { sameHashOrNone } from './content-compare.js';
 import { foldKey } from './paths.js';
 import { isExcluded, type PlanContext } from './resolve.js';
 import type {
@@ -76,7 +77,7 @@ export function needsRefresh(record: SyncRecord, entry: LocalEntry, remote: Remo
     entry.ctimeMs !== record.localCtimeMs ||
     remote.name !== record.remoteName ||
     remote.parentId !== record.remoteParentId ||
-    remote.md5 !== record.remoteMd5 ||
+    !sameHashOrNone(remote.hash, record.remoteHash) ||
     remote.size !== record.remoteSize ||
     remote.modifiedTime !== record.remoteModifiedTime
   );
```

`src/sync/plan-tracked.ts` (modify):

```diff
diff --git a/src/sync/plan-tracked.ts b/src/sync/plan-tracked.ts
index 22c9e3f..9ef98a9 100644
--- a/src/sync/plan-tracked.ts
+++ b/src/sync/plan-tracked.ts
@@ -1,4 +1,4 @@
-import { localMatchesRemote, remoteChanged } from './content-compare.js';
+import { localMatchesRemote, md5Value, remoteChanged } from './content-compare.js';
 import { foldKey } from './paths.js';
 import { planNative } from './plan-native.js';
 import { planRemoteOnly } from './plan-remote-only.js';
@@ -84,7 +84,7 @@ export function planTracked(ctx: PlanContext, record: SyncRecord): TrackedResult
     const others = (ctx.remoteByFold.get(foldKey(record.path)) ?? []).filter(
       (r) => !ctx.trackedIds.has(r.id),
     );
-    const reuploaded = others.find((r) => r.md5 !== null && r.md5 === lMd5);
+    const reuploaded = others.find((r) => lMd5 !== null && md5Value(r.hash) === lMd5);
     if (reuploaded)
       return act({
         ...base,
```

`src/sync/planner.ts` (modify):

```diff
diff --git a/src/sync/planner.ts b/src/sync/planner.ts
index 96ed2ba..911f7dc 100644
--- a/src/sync/planner.ts
+++ b/src/sync/planner.ts
@@ -40,7 +40,7 @@ export function brakeFor(actions: readonly Action[], tracked: number): BrakeInfo
 }
 
 /**
- * SHA-256 over the canonical `(kind, remoteId, key, local md5, remote md5)` list of
+ * SHA-256 over the canonical `(kind, remoteId, key, local md5, remote kind:hash)` list of
  * every non-refresh action — no generated names or timestamps (spec §5 step 5).
  */
 export function computePlanId(actions: readonly Action[]): string {
@@ -52,7 +52,7 @@ export function computePlanId(actions: readonly Action[]): string {
         a.record?.remoteId ?? a.remote?.id ?? '',
         a.key,
         a.localMd5 ?? '',
-        a.remote?.md5 ?? '',
+        a.remote?.hash ? `${a.remote.hash.kind}:${a.remote.hash.value}` : '',
       ]),
     )
     .sort();
```

`src/sync/remote-scanner.ts` (modify):

```diff
diff --git a/src/sync/remote-scanner.ts b/src/sync/remote-scanner.ts
index 7adc893..4f29719 100644
--- a/src/sync/remote-scanner.ts
+++ b/src/sync/remote-scanner.ts
@@ -37,7 +37,7 @@ export function toRemoteEntry(
     parentId,
     ancestorIds,
     mimeType: item.mimeType,
-    md5: native || item.hash?.kind !== 'md5' ? null : item.hash.value,
+    hash: native ? null : item.hash,
     size: native ? null : item.size,
     modifiedTime: item.modifiedTime,
     createdTime: item.createdTime,
```

`src/sync/types.ts` (modify):

```diff
diff --git a/src/sync/types.ts b/src/sync/types.ts
index e9c5a5b..46476e3 100644
--- a/src/sync/types.ts
+++ b/src/sync/types.ts
@@ -1,5 +1,5 @@
 import type { ExportFormat } from '../files/export-formats.js';
-import type { RemoteUnsupported } from './remote/sync-remote.js';
+import type { ContentHash, RemoteUnsupported } from './remote/sync-remote.js';
 
 /** Pair names: lower-case letters, digits and dashes (spec §3). */
 export const PAIR_NAME = /^[a-z0-9-]{1,40}$/;
@@ -48,7 +48,8 @@ export interface SyncRecord {
   localSize: number;
   localMtimeMs: number;
   localCtimeMs: number;
-  remoteMd5: string | null;
+  /** The remote's hash at the last sync (md5 on Google); null when it reported none. */
+  remoteHash: ContentHash | null;
   remoteSize: number | null;
   remoteModifiedTime: string;
   native: null | { mimeType: string; exportFormat: ExportFormat };
@@ -58,7 +59,7 @@ export interface SyncRecord {
 }
 
 export interface PairFile {
-  version: 1;
+  version: 2;
   pair: Pair;
   records: SyncRecord[];
 }
@@ -108,7 +109,8 @@ export interface RemoteEntry {
   /** Folder ids from the parent up to the pair root (inclusive). */
   ancestorIds: string[];
   mimeType: string;
-  md5: string | null;
+  /** Content hash of a binary file; null for natives and when the remote reports none. */
+  hash: ContentHash | null;
   size: number | null;
   modifiedTime: string;
   createdTime: string;
```

- [ ] **Step 4: Run it and watch it pass.**

Run: `npx vitest run src/sync/__tests__/pair-store.test.ts`

Expected: PASS (every test in the files passes).

- [ ] **Step 5: Format and run the whole check.**

Run: `npx prettier --write src/sync/__tests__/content-compare.test.ts src/sync/__tests__/exec-records.test.ts src/sync/__tests__/executor.test.ts src/sync/__tests__/fixtures.ts src/sync/__tests__/pair-store.test.ts src/sync/__tests__/plan-remote-only.test.ts src/sync/__tests__/plan-tracked.test.ts src/sync/__tests__/release.test.ts src/sync/__tests__/remote-probe.test.ts src/sync/__tests__/remote-scanner.test.ts src/sync/__tests__/sync-service.pairs.test.ts src/sync/content-compare.ts src/sync/exec-records.ts src/sync/executor.ts src/sync/pair-admin.ts src/sync/pair-store.ts src/sync/plan-remote-only.ts src/sync/plan-shared.ts src/sync/plan-tracked.ts src/sync/planner.ts src/sync/remote-scanner.ts src/sync/types.ts` then `npm run check`

Expected: exit 0, `Test Files  127 passed (127); Tests  1352 passed | 6 skipped (1358)`.

- [ ] **Step 6: Commit.**

```bash
git add src/sync/__tests__/content-compare.test.ts src/sync/__tests__/exec-records.test.ts src/sync/__tests__/executor.test.ts src/sync/__tests__/fixtures.ts src/sync/__tests__/pair-store.test.ts src/sync/__tests__/plan-remote-only.test.ts src/sync/__tests__/plan-tracked.test.ts src/sync/__tests__/release.test.ts src/sync/__tests__/remote-probe.test.ts src/sync/__tests__/remote-scanner.test.ts src/sync/__tests__/sync-service.pairs.test.ts src/sync/content-compare.ts src/sync/exec-records.ts src/sync/executor.ts src/sync/pair-admin.ts src/sync/pair-store.ts src/sync/plan-remote-only.ts src/sync/plan-shared.ts src/sync/plan-tracked.ts src/sync/planner.ts src/sync/remote-scanner.ts src/sync/types.ts
git commit -F - <<'MSG'
refactor(sync): ContentHash replaces md5 in entries, records and the pair file (v2)

RemoteEntry.md5 becomes hash, SyncRecord.remoteMd5 becomes remoteHash and the
planId hashes kind:value. The pair file moves to version 2; a version-1 file is
migrated in memory (remoteMd5 x -> { kind: 'md5', value: x }) and saved as
version 2. Test fixtures keep md5/remoteMd5 as shorthands.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
MSG
```

### Task 14: Pair deletion cursor and evidence fields; newer-version message

**Spec:** §4.1 (`remoteCursor`, `remoteDeletedIds`), §4.5 (older binary message). Commit `7d192fd` on the reference branch.

**Files:**
- Test: `src/sync/__tests__/fixtures.ts`
- Test: `src/sync/__tests__/pair-store.test.ts`
- Modify: `src/sync/pair-admin.ts`
- Modify: `src/sync/pair-store.ts`
- Modify: `src/sync/types.ts`

- [ ] **Step 1: Write the failing test (and its setup).**

`src/sync/__tests__/fixtures.ts` (modify):

```diff
diff --git a/src/sync/__tests__/fixtures.ts b/src/sync/__tests__/fixtures.ts
index 1836b4a..9c75ce6 100644
--- a/src/sync/__tests__/fixtures.ts
+++ b/src/sync/__tests__/fixtures.ts
@@ -52,6 +52,8 @@ export function makePair(overrides: Partial<Pair> = {}): Pair {
     lastAppliedRunAt: '2026-11-02T00:00:00.000Z',
     firstAppliedRunAt: '2026-11-02T00:00:00.000Z',
     nativeBaselineDone: true,
+    remoteCursor: null,
+    remoteDeletedIds: [],
     ...overrides,
   };
 }
```

`src/sync/__tests__/pair-store.test.ts` (modify):

```diff
diff --git a/src/sync/__tests__/pair-store.test.ts b/src/sync/__tests__/pair-store.test.ts
index ffe4426..37efacc 100644
--- a/src/sync/__tests__/pair-store.test.ts
+++ b/src/sync/__tests__/pair-store.test.ts
@@ -78,6 +78,27 @@ describe('PairStore', () => {
     expect(saved.records[0].remoteHash).toEqual({ kind: 'md5', value: 'md5-r1' });
   });
 
+  it('gives a version-1 pair an empty deletion cursor and evidence', async () => {
+    const file = makePairFile();
+    const pair: Record<string, unknown> = { ...file.pair };
+    delete pair.remoteCursor;
+    delete pair.remoteDeletedIds;
+    await mkdir(dir, { recursive: true });
+    await writeFile(path.join(dir, 'docs.json'), JSON.stringify({ ...file, version: 1, pair }));
+    expect((await store().load('docs')).pair).toMatchObject({
+      remoteCursor: null,
+      remoteDeletedIds: [],
+    });
+  });
+
+  it('refuses a pair file from a newer version with an update hint', async () => {
+    await mkdir(dir, { recursive: true });
+    await writeFile(path.join(dir, 'docs.json'), JSON.stringify({ ...makePairFile(), version: 3 }));
+    await expect(store().load('docs')).rejects.toThrow(
+      'this pair was saved by a newer marvin-drive; update it',
+    );
+  });
+
   it('tightens an existing sync dir to 0700', async () => {
     await mkdir(dir, { recursive: true });
     await chmod(dir, 0o755);
```

- [ ] **Step 2: Run it and watch it fail.**

Run: `npx vitest run src/sync/__tests__/pair-store.test.ts`

Expected: FAIL. 2 failed: `expected { Object (name, id, ...) } to match object { remoteCursor: null, …(1) }` and `expected [Function] to throw error including 'this pair was saved by a newer marvin…' but got 'Sync pair file for "docs" is invalid:…'`.

- [ ] **Step 3: Implement.**

`src/sync/pair-admin.ts` (modify):

```diff
diff --git a/src/sync/pair-admin.ts b/src/sync/pair-admin.ts
index ea61f74..5dbc977 100644
--- a/src/sync/pair-admin.ts
+++ b/src/sync/pair-admin.ts
@@ -146,6 +146,8 @@ export async function createPair(env: SyncEnv, input: CreatePairInput): Promise<
       lastAppliedRunAt: null,
       firstAppliedRunAt: null,
       nativeBaselineDone: false,
+      remoteCursor: null,
+      remoteDeletedIds: [],
     };
     const file: PairFile = { version: 2, pair, records: [] };
     await env.store.save(file);
```

`src/sync/pair-store.ts` (modify):

```diff
diff --git a/src/sync/pair-store.ts b/src/sync/pair-store.ts
index ca1bf93..eb05c67 100644
--- a/src/sync/pair-store.ts
+++ b/src/sync/pair-store.ts
@@ -32,8 +32,14 @@ const pairSchema = z.object({
   lastAppliedRunAt: z.string().nullable(),
   firstAppliedRunAt: z.string().nullable(),
   nativeBaselineDone: z.boolean().default(false),
+  // Added in version 2 (OneDrive sync spec §4.5); version-1 files start empty.
+  remoteCursor: z.string().nullable().default(null),
+  remoteDeletedIds: z.array(z.string()).default([]),
 });
 
+/** The pair file version this binary writes; a higher one comes from a newer release. */
+const PAIR_FILE_VERSION = 2;
+
 const contentHash = z.object({ kind: z.enum(['md5', 'quickXor']), value: z.string() });
 
 const recordFields = {
@@ -142,6 +148,12 @@ export class PairStore {
     } catch (err) {
       throw new ValidationError(`Sync pair file for "${name}" is not valid JSON`, { cause: err });
     }
+    const version = (json as { version?: unknown } | null)?.version;
+    if (typeof version === 'number' && version > PAIR_FILE_VERSION) {
+      throw new ValidationError(
+        `Sync pair file for "${name}": this pair was saved by a newer marvin-drive; update it`,
+      );
+    }
     const parsed = parsePairFile(json);
     if (!parsed.success) {
       throw new ValidationError(`Sync pair file for "${name}" is invalid: ${parsed.error.message}`);
```

`src/sync/types.ts` (modify):

```diff
diff --git a/src/sync/types.ts b/src/sync/types.ts
index 46476e3..2a3d977 100644
--- a/src/sync/types.ts
+++ b/src/sync/types.ts
@@ -36,6 +36,10 @@ export interface Pair {
   firstAppliedRunAt: string | null;
   /** Addendum §4.1: false until the first applied run that baselined Google-native files. */
   nativeBaselineDone: boolean;
+  /** OneDrive deletion feed cursor (spec §4.1); always null on Google pairs. */
+  remoteCursor: string | null;
+  /** Remote ids the deletion feed reported deleted and not yet acted on; empty on Google. */
+  remoteDeletedIds: string[];
 }
 
 export interface SyncRecord {
```

- [ ] **Step 4: Run it and watch it pass.**

Run: `npx vitest run src/sync/__tests__/pair-store.test.ts`

Expected: PASS (every test in the files passes).

- [ ] **Step 5: Format and run the whole check.**

Run: `npx prettier --write src/sync/__tests__/fixtures.ts src/sync/__tests__/pair-store.test.ts src/sync/pair-admin.ts src/sync/pair-store.ts src/sync/types.ts` then `npm run check`

Expected: exit 0, `Test Files  127 passed (127); Tests  1354 passed | 6 skipped (1360)`.

- [ ] **Step 6: Commit.**

```bash
git add src/sync/__tests__/fixtures.ts src/sync/__tests__/pair-store.test.ts src/sync/pair-admin.ts src/sync/pair-store.ts src/sync/types.ts
git commit -F - <<'MSG'
feat(sync): pair deletion cursor and evidence fields; newer-version message

Pair gains remoteCursor (null) and remoteDeletedIds ([]); version-1 files load
with those defaults. A pair file with a version above 2 is refused with "this pair
was saved by a newer marvin-drive; update it".

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
MSG
```

### Task 15: Local digests and sameContent

**Spec:** §3.1 (`LocalDigests`, `hashFileDigests`, `PlanInput.digests`, `Action.localDigests`, stat-unchanged files), §3.2 (`sameContent`, `localMatchesRemote` without weak fallback). Commit `169d140` on the reference branch.

**Files:**
- Test: `src/sync/__tests__/content-compare.test.ts`
- Test: `src/sync/__tests__/local-scanner.test.ts`
- Test: `src/sync/__tests__/plan-input.ts`
- Test: `src/sync/__tests__/planner.test.ts`
- Test: `src/sync/__tests__/resolve.test.ts`
- Modify: `src/sync/content-compare.ts`
- Modify: `src/sync/local-scanner.ts`
- Modify: `src/sync/plan-remote-only.ts`
- Modify: `src/sync/plan-shared.ts`
- Modify: `src/sync/plan-tracked.ts`
- Modify: `src/sync/plan-untracked.ts`
- Modify: `src/sync/release.ts`
- Modify: `src/sync/resolve.ts`
- Modify: `src/sync/scan-select.ts`
- Modify: `src/sync/types.ts`

- [ ] **Step 1: Write the failing test (and its setup).**

`src/sync/__tests__/content-compare.test.ts` (modify):

```diff
diff --git a/src/sync/__tests__/content-compare.test.ts b/src/sync/__tests__/content-compare.test.ts
index 8dde3b0..8fd1472 100644
--- a/src/sync/__tests__/content-compare.test.ts
+++ b/src/sync/__tests__/content-compare.test.ts
@@ -1,10 +1,16 @@
 import { describe, expect, it } from 'vitest';
 import type { DriveFile } from '../../drive/drive-adapter.js';
-import { localMatchesRemote, remoteChanged, remoteUnchangedSince } from '../content-compare.js';
+import {
+  localMatchesRemote,
+  remoteChanged,
+  remoteUnchangedSince,
+  sameContent,
+} from '../content-compare.js';
 import { toRemoteItem } from '../remote/google-remote.js';
 import type { RemoteItem } from '../remote/sync-remote.js';
 import { DEFAULT_GOOGLE_EXPORT } from '../types.js';
 import { nativeEntry, nativeRecord, record, remoteEntry } from './fixtures.js';
+import { md5Digests } from './plan-input.js';
 
 const item = (file: DriveFile): RemoteItem => toRemoteItem(file, DEFAULT_GOOGLE_EXPORT);
 
@@ -53,18 +59,37 @@ describe('remoteUnchangedSince', () => {
     expect(remoteUnchangedSince(r, item({ modifiedTime: LATER }))).toBe(false);
   });
 });
+describe('sameContent', () => {
+  it('compares the local digest of the remote kind; null when unknown or of another kind', () => {
+    const qx = { kind: 'quickXor' as const, value: 'QX' };
+    expect(sameContent(md5Digests('a'), { kind: 'md5', value: 'a' })).toBe(true);
+    expect(sameContent(md5Digests('a'), { kind: 'md5', value: 'b' })).toBe(false);
+    expect(sameContent(md5Digests('a'), null)).toBeNull();
+    expect(sameContent(md5Digests('a'), qx)).toBeNull();
+    expect(sameContent({ md5: 'a', remote: null }, qx)).toBeNull();
+    expect(sameContent({ md5: 'a', remote: qx }, qx)).toBe(true);
+  });
+});
 describe('localMatchesRemote', () => {
+  it('binary without a comparable remote hash is never a match (no weak fallback)', () => {
+    const r = remoteEntry('r1', 'a.pdf', { hash: { kind: 'quickXor', value: 'QX' } });
+    expect(localMatchesRemote(md5Digests('md5-r1'), null, r)).toBe(false);
+    expect(localMatchesRemote({ md5: 'md5-r1', remote: null }, null, r)).toBe(false);
+    expect(
+      localMatchesRemote({ md5: 'x', remote: { kind: 'quickXor', value: 'QX' } }, null, r),
+    ).toBe(true);
+  });
   it('binary: local md5 = Drive md5 (no record needed)', () => {
     const r = remoteEntry('r1', 'a.pdf');
-    expect(localMatchesRemote('md5-r1', null, r)).toBe(true);
-    expect(localMatchesRemote('other', null, r)).toBe(false);
-    expect(localMatchesRemote('md5-r1', null, { ...r, hash: null })).toBe(false);
+    expect(localMatchesRemote(md5Digests('md5-r1'), null, r)).toBe(true);
+    expect(localMatchesRemote(md5Digests('other'), null, r)).toBe(false);
+    expect(localMatchesRemote(md5Digests('md5-r1'), null, { ...r, hash: null })).toBe(false);
   });
   it('native: local md5 = md5 of the last export (record required)', () => {
     const k = nativeRecord('g1', 'Plan.docx', { localMd5: 'export-md5' });
     const r = nativeEntry('g1', 'Plan.docx');
-    expect(localMatchesRemote('export-md5', k, r)).toBe(true);
-    expect(localMatchesRemote('edited', k, r)).toBe(false);
-    expect(() => localMatchesRemote('export-md5', null, r)).toThrow(/needs its record/);
+    expect(localMatchesRemote(md5Digests('export-md5'), k, r)).toBe(true);
+    expect(localMatchesRemote(md5Digests('edited'), k, r)).toBe(false);
+    expect(() => localMatchesRemote(md5Digests('export-md5'), null, r)).toThrow(/needs its record/);
   });
 });
```

`src/sync/__tests__/local-scanner.test.ts` (modify):

```diff
diff --git a/src/sync/__tests__/local-scanner.test.ts b/src/sync/__tests__/local-scanner.test.ts
index 208f25e..e6988eb 100644
--- a/src/sync/__tests__/local-scanner.test.ts
+++ b/src/sync/__tests__/local-scanner.test.ts
@@ -5,7 +5,7 @@ import os from 'node:os';
 import path from 'node:path';
 import { afterEach, beforeEach, describe, expect, it } from 'vitest';
 import { linkDir, linkFileOrSkip } from '../../__tests__/links.js';
-import { hashLocal, md5File, probeOnDisk, scanLocal } from '../local-scanner.js';
+import { hashFileDigests, hashLocal, md5File, probeOnDisk, scanLocal } from '../local-scanner.js';
 
 const NFD = 'şartname.pdf'.normalize('NFD');
 const isRoot = process.getuid?.() === 0;
@@ -116,8 +116,29 @@ describe('hashing', () => {
     await writeFile(path.join(root, 'a.txt'), 'hello');
     const expected = createHash('md5').update('hello').digest('hex');
     expect(await md5File(path.join(root, 'a.txt'))).toBe(expected);
-    const { md5s, failed } = await hashLocal(root, ['a.txt', 'gone.txt']);
-    expect(md5s.get('a.txt')).toBe(expected);
+    const { digests, failed } = await hashLocal(root, ['a.txt', 'gone.txt'], 'md5');
+    expect(digests.get('a.txt')).toEqual({
+      md5: expected,
+      remote: { kind: 'md5', value: expected },
+    });
     expect(failed).toEqual(['gone.txt']);
   });
+
+  it('computes the remote kind next to md5 in one read, with an injected digester', async () => {
+    await writeFile(path.join(root, 'a.txt'), 'hello');
+    const expected = createHash('md5').update('hello').digest('hex');
+    const seen: string[] = [];
+    const stub = (kind: string) => ({
+      update: (chunk: Buffer) => void seen.push(`${kind}:${chunk.toString()}`),
+      digest: () => 'QX-STUB',
+    });
+    expect(await hashFileDigests(path.join(root, 'a.txt'), 'quickXor', stub)).toEqual({
+      md5: expected,
+      remote: { kind: 'quickXor', value: 'QX-STUB' },
+    });
+    expect(seen).toEqual(['quickXor:hello']);
+    await expect(hashFileDigests(path.join(root, 'a.txt'), 'quickXor')).rejects.toThrow(
+      'No quickXor digest',
+    );
+  });
 });
```

`src/sync/__tests__/plan-input.ts` (modify):

```diff
diff --git a/src/sync/__tests__/plan-input.ts b/src/sync/__tests__/plan-input.ts
index c5b6f9a..7073f9b 100644
--- a/src/sync/__tests__/plan-input.ts
+++ b/src/sync/__tests__/plan-input.ts
@@ -1,3 +1,4 @@
+import type { HashKind } from '../remote/sync-remote.js';
 import type { PlanInput } from '../resolve.js';
 import type {
   LocalEntry,
@@ -6,9 +7,10 @@ import type {
   Probe,
   RemoteEntry,
   RemoteIgnored,
+  LocalDigests,
   SyncRecord,
 } from '../types.js';
-import { ROOT_ID, makePair } from './fixtures.js';
+import { ROOT_ID, makePair, md5Hash } from './fixtures.js';
 
 export interface InputOptions {
   pair?: Partial<Pair>;
@@ -19,7 +21,10 @@ export interface InputOptions {
   remote?: RemoteEntry[];
   ignored?: RemoteIgnored[];
   probes?: Array<[string, Probe]>;
+  /** Shorthand: local md5 by on-disk name (its remote digest is the same md5). */
   md5s?: Array<[string, string]>;
+  digests?: Array<[string, LocalDigests]>;
+  remoteHashKind?: HashKind;
   onDisk?: Array<[string, OnDiskProbe]>;
   blocking?: string[];
   folders?: Array<[string, string]>;
@@ -29,6 +34,11 @@ export interface InputOptions {
   unknownFolderIds?: string[];
 }
 
+/** The digests of a file whose md5 is `md5` on an md5 remote. */
+export function md5Digests(md5: string): LocalDigests {
+  return { md5, remote: md5Hash(md5) };
+}
+
 export function planInput(o: InputOptions = {}): PlanInput {
   const records = o.records ?? [];
   const pair = makePair({
@@ -53,7 +63,11 @@ export function planInput(o: InputOptions = {}): PlanInput {
       unknownFolderIds: o.unknownFolderIds ?? [],
     },
     probes: new Map(o.probes ?? []),
-    md5s: new Map(o.md5s ?? []),
+    digests: new Map([
+      ...(o.md5s ?? []).map(([name, md5]): [string, LocalDigests] => [name, md5Digests(md5)]),
+      ...(o.digests ?? []),
+    ]),
+    remoteHashKind: o.remoteHashKind ?? 'md5',
     onDisk: new Map(o.onDisk ?? []),
   };
 }
```

`src/sync/__tests__/planner.test.ts` (modify):

```diff
diff --git a/src/sync/__tests__/planner.test.ts b/src/sync/__tests__/planner.test.ts
index cd4a48d..dbe9d38 100644
--- a/src/sync/__tests__/planner.test.ts
+++ b/src/sync/__tests__/planner.test.ts
@@ -2,7 +2,7 @@ import { afterEach, describe, expect, it, vi } from 'vitest';
 import { brakeFor, computePlanId, plan } from '../planner.js';
 import type { Action } from '../types.js';
 import { localEntry, nativeEntry, nativeRecord, record, remoteEntry } from './fixtures.js';
-import { planInput } from './plan-input.js';
+import { md5Digests, planInput } from './plan-input.js';
 
 function trash(kind: 'trash-remote' | 'trash-local', n: number): Action[] {
   return Array.from({ length: n }, (_, i) => ({
@@ -197,9 +197,9 @@ describe('planId (spec §5)', () => {
 
   it('changes when content changes', () => {
     const changed = input();
-    const md5s = new Map(changed.md5s);
-    md5s.set('a.pdf', 'local-2');
-    expect(plan({ ...changed, md5s }).planId).not.toBe(plan(input()).planId);
+    const digests = new Map(changed.digests);
+    digests.set('a.pdf', md5Digests('local-2'));
+    expect(plan({ ...changed, digests }).planId).not.toBe(plan(input()).planId);
   });
 });
```

`src/sync/__tests__/resolve.test.ts` (modify):

```diff
diff --git a/src/sync/__tests__/resolve.test.ts b/src/sync/__tests__/resolve.test.ts
index 248d71e..ae5c38d 100644
--- a/src/sync/__tests__/resolve.test.ts
+++ b/src/sync/__tests__/resolve.test.ts
@@ -8,7 +8,7 @@ import {
   resolveRemote,
 } from '../resolve.js';
 import { localEntry, record, remoteEntry } from './fixtures.js';
-import { planInput } from './plan-input.js';
+import { md5Digests, planInput } from './plan-input.js';
 
 const NFD = 'şartname.pdf'.normalize('NFD');
 
@@ -109,13 +109,35 @@ describe('content state', () => {
   it('local: unchanged by stat, else by md5; null when not hashed', () => {
     const k = record('r1', 'a.pdf');
     const ctx = buildContext(planInput({ md5s: [['b.pdf', 'md5-r1']] }));
-    expect(localState(ctx, k, localEntry('a.pdf'))).toEqual({ changed: false, md5: 'md5-r1' });
+    expect(localState(ctx, k, localEntry('a.pdf'))).toEqual({
+      changed: false,
+      digests: md5Digests('md5-r1'),
+    });
     expect(localState(ctx, k, localEntry('b.pdf', { mtimeMs: 5 }))).toEqual({
       changed: false,
-      md5: 'md5-r1',
+      digests: md5Digests('md5-r1'),
     });
     expect(localState(ctx, k, localEntry('a.pdf', { mtimeMs: 5 }))).toBeNull();
   });
+  it('local on a non-md5 remote: stat-unchanged keeps the record md5, remote digest only if hashed', () => {
+    const k = record('r1', 'a.pdf');
+    const qx = { kind: 'quickXor' as const, value: 'QX' };
+    const plain = buildContext(planInput({ remoteHashKind: 'quickXor' }));
+    expect(localState(plain, k, localEntry('a.pdf'))).toEqual({
+      changed: false,
+      digests: { md5: 'md5-r1', remote: null },
+    });
+    const hashed = buildContext(
+      planInput({
+        remoteHashKind: 'quickXor',
+        digests: [['a.pdf', { md5: 'md5-r1', remote: qx }]],
+      }),
+    );
+    expect(localState(hashed, k, localEntry('a.pdf'))).toEqual({
+      changed: false,
+      digests: { md5: 'md5-r1', remote: qx },
+    });
+  });
 });
 
 describe('hashTargets', () => {
```

- [ ] **Step 2: Run it and watch it fail.**

Run: `npx vitest run src/sync/__tests__/local-scanner.test.ts src/sync/__tests__/resolve.test.ts`

Expected: FAIL. 4 failed: `TypeError: Cannot read properties of undefined (reading 'get')`, `TypeError: hashFileDigests is not a function`, `AssertionError: expected { changed: false, md5: 'md5-r1' } to deeply equal { changed: false, digests: { …(2) } }` (twice).

- [ ] **Step 3: Implement.**

`src/sync/content-compare.ts` (modify):

```diff
diff --git a/src/sync/content-compare.ts b/src/sync/content-compare.ts
index 5a329fd..a394b53 100644
--- a/src/sync/content-compare.ts
+++ b/src/sync/content-compare.ts
@@ -1,6 +1,6 @@
 import { ValidationError } from '../errors.js';
 import type { ContentHash, RemoteItem } from './remote/sync-remote.js';
-import type { RemoteEntry, SyncRecord } from './types.js';
+import type { LocalDigests, RemoteEntry, SyncRecord } from './types.js';
 
 /** The item's md5, or null when it reports none (or another hash kind). */
 export function md5Of(item: RemoteItem): string | null {
@@ -49,17 +49,26 @@ export function remoteUnchangedSince(planned: RemoteEntry, current: RemoteItem):
 }
 
 /**
- * L equals R: binary by Drive md5 (record unused: U2/B4 adopt); native by the md5 of the
- * last export (record required — untracked natives with a local file are U0b).
+ * L's content vs a remote hash (spec §3.2): null when the remote reports none, the local
+ * digest of its kind was not computed, or the kinds differ.
+ */
+export function sameContent(local: LocalDigests, remote: ContentHash | null): boolean | null {
+  return sameHash(local.remote, remote);
+}
+
+/**
+ * L equals R: binary by the remote hash, never by a weaker fallback (record unused: U2/B4
+ * adopt, release); native by the md5 of the last export (record required — untracked
+ * natives with a local file are U0b).
  */
 export function localMatchesRemote(
-  localMd5: string,
+  local: LocalDigests,
   record: SyncRecord | null,
   entry: RemoteEntry,
 ): boolean {
-  if (entry.native === null) return md5Value(entry.hash) === localMd5;
+  if (entry.native === null) return sameContent(local, entry.hash) === true;
   if (record === null) {
     throw new ValidationError(`Internal: comparing ${entry.key} needs its record`);
   }
-  return localMd5 === record.localMd5;
+  return local.md5 === record.localMd5;
 }
```

`src/sync/local-scanner.ts` (modify):

```diff
diff --git a/src/sync/local-scanner.ts b/src/sync/local-scanner.ts
index 986940d..306412c 100644
--- a/src/sync/local-scanner.ts
+++ b/src/sync/local-scanner.ts
@@ -5,7 +5,49 @@ import path from 'node:path';
 import { pipeline } from 'node:stream/promises';
 import { ValidationError, hasErrorCode } from '../errors.js';
 import { PART_SUFFIX, absInside, ancestorKeys, foldKey, isIgnoredName, toKey } from './paths.js';
-import type { LocalScan, OnDiskProbe } from './types.js';
+import type { HashKind } from './remote/sync-remote.js';
+import type { LocalDigests, LocalScan, OnDiskProbe } from './types.js';
+
+/** An incremental digest of one hash kind. */
+export interface Digester {
+  update(chunk: Buffer): void;
+  digest(): string;
+}
+
+/** Makes a digester for a remote's hash kind (injectable; quickXor plugs in here). */
+export type DigesterFactory = (kind: HashKind) => Digester;
+
+/** md5 only; other kinds are added with their implementation. */
+export const defaultDigesters: DigesterFactory = (kind) => {
+  if (kind !== 'md5') throw new ValidationError(`No ${kind} digest is available in this build`);
+  const hash = createHash('md5');
+  return {
+    update: (chunk): void => {
+      hash.update(chunk);
+    },
+    digest: (): string => hash.digest('hex'),
+  };
+};
+
+/** md5 and, when `kind` is not md5, the digest of `kind`, in one read (spec §3.1). */
+export async function hashFileDigests(
+  abs: string,
+  kind: HashKind,
+  digesters: DigesterFactory = defaultDigesters,
+): Promise<LocalDigests> {
+  const md5 = createHash('md5');
+  const other = kind === 'md5' ? null : digesters(kind);
+  for await (const chunk of createReadStream(abs)) {
+    const buf = chunk as Buffer;
+    md5.update(buf);
+    other?.update(buf);
+  }
+  const value = md5.digest('hex');
+  return {
+    md5: value,
+    remote: other ? { kind, value: other.digest() } : { kind: 'md5', value },
+  };
+}
 
 export interface LocalScanOptions {
   /** On-disk relative directory to restrict the scan to (sync_scan `subdir`). */
@@ -144,19 +186,21 @@ export async function md5File(abs: string): Promise<string> {
   return hash.digest('hex');
 }
 
-/** Hashes the given on-disk relative names; failures are returned, not thrown. */
+/** Digests of the given on-disk relative names; failures are returned, not thrown. */
 export async function hashLocal(
   root: string,
   names: readonly string[],
-): Promise<{ md5s: Map<string, string>; failed: string[] }> {
-  const md5s = new Map<string, string>();
+  kind: HashKind,
+  digesters: DigesterFactory = defaultDigesters,
+): Promise<{ digests: Map<string, LocalDigests>; failed: string[] }> {
+  const digests = new Map<string, LocalDigests>();
   const failed: string[] = [];
   for (const name of names) {
     try {
-      md5s.set(name, await md5File(absInside(root, name)));
+      digests.set(name, await hashFileDigests(absInside(root, name), kind, digesters));
     } catch {
       failed.push(name);
     }
   }
-  return { md5s, failed };
+  return { digests, failed };
 }
```

`src/sync/plan-remote-only.ts` (modify):

```diff
diff --git a/src/sync/plan-remote-only.ts b/src/sync/plan-remote-only.ts
index 8176440..21f1fd9 100644
--- a/src/sync/plan-remote-only.ts
+++ b/src/sync/plan-remote-only.ts
@@ -2,7 +2,7 @@ import { localMatchesRemote, remoteChanged, sameHashOrNone } from './content-com
 import { foldKey } from './paths.js';
 import type { ActionBase, TrackedResult, TrackedScope } from './plan-shared.js';
 import { isExcluded, localState, type LocalResolution, type RemoteResolution } from './resolve.js';
-import type { RemoteEntry, SyncRecord } from './types.js';
+import type { LocalDigests, RemoteEntry, SyncRecord } from './types.js';
 
 /**
  * Remote-side record fields that differ from R (O3/O4/O6 record refresh). A native's
@@ -32,16 +32,23 @@ export function planRemoteOnly(
 ): TrackedResult {
   const { ctx, record, out, note, act } = s;
   const entry = L.kind === 'present' ? L.entry : null;
-  let lMd5: string | null = null;
+  let lDigests: LocalDigests | null = null;
   if (entry) {
     const st = localState(ctx, record, entry);
     if (!st) return note('unknown-state', 'unknown', 'local file could not be hashed');
-    lMd5 = st.md5;
+    lDigests = st.digests;
   }
-  const base: ActionBase = { key: record.path, local: entry, localMd5: lMd5, selection: {} };
+  const base: ActionBase = {
+    key: record.path,
+    local: entry,
+    localMd5: lDigests?.md5 ?? null,
+    localDigests: lDigests,
+    selection: {},
+  };
   const untrack = { remove: [record.path], exclude: [record.path] };
   const present = R.kind === 'present' ? R.entry : null;
-  const same = present !== null && lMd5 !== null && localMatchesRemote(lMd5, record, present);
+  const same =
+    present !== null && lDigests !== null && localMatchesRemote(lDigests, record, present);
   // L is the unmodified last export but the Doc changed since: re-export over it (like N4).
   const stale = same && present.native !== null && remoteChanged(record, present).changed;
   const back = (rule: 'O0' | 'O8', remote: RemoteEntry): TrackedResult =>
@@ -63,6 +70,7 @@ export function planRemoteOnly(
         key: target,
         local: null,
         localMd5: null,
+        localDigests: null,
         kind: present.native ? 'export-new' : 'download-new',
         rule: 'O1',
         remote: present,
```

`src/sync/plan-shared.ts` (modify):

```diff
diff --git a/src/sync/plan-shared.ts b/src/sync/plan-shared.ts
index 361359b..278983d 100644
--- a/src/sync/plan-shared.ts
+++ b/src/sync/plan-shared.ts
@@ -4,6 +4,7 @@ import { isExcluded, type PlanContext } from './resolve.js';
 import type {
   Action,
   ActionKind,
+  LocalDigests,
   LocalEntry,
   Note,
   NoteCode,
@@ -37,6 +38,7 @@ export interface ActionBase {
   key: string;
   local: LocalEntry | null;
   localMd5: string | null;
+  localDigests: LocalDigests | null;
   selection: SelectionChange;
 }
 
@@ -115,15 +117,16 @@ export function planMoved(
   const [moved] = blockers;
   if (!entry && !rChanged && blockers.length === 1 && moved) {
     // Resume after a crash between the local move and persistence: the file is already there.
-    const md5 = ctx.input.md5s.get(moved.name);
-    if (md5 === record.localMd5) {
+    const digests = ctx.input.digests.get(moved.name);
+    if (digests !== undefined && digests.md5 === record.localMd5) {
       return act({
         ...base,
         key: target,
         kind: 'adopt',
         rule: rule('B7-resume'),
         local: moved,
-        localMd5: md5,
+        localMd5: digests.md5,
+        localDigests: digests,
         remote,
         selection: { remove: [record.path], add: [target] },
       });
```

`src/sync/plan-tracked.ts` (modify):

```diff
diff --git a/src/sync/plan-tracked.ts b/src/sync/plan-tracked.ts
index 9ef98a9..dff2375 100644
--- a/src/sync/plan-tracked.ts
+++ b/src/sync/plan-tracked.ts
@@ -1,4 +1,4 @@
-import { localMatchesRemote, md5Value, remoteChanged } from './content-compare.js';
+import { localMatchesRemote, remoteChanged, sameContent } from './content-compare.js';
 import { foldKey } from './paths.js';
 import { planNative } from './plan-native.js';
 import { planRemoteOnly } from './plan-remote-only.js';
@@ -10,7 +10,7 @@ import {
   resolveRemote,
   type PlanContext,
 } from './resolve.js';
-import type { SyncRecord } from './types.js';
+import type { LocalDigests, SyncRecord } from './types.js';
 
 export type { TrackedResult } from './plan-shared.js';
 
@@ -50,14 +50,20 @@ export function planTracked(ctx: PlanContext, record: SyncRecord): TrackedResult
 
   const entry = L.kind === 'present' ? L.entry : null;
   let lChanged = false;
-  let lMd5: string | null = null;
+  let lDigests: LocalDigests | null = null;
   if (entry) {
     const ls = localState(ctx, record, entry);
     if (!ls) return note('unknown-state', 'unknown', 'local file could not be hashed');
     lChanged = ls.changed;
-    lMd5 = ls.md5;
+    lDigests = ls.digests;
   }
-  const base = { key: record.path, local: entry, localMd5: lMd5, selection: {} };
+  const base = {
+    key: record.path,
+    local: entry,
+    localMd5: lDigests?.md5 ?? null,
+    localDigests: lDigests,
+    selection: {},
+  };
   // (d)
   if (record.native) return planNative(s, base, R, lChanged);
 
@@ -84,7 +90,7 @@ export function planTracked(ctx: PlanContext, record: SyncRecord): TrackedResult
     const others = (ctx.remoteByFold.get(foldKey(record.path)) ?? []).filter(
       (r) => !ctx.trackedIds.has(r.id),
     );
-    const reuploaded = others.find((r) => lMd5 !== null && md5Value(r.hash) === lMd5);
+    const reuploaded = others.find((r) => lDigests !== null && sameContent(lDigests, r.hash));
     if (reuploaded)
       return act({
         ...base,
@@ -141,7 +147,7 @@ export function planTracked(ctx: PlanContext, record: SyncRecord): TrackedResult
       }
       if (rs.changed && !lChanged)
         return act({ ...base, kind: 'download-replace', rule: 'B3', remote });
-      if (lMd5 !== null && localMatchesRemote(lMd5, null, remote))
+      if (lDigests !== null && localMatchesRemote(lDigests, null, remote))
         return act({ ...base, kind: 'adopt', rule: 'B4', remote });
       if (!remote.canEdit)
         note('remote-readonly', 'B4', 'no edit permission; kept a conflict copy only');
```

`src/sync/plan-untracked.ts` (modify):

```diff
diff --git a/src/sync/plan-untracked.ts b/src/sync/plan-untracked.ts
index ad1324b..2d91b0a 100644
--- a/src/sync/plan-untracked.ts
+++ b/src/sync/plan-untracked.ts
@@ -165,21 +165,23 @@ export function planUntracked(ctx: PlanContext, claims: Claims): UntrackedResult
           rule: 'U1',
           key: target,
           local: L,
-          localMd5: ctx.input.md5s.get(L.name) ?? null,
+          localMd5: ctx.input.digests.get(L.name)?.md5 ?? null,
+          localDigests: ctx.input.digests.get(L.name) ?? null,
           remote: null,
           selection: rename(sel, target),
         });
       } else if (L && R) {
-        const lMd5 = ctx.input.md5s.get(L.name);
-        if (lMd5 === undefined) note('unknown-state', 'U2', 'local file could not be hashed');
-        else if (localMatchesRemote(lMd5, null, R)) {
+        const lDigests = ctx.input.digests.get(L.name);
+        if (lDigests === undefined) note('unknown-state', 'U2', 'local file could not be hashed');
+        else if (localMatchesRemote(lDigests, null, R)) {
           out.actions.push({
             ...base,
             kind: 'adopt',
             rule: 'U2',
             key: R.key,
             local: L,
-            localMd5: lMd5,
+            localMd5: lDigests.md5,
+            localDigests: lDigests,
             remote: R,
             selection: rename(sel, R.key),
           });
@@ -192,7 +194,8 @@ export function planUntracked(ctx: PlanContext, claims: Claims): UntrackedResult
             rule: 'U2',
             key: R.key,
             local: L,
-            localMd5: lMd5,
+            localMd5: lDigests.md5,
+            localDigests: lDigests,
             remote: R,
             updateRemote: true,
             selection: rename(sel, R.key),
```

`src/sync/release.ts` (modify):

```diff
diff --git a/src/sync/release.ts b/src/sync/release.ts
index c3b6c8f..1798201 100644
--- a/src/sync/release.ts
+++ b/src/sync/release.ts
@@ -77,7 +77,7 @@ function check(ctx: PlanContext, record: SyncRecord, explicit: boolean): Release
   if (L.kind === 'present') {
     const st = localState(ctx, record, L.entry);
     if (!st) return 'local file could not be hashed';
-    if (st.changed || !localMatchesRemote(st.md5, record, R.entry)) {
+    if (st.changed || !localMatchesRemote(st.digests, record, R.entry)) {
       return 'not in sync (changed locally or in Drive); run sync_run first';
     }
     return { record, remote: R.entry, kind: 'present', localName: L.entry.name };
@@ -189,7 +189,8 @@ async function verifyLocal(abs: string, c: ReleaseCandidate): Promise<void> {
     if (hasErrorCode(err, 'ENOENT')) throw new TargetChangedError(`${key} is already gone`);
     throw err;
   });
-  if (md5 !== c.record.localMd5 || !localMatchesRemote(md5, c.record, c.remote)) {
+  const digests = { md5, remote: { kind: 'md5' as const, value: md5 } };
+  if (md5 !== c.record.localMd5 || !localMatchesRemote(digests, c.record, c.remote)) {
     throw new TargetChangedError(`${key} changed locally since the scan`);
   }
 }
```

`src/sync/resolve.ts` (modify):

```diff
diff --git a/src/sync/resolve.ts b/src/sync/resolve.ts
index 1133d96..69d900a 100644
--- a/src/sync/resolve.ts
+++ b/src/sync/resolve.ts
@@ -1,5 +1,7 @@
 import { ancestorKeys, foldKey, isUnder } from './paths.js';
+import type { HashKind } from './remote/sync-remote.js';
 import type {
+  LocalDigests,
   LocalEntry,
   LocalScan,
   OnDiskProbe,
@@ -18,8 +20,10 @@ export interface PlanInput {
   remote: RemoteScan;
   /** Probe results for records missing from the remote scan (spec §6.2). */
   probes: ReadonlyMap<string, Probe>;
-  /** md5 by on-disk relative name, for the names `hashTargets` asked for. */
-  md5s: ReadonlyMap<string, string>;
+  /** Digests by on-disk relative name, for the names `hashTargets` asked for. */
+  digests: ReadonlyMap<string, LocalDigests>;
+  /** The pair remote's hash kind (local digests of this kind are compared with it). */
+  remoteHashKind: HashKind;
   /** lstat of record keys that have no exact scan match (absent keys are omitted). */
   onDisk: ReadonlyMap<string, OnDiskProbe>;
 }
@@ -204,11 +208,19 @@ export function localState(
   ctx: PlanContext,
   record: SyncRecord,
   entry: LocalEntry,
-): { changed: boolean; md5: string } | null {
-  if (statMatches(entry, record)) return { changed: false, md5: record.localMd5 };
-  const md5 = ctx.input.md5s.get(entry.name);
-  if (md5 === undefined) return null;
-  return { changed: md5 !== record.localMd5, md5 };
+): { changed: boolean; digests: LocalDigests } | null {
+  const hashed = ctx.input.digests.get(entry.name);
+  if (statMatches(entry, record)) {
+    // Not re-hashed for change detection: the record md5 stands (spec §3.1).
+    const md5 = record.localMd5;
+    const remote =
+      ctx.input.remoteHashKind === 'md5'
+        ? { kind: 'md5' as const, value: md5 }
+        : (hashed?.remote ?? null);
+    return { changed: false, digests: { md5, remote } };
+  }
+  if (hashed === undefined) return null;
+  return { changed: hashed.md5 !== record.localMd5, digests: hashed };
 }
 
 /**
@@ -236,8 +248,8 @@ export function onDiskProbeKeys(
  * files whose stat differs from the record, selected files not yet recorded, and a
  * local file already at a vanished record's Drive-move target (crash after a move).
  */
-export function hashTargets(input: Omit<PlanInput, 'md5s'>): string[] {
-  const ctx = buildContext({ ...input, md5s: new Map() });
+export function hashTargets(input: Omit<PlanInput, 'digests'>): string[] {
+  const ctx = buildContext({ ...input, digests: new Map() });
   const names = new Set<string>();
   const recordFolds = new Set<string>();
   for (const record of input.records) {
```

`src/sync/scan-select.ts` (modify):

```diff
diff --git a/src/sync/scan-select.ts b/src/sync/scan-select.ts
index 7afacef..5b67c7f 100644
--- a/src/sync/scan-select.ts
+++ b/src/sync/scan-select.ts
@@ -101,13 +101,26 @@ export async function gatherInput(
     pair.localDir,
     onDiskProbeKeys({ pair, records, local, remote }),
   );
-  const base = { pair, records, local, remote, probes: new Map(), onDisk };
-  const { md5s, failed } = await hashLocal(pair.localDir, hashTargets(base));
+  const syncRemote = env.remoteFor(pair);
+  const base = {
+    pair,
+    records,
+    local,
+    remote,
+    probes: new Map(),
+    onDisk,
+    remoteHashKind: syncRemote.hashKind,
+  };
+  const { digests, failed } = await hashLocal(
+    pair.localDir,
+    hashTargets(base),
+    syncRemote.hashKind,
+  );
   for (const name of failed) local.unknownSubtrees.push(toKey(name));
   const seen = new Set([...remote.entries.map((e) => e.id), ...remote.ignored.map((i) => i.id)]);
   const missing = records.map((r) => r.remoteId).filter((id) => !seen.has(id));
-  const probes = await probeRecords(missing, remote, env.remoteFor(pair));
-  return { input: { ...base, probes, md5s }, local, remote };
+  const probes = await probeRecords(missing, remote, syncRemote);
+  return { input: { ...base, probes, digests }, local, remote };
 }
 
 /** sync_scan: local files (with text previews) and remote candidates for Claude to choose from. */
```

`src/sync/types.ts` (modify):

```diff
diff --git a/src/sync/types.ts b/src/sync/types.ts
index 2a3d977..4c0de62 100644
--- a/src/sync/types.ts
+++ b/src/sync/types.ts
@@ -97,6 +97,16 @@ export interface OnDiskProbe {
   ino: number;
 }
 
+/**
+ * A local file's digests (OneDrive sync spec §3.1): its md5, and the digest of the remote's
+ * hash kind (the same md5 on Google). `remote` is null only when it was not computed: a
+ * stat-unchanged tracked file on a remote whose kind is not md5 (§3.1 "Stat-unchanged").
+ */
+export interface LocalDigests {
+  md5: string;
+  remote: ContentHash | null;
+}
+
 /** Export settings of a Google-native Drive file (addendum §4.1). */
 export interface NativeInfo {
   mimeType: string;
@@ -182,6 +192,8 @@ export interface Action {
   record: SyncRecord | null;
   local: LocalEntry | null;
   localMd5: string | null;
+  /** The planned local content (md5 and the remote's kind); null when no local file is read. */
+  localDigests?: LocalDigests | null;
   remote: RemoteEntry | null;
   selection: SelectionChange;
   /** move-local: rename in place (case-only change on a case-insensitive volume). */
```

- [ ] **Step 4: Run it and watch it pass.**

Run: `npx vitest run src/sync/__tests__/local-scanner.test.ts src/sync/__tests__/resolve.test.ts`

Expected: PASS (every test in the files passes).

- [ ] **Step 5: Format and run the whole check.**

Run: `npx prettier --write src/sync/__tests__/content-compare.test.ts src/sync/__tests__/local-scanner.test.ts src/sync/__tests__/plan-input.ts src/sync/__tests__/planner.test.ts src/sync/__tests__/resolve.test.ts src/sync/content-compare.ts src/sync/local-scanner.ts src/sync/plan-remote-only.ts src/sync/plan-shared.ts src/sync/plan-tracked.ts src/sync/plan-untracked.ts src/sync/release.ts src/sync/resolve.ts src/sync/scan-select.ts src/sync/types.ts` then `npm run check`

Expected: exit 0, `Test Files  127 passed (127); Tests  1358 passed | 6 skipped (1364)`.

- [ ] **Step 6: Commit.**

```bash
git add src/sync/__tests__/content-compare.test.ts src/sync/__tests__/local-scanner.test.ts src/sync/__tests__/plan-input.ts src/sync/__tests__/planner.test.ts src/sync/__tests__/resolve.test.ts src/sync/content-compare.ts src/sync/local-scanner.ts src/sync/plan-remote-only.ts src/sync/plan-shared.ts src/sync/plan-tracked.ts src/sync/plan-untracked.ts src/sync/release.ts src/sync/resolve.ts src/sync/scan-select.ts src/sync/types.ts
git commit -F - <<'MSG'
feat(sync): local digests and sameContent for content comparison

hashFileDigests computes md5 plus the remote's hash kind in one read (digesters
are injectable; only md5 exists so far). PlanInput.md5s becomes digests, with
remoteHashKind; localState returns LocalDigests; actions carry localDigests.
localMatchesRemote compares through sameContent and never falls back to a weak
match. On Google every digest is the md5, so plans are unchanged.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
MSG
```

### Task 16: hashTargets asks for remote-kind digests to adopt or release

**Spec:** §3.1 "Stat-unchanged files" (`remoteHashKind`, `releaseNames`, release candidates, untracked same-key files). Commit `a056c42` on the reference branch.

**Files:**
- Test (create): `src/sync/__tests__/gather-digests.test.ts`
- Test: `src/sync/__tests__/plan-input.ts`
- Test: `src/sync/__tests__/resolve.test.ts`
- Modify: `src/sync/pair-admin.ts`
- Modify: `src/sync/resolve.ts`
- Modify: `src/sync/scan-select.ts`
- Modify: `src/sync/sync-service.ts`

- [ ] **Step 1: Write the failing test (and its setup).**

`src/sync/__tests__/gather-digests.test.ts` (create):

```ts
import { createHash } from 'node:crypto';
import { lstat, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createAudit, silentLogger } from '../../files/__tests__/fakes.js';
import type { Digester } from '../local-scanner.js';
import type { SyncEnv } from '../pair-admin.js';
import { PairStore } from '../pair-store.js';
import { selectReleasable } from '../release.js';
import type { RemoteItem, SyncRemote } from '../remote/sync-remote.js';
import { gatherInput } from '../scan-select.js';
import type { PairFile } from '../types.js';
import { googleRemoteOver } from './fake-remote.js';
import { makePairFile, record } from './fixtures.js';
import { memoryDrive } from './memory-drive.js';

const md5 = (s: string): string => createHash('md5').update(s).digest('hex');

/** Test-only "quickXor": `QX-` + the md5 of the content (the real one arrives in stage 3). */
const qx = (md5hex: string): string => `QX-${md5hex}`;
const stubDigester = (): Digester => {
  const h = createHash('md5');
  return { update: (c) => void h.update(c), digest: () => qx(h.digest('hex')) };
};

/** A remote that reports quickXor hashes (derived from the memory Drive's md5). */
function quickXorRemote(inner: SyncRemote): SyncRemote {
  const convert = (i: RemoteItem): RemoteItem =>
    i.hash ? { ...i, hash: { kind: 'quickXor', value: qx(i.hash.value) } } : i;
  return Object.assign(Object.create(inner) as SyncRemote, {
    hashKind: 'quickXor' as const,
    listChildren: async (id: string, token: string | undefined) => {
      const page = await inner.listChildren(id, token);
      return { ...page, items: page.items.map(convert) };
    },
  });
}

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'sync-digests-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('gatherInput on a non-md5 remote (spec §3.1 stat-unchanged files)', () => {
  it('a stat-unchanged file gets a remote-kind digest only when release asks for it', async () => {
    const mem = memoryDrive('ROOT');
    mem.addFile('r1', 'a.pdf', 'ROOT', 'hello');
    await writeFile(path.join(dir, 'a.pdf'), 'hello');
    const info = await lstat(path.join(dir, 'a.pdf'));
    const file: PairFile = makePairFile({ localDir: dir, remoteFolderId: 'ROOT' }, [
      record('r1', 'a.pdf', {
        remoteParentId: 'ROOT',
        localMd5: md5('hello'),
        localSize: info.size,
        localMtimeMs: info.mtimeMs,
        localCtimeMs: info.ctimeMs,
        remoteHash: { kind: 'quickXor', value: qx(md5('hello')) },
        remoteSize: 5,
        remoteModifiedTime: mem.files.get('r1')?.modifiedTime ?? '',
      }),
    ]);
    const remote = quickXorRemote(googleRemoteOver(mem.drive));
    const env: SyncEnv = {
      audit: createAudit(),
      log: silentLogger(),
      clock: () => new Date('2026-11-03T12:00:00.000Z'),
      store: new PairStore({ dir: path.join(dir, '.store'), logger: silentLogger() }),
      remoteFor: () => remote,
      openRemote: async () => remote,
      assertSupportedAccount: async () => {},
      digesters: stubDigester,
    };
    const plain = await gatherInput(env, file);
    expect(plain.input.digests.size).toBe(0);
    expect(selectReleasable(plain.input, { all: true }).skipped).toEqual([
      { path: 'a.pdf', reason: 'not in sync (changed locally or in Drive); run sync_run first' },
    ]);
    const asked = await gatherInput(env, file, 'all');
    expect(asked.input.digests.get('a.pdf')).toEqual({
      md5: md5('hello'),
      remote: { kind: 'quickXor', value: qx(md5('hello')) },
    });
    expect(selectReleasable(asked.input, { all: true }).eligible.map((c) => c.record.path)).toEqual(
      ['a.pdf'],
    );
  });
});
```

`src/sync/__tests__/plan-input.ts` (modify):

```diff
diff --git a/src/sync/__tests__/plan-input.ts b/src/sync/__tests__/plan-input.ts
index 7073f9b..193cdd6 100644
--- a/src/sync/__tests__/plan-input.ts
+++ b/src/sync/__tests__/plan-input.ts
@@ -25,6 +25,7 @@ export interface InputOptions {
   md5s?: Array<[string, string]>;
   digests?: Array<[string, LocalDigests]>;
   remoteHashKind?: HashKind;
+  releaseNames?: PlanInput['releaseNames'];
   onDisk?: Array<[string, OnDiskProbe]>;
   blocking?: string[];
   folders?: Array<[string, string]>;
@@ -68,6 +69,7 @@ export function planInput(o: InputOptions = {}): PlanInput {
       ...(o.digests ?? []),
     ]),
     remoteHashKind: o.remoteHashKind ?? 'md5',
+    releaseNames: o.releaseNames ?? null,
     onDisk: new Map(o.onDisk ?? []),
   };
 }
```

`src/sync/__tests__/resolve.test.ts` (modify):

```diff
diff --git a/src/sync/__tests__/resolve.test.ts b/src/sync/__tests__/resolve.test.ts
index ae5c38d..17c4d8f 100644
--- a/src/sync/__tests__/resolve.test.ts
+++ b/src/sync/__tests__/resolve.test.ts
@@ -8,7 +8,7 @@ import {
   resolveRemote,
 } from '../resolve.js';
 import { localEntry, record, remoteEntry } from './fixtures.js';
-import { md5Digests, planInput } from './plan-input.js';
+import { md5Digests, planInput, type InputOptions } from './plan-input.js';
 
 const NFD = 'şartname.pdf'.normalize('NFD');
 
@@ -154,6 +154,47 @@ describe('hashTargets', () => {
     });
     expect(hashTargets(input)).toEqual(['new.pdf', 'touched.pdf']);
   });
+
+  const releaseCase = (o: Partial<InputOptions> = {}) =>
+    planInput({
+      records: [
+        record('r1', 'same.pdf'),
+        record('r2', 'nohash.pdf'),
+        record('r3', 'gone.pdf'),
+        record('r4', 'released.pdf', { remoteOnly: true }),
+      ],
+      local: [
+        localEntry('same.pdf'),
+        localEntry('nohash.pdf'),
+        localEntry('released.pdf'),
+        localEntry('adopt.pdf'),
+        localEntry('lonely.pdf'),
+      ],
+      remote: [
+        remoteEntry('r1', 'same.pdf'),
+        remoteEntry('r2', 'nohash.pdf', { hash: null }),
+        remoteEntry('r4', 'released.pdf'),
+        remoteEntry('n1', 'Adopt.pdf'),
+      ],
+      ...o,
+    });
+
+  it('on an md5 remote, release requests and adopt candidates add nothing', () => {
+    const base = hashTargets(releaseCase());
+    expect(base).toEqual([]);
+    expect(hashTargets({ ...releaseCase(), releaseNames: 'all' })).toEqual(base);
+    expect(hashTargets({ ...releaseCase(), releaseNames: ['same.pdf'] })).toEqual(base);
+  });
+
+  it('on another hash kind, adds release candidates and untracked same-key files', () => {
+    const qx = releaseCase({ remoteHashKind: 'quickXor' });
+    expect(hashTargets(qx)).toEqual(['adopt.pdf']);
+    expect(hashTargets({ ...qx, releaseNames: 'all' })).toEqual(['adopt.pdf', 'same.pdf']);
+    expect(hashTargets({ ...qx, releaseNames: ['NOHASH.pdf', 'gone.pdf'] })).toEqual([
+      'adopt.pdf',
+      'nohash.pdf',
+    ]);
+  });
 });
 
 describe('resolveLocal safety (blocking ancestors, on-disk probe)', () => {
```

- [ ] **Step 2: Run it and watch it fail.**

Run: `npx vitest run src/sync/__tests__/resolve.test.ts src/sync/__tests__/gather-digests.test.ts`

Expected: FAIL. `AssertionError: expected [] to deeply equal [ 'adopt.pdf' ]` in resolve.test.ts; gather-digests.test.ts fails on `asked.input.digests.get('a.pdf')` being undefined.

- [ ] **Step 3: Implement.**

`src/sync/pair-admin.ts` (modify):

```diff
diff --git a/src/sync/pair-admin.ts b/src/sync/pair-admin.ts
index 5dbc977..122d42b 100644
--- a/src/sync/pair-admin.ts
+++ b/src/sync/pair-admin.ts
@@ -6,6 +6,7 @@ import type { AuditSink } from '../audit/audit-log.js';
 import { NotFoundError, ValidationError } from '../errors.js';
 import { expandHome } from '../files/destination.js';
 import type { Logger } from '../logger.js';
+import type { DigesterFactory } from './local-scanner.js';
 import { SyncRootError } from './errors.js';
 import {
   checkOverlap,
@@ -31,6 +32,8 @@ export interface SyncEnv {
   openRemote: (accountRef: string | undefined, prefs: GoogleExportPrefs) => Promise<SyncRemote>;
   /** Throws when the account cannot be synced, before anything touches the user's folder. */
   assertSupportedAccount: (ref: string | undefined) => Promise<void>;
+  /** Local digests of the remote's hash kind (md5 built in; tests inject others). */
+  digesters: DigesterFactory;
 }
 
 export interface CreatePairInput {
```

`src/sync/resolve.ts` (modify):

```diff
diff --git a/src/sync/resolve.ts b/src/sync/resolve.ts
index 69d900a..bb78dec 100644
--- a/src/sync/resolve.ts
+++ b/src/sync/resolve.ts
@@ -24,6 +24,8 @@ export interface PlanInput {
   digests: ReadonlyMap<string, LocalDigests>;
   /** The pair remote's hash kind (local digests of this kind are compared with it). */
   remoteHashKind: HashKind;
+  /** sync_release's request (`all` or the given paths); null for scans and runs. */
+  releaseNames: readonly string[] | 'all' | null;
   /** lstat of record keys that have no exact scan match (absent keys are omitted). */
   onDisk: ReadonlyMap<string, OnDiskProbe>;
 }
@@ -247,6 +249,9 @@ export function onDiskProbeKeys(
  * On-disk names the service must hash before planning (spec §5 step 3): tracked
  * files whose stat differs from the record, selected files not yet recorded, and a
  * local file already at a vanished record's Drive-move target (crash after a move).
+ * On a remote whose hash kind is not md5 it also asks for the files whose remote-kind
+ * digest is needed only to adopt or release (OneDrive sync spec §3.1): release candidates
+ * and untracked files with a same-key remote file. With md5 the set is exactly the above.
  */
 export function hashTargets(input: Omit<PlanInput, 'digests'>): string[] {
   const ctx = buildContext({ ...input, digests: new Map() });
@@ -266,5 +271,30 @@ export function hashTargets(input: Omit<PlanInput, 'digests'>): string[] {
     if (recordFolds.has(fold)) continue;
     for (const e of ctx.localByFold.get(fold) ?? []) names.add(e.name);
   }
+  if (input.remoteHashKind !== 'md5') {
+    for (const name of digestOnlyTargets(ctx, recordFolds)) names.add(name);
+  }
   return [...names].sort();
 }
+
+/** Release candidates and untracked same-key files (non-md5 remotes only). */
+function digestOnlyTargets(ctx: PlanContext, recordFolds: ReadonlySet<string>): string[] {
+  const { input } = ctx;
+  const names: string[] = [];
+  const release = input.releaseNames;
+  const named = Array.isArray(release) ? new Set(release.map(foldKey)) : null;
+  for (const record of input.records) {
+    const wanted =
+      release === 'all'
+        ? !record.remoteOnly && (ctx.remoteById.get(record.remoteId)?.hash ?? null) !== null
+        : named !== null && named.has(foldKey(record.path));
+    if (!wanted) continue;
+    const l = resolveLocal(ctx, record.path);
+    if (l.kind === 'present') names.push(l.entry.name);
+  }
+  for (const e of input.local.entries) {
+    if (recordFolds.has(e.foldKey)) continue;
+    if ((ctx.remoteByFold.get(e.foldKey) ?? []).length > 0) names.push(e.name);
+  }
+  return names;
+}
```

`src/sync/scan-select.ts` (modify):

```diff
diff --git a/src/sync/scan-select.ts b/src/sync/scan-select.ts
index 5b67c7f..17a2bd2 100644
--- a/src/sync/scan-select.ts
+++ b/src/sync/scan-select.ts
@@ -92,6 +92,7 @@ export async function scanBoth(
 export async function gatherInput(
   env: SyncEnv,
   file: PairFile,
+  releaseNames: PlanInput['releaseNames'] = null,
 ): Promise<{ input: PlanInput; local: LocalScan; remote: RemoteScan }> {
   const { pair, records } = file;
   const { local, remote } = await scanBoth(env, pair);
@@ -110,11 +111,13 @@ export async function gatherInput(
     probes: new Map(),
     onDisk,
     remoteHashKind: syncRemote.hashKind,
+    releaseNames,
   };
   const { digests, failed } = await hashLocal(
     pair.localDir,
     hashTargets(base),
     syncRemote.hashKind,
+    env.digesters,
   );
   for (const name of failed) local.unknownSubtrees.push(toKey(name));
   const seen = new Set([...remote.entries.map((e) => e.id), ...remote.ignored.map((i) => i.id)]);
```

`src/sync/sync-service.ts` (modify):

```diff
diff --git a/src/sync/sync-service.ts b/src/sync/sync-service.ts
index d7f2a52..aaa8a76 100644
--- a/src/sync/sync-service.ts
+++ b/src/sync/sync-service.ts
@@ -3,6 +3,7 @@ import { OperationRunner, type OperationDeps } from '../core/operation.js';
 import { ValidationError } from '../errors.js';
 import { logger as defaultLogger, type Logger } from '../logger.js';
 import { Executor } from './executor.js';
+import { defaultDigesters, type DigesterFactory } from './local-scanner.js';
 import {
   checkRoots,
   createPair,
@@ -57,6 +58,8 @@ export interface SyncServiceDeps extends OperationDeps {
   clock?: () => Date;
   /** Rejects accounts sync cannot serve (the app rejects Microsoft accounts). */
   assertSupportedAccount?: (ref: string | undefined) => Promise<void>;
+  /** Digests of non-md5 remote hash kinds (default: built-in digesters). */
+  digesters?: DigesterFactory;
 }
 
 export interface RunInput {
@@ -98,6 +101,7 @@ export class SyncService {
       openRemote: (ref, prefs): Promise<SyncRemote> => GoogleSyncRemote.open(this.ops, ref, prefs),
       assertSupportedAccount:
         deps.assertSupportedAccount ?? ((): Promise<void> => Promise.resolve()),
+      digesters: deps.digesters ?? defaultDigesters,
     };
   }
 
@@ -255,7 +259,11 @@ export class SyncService {
     return this.store.withLock(input.name, async () => {
       const file = await this.store.load(input.name);
       await checkRoots(this.env, file.pair);
-      const { input: planInput } = await gatherInput(this.env, file);
+      const { input: planInput } = await gatherInput(
+        this.env,
+        file,
+        all ? 'all' : (input.paths ?? []),
+      );
       const selection = await withoutTrash(
         selectReleasable(planInput, all ? { all } : { paths: input.paths ?? [] }),
         file.pair.localDir,
```

- [ ] **Step 4: Run it and watch it pass.**

Run: `npx vitest run src/sync/__tests__/resolve.test.ts src/sync/__tests__/gather-digests.test.ts`

Expected: PASS (every test in the files passes).

- [ ] **Step 5: Format and run the whole check.**

Run: `npx prettier --write src/sync/__tests__/gather-digests.test.ts src/sync/__tests__/plan-input.ts src/sync/__tests__/resolve.test.ts src/sync/pair-admin.ts src/sync/resolve.ts src/sync/scan-select.ts src/sync/sync-service.ts` then `npm run check`

Expected: exit 0, `Test Files  128 passed (128); Tests  1361 passed | 6 skipped (1367)`.

- [ ] **Step 6: Commit.**

```bash
git add src/sync/__tests__/gather-digests.test.ts src/sync/__tests__/plan-input.ts src/sync/__tests__/resolve.test.ts src/sync/pair-admin.ts src/sync/resolve.ts src/sync/scan-select.ts src/sync/sync-service.ts
git commit -F - <<'MSG'
feat(sync): hashTargets asks for remote-kind digests to adopt or release

PlanInput gains releaseNames; sync_release passes 'all' or its paths. On a remote
whose hash kind is not md5, hashTargets also returns release candidates (with
'all': records whose remote hash is known) and untracked local files with a
same-key remote file. On md5 the set is exactly as before. SyncEnv carries the
digesters so tests (and stage 3's quickXor) can plug a kind in.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
MSG
```

### Task 17: Uploads compare through sameContent; localMd5 is always local

**Spec:** §3.1 last bullet (`localMd5` invariant), §3.2 (`findDuplicateUpload` size + `sameContent`, quiet `changed-during-upload` on a null hash). Commit `081b1f2` on the reference branch.

**Files:**
- Test: `src/sync/__tests__/executor.test.ts`
- Modify: `src/sync/content-compare.ts`
- Modify: `src/sync/executor.ts`

- [ ] **Step 1: Write the failing test (and its setup).**

`src/sync/__tests__/executor.test.ts` (modify):

```diff
diff --git a/src/sync/__tests__/executor.test.ts b/src/sync/__tests__/executor.test.ts
index 570b5f4..7b7aa4b 100644
--- a/src/sync/__tests__/executor.test.ts
+++ b/src/sync/__tests__/executor.test.ts
@@ -237,13 +237,48 @@ describe('Executor', () => {
       action('upload-new', 'a.pdf', { local: l, localMd5: md5('hello') }),
     ]);
     expect(out[0]?.warning).toBe('changed-during-upload');
+    // localMd5 is always the local md5, never the remote's value (OneDrive sync spec §3.1).
     expect(file.records[0]).toMatchObject({
-      localMd5: 'other',
+      localMd5: md5('hello'),
       remoteHash: { kind: 'md5', value: 'other' },
       localSize: l.size,
     });
   });
 
+  it('is quiet when the remote reports no hash for the upload', async () => {
+    const l = await put('a.pdf', 'hello');
+    drive.createFile.mockResolvedValueOnce({ id: 'n1', name: 'a.pdf' });
+    const file = pairFile([], ['a.pdf']);
+    const out = await executor(file).run([
+      action('upload-new', 'a.pdf', { local: l, localMd5: md5('hello') }),
+    ]);
+    expect(out[0]).toEqual({ kind: 'upload-new', path: 'a.pdf', status: 'done' });
+    expect(file.records[0]).toMatchObject({ localMd5: md5('hello'), remoteHash: null });
+  });
+
+  it('does not adopt a same-hash duplicate whose size differs', async () => {
+    const l = await put('a.pdf', 'hello');
+    drive.createFile.mockRejectedValueOnce(httpError(500));
+    drive.listFiles.mockResolvedValueOnce({
+      files: [
+        {
+          id: 'n1',
+          name: 'a.pdf',
+          md5Checksum: md5('hello'),
+          size: '6',
+          createdTime: new Date(NOW.getTime() - 60_000).toISOString(),
+          parents: [ROOT_ID],
+        },
+      ],
+    });
+    const file = pairFile([], ['a.pdf']);
+    const out = await executor(file).run([
+      action('upload-new', 'a.pdf', { local: l, localMd5: md5('hello') }),
+    ]);
+    expect(out[0]?.status).toBe('failed');
+    expect(file.records).toEqual([]);
+  });
+
   it('adopts its own upload after an ambiguous upload error (duplicate-safe)', async () => {
     const l = await put('a.pdf', 'hello');
     drive.createFile.mockRejectedValueOnce(httpError(500));
@@ -253,6 +288,7 @@ describe('Executor', () => {
           id: 'n1',
           name: 'a.pdf',
           md5Checksum: md5('hello'),
+          size: '5',
           createdTime: new Date(NOW.getTime() - 60_000).toISOString(),
           parents: [ROOT_ID],
         },
```

- [ ] **Step 2: Run it and watch it fail.**

Run: `npx vitest run src/sync/__tests__/executor.test.ts`

Expected: FAIL. 2 failed: the changed-during-upload record still has `localMd5: 'other'`, and the size-mismatched duplicate is adopted (`expected 'done' to be 'failed'`).

- [ ] **Step 3: Implement.**

`src/sync/content-compare.ts` (modify):

```diff
diff --git a/src/sync/content-compare.ts b/src/sync/content-compare.ts
index a394b53..c59b496 100644
--- a/src/sync/content-compare.ts
+++ b/src/sync/content-compare.ts
@@ -2,11 +2,6 @@ import { ValidationError } from '../errors.js';
 import type { ContentHash, RemoteItem } from './remote/sync-remote.js';
 import type { LocalDigests, RemoteEntry, SyncRecord } from './types.js';
 
-/** The item's md5, or null when it reports none (or another hash kind). */
-export function md5Of(item: RemoteItem): string | null {
-  return md5Value(item.hash);
-}
-
 /** The value of an md5 hash; null for none or another kind. */
 export function md5Value(hash: ContentHash | null): string | null {
   return hash?.kind === 'md5' ? hash.value : null;
```

`src/sync/executor.ts` (modify):

```diff
diff --git a/src/sync/executor.ts b/src/sync/executor.ts
index fb2dd8a..57e4861 100644
--- a/src/sync/executor.ts
+++ b/src/sync/executor.ts
@@ -3,7 +3,7 @@ import path from 'node:path';
 import type { AuditOp, AuditSink } from '../audit/audit-log.js';
 import { AppError, ExportTooLargeError, hasErrorCode } from '../errors.js';
 import type { Logger } from '../logger.js';
-import { md5Of, md5Value, remoteUnchangedSince } from './content-compare.js';
+import { md5Value, remoteUnchangedSince, sameContent } from './content-compare.js';
 import {
   CollisionError,
   LocalEditKeptError,
@@ -23,9 +23,10 @@ import {
   putRecord,
   statOf,
   type LocalFields,
+  type RemoteFields,
 } from './exec-records.js';
 import { exportNew, exportOver, exportReplace, type ExportHost } from './exec-export.js';
-import { md5File } from './local-scanner.js';
+import { defaultDigesters, hashFileDigests, type DigesterFactory } from './local-scanner.js';
 import { absInside, baseName, parentKey, prepareParent } from './paths.js';
 import { RemoteFolders } from './remote-folders.js';
 import type { RemoteItem, SyncRemote } from './remote/sync-remote.js';
@@ -35,6 +36,7 @@ import {
   type Action,
   type ActionKind,
   type ActionOutcome,
+  type LocalDigests,
   type LocalEntry,
   type PairFile,
   type RemoteEntry,
@@ -65,6 +67,8 @@ export interface ExecutorDeps {
   save: (file: PairFile) => Promise<void>;
   /** Moves local files to the OS trash (tests pass a fake). */
   trash: LocalTrash;
+  /** Local digests of the remote's hash kind (default: built-in digesters). */
+  digesters?: DigesterFactory;
 }
 
 /** Executes a plan in spec §7 order, persisting the pair file after every success. */
@@ -79,6 +83,10 @@ export class Executor {
     this.folders = new RemoteFolders(deps, file.pair, folders);
   }
 
+  private get digesters(): DigesterFactory {
+    return this.deps.digesters ?? defaultDigesters;
+  }
+
   private get pair(): PairFile['pair'] {
     return this.file.pair;
   }
@@ -274,9 +282,24 @@ export class Executor {
 
   // ---- uploads ----------------------------------------------------------------------
 
+  /** The planned local content; actions built without digests carry the md5 alone. */
+  private plannedDigests(action: Action): LocalDigests {
+    if (action.localDigests) return action.localDigests;
+    const md5 = need(action.localMd5, 'local md5');
+    return {
+      md5,
+      remote: this.deps.remote.hashKind === 'md5' ? { kind: 'md5', value: md5 } : null,
+    };
+  }
+
+  /** Only a hash that differs warns; a missing or other-kind hash is not a warning (§3.2). */
+  private changedDuringUpload(planned: LocalDigests, fields: RemoteFields): string | undefined {
+    return sameContent(planned, fields.hash) === false ? 'changed-during-upload' : undefined;
+  }
+
   private async upload(action: Action): Promise<Partial<ActionOutcome>> {
     const local = need(action.local, 'local');
-    const planned = need(action.localMd5, 'local md5');
+    const planned = this.plannedDigests(action);
     const parentId = await this.folders.folderFor(parentKey(action.key));
     const abs = absInside(this.pair.localDir, local.name);
     const name = baseName(action.key);
@@ -285,18 +308,16 @@ export class Executor {
       uploaded = await this.deps.remote.uploadNew(parentId, name, abs);
     } catch (err) {
       if (isAbortError(err)) throw err;
-      const adopted = await this.findDuplicateUpload(parentId, name, planned);
+      const adopted = await this.findDuplicateUpload(parentId, name, planned, local.size);
       if (!adopted) throw err;
       uploaded = adopted;
     }
     const remote = fromRemote(uploaded, parentId);
-    const uploadedMd5 = md5Value(remote.hash);
-    const warning =
-      uploadedMd5 !== null && uploadedMd5 !== planned ? 'changed-during-upload' : undefined;
+    const warning = this.changedDuringUpload(planned, remote);
     await this.commit(action, () =>
       putRecord(
         this.file,
-        makeRecord(action.key, this.localFields(local, uploadedMd5 ?? planned), remote),
+        makeRecord(action.key, this.localFields(local, planned.md5), remote),
         action.rebaseFrom,
       ),
     );
@@ -304,11 +325,15 @@ export class Executor {
     return warning ? { warning } : {};
   }
 
-  /** After an upload error: a same-name, same-md5 file created within 10 minutes is ours (spec §7). */
+  /**
+   * After an upload error: a same-name file with the planned size and content, created
+   * within 10 minutes, is ours (spec §7; OneDrive sync spec §3.2).
+   */
   private async findDuplicateUpload(
     parentId: string,
     name: string,
-    md5: string,
+    planned: LocalDigests,
+    size: number,
   ): Promise<RemoteItem | null> {
     try {
       const list = await this.deps.remote.findChildren(parentId, name);
@@ -316,7 +341,8 @@ export class Executor {
       return (
         list.find(
           (f) =>
-            md5Of(f) === md5 &&
+            f.size === size &&
+            sameContent(planned, f.hash) === true &&
             f.name === name &&
             Math.abs(now - Date.parse(f.createdTime)) <= DUPLICATE_WINDOW_MS,
         ) ?? null
@@ -329,20 +355,15 @@ export class Executor {
 
   private async updateRemote(action: Action): Promise<Partial<ActionOutcome>> {
     const local = need(action.local, 'local');
-    const planned = need(action.localMd5, 'local md5');
+    const planned = this.plannedDigests(action);
     const remote = need(action.remote, 'remote');
     const current = await this.verifyRemote(remote);
     const abs = absInside(this.pair.localDir, local.name);
     const updated = await this.deps.remote.replaceContent(current, abs);
     const fields = fromRemote(updated, remote.parentId);
-    const updatedMd5 = md5Value(fields.hash);
-    const warning =
-      updatedMd5 !== null && updatedMd5 !== planned ? 'changed-during-upload' : undefined;
+    const warning = this.changedDuringUpload(planned, fields);
     await this.commit(action, () =>
-      putRecord(
-        this.file,
-        makeRecord(action.key, this.localFields(local, updatedMd5 ?? planned), fields),
-      ),
+      putRecord(this.file, makeRecord(action.key, this.localFields(local, planned.md5), fields)),
     );
     await this.audit('sync_update', action, remote.id);
     return warning ? { warning } : {};
@@ -424,7 +445,7 @@ export class Executor {
   private async conflict(action: Action): Promise<Partial<ActionOutcome>> {
     const local = need(action.local, 'local');
     const remote = need(action.remote, 'remote');
-    const planned = need(action.localMd5, 'local md5');
+    const planned = this.plannedDigests(action);
     const abs = absInside(this.pair.localDir, local.name);
     const at = this.deps.clock();
     const base = path.basename(abs);
@@ -453,20 +474,12 @@ export class Executor {
     const current = await this.verifyRemote(remote);
     const updated = await this.deps.remote.replaceContent(current, abs);
     const fields = fromRemote(updated, remote.parentId);
-    const updatedMd5 = md5Value(fields.hash);
+    const warning = this.changedDuringUpload(planned, fields);
     await this.commit(action, () =>
-      putRecord(
-        this.file,
-        makeRecord(action.key, this.localFields(local, updatedMd5 ?? planned), fields),
-      ),
+      putRecord(this.file, makeRecord(action.key, this.localFields(local, planned.md5), fields)),
     );
     await this.audit('sync_update', action, remote.id);
-    return {
-      conflictCopy,
-      ...(updatedMd5 !== null && updatedMd5 !== planned
-        ? { warning: 'changed-during-upload' }
-        : {}),
-    };
+    return { conflictCopy, ...(warning ? { warning } : {}) };
   }
 
   // ---- deletions --------------------------------------------------------------------
@@ -500,7 +513,7 @@ export class Executor {
     const abs = absInside(this.pair.localDir, local.name);
     let md5: string;
     try {
-      md5 = await md5File(abs);
+      md5 = (await hashFileDigests(abs, 'md5', this.digesters)).md5;
     } catch (err) {
       if (hasErrorCode(err, 'ENOENT'))
         throw new TargetChangedError(`${action.key} is already gone`);
```

- [ ] **Step 4: Run it and watch it pass.**

Run: `npx vitest run src/sync/__tests__/executor.test.ts`

Expected: PASS (every test in the files passes).

- [ ] **Step 5: Format and run the whole check.**

Run: `npx prettier --write src/sync/__tests__/executor.test.ts src/sync/content-compare.ts src/sync/executor.ts` then `npm run check`

Expected: exit 0, `Test Files  128 passed (128); Tests  1363 passed | 6 skipped (1369)`.

- [ ] **Step 6: Commit.**

```bash
git add src/sync/__tests__/executor.test.ts src/sync/content-compare.ts src/sync/executor.ts
git commit -F - <<'MSG'
feat(sync): uploads compare through sameContent; localMd5 is always local

changed-during-upload warns only when sameContent is false (no hash: quiet).
The duplicate-upload check matches the planned size and sameContent. Records
take the planned local md5 after an upload, never the remote's value (this
changes the changed-during-upload record from the remote md5 to the local one,
as OneDrive sync spec §3.1 asks). trash-local re-hashes with hashFileDigests.
md5Of is gone.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
MSG
```

### Task 18: Downloads verify the remote hash kind and size

**Spec:** §3.3 (`expected: ContentHash | null`, `expectedSize`, mismatch fails the action, both providers). Commit `d9384a3` on the reference branch.

**Files:**
- Test: `src/sync/__tests__/executor.test.ts`
- Test: `src/sync/__tests__/transfer.test.ts`
- Modify: `src/sync/content-compare.ts`
- Modify: `src/sync/errors.ts`
- Modify: `src/sync/exec-export.ts`
- Modify: `src/sync/executor.ts`
- Modify: `src/sync/transfer.ts`

- [ ] **Step 1: Write the failing test (and its setup).**

`src/sync/__tests__/executor.test.ts` (modify):

```diff
diff --git a/src/sync/__tests__/executor.test.ts b/src/sync/__tests__/executor.test.ts
index 7b7aa4b..4a97287 100644
--- a/src/sync/__tests__/executor.test.ts
+++ b/src/sync/__tests__/executor.test.ts
@@ -512,6 +512,19 @@ describe('Executor', () => {
     expect(saves).toEqual([]);
   });
 
+  it('fails a download whose size differs from the remote size; nothing is placed', async () => {
+    serve('R');
+    const r = remote('r1', 'a.pdf', 'R', { size: 7 });
+    const out = await executor(pairFile([], ['a.pdf'])).run([
+      action('download-new', 'a.pdf', { remote: r }),
+    ]);
+    expect(out[0]).toMatchObject({
+      status: 'failed',
+      message: expect.stringMatching(/7 bytes, got 1/),
+    });
+    expect(await readdir(dir)).toEqual([]);
+  });
+
   it('isolates failures and aborts on run-ending errors', async () => {
     const a = await put('a.pdf', 'A');
     const b = await put('b.pdf', 'B');
```

`src/sync/__tests__/transfer.test.ts` (modify):

```diff
diff --git a/src/sync/__tests__/transfer.test.ts b/src/sync/__tests__/transfer.test.ts
index d7504ac..a9e48c1 100644
--- a/src/sync/__tests__/transfer.test.ts
+++ b/src/sync/__tests__/transfer.test.ts
@@ -4,7 +4,13 @@ import os from 'node:os';
 import path from 'node:path';
 import { Readable } from 'node:stream';
 import { afterEach, beforeEach, describe, expect, it } from 'vitest';
-import { ChecksumMismatchError, CollisionError, TargetChangedError } from '../errors.js';
+import {
+  ChecksumMismatchError,
+  CollisionError,
+  SizeMismatchError,
+  TargetChangedError,
+} from '../errors.js';
+import { md5Hash } from './fixtures.js';
 import {
   downloadReplace,
   moveLocal,
@@ -36,7 +42,7 @@ async function leftovers(): Promise<string[]> {
 describe('placeExclusive', () => {
   it('writes a new file and verifies md5', async () => {
     const out = await placeExclusive(dir, () => 'a.pdf', source('hello'), {
-      expectedMd5: md5('hello'),
+      expected: md5Hash(md5('hello')),
     });
     expect(out).toEqual({ path: path.join(dir, 'a.pdf'), md5: md5('hello'), size: 5 });
     expect(await readFile(out.path, 'utf8')).toBe('hello');
@@ -61,11 +67,34 @@ describe('placeExclusive', () => {
 
   it('removes the temp file on a checksum mismatch', async () => {
     await expect(
-      placeExclusive(dir, () => 'a.pdf', source('hello'), { expectedMd5: 'nope' }),
+      placeExclusive(dir, () => 'a.pdf', source('hello'), { expected: md5Hash('nope') }),
     ).rejects.toBeInstanceOf(ChecksumMismatchError);
     expect(await readdir(dir)).toEqual([]);
   });
 
+  it('removes the temp file on a size mismatch', async () => {
+    await expect(
+      placeExclusive(dir, () => 'a.pdf', source('hello'), { expectedSize: 4 }),
+    ).rejects.toBeInstanceOf(SizeMismatchError);
+    expect(await readdir(dir)).toEqual([]);
+  });
+
+  it('verifies a non-md5 remote hash with the injected digester, md5 still returned', async () => {
+    const digesters = () => ({ update: () => {}, digest: () => 'QX' });
+    const out = await placeExclusive(dir, () => 'a.pdf', source('hello'), {
+      expected: { kind: 'quickXor', value: 'QX' },
+      digesters,
+    });
+    expect(out.md5).toBe(md5('hello'));
+    await expect(
+      placeExclusive(dir, () => 'b.pdf', source('hello'), {
+        expected: { kind: 'quickXor', value: 'other' },
+        digesters,
+      }),
+    ).rejects.toThrow('expected quickXor other, got QX');
+    expect(await leftovers()).toEqual([]);
+  });
+
   it('falls back to exists-check + rename where hard links are unsupported', async () => {
     const noLink = async (): Promise<void> => {
       throw Object.assign(new Error('nope'), { code: 'ENOTSUP' });
@@ -84,7 +113,7 @@ describe('downloadReplace', () => {
     await writeFile(target, 'old');
     const res = await downloadReplace(target, source('new'), {
       expect: await statOf(target),
-      expectedMd5: md5('new'),
+      expected: md5Hash(md5('new')),
     });
     expect(res).toEqual({ md5: md5('new'), size: 3 });
     expect(await readFile(target, 'utf8')).toBe('new');
@@ -97,7 +126,7 @@ describe('downloadReplace', () => {
     const expect0 = await statOf(target);
     await writeFile(target, 'edited!');
     await expect(
-      downloadReplace(target, source('new'), { expect: expect0, expectedMd5: null }),
+      downloadReplace(target, source('new'), { expect: expect0 }),
     ).rejects.toBeInstanceOf(TargetChangedError);
     expect(await readFile(target, 'utf8')).toBe('edited!');
   });
@@ -110,18 +139,31 @@ describe('downloadReplace', () => {
       await writeFile(target, 'edited during download');
       return Readable.from([Buffer.from('new')]);
     };
-    await expect(
-      downloadReplace(target, racing, { expect: expect0, expectedMd5: null }),
-    ).rejects.toBeInstanceOf(TargetChangedError);
+    await expect(downloadReplace(target, racing, { expect: expect0 })).rejects.toBeInstanceOf(
+      TargetChangedError,
+    );
     expect(await readFile(target, 'utf8')).toBe('edited during download');
     expect(await leftovers()).toEqual([]);
   });
 
+  it('keeps the old file on a size mismatch', async () => {
+    const target = path.join(dir, 'a.pdf');
+    await writeFile(target, 'old');
+    await expect(
+      downloadReplace(target, source('new'), { expect: await statOf(target), expectedSize: 9 }),
+    ).rejects.toBeInstanceOf(SizeMismatchError);
+    expect(await readFile(target, 'utf8')).toBe('old');
+    expect(await leftovers()).toEqual([]);
+  });
+
   it('keeps the old file on a checksum mismatch', async () => {
     const target = path.join(dir, 'a.pdf');
     await writeFile(target, 'old');
     await expect(
-      downloadReplace(target, source('new'), { expect: await statOf(target), expectedMd5: 'x' }),
+      downloadReplace(target, source('new'), {
+        expect: await statOf(target),
+        expected: md5Hash('x'),
+      }),
     ).rejects.toBeInstanceOf(ChecksumMismatchError);
     expect(await readFile(target, 'utf8')).toBe('old');
   });
```

- [ ] **Step 2: Run it and watch it fail.**

Run: `npx vitest run src/sync/__tests__/transfer.test.ts src/sync/__tests__/executor.test.ts`

Expected: FAIL. The old `placeExclusive`/`downloadReplace` ignore `expected` and `expectedSize`, so the mismatch tests fail with `promise resolved "{ …(3) }" instead of rejecting` and the executor size test ends `done` instead of `failed`.

- [ ] **Step 3: Implement.**

`src/sync/content-compare.ts` (modify):

```diff
diff --git a/src/sync/content-compare.ts b/src/sync/content-compare.ts
index c59b496..97b8eed 100644
--- a/src/sync/content-compare.ts
+++ b/src/sync/content-compare.ts
@@ -2,11 +2,6 @@ import { ValidationError } from '../errors.js';
 import type { ContentHash, RemoteItem } from './remote/sync-remote.js';
 import type { LocalDigests, RemoteEntry, SyncRecord } from './types.js';
 
-/** The value of an md5 hash; null for none or another kind. */
-export function md5Value(hash: ContentHash | null): string | null {
-  return hash?.kind === 'md5' ? hash.value : null;
-}
-
 /** Equal hashes, or both missing (record bookkeeping: did the remote's hash change?). */
 export function sameHashOrNone(a: ContentHash | null, b: ContentHash | null): boolean {
   if (a === null || b === null) return a === b;
```

`src/sync/errors.ts` (modify):

```diff
diff --git a/src/sync/errors.ts b/src/sync/errors.ts
index 55721fb..f929492 100644
--- a/src/sync/errors.ts
+++ b/src/sync/errors.ts
@@ -1,3 +1,4 @@
+import type { HashKind } from './remote/sync-remote.js';
 import {
   ApiDisabledError,
   AppError,
@@ -28,8 +29,17 @@ export class TargetChangedError extends AppError {
 export class ChecksumMismatchError extends AppError {
   readonly code = 'SYNC_CHECKSUM_MISMATCH';
 
-  constructor(what: string, expected: string, actual: string) {
-    super(`${what}: expected md5 ${expected}, got ${actual}`);
+  constructor(what: string, expected: string, actual: string, kind: HashKind = 'md5') {
+    super(`${what}: expected ${kind} ${expected}, got ${actual}`);
+  }
+}
+
+/** Downloaded bytes differ in length from the size the remote reported (spec §3.3). */
+export class SizeMismatchError extends AppError {
+  readonly code = 'SYNC_SIZE_MISMATCH';
+
+  constructor(what: string, expected: number, actual: number) {
+    super(`${what}: expected ${expected} bytes, got ${actual}`);
   }
 }
```

`src/sync/exec-export.ts` (modify):

```diff
diff --git a/src/sync/exec-export.ts b/src/sync/exec-export.ts
index 59cdfed..6ba3ed1 100644
--- a/src/sync/exec-export.ts
+++ b/src/sync/exec-export.ts
@@ -63,7 +63,7 @@ export async function exportOver(
 ): Promise<{ md5: string; size: number }> {
   const current = await reread(host, remote);
   return host.remote.exportNative(current, planOf(remote), (open) =>
-    downloadReplace(abs, open, { expect, expectedMd5: null }),
+    downloadReplace(abs, open, { expect }),
   );
 }
```

`src/sync/executor.ts` (modify):

```diff
diff --git a/src/sync/executor.ts b/src/sync/executor.ts
index 57e4861..34914ce 100644
--- a/src/sync/executor.ts
+++ b/src/sync/executor.ts
@@ -3,7 +3,7 @@ import path from 'node:path';
 import type { AuditOp, AuditSink } from '../audit/audit-log.js';
 import { AppError, ExportTooLargeError, hasErrorCode } from '../errors.js';
 import type { Logger } from '../logger.js';
-import { md5Value, remoteUnchangedSince, sameContent } from './content-compare.js';
+import { remoteUnchangedSince, sameContent } from './content-compare.js';
 import {
   CollisionError,
   LocalEditKeptError,
@@ -30,7 +30,7 @@ import { defaultDigesters, hashFileDigests, type DigesterFactory } from './local
 import { absInside, baseName, parentKey, prepareParent } from './paths.js';
 import { RemoteFolders } from './remote-folders.js';
 import type { RemoteItem, SyncRemote } from './remote/sync-remote.js';
-import { downloadReplace, moveLocal, placeExclusive } from './transfer.js';
+import { downloadReplace, moveLocal, placeExclusive, type DownloadCheck } from './transfer.js';
 import type { LocalTrash } from './trash.js';
 import {
   type Action,
@@ -282,6 +282,11 @@ export class Executor {
 
   // ---- uploads ----------------------------------------------------------------------
 
+  /** A download must match R's hash and size (OneDrive sync spec §3.3). */
+  private check(remote: RemoteEntry): DownloadCheck {
+    return { expected: remote.hash, expectedSize: remote.size, digesters: this.digesters };
+  }
+
   /** The planned local content; actions built without digests carry the md5 alone. */
   private plannedDigests(action: Action): LocalDigests {
     if (action.localDigests) return action.localDigests;
@@ -401,7 +406,7 @@ export class Executor {
     const written = remote.native
       ? await exportOver(this.host(), to, expect, remote)
       : await this.deps.remote.download(remote.id, (open) =>
-          downloadReplace(to, open, { expect, expectedMd5: md5Value(remote.hash) }),
+          downloadReplace(to, open, { expect, ...this.check(remote) }),
         );
     const after = await this.statFields(action.key, written.md5);
     putRecord(this.file, makeRecord(action.key, after, fromEntry(remote)));
@@ -415,7 +420,7 @@ export class Executor {
     const abs = await prepareParent(this.pair.localDir, action.key);
     const written = await this.deps.remote.download(remote.id, (open) =>
       placeExclusive(path.dirname(abs), () => path.basename(abs), open, {
-        expectedMd5: md5Value(remote.hash),
+        ...this.check(remote),
       }),
     );
     const local = await this.statFields(action.key, written.md5);
@@ -431,7 +436,7 @@ export class Executor {
     const remote = need(action.remote, 'remote');
     const abs = absInside(this.pair.localDir, local.name);
     const written = await this.deps.remote.download(remote.id, (open) =>
-      downloadReplace(abs, open, { expect: statOf(local), expectedMd5: md5Value(remote.hash) }),
+      downloadReplace(abs, open, { expect: statOf(local), ...this.check(remote) }),
     );
     const after = await this.statFields(local.name, written.md5);
     await this.commit(action, () =>
@@ -451,7 +456,7 @@ export class Executor {
     const base = path.basename(abs);
     const copy = await this.deps.remote.download(remote.id, (open) =>
       placeExclusive(path.dirname(abs), (i) => conflictName(base, at, i), open, {
-        expectedMd5: md5Value(remote.hash),
+        ...this.check(remote),
         maxAttempts: MAX_CONFLICT_NAMES,
       }),
     );
```

`src/sync/transfer.ts` (modify):

```diff
diff --git a/src/sync/transfer.ts b/src/sync/transfer.ts
index 1127e17..848dcfc 100644
--- a/src/sync/transfer.ts
+++ b/src/sync/transfer.ts
@@ -3,8 +3,15 @@ import { link as fsLink, lstat, open, readdir, rename, rm, unlink } from 'node:f
 import path from 'node:path';
 import type { Readable } from 'node:stream';
 import { hasErrorCode } from '../errors.js';
-import { ChecksumMismatchError, CollisionError, TargetChangedError } from './errors.js';
+import {
+  ChecksumMismatchError,
+  CollisionError,
+  SizeMismatchError,
+  TargetChangedError,
+} from './errors.js';
+import { defaultDigesters, type DigesterFactory } from './local-scanner.js';
 import { PART_SUFFIX } from './paths.js';
+import type { ContentHash } from './remote/sync-remote.js';
 import { renameReplacing } from '../files/rename-replacing.js';
 
 export type LinkFn = (existingPath: string, newPath: string) => Promise<void>;
@@ -33,19 +40,39 @@ async function exists(p: string): Promise<boolean> {
   }
 }
 
-/** Streams `source` into a fresh `.<uuid>.marvin-part` in `dir`, hashing and fsyncing it. */
+/** What a download must match (OneDrive sync spec §3.3); null/undefined: no check. */
+export interface DownloadCheck {
+  /** The remote's hash: md5 is always computed, another kind through `digesters`. */
+  expected?: ContentHash | null;
+  /** The remote's size; a different byte count fails the write. */
+  expectedSize?: number | null;
+  digesters?: DigesterFactory;
+}
+
+/**
+ * Streams `source` into a fresh `.<uuid>.marvin-part` in `dir`, hashing and fsyncing it,
+ * then checks it against `check`. On a mismatch or error the temp file is removed.
+ */
 async function writeTemp(
   dir: string,
   source: Readable,
+  what: string,
+  check: DownloadCheck,
 ): Promise<{ tmp: string; md5: string; size: number }> {
   const tmp = path.join(dir, `.${randomUUID()}${PART_SUFFIX}`);
   const handle = await open(tmp, 'wx', 0o644);
   const hash = createHash('md5');
+  const expected = check.expected ?? null;
+  const other =
+    expected !== null && expected.kind !== 'md5'
+      ? (check.digesters ?? defaultDigesters)(expected.kind)
+      : null;
   let size = 0;
   try {
     for await (const chunk of source) {
       const buf = typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer);
       hash.update(buf);
+      other?.update(buf);
       size += buf.length;
       await handle.write(buf);
     }
@@ -57,7 +84,23 @@ async function writeTemp(
     throw err;
   }
   await handle.close();
-  return { tmp, md5: hash.digest('hex'), size };
+  const md5 = hash.digest('hex');
+  try {
+    if (expected !== null) {
+      const actual = other ? other.digest() : md5;
+      if (actual !== expected.value) {
+        throw new ChecksumMismatchError(what, expected.value, actual, expected.kind);
+      }
+    }
+    const expectedSize = check.expectedSize ?? null;
+    if (expectedSize !== null && size !== expectedSize) {
+      throw new SizeMismatchError(what, expectedSize, size);
+    }
+  } catch (err) {
+    await rm(tmp, { force: true });
+    throw err;
+  }
+  return { tmp, md5, size };
 }
 
 /** fsync a directory so a new entry survives a crash (best effort where unsupported). */
@@ -95,9 +138,7 @@ export async function assertUnchanged(target: string, expect: StatExpect): Promi
   }
 }
 
-export interface PlaceOptions {
-  /** Verify the written bytes (null/undefined: no check). */
-  expectedMd5?: string | null;
+export interface PlaceOptions extends DownloadCheck {
   /** Names tried: nameFor(0), nameFor(1)…; default 1 (plain exclusive create). */
   maxAttempts?: number;
   link?: LinkFn;
@@ -114,11 +155,8 @@ export async function placeExclusive(
   opts: PlaceOptions = {},
 ): Promise<Written> {
   const link = opts.link ?? fsLink;
-  const { tmp, md5, size } = await writeTemp(dir, await openSource());
+  const { tmp, md5, size } = await writeTemp(dir, await openSource(), nameFor(0), opts);
   try {
-    if (opts.expectedMd5 && md5 !== opts.expectedMd5) {
-      throw new ChecksumMismatchError(nameFor(0), opts.expectedMd5, md5);
-    }
     const attempts = opts.maxAttempts ?? 1;
     for (let i = 0; i < attempts; i++) {
       const target = path.join(dir, nameFor(i));
@@ -146,14 +184,16 @@ export async function placeExclusive(
 export async function downloadReplace(
   target: string,
   openSource: () => Promise<Readable>,
-  opts: { expect: StatExpect; expectedMd5: string | null },
+  opts: DownloadCheck & { expect: StatExpect },
 ): Promise<{ md5: string; size: number }> {
   await assertUnchanged(target, opts.expect);
-  const { tmp, md5, size } = await writeTemp(path.dirname(target), await openSource());
+  const { tmp, md5, size } = await writeTemp(
+    path.dirname(target),
+    await openSource(),
+    target,
+    opts,
+  );
   try {
-    if (opts.expectedMd5 && md5 !== opts.expectedMd5) {
-      throw new ChecksumMismatchError(target, opts.expectedMd5, md5);
-    }
     await assertUnchanged(target, opts.expect);
     await renameReplacing(tmp, target);
   } finally {
```

- [ ] **Step 4: Run it and watch it pass.**

Run: `npx vitest run src/sync/__tests__/transfer.test.ts src/sync/__tests__/executor.test.ts`

Expected: PASS (every test in the files passes).

- [ ] **Step 5: Format and run the whole check.**

Run: `npx prettier --write src/sync/__tests__/executor.test.ts src/sync/__tests__/transfer.test.ts src/sync/content-compare.ts src/sync/errors.ts src/sync/exec-export.ts src/sync/executor.ts src/sync/transfer.ts` then `npm run check`

Expected: exit 0, `Test Files  128 passed (128); Tests  1367 passed | 6 skipped (1373)`.

- [ ] **Step 6: Commit.**

```bash
git add src/sync/__tests__/executor.test.ts src/sync/__tests__/transfer.test.ts src/sync/content-compare.ts src/sync/errors.ts src/sync/exec-export.ts src/sync/executor.ts src/sync/transfer.ts
git commit -F - <<'MSG'
feat(sync): downloads verify the remote hash kind and size

writeTemp takes expected (ContentHash) and expectedSize. It always computes md5
for the record and the expected kind through the digesters; a hash or size
mismatch removes the temp file and fails the action (SizeMismatchError is new,
for both providers). md5Value is gone.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
MSG
```

### Task 19: Release re-hashes the local copy in the remote's hash kind

**Spec:** §3.1 (release `verifyLocal` through `hashFileDigests`). Commit `daa7b9b` on the reference branch.

**Files:**
- Test: `src/sync/__tests__/local-scanner.test.ts`
- Test: `src/sync/__tests__/release.test.ts`
- Modify: `src/sync/local-scanner.ts`
- Modify: `src/sync/release.ts`
- Modify: `src/sync/sync-service.ts`

- [ ] **Step 1: Write the failing test (and its setup).**

`src/sync/__tests__/local-scanner.test.ts` (modify):

```diff
diff --git a/src/sync/__tests__/local-scanner.test.ts b/src/sync/__tests__/local-scanner.test.ts
index e6988eb..c3a5f91 100644
--- a/src/sync/__tests__/local-scanner.test.ts
+++ b/src/sync/__tests__/local-scanner.test.ts
@@ -5,7 +5,7 @@ import os from 'node:os';
 import path from 'node:path';
 import { afterEach, beforeEach, describe, expect, it } from 'vitest';
 import { linkDir, linkFileOrSkip } from '../../__tests__/links.js';
-import { hashFileDigests, hashLocal, md5File, probeOnDisk, scanLocal } from '../local-scanner.js';
+import { hashFileDigests, hashLocal, probeOnDisk, scanLocal } from '../local-scanner.js';
 
 const NFD = 'şartname.pdf'.normalize('NFD');
 const isRoot = process.getuid?.() === 0;
@@ -115,7 +115,6 @@ describe('hashing', () => {
   it('computes md5 and reports failures', async () => {
     await writeFile(path.join(root, 'a.txt'), 'hello');
     const expected = createHash('md5').update('hello').digest('hex');
-    expect(await md5File(path.join(root, 'a.txt'))).toBe(expected);
     const { digests, failed } = await hashLocal(root, ['a.txt', 'gone.txt'], 'md5');
     expect(digests.get('a.txt')).toEqual({
       md5: expected,
```

`src/sync/__tests__/release.test.ts` (modify):

```diff
diff --git a/src/sync/__tests__/release.test.ts b/src/sync/__tests__/release.test.ts
index d01dd9e..4876838 100644
--- a/src/sync/__tests__/release.test.ts
+++ b/src/sync/__tests__/release.test.ts
@@ -1,4 +1,9 @@
+import { createHash } from 'node:crypto';
+import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
+import os from 'node:os';
+import path from 'node:path';
 import { describe, expect, it } from 'vitest';
+import type { SyncRemote } from '../remote/sync-remote.js';
 import { createAudit, createFakeDrive, silentLogger } from '../../files/__tests__/fakes.js';
 import { applyRelease, selectReleasable, type ReleaseSelection } from '../release.js';
 import { binary } from './drive-tree.js';
@@ -8,6 +13,7 @@ import {
   makePairFile,
   nativeEntry,
   nativeRecord,
+  dirTrash,
   record,
   refuseTrash,
   remoteEntry,
@@ -179,3 +185,57 @@ describe('applyRelease re-reads R through the remote', () => {
     expect(drive.getFile).toHaveBeenCalledWith('r1', expect.stringContaining('md5Checksum'));
   });
 });
+
+describe('applyRelease re-hashes L with the remote hash kind (spec §3.1)', () => {
+  const md5 = (t: string): string => createHash('md5').update(t).digest('hex');
+  const qx = (t: string): string => `QX-${md5(t)}`;
+  const digesters = () => {
+    const h = createHash('md5');
+    return { update: (c: Buffer) => void h.update(c), digest: () => `QX-${h.digest('hex')}` };
+  };
+
+  async function releaseOnQuickXor(localContent: string) {
+    const dir = await mkdtemp(path.join(os.tmpdir(), 'sync-release-qx-'));
+    const trashDir = await mkdtemp(path.join(os.tmpdir(), 'sync-release-qx-trash-'));
+    try {
+      await writeFile(path.join(dir, 'a.pdf'), localContent);
+      const remote = remoteEntry('r1', 'a.pdf', { hash: { kind: 'quickXor', value: qx('hello') } });
+      const rec = record('r1', 'a.pdf', { localMd5: md5('hello'), remoteHash: remote.hash });
+      const drive = createFakeDrive();
+      drive.getFile.mockResolvedValueOnce(binary('r1', 'a.pdf', remote.parentId));
+      const inner = googleRemoteOver(drive);
+      const fake = Object.assign(Object.create(inner) as SyncRemote, {
+        hashKind: 'quickXor' as const,
+        read: async () => ({ ...(await inner.read('r1')), hash: remote.hash }),
+      });
+      const out = await applyRelease(
+        {
+          remote: fake,
+          digesters,
+          audit: createAudit(),
+          logger: silentLogger(),
+          trash: dirTrash(trashDir),
+          save: async () => {},
+        },
+        makePairFile({ localDir: dir }, [rec]),
+        [{ record: rec, remote, kind: 'present', localName: 'a.pdf' }],
+      );
+      return { out, left: await readdir(dir) };
+    } finally {
+      await rm(dir, { recursive: true, force: true });
+      await rm(trashDir, { recursive: true, force: true });
+    }
+  }
+
+  it('releases when the local quickXor digest equals the remote hash', async () => {
+    const { out, left } = await releaseOnQuickXor('hello');
+    expect(out.released).toEqual([{ path: 'a.pdf', status: 'released' }]);
+    expect(left).toEqual([]);
+  });
+
+  it('refuses when the local content changed', async () => {
+    const { out, left } = await releaseOnQuickXor('edited');
+    expect(out.failed).toEqual([{ path: 'a.pdf', reason: 'a.pdf changed locally since the scan' }]);
+    expect(left).toEqual(['a.pdf']);
+  });
+});
```

- [ ] **Step 2: Run it and watch it fail.**

Run: `npx vitest run src/sync/__tests__/release.test.ts`

Expected: FAIL. 1 failed: `AssertionError: expected [] to deeply equal [ { path: 'a.pdf', …(1) } ]` (the md5-only re-hash cannot match a quickXor remote hash).

- [ ] **Step 3: Implement.**

`src/sync/local-scanner.ts` (modify):

```diff
diff --git a/src/sync/local-scanner.ts b/src/sync/local-scanner.ts
index 306412c..2953639 100644
--- a/src/sync/local-scanner.ts
+++ b/src/sync/local-scanner.ts
@@ -2,7 +2,6 @@ import { createHash } from 'node:crypto';
 import { createReadStream, type Stats } from 'node:fs';
 import { lstat, readdir } from 'node:fs/promises';
 import path from 'node:path';
-import { pipeline } from 'node:stream/promises';
 import { ValidationError, hasErrorCode } from '../errors.js';
 import { PART_SUFFIX, absInside, ancestorKeys, foldKey, isIgnoredName, toKey } from './paths.js';
 import type { HashKind } from './remote/sync-remote.js';
@@ -180,12 +179,6 @@ async function blockedByNonDirectory(
   return false;
 }
 
-export async function md5File(abs: string): Promise<string> {
-  const hash = createHash('md5');
-  await pipeline(createReadStream(abs), hash);
-  return hash.digest('hex');
-}
-
 /** Digests of the given on-disk relative names; failures are returned, not thrown. */
 export async function hashLocal(
   root: string,
```

`src/sync/release.ts` (modify):

```diff
diff --git a/src/sync/release.ts b/src/sync/release.ts
index 1798201..c4ffe27 100644
--- a/src/sync/release.ts
+++ b/src/sync/release.ts
@@ -5,7 +5,7 @@ import { AppError, hasErrorCode } from '../errors.js';
 import type { Logger } from '../logger.js';
 import { localMatchesRemote, remoteChanged, remoteUnchangedSince } from './content-compare.js';
 import { isAbortError, messageOf, PersistenceError, TargetChangedError } from './errors.js';
-import { md5File } from './local-scanner.js';
+import { defaultDigesters, hashFileDigests, type DigesterFactory } from './local-scanner.js';
 import { absInside, baseName, foldKey, parentKey, toKey, validateRelPath } from './paths.js';
 import { TYPE_CHANGED } from './plan-tracked.js';
 import type { SyncRemote } from './remote/sync-remote.js';
@@ -158,6 +158,8 @@ export async function withoutTrash(
 export interface ReleaseDeps {
   /** The pair's remote. */
   remote: SyncRemote;
+  /** Local digests of the remote's hash kind (default: built-in digesters). */
+  digesters?: DigesterFactory;
   audit: AuditSink;
   logger: Logger;
   trash: LocalTrash;
@@ -182,15 +184,21 @@ async function verifyRemote(deps: ReleaseDeps, planned: RemoteEntry): Promise<vo
   }
 }
 
-/** Present: L re-hashed must equal the record (binary: and R's md5) — never trash an edit. */
-async function verifyLocal(abs: string, c: ReleaseCandidate): Promise<void> {
+/**
+ * Present: L re-hashed must equal the record (md5) and, for a binary file, R's hash in R's
+ * kind — never trash an edit.
+ */
+async function verifyLocal(deps: ReleaseDeps, abs: string, c: ReleaseCandidate): Promise<void> {
   const key = c.record.path;
-  const md5 = await md5File(abs).catch((err: unknown) => {
+  const digests = await hashFileDigests(
+    abs,
+    deps.remote.hashKind,
+    deps.digesters ?? defaultDigesters,
+  ).catch((err: unknown) => {
     if (hasErrorCode(err, 'ENOENT')) throw new TargetChangedError(`${key} is already gone`);
     throw err;
   });
-  const digests = { md5, remote: { kind: 'md5' as const, value: md5 } };
-  if (md5 !== c.record.localMd5 || !localMatchesRemote(digests, c.record, c.remote)) {
+  if (digests.md5 !== c.record.localMd5 || !localMatchesRemote(digests, c.record, c.remote)) {
     throw new TargetChangedError(`${key} changed locally since the scan`);
   }
 }
@@ -281,7 +289,7 @@ export async function applyRelease(
       if (c.kind === 'present') {
         name = c.localName ?? key;
         abs = absInside(pair.localDir, name);
-        await verifyLocal(abs, c);
+        await verifyLocal(deps, abs, c);
       } else {
         await assertStillAbsent(pair, key);
       }
```

`src/sync/sync-service.ts` (modify):

```diff
diff --git a/src/sync/sync-service.ts b/src/sync/sync-service.ts
index aaa8a76..69f38f1 100644
--- a/src/sync/sync-service.ts
+++ b/src/sync/sync-service.ts
@@ -209,6 +209,7 @@ export class SyncService {
       const executor = new Executor(
         {
           remote: this.env.remoteFor(file.pair),
+          digesters: this.env.digesters,
           audit: this.deps.audit,
           logger: this.log,
           clock: this.clock,
@@ -286,6 +287,7 @@ export class SyncService {
       const done = await applyRelease(
         {
           remote: this.env.remoteFor(file.pair),
+          digesters: this.env.digesters,
           audit: this.deps.audit,
           logger: this.log,
           trash: this.deps.trash,
```

- [ ] **Step 4: Run it and watch it pass.**

Run: `npx vitest run src/sync/__tests__/release.test.ts`

Expected: PASS (every test in the files passes).

- [ ] **Step 5: Format and run the whole check.**

Run: `npx prettier --write src/sync/__tests__/local-scanner.test.ts src/sync/__tests__/release.test.ts src/sync/local-scanner.ts src/sync/release.ts src/sync/sync-service.ts` then `npm run check`

Expected: exit 0, `Test Files  128 passed (128); Tests  1369 passed | 6 skipped (1375)`.

- [ ] **Step 6: Commit.**

```bash
git add src/sync/__tests__/local-scanner.test.ts src/sync/__tests__/release.test.ts src/sync/local-scanner.ts src/sync/release.ts src/sync/sync-service.ts
git commit -F - <<'MSG'
feat(sync): release re-hashes the local copy in the remote's hash kind

verifyLocal uses hashFileDigests with the pair remote's kind and compares through
localMatchesRemote, so a non-md5 remote can release by its own hash. The
executor and release get the SyncEnv digesters. md5File is gone; hashFileDigests
is the one hashing helper.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
MSG
```

### Task 20: Review fixes for chunk 1 (a): findChildren contract, signals, quickXor re-verification

**Spec:** review items 1, 3 and 5 (port docs; `remoteUnchangedSince` with a quickXor item). Commit `a5043ec` on the reference branch.

**Files:**
- Test: `src/sync/__tests__/content-compare.test.ts`
- Modify: `src/sync/remote/sync-remote.ts`

- [ ] **Step 1: Write the failing test (and its setup).**

`src/sync/__tests__/content-compare.test.ts` (modify):

```diff
diff --git a/src/sync/__tests__/content-compare.test.ts b/src/sync/__tests__/content-compare.test.ts
index 8fd1472..fed5c7d 100644
--- a/src/sync/__tests__/content-compare.test.ts
+++ b/src/sync/__tests__/content-compare.test.ts
@@ -53,6 +53,14 @@ describe('remoteUnchangedSince', () => {
     );
     expect(remoteUnchangedSince(r, item({ md5Checksum, modifiedTime: LATER }))).toBe(false);
   });
+  it('a quickXor hash compares by kind and value (never always-changed)', () => {
+    const hash = { kind: 'quickXor' as const, value: 'QX' };
+    const r = remoteEntry('r1', 'a.pdf', { hash });
+    const current = { ...item({ modifiedTime: r.modifiedTime }), hash };
+    expect(remoteUnchangedSince(r, current)).toBe(true);
+    expect(remoteUnchangedSince(r, { ...current, hash: { ...hash, value: 'other' } })).toBe(false);
+    expect(remoteUnchangedSince(r, { ...current, hash: { kind: 'md5', value: 'QX' } })).toBe(false);
+  });
   it('native needs modifiedTime equal', () => {
     const r = nativeEntry('g1', 'Plan.docx');
     expect(remoteUnchangedSince(r, item({ modifiedTime: r.modifiedTime }))).toBe(true);
```

- [ ] **Step 2: Run it and watch it fail.**

Run: `npx vitest run src/sync/__tests__/content-compare.test.ts`

Expected: PASS already (the ContentHash work of Tasks 13–19 covers it); this task pins it with a test and fixes the doc comments.

- [ ] **Step 3: Implement.**

`src/sync/remote/sync-remote.ts` (modify):

```diff
diff --git a/src/sync/remote/sync-remote.ts b/src/sync/remote/sync-remote.ts
index c07042c..a8790bd 100644
--- a/src/sync/remote/sync-remote.ts
+++ b/src/sync/remote/sync-remote.ts
@@ -58,6 +58,10 @@ export interface DeletionFeed {
   read(cursor: string): Promise<{ deletedIds: string[]; cursor: string } | { expired: true }>;
 }
 
+/**
+ * Optional `signal` parameters are honoured by OneDrive (stage 3) and ignored by Google,
+ * whose OperationRunner has no cancellation.
+ */
 export interface SyncRemote {
   readonly provider: 'google' | 'microsoft';
   /** The hash kind this remote reports for files. */
@@ -75,7 +79,14 @@ export interface SyncRemote {
     pageToken: string | undefined,
     signal?: AbortSignal,
   ): Promise<{ items: RemoteItem[]; next?: string }>;
-  /** Children whose name folds to `name`'s fold key; the engine decides what to do. */
+  /**
+   * Candidate children named `name`; callers re-check the names they accept.
+   * - Google, `kind: 'folder'`: every folder of the parent (all pages) whose name folds to
+   *   `name`'s fold key.
+   * - Google, files: the first page (100) of Drive's exact-name query, as the duplicate
+   *   upload check always read it; not paged.
+   * - OneDrive (stage 3): every child whose name folds to `name`'s fold key.
+   */
   findChildren(parentId: string, name: string, kind?: 'folder'): Promise<RemoteItem[]>;
   createFolder(parentId: string, name: string): Promise<RemoteItem>;
   uploadNew(parentId: string, name: string, localPath: string): Promise<RemoteItem>;
```

- [ ] **Step 4: Run it and watch it pass.**

Run: `npx vitest run src/sync/__tests__/content-compare.test.ts`

Expected: PASS (every test in the files passes).

- [ ] **Step 5: Format and run the whole check.**

Run: `npx prettier --write src/sync/__tests__/content-compare.test.ts src/sync/remote/sync-remote.ts` then `npm run check`

Expected: exit 0, `Test Files  128 passed (128); Tests  1370 passed | 6 skipped (1376)`.

- [ ] **Step 6: Commit.**

```bash
git add src/sync/__tests__/content-compare.test.ts src/sync/remote/sync-remote.ts
git commit -F - <<'MSG'
docs(sync): per-provider findChildren contract, ignored signals on Google

Review fixes for chunk 1: the port documents what Google's findChildren returns
(all fold-matching folders; the first page of the exact-name file query) and that
the optional signals are honoured by OneDrive only. A test pins that a quickXor
hash compares by kind and value in remoteUnchangedSince.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
MSG
```

### Task 21: Review fixes for chunk 1 (b): a NativeSource exports through any remote

**Spec:** review item 4 (`env.remoteFor` builds one remote per call). Commit `113f376` on the reference branch.

**Files:**
- Test: `src/sync/__tests__/google-remote.test.ts`
- Modify: `src/sync/remote/google-remote.ts`

- [ ] **Step 1: Write the failing test (and its setup).**

`src/sync/__tests__/google-remote.test.ts` (modify):

```diff
diff --git a/src/sync/__tests__/google-remote.test.ts b/src/sync/__tests__/google-remote.test.ts
index 61dfa8e..a699399 100644
--- a/src/sync/__tests__/google-remote.test.ts
+++ b/src/sync/__tests__/google-remote.test.ts
@@ -199,6 +199,22 @@ describe('GoogleSyncRemote writes and content (pinned)', () => {
     expect(drive.downloadMedia.mock.calls).toEqual([['r1'], ['r1']]);
   });
 
+  it('a NativeSource read by one remote instance exports through another', async () => {
+    const drive = createFakeDrive();
+    drive.getFile.mockResolvedValueOnce({ id: 'g1', name: 'Plan', mimeType: GOOGLE_MIME.document });
+    drive.exportMedia.mockResolvedValueOnce(Readable.from([Buffer.from('doc')]));
+    const source = await googleRemoteOver(drive).readNative('g1');
+    const plan = { format: 'docx' as const, extension: 'docx', mimeType: DOCX_MIME };
+    const stream = await googleRemoteOver(drive).exportNative(source, plan, (open) => open());
+    let out = '';
+    for await (const chunk of stream) out += String(chunk);
+    expect(out).toBe('doc');
+    const forged = { item: source.item };
+    await expect(googleRemoteOver(drive).exportNative(forged, plan, (o) => o())).rejects.toThrow(
+      'export source was not read',
+    );
+  });
+
   it('readNative reads the export fields; exportNative exports with them', async () => {
     const drive = createFakeDrive();
     drive.getFile.mockResolvedValueOnce({
```

- [ ] **Step 2: Run it and watch it fail.**

Run: `npx vitest run src/sync/__tests__/google-remote.test.ts`

Expected: FAIL. 1 failed: `ValidationError: Internal: export source was not read by this remote`.

- [ ] **Step 3: Implement.**

`src/sync/remote/google-remote.ts` (modify):

```diff
diff --git a/src/sync/remote/google-remote.ts b/src/sync/remote/google-remote.ts
index 1114819..1290a68 100644
--- a/src/sync/remote/google-remote.ts
+++ b/src/sync/remote/google-remote.ts
@@ -129,6 +129,12 @@ export function toRemoteItem(file: DriveFile, prefs: GoogleExportPrefs): RemoteI
   };
 }
 
+/**
+ * What `exportNative` needs from a `readNative` (the export links), shared by every
+ * GoogleSyncRemote so a source stays usable whichever instance exports it.
+ */
+const NATIVE_FILES = new WeakMap<NativeSource, { id: string; file: DriveFile }>();
+
 /**
  * SyncRemote over the Drive adapter (OneDrive sync spec §2.2). Every call goes through the
  * OperationRunner with the operation kind and target the engine used before the port.
@@ -137,7 +143,6 @@ export class GoogleSyncRemote implements SyncRemote {
   readonly provider = 'google';
   readonly hashKind = 'md5';
   readonly rootId = 'root';
-  private readonly nativeFiles = new WeakMap<NativeSource, { id: string; file: DriveFile }>();
 
   constructor(
     private readonly ops: OperationRunner,
@@ -285,17 +290,17 @@ export class GoogleSyncRemote implements SyncRemote {
       ctx.drive.getFile(id, SYNC_EXPORT_FIELDS),
     );
     const source: NativeSource = { item: this.item(file) };
-    this.nativeFiles.set(source, { id, file });
+    NATIVE_FILES.set(source, { id, file });
     return source;
   }
 
-  exportNative<T>(
+  async exportNative<T>(
     source: NativeSource,
     plan: ExportPlan,
     consume: (open: OpenStream) => Promise<T>,
   ): Promise<T> {
-    const read = this.nativeFiles.get(source);
-    if (!read) throw new ValidationError('Internal: export source was not read by this remote');
+    const read = NATIVE_FILES.get(source);
+    if (!read) throw new ValidationError('Internal: export source was not read by readNative');
     return this.ops.exec(this.account, 'idempotent', read.id, (ctx) =>
       consume(() => openExport(ctx.drive, read.file, plan, this.ops.log)),
     );
```

- [ ] **Step 4: Run it and watch it pass.**

Run: `npx vitest run src/sync/__tests__/google-remote.test.ts`

Expected: PASS (every test in the files passes).

- [ ] **Step 5: Format and run the whole check.**

Run: `npx prettier --write src/sync/__tests__/google-remote.test.ts src/sync/remote/google-remote.ts` then `npm run check`

Expected: exit 0, `Test Files  128 passed (128); Tests  1371 passed | 6 skipped (1377)`.

- [ ] **Step 6: Commit.**

```bash
git add src/sync/__tests__/google-remote.test.ts src/sync/remote/google-remote.ts
git commit -F - <<'MSG'
fix(sync): a NativeSource exports through any GoogleSyncRemote

Review fix for chunk 1: env.remoteFor builds a new remote per call, so the
export links read by readNative now live in one module-level WeakMap instead of
per instance. A forged source is still refused.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
MSG
```

### Task 22: Review fixes for chunk 1 (c): retry classes and the probe's parent-walk fields

**Spec:** review item 6. Commit `3ee73b1` on the reference branch.

**Files:**
- Test: `src/sync/__tests__/google-remote.test.ts`
- Test: `src/sync/__tests__/remote-probe.test.ts`
- Modify: `src/sync/remote-probe.ts`

- [ ] **Step 1: Write the failing test (and its setup).**

`src/sync/__tests__/google-remote.test.ts` (modify):

```diff
diff --git a/src/sync/__tests__/google-remote.test.ts b/src/sync/__tests__/google-remote.test.ts
index a699399..9a9839e 100644
--- a/src/sync/__tests__/google-remote.test.ts
+++ b/src/sync/__tests__/google-remote.test.ts
@@ -136,6 +136,27 @@ describe('GoogleSyncRemote writes and content (pinned)', () => {
     await rm(dir, { recursive: true, force: true });
   });
 
+  it('creates are never retried blindly; replaceContent runs as a mutate', async () => {
+    const abs = path.join(dir, 'a.pdf');
+    await writeFile(abs, 'x');
+    const drive = createFakeDrive();
+    const remote = googleRemoteOver(drive);
+    drive.createFile.mockRejectedValue(httpError(503, 'backendError'));
+    await expect(remote.createFolder('P', 'docs')).rejects.toThrow(
+      'The item may have been created anyway',
+    );
+    expect(drive.createFile).toHaveBeenCalledTimes(1);
+    await expect(remote.uploadNew('P', 'a.pdf', abs)).rejects.toThrow(
+      'The item may have been created anyway',
+    );
+    expect(drive.createFile).toHaveBeenCalledTimes(2);
+    drive.updateFile.mockRejectedValue(httpError(503, 'backendError'));
+    await expect(
+      remote.replaceContent(toRemoteItem({ id: 'r1' }, DEFAULT_GOOGLE_EXPORT), abs),
+    ).rejects.toThrow('The change may have been applied anyway');
+    expect(drive.updateFile).toHaveBeenCalledTimes(1);
+  });
+
   it('createFolder: folder MIME type, the parent, id and name fields', async () => {
     const drive = createFakeDrive();
     drive.createFile.mockResolvedValueOnce({ id: 'f9', name: 'docs' });
```

`src/sync/__tests__/remote-probe.test.ts` (modify):

```diff
diff --git a/src/sync/__tests__/remote-probe.test.ts b/src/sync/__tests__/remote-probe.test.ts
index cab9c45..27849e5 100644
--- a/src/sync/__tests__/remote-probe.test.ts
+++ b/src/sync/__tests__/remote-probe.test.ts
@@ -8,6 +8,7 @@ import {
 } from '../../errors.js';
 import { createFakeDrive } from '../../files/__tests__/fakes.js';
 import { GOOGLE_MIME } from '../../files/export-formats.js';
+import { SYNC_FILE_FIELDS } from '../remote/google-remote.js';
 import { probeRecord, probeRecords, type ItemGetter } from '../remote-probe.js';
 import type { RemoteScan } from '../types.js';
 import { binary } from './drive-tree.js';
@@ -91,6 +92,25 @@ describe('probeRecord', () => {
     });
   });
 
+  it('reads each parent in the walk with the full sync fields (not just id, parents)', async () => {
+    const drive = createFakeDrive();
+    drive.getFile.mockImplementation(async (id) =>
+      id === 'r'
+        ? binary('r', 'a.pdf', 'elsewhere')
+        : id === 'elsewhere'
+          ? { id: 'elsewhere', parents: ['my-drive'] }
+          : { id: 'my-drive' },
+    );
+    expect(await probeRecord('r', scan(), googleRemoteOver(drive))).toEqual({
+      state: 'moved-out',
+    });
+    expect(drive.getFile.mock.calls).toEqual([
+      ['r', SYNC_FILE_FIELDS],
+      ['elsewhere', SYNC_FILE_FIELDS],
+      ['my-drive', SYNC_FILE_FIELDS],
+    ]);
+  });
+
   it('reports moved-out when the ancestry leaves the pair', async () => {
     const get = getter({
       r: binary('r', 'a.pdf', 'elsewhere'),
```

- [ ] **Step 2: Run it and watch it fail.**

Run: `npx vitest run src/sync/__tests__/google-remote.test.ts src/sync/__tests__/remote-probe.test.ts`

Expected: PASS already (behaviour unchanged); the tests pin it.

- [ ] **Step 3: Implement.**

`src/sync/remote-probe.ts` (modify):

```diff
diff --git a/src/sync/remote-probe.ts b/src/sync/remote-probe.ts
index b79666e..071ea23 100644
--- a/src/sync/remote-probe.ts
+++ b/src/sync/remote-probe.ts
@@ -55,6 +55,8 @@ export async function probeRecord(
     }
     return { state: 'present', entry };
   }
+  // The parent walk reads each folder through `get`, so Google requests the full sync
+  // fields here (before the port: 'id, parents'); only `parentId` is used.
   let current = parent;
   for (let depth = 0; depth < MAX_DEPTH; depth++) {
     let folder: RemoteItem | null;
```

- [ ] **Step 4: Run it and watch it pass.**

Run: `npx vitest run src/sync/__tests__/google-remote.test.ts src/sync/__tests__/remote-probe.test.ts`

Expected: PASS (every test in the files passes).

- [ ] **Step 5: Format and run the whole check.**

Run: `npx prettier --write src/sync/__tests__/google-remote.test.ts src/sync/__tests__/remote-probe.test.ts src/sync/remote-probe.ts` then `npm run check`

Expected: exit 0, `Test Files  128 passed (128); Tests  1373 passed | 6 skipped (1379)`.

- [ ] **Step 6: Commit.**

```bash
git add src/sync/__tests__/google-remote.test.ts src/sync/__tests__/remote-probe.test.ts src/sync/remote-probe.ts
git commit -F - <<'MSG'
test(sync): pin retry classes and the probe's parent-walk fields

Review fixes for chunk 1: createFolder and uploadNew are not retried on a 503
(one call, the create hint), replaceContent runs as a mutate (one call, the mutate
hint). The probe's parent walk reads full sync fields; a comment and a test say so.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
MSG
```

### End of Chunk 2

- [ ] Rerun the Google live sync E2E on the Chunk 2 head (the user runs it).

## Chunk 3: OneDrive

Notes from Chunks 1–2 for this chunk:
- Write-guarding re-reads use the throwing `read` (executor `verifyRemote` and trash-remote, release `verifyRemote`). On OneDrive they need per-caller null handling (spec §5): e.g. trash-remote of an item already gone with feed evidence drops the record; without evidence the action is skipped, not failed.
- Plug quickXor into `defaultDigesters` (`src/sync/local-scanner.ts`); `writeTemp`, `hashLocal`, the executor and release already ask for the remote's kind.
- `Pair.remoteCursor` / `remoteDeletedIds` exist and persist; nothing reads or writes them yet.

To be written: `quickxor.ts`, `onedrive-remote.ts`, the deletion feed and its probe mapping, `remote-names.ts`, the ignored reasons, Microsoft pair settings, §5 error handling and account routing (spec §2.2, §4, §5, §8 item 3).

## Chunk 4: Cloud folder guard and docs

To be written: `cloud-folders.ts` in `sync_create_pair` and `sync repair-marker`, the list warning, README and CHANGELOG (spec §6, §7, §8 item 4).
