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

- [ ] Run the Google live sync E2E (spec §8 item 1; the user runs it) and record the result here before Chunk 2 starts.

## Chunk 2: Hashes and pair file v2

To be written: `LocalDigests`, `sameContent` in `content-compare`, `writeTemp` expected hash and size, `exec-records` and release re-hash, `RemoteEntry.hash` / `SyncRecord.remoteHash`, pair file v2 with the v1 migration (spec §3, §4.5, §8 item 2).

## Chunk 3: OneDrive

To be written: `quickxor.ts`, `onedrive-remote.ts`, the deletion feed and its probe mapping, `remote-names.ts`, the ignored reasons, Microsoft pair settings, §5 error handling and account routing (spec §2.2, §4, §5, §8 item 3).

## Chunk 4: Cloud folder guard and docs

To be written: `cloud-folders.ts` in `sync_create_pair` and `sync repair-marker`, the list warning, README and CHANGELOG (spec §6, §7, §8 item 4).
