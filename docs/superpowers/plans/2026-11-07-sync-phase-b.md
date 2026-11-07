# Sync Phase B Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish selective sync: Google Docs/Sheets/Slides/Drawings are synced as pull-only exports (rules N1–N9), files can be "moved to Drive" with `sync_release` (remote-only records, rules O0–O8, R0), and a local deletion only trashes the Drive copy after explicit confirmation (`confirmRemoteTrash`, `pendingConfirmation`).

**Architecture:** First a provider-neutral file split (executor → `exec-records` / `remote-folders`; service → `pair-admin` / `scan-select`). Google-specific knowledge goes into two new modules: `remote-kinds.ts` (the only sync module that knows Google-native MIME types and calls `resolveExport`) and `content-compare.ts` (all "did content change" decisions). The scanner and probe classify every Drive file into binary / native / unsupported, natives are keyed by their export name and carry `RemoteEntry.native`. The pure planner gains `plan-native.ts` (N rules), `plan-remote-only.ts` (O rules) and `plan-shared.ts` (scope + B7–B9/N6 move logic). The executor gains `exec-export.ts` (export-new/export-replace/local-edit copy, using the shared `openExport` helper moved out of `FileService` into `src/files/export-stream.ts`). `release.ts` holds the pure release selection (incl. R0) and the verified release execution through the injected `LocalTrash`. B5 deletions carry `reason: 'local-deleted'` and run only with `confirmRemoteTrash`.

**Tech Stack:** TypeScript (strict, ESM/NodeNext), Node ≥ 22, `googleapis` Drive v3 (never imported under `src/sync/`), `@modelcontextprotocol/sdk`, `zod` v4, `commander`, Vitest. No new dependencies.

---

**Specs (read first):** `docs/superpowers/specs/2026-11-07-sync-phase-b-addendum.md` (wins on conflicts), `docs/superpowers/specs/2026-11-03-selective-sync-design.md` §3–§8, §6.6, §6.7, §10, §11, and `docs/superpowers/specs/2026-11-05-local-trash-design.md` (`LocalTrash`).

## Ground rules

- Branch `feat/sync-phase-b`; never switch branches, **never push** (the GitHub account is suspended).
- After every task: `npx prettier --write <changed files>` then `npm run check` (typecheck + eslint with zero warnings + prettier + vitest). Starting point: 616 passed, 6 skipped. Never commit red.
- Imports use the `.js` suffix. Non-test code has explicit return types (`@typescript-eslint/explicit-function-return-type`); tests are exempt.
- Test helpers: `src/files/__tests__/fakes.ts` (`createFakeDrive`, `createRunner`, `createAudit`, `noSleep`, `silentLogger`, `httpError`), `src/sync/__tests__/fixtures.ts` (`makePair`, `makePairFile`, `localEntry`, `remoteEntry`, `record`, `dirTrash`, `refuseTrash`, `ROOT_ID`), `plan-input.ts` (`planInput`), `drive-tree.ts` (`binary`, `folder`, `treeLister`), `memory-drive.ts` (`memoryDrive`).
- Every commit message ends with:

  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01UgKFZLKWgWnvQtSbn1kZ9c
  ```

  The commit steps write it as `git commit -m "<subject>" -m "<body or omitted>" -m "Co-Authored-By: …" ` with the two trailer lines in the last `-m` separated by a newline. Shorthand used below: `$TRAILER` stands for that last argument:

  ```bash
  TRAILER=$'Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>\nClaude-Session: https://claude.ai/code/session_01UgKFZLKWgWnvQtSbn1kZ9c'
  ```

- A test file for a module that does not exist yet fails with `Failed to load url ../x.js` / `Cannot find module` — that is the expected red.

## Resolved ambiguities (intentional, keep consistent)

1. **Native entries in the scan.** `RemoteEntry.key` of a native file is its export key (`exportKey(parentKey, driveName, extension)`), `RemoteEntry.name` stays the Drive name, `md5`/`size` are `null`. A native whose export name is not representable is ignored as `unrepresentable`.
2. **Interim guard (Task 6 → removed in Task 11).** Between scanner classification (chunk 2) and the native rules (chunk 3) every untracked native is listed as a remote candidate and never acted on, so no intermediate commit downloads a Google file as binary.
3. **`type-changed`** is an `unknown-state` note with rule `type-changed` and a message starting with `type-changed:`; it is checked in `planTracked` after (a)/(b) and before (c)/(d), so it covers the scan and probe paths and remote-only records.
4. **N5** is an `export-new` action with `localEdit: true`: the export stream is opened first, then L is moved aside with the exclusive `moveLocal` (numbered like conflict copies), then the export is placed at the key. The outcome carries `conflictCopy` (the kept name) and warning `native-local-edit-kept`; a failure after the move still reports the kept name (`LocalEditKeptError`).
5. **`native-too-large`**: `ExportTooLargeError` during an export becomes outcome `skipped` with `warning: 'native-too-large'`; the report uses `o.warning ?? 'skipped-changed'` as the warning code for skips. The record is unchanged, so the next run plans it again.
6. **Exports are audited as `sync_download`** (no new `AuditOp`; the spec lists none for exports).
7. **N8** uses a new note `native-trashed-edited`; **O2/O5** use `remote-only-trashed`; **U0b** uses `ambiguous-native`. All are warnings.
8. **Remote-only bookkeeping** (O3 record refresh, O4 path move, O5/O6 `remoteTrashed`) is a `refresh` action with a `patch: Partial<SyncRecord>`; like every `refresh` it is excluded from `planId` and from report `actions`.
9. **O1 collision** is decided in the planner (a local file at R's key → `collision` note) and still guarded by `placeExclusive`.
10. **Upgrade baseline:** the applied run that flips `nativeBaselineDone` adds `plan.nativeBaseline` (untracked native scan entries) to `remoteBaseline` and `plan.baseline.folders` (unknown + ignored remote folders, same set the first applied run stores) to `baselineFolders`.
11. **Release result** = `{ pair, dryRun, released: [{ path, status }], skipped: [{ path, reason }], failed: [{ path, reason }], removedDirs }`. `skipped` = not eligible at planning; `failed` = re-verification or trash failed during apply. CLI exit code 1 only when `failed` is non-empty. `status` is one of `released`, `would release`, `released (already deleted locally)`, `would release (already deleted locally)`.
12. **`releasable`** (applied runs only) = records that are not remote-only after the run and were either in sync at planning (B1/N1, `Plan.inSync`) or were the path of a successful action. It is a hint; `sync_release` re-checks everything.
13. **Pending-confirmation wording** lives in the CLI human report and in the `sync_run` / `sync_release` tool descriptions; the JSON report carries `pendingConfirmation` exactly as the addendum defines it. `confirm-needs-mass-delete` is a report warning with `path: ''`.
14. **CLI `sync run`** passes `confirmRemoteTrash: true` only when `--confirm-remote-trash` is given (keeps the existing call-shape tests), and that flag requires `--plan-id`. **CLI `sync release`** passes `--all` and paths through unchanged so the service's "exactly one" check decides.

## File structure

| File | Status | Responsibility |
|---|---|---|
| `src/sync/exec-records.ts` | Create (T1) | `RemoteFields`, `LocalFields`, `fromEntry`, `fromDrive`, `statOf`, `makeRecord`, `conflictName`, `localEditName` (T10), `applySelection`, `putRecord`, `dropRecord` |
| `src/sync/remote-folders.ts` | Create (T1) | `RemoteFolders` class: `ensureAll`, `folderFor`, `ensureRemoteFolder` |
| `src/sync/executor.ts` | Modify | ordering, dispatch, persistence, audit, isolation; `verifyRemote`/`trashRemote` use `remoteUnchangedSince`; `ExportTooLargeError` → `native-too-large`; refresh patches |
| `src/sync/exec-export.ts` | Create (T10) | `SYNC_EXPORT_FIELDS`, `ExportHost`, `exportNew`, `exportReplace`, `exportOver`, local-edit move-aside |
| `src/sync/errors.ts` | Modify (T1) | gains `messageOf` (moved from executor) |
| `src/sync/pair-admin.ts` | Create (T1) | `SyncEnv`, create/list/remove pair, repair marker, root checks, `summarize`, `remoteRootProblem`; `googleExport` validation (T8) |
| `src/sync/scan-select.ts` | Create (T1) | `scanBoth`, `scanRemoteTree` (T2), `scanPair`, `selectPaths`, previews; `gatherInput` (T17); restorePending (T15) |
| `src/sync/sync-service.ts` | Modify | `SyncService` facade, `run`, `release` (T17); re-exports for MCP/CLI |
| `src/sync/remote-kinds.ts` | Create (T4) | `classifyRemote`, `exportKey`, `validateGoogleExport`, `RemoteKind` |
| `src/sync/content-compare.ts` | Create (T5) | `remoteChanged`, `remoteUnchangedSince`, `localMatchesRemote` |
| `src/files/export-stream.ts` | Create (T3) | `openExport(drive, file, plan, log)` with the `exportLinks` fallback |
| `src/files/file-service.ts` | Modify (T3) | `download` uses `openExport`; private `openExport` removed |
| `src/sync/types.ts` | Modify | `NativeInfo`, `RemoteEntry.native`, `Pair.nativeBaselineDone`, new `ActionKind`s, `Action.localEdit/patch/reason`, new `NoteCode`s, `Plan.nativeBaseline/inSync/brakeUnconfirmed`, `SyncReport.pendingConfirmation/releasable` |
| `src/sync/pair-store.ts` | Modify (T7) | `nativeBaselineDone: z.boolean().default(false)` |
| `src/sync/remote-scanner.ts` | Modify (T6) | classify via `remoteKinds`; `toRemoteEntry(…, kind)`; `native-unsupported` |
| `src/sync/remote-probe.ts` | Modify (T6) | same classification; native found by probe is `present` |
| `src/sync/resolve.ts` | Modify (T5) | `remoteState` removed |
| `src/sync/plan-shared.ts` | Create (T12) | `TrackedResult`, `TrackedScope`, `makeScope`, `needsRefresh`, `ActionBase`, `planMoved` (B7–B9 / N6) |
| `src/sync/plan-tracked.ts` | Modify | dispatch §6.3 + `type-changed`; B1–B14 |
| `src/sync/plan-native.ts` | Create (T12) | N1–N9 |
| `src/sync/plan-remote-only.ts` | Create (T14) | O0–O8 |
| `src/sync/plan-untracked.ts` | Modify | interim guard (T6), U0b/U3/U6 exports, U5 upgrade narrowing (T11) |
| `src/sync/planner.ts` | Modify | export kinds order, `native-unsupported` note, `nativeBaseline`, `inSync`, `brakeUnconfirmed` |
| `src/sync/report.ts` | Modify | warning codes, skip codes, done-outcome messages, `pendingConfirmation`, `releasable` |
| `src/sync/release.ts` | Create (T16–T17) | `selectReleasable` (pure, incl. R0), `applyRelease` |
| `src/mcp/sync-tools.ts` | Modify | `googleExport` (T8), `sync_release` (T19), `confirmRemoteTrash` (T22) |
| `src/cli/sync-commands.ts`, `src/cli/sync-format.ts` | Modify | `sync release` (T19), `--confirm-remote-trash` + pending section (T22), wording (T23) |
| `src/sync/__tests__/*` | Modify/Create | `scan-select.test.ts`, `remote-kinds.test.ts`, `content-compare.test.ts`, `no-googleapis.test.ts`, `plan-native.test.ts`, `plan-remote-only.test.ts`, `release.test.ts`, `sync-service.native.test.ts`, `sync-service.release.test.ts`; fixtures `nativeEntry`/`nativeRecord`; memory-drive natives |
| `src/files/__tests__/export-stream.test.ts` | Create (T3) | helper unit tests |
| `tests/e2e/sync.e2e.test.ts` | Modify (T21, T25) | confirmed B5 in the Phase A flow; Phase B live flow |
| `README.md`, `docs/CHANGELOG.md`, `docs/FEATURES.md` | Modify (T24) | user docs |

---

## Chunk 1: File split

### Task 1: Pure move (commit 1)

**Files:**
- Create: `src/sync/exec-records.ts`, `src/sync/remote-folders.ts`, `src/sync/pair-admin.ts`, `src/sync/scan-select.ts`
- Modify: `src/sync/executor.ts` (whole file), `src/sync/sync-service.ts` (whole file), `src/sync/errors.ts` (append `messageOf`)
- Tests: none change except imports (none are needed if the re-exports below are kept).

- [ ] **Step 1: Baseline.** Run `npm run check`. Expected: 616 passed, 6 skipped. Note the exact numbers.

- [ ] **Step 2: Move `messageOf` to `src/sync/errors.ts`.** Append (body moved verbatim from `executor.ts` lines 164–167, now exported):

  ```ts
  /** Safe message of any thrown value (AppError messages are user-facing). */
  export function messageOf(err: unknown): string {
    if (err instanceof AppError) return err.message;
    return err instanceof Error ? err.message : String(err);
  }
  ```

- [ ] **Step 3: Create `src/sync/exec-records.ts`.** Move verbatim from `executor.ts`, exporting each: `interface RemoteFields` (l. 59–66), `interface LocalFields` (l. 68–74), `fromEntry` (l. 76–85), `fromDrive` (l. 87–96), `statOf` (l. 98–100), `makeRecord` (l. 102–121), `pad` (l. 123–125, stays module-private), `conflictName` (l. 127–134), `applySelection` (l. 136–151), `putRecord` (l. 153–158), `dropRecord` (l. 160–162). Imports: `type { DriveFile } from '../drive/drive-adapter.js'`, `{ foldKey } from './paths.js'`, `type { StatExpect } from './transfer.js'`, `type { LocalEntry, PairFile, RemoteEntry, SelectionChange, SyncRecord } from './types.js'`.

- [ ] **Step 4: Create `src/sync/remote-folders.ts`.** Bodies of `ensureFolders` (l. 327–339, renamed `ensureAll`), `folderFor` (l. 341–354) and `ensureRemoteFolder` (l. 356–403) move verbatim with `this.deps.*` / `this.pair.*` unchanged in meaning and `this.need(created.id, 'folder id')` replaced by the inline check shown:

  ```ts
  import type { AuditSink } from '../audit/audit-log.js';
  import type { OperationRunner } from '../core/operation.js';
  import type { DriveFile } from '../drive/drive-adapter.js';
  import { ValidationError } from '../errors.js';
  import { GOOGLE_MIME } from '../files/export-formats.js';
  import { escapeQueryValue } from '../files/query.js';
  import type { Logger } from '../logger.js';
  import { isAbortError, messageOf } from './errors.js';
  import { baseName, foldKey, parentKey } from './paths.js';
  import type { Action, Pair } from './types.js';

  export interface RemoteFolderDeps {
    ops: OperationRunner;
    audit: AuditSink;
    logger: Logger;
  }

  /** Drive folders for uploads: scanned ids first, then reuse-or-create (spec §4). */
  export class RemoteFolders {
    private readonly folderIds = new Map<string, string>();
    private readonly folderErrors = new Map<string, string>();

    constructor(
      private readonly deps: RemoteFolderDeps,
      private readonly pair: Pair,
      folders: ReadonlyMap<string, string>,
    ) {
      for (const [id, key] of folders) this.folderIds.set(key, id);
    }

    async ensureAll(uploads: readonly Action[]): Promise<void> {
      /* body of Executor.ensureFolders, unchanged */
    }

    async folderFor(dir: string): Promise<string> {
      /* body of Executor.folderFor, unchanged */
    }

    private async ensureRemoteFolder(parentId: string, name: string): Promise<string> {
      /* body of Executor.ensureRemoteFolder, with: */
      // const id = created.id;
      // if (!id) throw new ValidationError('Internal: folder id missing for sync action');
    }
  }
  ```

- [ ] **Step 5: Slim `src/sync/executor.ts`.** Delete the moved code; keep `STAGES`, `DUPLICATE_WINDOW_MS`, `MAX_CONFLICT_NAMES`, `ExecutorDeps`, class `Executor` (`run`, `execute`, `persist`, `commit`, `audit`, `need`, `localFields`, `statFields`, `readRemote`, `verifyRemote`, `adopt`, `refresh`, `forget`, `upload`, `findDuplicateUpload`, `updateRemote`, `move`, `downloadNew`, `downloadReplace`, `conflict`, `trashRemote`, `trashLocalFile`). Changes:
  - Replace the fields `folderIds`/`folderErrors` and the constructor loop with `private readonly folders: RemoteFolders;` and `this.folders = new RemoteFolders(deps, file.pair, folders);` in the constructor.
  - `run`: `await this.folders.ensureAll(actions.filter((a) => a.kind === 'upload-new'));`
  - `upload`: `const parentId = await this.folders.folderFor(parentKey(action.key));`
  - Imports: add `{ RemoteFolders } from './remote-folders.js'`, `{ applySelection, conflictName, dropRecord, fromDrive, fromEntry, makeRecord, putRecord, statOf, type LocalFields } from './exec-records.js'` (`conflictName` is still called by `conflict()`; the re-export below creates no local binding), `messageOf` from `./errors.js`. `executor.ts` loses the imports `GOOGLE_MIME` (`../files/export-formats.js`) and `foldKey` (from `./paths.js`, keep `absInside, baseName, parentKey, prepareParent`); it keeps `escapeQueryValue` (used by `findDuplicateUpload`) and `type DriveFile`.
  - Keep the public surface for tests: `export { conflictName } from './exec-records.js';`

- [ ] **Step 6: Create `src/sync/pair-admin.ts`.** Move verbatim from `sync-service.ts`, turning `this.x` into `env.x`: `interface CreatePairInput` (l. 60–67), `interface PairSummary` (l. 69–84), `summarize` (l. 135–153), `remoteRootProblem` (l. 155–161), `resolveLocalDir` (l. 163–176, module-private), `createPair(env, input)` (l. 207–252), `resolveRemoteRoot(env, input)` (l. 254–277, module-private), `listPairs(env)` (l. 279–281), `removePair(env, input)` (l. 283–300), `repairMarker(env, name, confirm)` (l. 302–321), `checkRoots(env, pair)` (l. 323–359, now exported). Replacements: `this.store` → `env.store`, `this.ops` → `env.ops`, `this.log` → `env.log`, `this.clock()` → `env.clock()`, `this.resolveRemoteRoot(` → `resolveRemoteRoot(env, `. Imports of `pair-admin.ts`:
  ```ts
  import { randomUUID } from 'node:crypto';
  import { constants } from 'node:fs';
  import { access, realpath, stat } from 'node:fs/promises';
  import path from 'node:path';
  import type { OperationRunner } from '../core/operation.js';
  import type { DriveFile } from '../drive/drive-adapter.js';
  import { NotFoundError, ValidationError } from '../errors.js';
  import { expandHome } from '../files/destination.js';
  import { GOOGLE_MIME } from '../files/export-formats.js';
  import type { Logger } from '../logger.js';
  import { SyncRootError } from './errors.js';
  import {
    checkOverlap,
    probeCaseInsensitive,
    readMarker,
    removeMarker,
    writeMarker,
    type PairStore,
  } from './pair-store.js';
  import { DEFAULT_GOOGLE_EXPORT, PAIR_NAME, SYNC_FILE_FIELDS, type Pair, type PairFile } from './types.js';
  ```
  Add:

  ```ts
  /** What the split service modules share (one per SyncService). */
  export interface SyncEnv {
    ops: OperationRunner;
    log: Logger;
    clock: () => Date;
    store: PairStore;
  }
  ```

- [ ] **Step 7: Create `src/sync/scan-select.ts`.** Move verbatim: `TEXT_MIME` (l. 51), `ScanInput`, `ScanEntry`, `ScanResult`, `SelectInput`, `SelectResult` (l. 86–133), `readPreview` (l. 178–189, private), `scanBoth(env, pair)` (l. 361–374, exported), `scanPair(env, input)` (= `scan`, l. 377–429), `selectPaths(env, input)` (= `select`, l. 432–504). Replacements as in Step 6 plus `this.checkRoots(pair)` → `checkRoots(env, pair)` and `this.scanBoth(pair)` → `scanBoth(env, pair)`. Imports of `scan-select.ts`:
  ```ts
  import { open } from 'node:fs/promises';
  import { AppError } from '../errors.js';
  import { uploadMimeType } from '../files/upload-mime.js';
  import { scanLocal } from './local-scanner.js';
  import { checkRoots, type SyncEnv } from './pair-admin.js';
  import { absInside, ancestorKeys, foldKey, isIgnoredName, isUnder, validateRelPath } from './paths.js';
  import { SYNC_LIST_FIELDS, SYNC_PAGE_SIZE, childrenQuery, scanRemote } from './remote-scanner.js';
  import type { LocalScan, Pair, RemoteScan } from './types.js';
  ```

- [ ] **Step 8: Slim `src/sync/sync-service.ts`.** It loses the imports `randomUUID`, `constants`, `access`/`open`/`realpath`/`stat` (keeps `rm`), `path`, `type DriveFile`, `AppError`/`NotFoundError`/`ValidationError`, `expandHome`, `GOOGLE_MIME`, `uploadMimeType`, `SyncRootError`, `checkOverlap`/`probeCaseInsensitive`/`readMarker`/`removeMarker`/`writeMarker` (keeps `type PairStore`), `ancestorKeys`/`foldKey`/`isIgnoredName`/`isUnder`/`validateRelPath` (keeps `absInside`, `toKey`), the `remote-scanner.js` import, `DEFAULT_GOOGLE_EXPORT`, `PAIR_NAME`, `SYNC_FILE_FIELDS`; it gains `{ checkRoots, createPair, listPairs, removePair, repairMarker, type CreatePairInput, type PairSummary, type SyncEnv } from './pair-admin.js'` and `{ scanBoth, scanPair, selectPaths, type ScanInput, type ScanResult, type SelectInput, type SelectResult } from './scan-select.js'` (typecheck + lint confirm nothing else is left over). Keep `STALE_PART_MS`, `SyncServiceDeps`, `RunInput`, class `SyncService` with `buildPlan`, `removeStaleParts`, `run` unchanged in behavior. The class gets `private readonly env: SyncEnv;` set in the constructor to `{ ops: this.ops, log: this.log, clock: this.clock, store: deps.store }` and one-line facades:

  ```ts
  createPair(input: CreatePairInput): Promise<PairSummary> {
    return createPair(this.env, input);
  }
  listPairs(): Promise<PairSummary[]> {
    return listPairs(this.env);
  }
  removePair(input: { name: string }): Promise<{ name: string; removed: true; note: string }> {
    return removePair(this.env, input);
  }
  repairMarker(
    name: string,
    confirm: (pair: Pair) => Promise<boolean>,
  ): Promise<{ repaired: boolean; localDir: string; caseInsensitive: boolean }> {
    return repairMarker(this.env, name, confirm);
  }
  scan(input: ScanInput): Promise<ScanResult> {
    return scanPair(this.env, input);
  }
  select(input: SelectInput): Promise<SelectResult> {
    return selectPaths(this.env, input);
  }
  ```

  In `run`/`buildPlan`: `this.checkRoots(file.pair)` → `checkRoots(this.env, file.pair)`, `this.scanBoth(pair)` → `scanBoth(this.env, pair)`. Re-export for callers:

  ```ts
  export {
    remoteRootProblem,
    summarize,
    type CreatePairInput,
    type PairSummary,
  } from './pair-admin.js';
  export type {
    ScanEntry,
    ScanInput,
    ScanResult,
    SelectInput,
    SelectResult,
  } from './scan-select.js';
  ```

- [ ] **Step 9: Verify the pure move.** `npx prettier --write src/sync/*.ts && npm run check`. Expected: exactly the Step 1 numbers (616 passed, 6 skipped), no test file changed (`git status --short src/sync/__tests__` prints nothing).

- [ ] **Step 10: Commit 1.**

  ```bash
  git add src/sync/exec-records.ts src/sync/remote-folders.ts src/sync/pair-admin.ts src/sync/scan-select.ts src/sync/executor.ts src/sync/sync-service.ts src/sync/errors.ts
  git commit -m "refactor(sync): split executor and sync service along provider-neutral lines" -m "Pure move: exec-records, remote-folders, pair-admin, scan-select. No behavior change." -m "$TRAILER"
  ```

### Task 2: `sync_scan` scans the local tree once (commit 2)

**Files:**
- Create: `src/sync/__tests__/scan-select.test.ts`
- Modify: `src/sync/scan-select.ts` (`scanBoth`, `scanPair`)

- [ ] **Step 1: Write the failing test** `src/sync/__tests__/scan-select.test.ts`:

  ```ts
  import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
  import os from 'node:os';
  import path from 'node:path';
  import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
  import { createAudit, createRunner, noSleep, silentLogger } from '../../files/__tests__/fakes.js';
  import { PairStore } from '../pair-store.js';
  import { SyncService } from '../sync-service.js';
  import { refuseTrash } from './fixtures.js';
  import { memoryDrive, type MemoryDrive } from './memory-drive.js';

  const counter = vi.hoisted(() => ({ scans: 0 }));
  vi.mock('../local-scanner.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../local-scanner.js')>();
    return {
      ...actual,
      scanLocal: (...args: Parameters<typeof actual.scanLocal>) => {
        counter.scans++;
        return actual.scanLocal(...args);
      },
    };
  });

  let tmp: string;
  let local: string;
  let mem: MemoryDrive;
  let sync: SyncService;

  beforeEach(async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), 'sync-scan-'));
    local = path.join(tmp, 'Local');
    await mkdir(local);
    mem = memoryDrive('ROOT');
    sync = new SyncService({
      runner: createRunner(mem.drive),
      audit: createAudit(),
      retry: noSleep,
      logger: silentLogger(),
      store: new PairStore({ dir: path.join(tmp, 'sync'), logger: silentLogger() }),
      trash: refuseTrash,
      clock: () => new Date('2026-11-03T12:00:00.000Z'),
    });
    await sync.createPair({ name: 'docs', localDir: local, remoteFolderId: 'ROOT' });
  });
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  describe('sync_scan', () => {
    it('scans the local tree once and returns the same result', async () => {
      await writeFile(path.join(local, 'a.txt'), 'hello');
      mem.addFile('r1', 'remote.pdf', 'ROOT', 'R');
      counter.scans = 0;
      const result = await sync.scan({ name: 'docs' });
      expect(counter.scans).toBe(1);
      expect(result).toMatchObject({
        entries: [{ path: 'a.txt', preview: 'hello', size: 5 }],
        remoteCandidates: [{ path: 'remote.pdf', size: 1 }],
        truncated: false,
      });
    });
  });
  ```

- [ ] **Step 2: Run it.** `npx vitest run src/sync/__tests__/scan-select.test.ts -t "scans the local tree once"`. Expected FAIL: `expected 2 to be 1`.

- [ ] **Step 3: Implement** in `src/sync/scan-select.ts`:

  ```ts
  /** Breadth-first scan of the pair's Drive folder (no local work). */
  export function scanRemoteTree(env: SyncEnv, pair: Pair): Promise<RemoteScan> {
    return scanRemote(pair.remoteFolderId, (folderId, pageToken) =>
      env.ops.exec(pair.account, 'idempotent', folderId, (ctx) =>
        ctx.drive.listFiles({
          q: childrenQuery(folderId),
          pageSize: SYNC_PAGE_SIZE,
          ...(pageToken ? { pageToken } : {}),
          fields: SYNC_LIST_FIELDS,
        }),
      ),
    );
  }

  export async function scanBoth(
    env: SyncEnv,
    pair: Pair,
  ): Promise<{ local: LocalScan; remote: RemoteScan }> {
    const local = await scanLocal(pair.localDir);
    const remote = await scanRemoteTree(env, pair);
    return { local, remote };
  }
  ```

  In `scanPair` replace `const { remote } = await scanBoth(env, pair);` with `const remote = await scanRemoteTree(env, pair);`.

- [ ] **Step 4: Run to pass.** Same command. Expected PASS.

- [ ] **Step 5:** `npx prettier --write src/sync/scan-select.ts src/sync/__tests__/scan-select.test.ts && npm run check` → green (617 passed).

- [ ] **Step 6: Commit 2.**

  ```bash
  git add src/sync/scan-select.ts src/sync/__tests__/scan-select.test.ts
  git commit -m "perf(sync): sync_scan walks the local tree once" -m "$TRAILER"
  ```

---

## Chunk 2: Provider boundary, native classification, upgrade guard

### Task 3: `openExport` helper in `src/files/export-stream.ts`

**Files:**
- Create: `src/files/export-stream.ts`, `src/files/__tests__/export-stream.test.ts`
- Modify: `src/files/file-service.ts` (`download` ~l. 386–409; delete private `openExport` l. 411–433)

- [ ] **Step 1: Write the failing test** `src/files/__tests__/export-stream.test.ts`:
  ```ts
  import { Readable } from 'node:stream';
  import { describe, expect, it } from 'vitest';
  import { ExportTooLargeError } from '../../errors.js';
  import { GOOGLE_MIME, resolveExport, type ExportPlan } from '../export-formats.js';
  import { openExport } from '../export-stream.js';
  import { createFakeDrive, httpError, silentLogger } from './fakes.js';

  const PLAN = resolveExport(GOOGLE_MIME.document, 'docx') as ExportPlan;
  const FILE = {
    id: 'd1',
    name: 'Big',
    mimeType: GOOGLE_MIME.document,
    webViewLink: 'https://docs/d1',
    exportLinks: { [PLAN.mimeType]: 'https://export/d1.docx' },
  };

  async function text(stream: Readable): Promise<string> {
    let out = '';
    for await (const chunk of stream) out += String(chunk);
    return out;
  }
  describe('openExport', () => {
    it('streams files.export in the planned MIME type', async () => {
      const drive = createFakeDrive();
      drive.exportMedia.mockResolvedValueOnce(Readable.from([Buffer.from('DOCX')]));
      expect(await text(await openExport(drive, FILE, PLAN, silentLogger()))).toBe('DOCX');
      expect(drive.exportMedia).toHaveBeenCalledWith('d1', PLAN.mimeType);
    });
    it('falls back to the exportLinks URL over the 10 MB limit', async () => {
      const drive = createFakeDrive();
      drive.exportMedia.mockRejectedValueOnce(httpError(403, 'exportSizeLimitExceeded'));
      drive.fetchExportLink.mockResolvedValueOnce(Readable.from([Buffer.from('BIG')]));
      expect(await text(await openExport(drive, FILE, PLAN, silentLogger()))).toBe('BIG');
      expect(drive.fetchExportLink).toHaveBeenCalledWith('https://export/d1.docx');
    });
    it('throws ExportTooLargeError with the web link when the fallback fails', async () => {
      const drive = createFakeDrive();
      const log = silentLogger();
      drive.exportMedia.mockRejectedValueOnce(httpError(403, 'exportSizeLimitExceeded'));
      drive.fetchExportLink.mockRejectedValueOnce(httpError(403));
      const err = await openExport(drive, FILE, PLAN, log).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ExportTooLargeError);
      expect((err as Error).message).toContain('https://docs/d1');
      expect(log.warn).toHaveBeenCalledWith('exportLinks fallback failed', expect.objectContaining({ fileId: 'd1' }));
    });
    it('rethrows other export errors and retryable fallback errors', async () => {
      const drive = createFakeDrive();
      drive.exportMedia.mockRejectedValueOnce(httpError(500));
      await expect(openExport(drive, FILE, PLAN, silentLogger())).rejects.toMatchObject({ status: 500 });
      drive.exportMedia.mockRejectedValueOnce(httpError(403, 'exportSizeLimitExceeded'));
      drive.fetchExportLink.mockRejectedValueOnce(httpError(503));
      await expect(openExport(drive, FILE, PLAN, silentLogger())).rejects.toMatchObject({ status: 503 });
    });
  });
  ```

- [ ] **Step 2: Run it.** `npx vitest run src/files/__tests__/export-stream.test.ts`. Expected FAIL: `Failed to load url ../export-stream.js`.

- [ ] **Step 3: Implement** `src/files/export-stream.ts` (logic moved from `FileService.openExport`):
  ```ts
  import type { Readable } from 'node:stream';
  import type { DriveAdapter, DriveFile } from '../drive/drive-adapter.js';
  import { ExportTooLargeError } from '../errors.js';
  import type { Logger } from '../logger.js';
  import { reasonOf } from './drive-errors.js';
  import type { ExportPlan } from './export-formats.js';
  import { retryKind } from './retry.js';

  /**
   * Opens an export of a Google-native file: files.export, and over Drive's 10 MB export
   * limit the file's `exportLinks` URL (`file` must carry `exportLinks`/`webViewLink`).
   * When both fail → ExportTooLargeError. Retryable fallback errors are rethrown so the
   * caller's retry loop runs again. Used by FileService.download and the sync executor.
   */
  export async function openExport(
    drive: DriveAdapter,
    file: DriveFile,
    plan: ExportPlan,
    log: Logger,
  ): Promise<Readable> {
    const fileId = file.id ?? '';
    try {
      return await drive.exportMedia(fileId, plan.mimeType);
    } catch (err) {
      if (reasonOf(err) !== 'exportSizeLimitExceeded') throw err;
      const link = file.exportLinks?.[plan.mimeType];
      if (link) {
        try {
          return await drive.fetchExportLink(link);
        } catch (fallbackErr) {
          if (retryKind(fallbackErr) !== null) throw fallbackErr;
          log.warn('exportLinks fallback failed', { fileId, error: fallbackErr });
        }
      }
      throw new ExportTooLargeError(file.webViewLink ?? null, { cause: err, format: plan.format });
    }
  }
  ```
  In `FileService.download` replace `plan ? this.openExport(ctx, fileId, plan, file) : ctx.drive.downloadMedia(fileId)` with `plan ? openExport(ctx.drive, { ...file, id: fileId }, plan, this.log) : ctx.drive.downloadMedia(fileId)`, add `import { openExport } from './export-stream.js';`, delete the private `openExport` method and the imports that became unused (`tsc` reports them; expected: `ExportTooLargeError`, `reasonOf`, `retryKind`, `type ExportPlan`, `type Readable` if no longer referenced).

- [ ] **Step 4: Run to pass.** `npx vitest run src/files/__tests__/export-stream.test.ts src/files/__tests__/file-service.download.test.ts`. Expected PASS (the existing download fallback tests still pass unchanged).

- [ ] **Step 5:** `npx prettier --write src/files/export-stream.ts src/files/file-service.ts src/files/__tests__/export-stream.test.ts && npm run check` → green.

- [ ] **Step 6: Commit.**
  ```bash
  git add src/files/export-stream.ts src/files/file-service.ts src/files/__tests__/export-stream.test.ts
  git commit -m "refactor(files): move the export fallback into a shared openExport helper" -m "$TRAILER"
  ```

### Task 4: `RemoteEntry.native` and `remote-kinds.ts`

**Files:**
- Create: `src/sync/remote-kinds.ts`, `src/sync/__tests__/remote-kinds.test.ts`
- Modify: `src/sync/types.ts` (`RemoteEntry`, new `NativeInfo`), `src/sync/remote-scanner.ts` (`toRemoteEntry` adds `native: null`), `src/sync/__tests__/fixtures.ts` (`remoteEntry`, new `DOCX_MIME`, `nativeEntry`, `nativeRecord`)

- [ ] **Step 1: Write the failing test** `src/sync/__tests__/remote-kinds.test.ts`:
  ```ts
  import { describe, expect, it } from 'vitest';
  import { ValidationError } from '../../errors.js';
  import { GOOGLE_MIME } from '../../files/export-formats.js';
  import { classifyRemote, exportKey, validateGoogleExport } from '../remote-kinds.js';
  import { DEFAULT_GOOGLE_EXPORT } from '../types.js';
  import { DOCX_MIME } from './fixtures.js';

  describe('classifyRemote', () => {
    it('binary files', () => {
      expect(classifyRemote({ mimeType: 'application/pdf' }, DEFAULT_GOOGLE_EXPORT)).toEqual({ kind: 'binary' });
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
  describe('exportKey', () => {
    it('adds the extension unless present, NFC, under the parent key', () => {
      expect(exportKey('', 'Plan', 'docx')).toBe('Plan.docx');
      expect(exportKey('a/b', 'Report.DOCX', 'docx')).toBe('a/b/Report.DOCX');
      expect(exportKey('', 'şartname'.normalize('NFD'), 'docx')).toBe('şartname.docx');
    });
  });
  describe('validateGoogleExport', () => {
    it('fills omitted types with the defaults', () => {
      expect(validateGoogleExport({})).toEqual(DEFAULT_GOOGLE_EXPORT);
      expect(validateGoogleExport({ document: 'pdf' })).toEqual({ ...DEFAULT_GOOGLE_EXPORT, document: 'pdf' });
    });
    it('rejects a format the type cannot be exported as', () => {
      expect(() => validateGoogleExport({ spreadsheet: 'docx' })).toThrow(ValidationError);
      expect(() => validateGoogleExport({ spreadsheet: 'docx' })).toThrow('Google Sheets cannot be exported as "docx"');
    });
  });
  ```

- [ ] **Step 2: Run it.** `npx vitest run src/sync/__tests__/remote-kinds.test.ts`. Expected FAIL: `Failed to load url ../remote-kinds.js`.

- [ ] **Step 3: Types and fixtures.** In `src/sync/types.ts`, above `RemoteEntry`:
  ```ts
  /** Export settings of a Google-native Drive file (addendum §4.1). */
  export interface NativeInfo {
    mimeType: string;
    exportFormat: ExportFormat;
    exportMime: string;
  }
  ```
  and add as the last field of `RemoteEntry`:
  ```ts
    /** Google-native file synced as a read-only export; null for binary files. */
    native: NativeInfo | null;
  ```
  In `toRemoteEntry` (`src/sync/remote-scanner.ts`) add `native: null,` as the last property. In `src/sync/__tests__/fixtures.ts` add `native: null,` before `...overrides` in `remoteEntry`, add `import { GOOGLE_MIME } from '../../files/export-formats.js';` and append:
  ```ts
  export const DOCX_MIME =
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

  /** A Google Doc exported as docx; `key` is the export key (e.g. `Plan.docx`). */
  export function nativeEntry(
    id: string,
    key: string,
    overrides: Partial<RemoteEntry> = {},
  ): RemoteEntry {
    const base = key.slice(key.lastIndexOf('/') + 1);
    return remoteEntry(id, key, {
      name: base.replace(/\.docx$/, ''),
      mimeType: GOOGLE_MIME.document,
      md5: null,
      size: null,
      native: { mimeType: GOOGLE_MIME.document, exportFormat: 'docx', exportMime: DOCX_MIME },
      ...overrides,
    });
  }

  /** A native record in sync with `localEntry(key)` and `nativeEntry(remoteId, key)`. */
  export function nativeRecord(
    remoteId: string,
    key: string,
    overrides: Partial<SyncRecord> = {},
  ): SyncRecord {
    const base = key.slice(key.lastIndexOf('/') + 1);
    return record(remoteId, key, {
      remoteName: base.replace(/\.docx$/, ''),
      remoteMd5: null,
      remoteSize: null,
      native: { mimeType: GOOGLE_MIME.document, exportFormat: 'docx' },
      ...overrides,
    });
  }
  ```

- [ ] **Step 4: Implement** `src/sync/remote-kinds.ts`:
  ```ts
  import type { DriveFile } from '../drive/drive-adapter.js';
  import {
    GOOGLE_MIME,
    isGoogleNative,
    resolveExport,
    type ExportFormat,
  } from '../files/export-formats.js';
  import { ensureExtension } from '../files/filename.js';
  import { DEFAULT_GOOGLE_EXPORT, type GoogleExportPrefs } from './types.js';

  /**
   * The only sync module that knows Google-native MIME types or calls resolveExport
   * (addendum §4.1). Folder and shortcut checks stay with their callers.
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
    if (plan === null) return { kind: 'binary' };
    return {
      kind: 'native',
      mimeType,
      exportFormat: plan.format,
      exportMime: plan.mimeType,
      extension: plan.extension,
    };
  }

  /** Local key of a native file's export: Drive name + extension unless present (NFC). */
  export function exportKey(parentKey: string, remoteName: string, extension: string): string {
    const name = ensureExtension(remoteName.normalize('NFC'), extension);
    return parentKey === '' ? name : `${parentKey}/${name}`;
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
  ```

- [ ] **Step 5: Run to pass.** `npx vitest run src/sync/__tests__/remote-kinds.test.ts`. Expected PASS.

- [ ] **Step 6:** `npx prettier --write src/sync/remote-kinds.ts src/sync/types.ts src/sync/remote-scanner.ts src/sync/__tests__/fixtures.ts src/sync/__tests__/remote-kinds.test.ts && npm run check` → green.

- [ ] **Step 7: Commit.**
  ```bash
  git add src/sync/remote-kinds.ts src/sync/types.ts src/sync/remote-scanner.ts src/sync/__tests__/fixtures.ts src/sync/__tests__/remote-kinds.test.ts
  git commit -m "feat(sync): classify Drive files as binary, native or unsupported in remote-kinds" -m "$TRAILER"
  ```

### Task 5: `content-compare.ts` replaces the scattered content checks

**Files:**
- Create: `src/sync/content-compare.ts`, `src/sync/__tests__/content-compare.test.ts`
- Modify: `src/sync/resolve.ts` (delete `remoteState`, l. 207–219), `src/sync/plan-tracked.ts` (import; `rs = remoteChanged(...)` ~l. 157; B4 adopt ~l. 173), `src/sync/plan-untracked.ts` (U2 adopt ~l. 160), `src/sync/executor.ts` (`verifyRemote`, `trashRemote`), `src/sync/__tests__/resolve.test.ts` (move the `remote: md5 compare…` test), `src/sync/__tests__/executor.test.ts` (one guard test)

- [ ] **Step 1: Write the failing test** `src/sync/__tests__/content-compare.test.ts` (the binary `remoteChanged` case is the `remote: md5 compare, else weak size + modifiedTime` test moved from `resolve.test.ts`; delete it there and drop `remoteState` from that file's import):
  ```ts
  import { describe, expect, it } from 'vitest';
  import {
    localMatchesRemote,
    remoteChanged,
    remoteUnchangedSince,
  } from '../content-compare.js';
  import { nativeEntry, nativeRecord, record, remoteEntry } from './fixtures.js';

  const LATER = '2026-11-04T00:00:00.000Z';

  describe('remoteChanged', () => {
    it('binary: md5 compare, else weak size + modifiedTime', () => {
      const k = record('r1', 'a.pdf');
      expect(remoteChanged(k, remoteEntry('r1', 'a.pdf', { md5: 'other' }))).toEqual({ changed: true, weak: false });
      expect(remoteChanged(k, remoteEntry('r1', 'a.pdf', { md5: null }))).toEqual({ changed: false, weak: true });
      expect(remoteChanged(k, remoteEntry('r1', 'a.pdf', { md5: null, size: 11 })).changed).toBe(true);
    });
    it('native: modifiedTime only', () => {
      const k = nativeRecord('g1', 'Plan.docx');
      expect(remoteChanged(k, nativeEntry('g1', 'Plan.docx'))).toEqual({ changed: false, weak: false });
      expect(remoteChanged(k, nativeEntry('g1', 'Plan.docx', { modifiedTime: LATER }))).toEqual({
        changed: true,
        weak: false,
      });
    });
  });
  describe('remoteUnchangedSince', () => {
    it('binary needs md5 and modifiedTime equal', () => {
      const r = remoteEntry('r1', 'a.pdf');
      expect(remoteUnchangedSince(r, { md5Checksum: r.md5, modifiedTime: r.modifiedTime })).toBe(true);
      expect(remoteUnchangedSince(r, { md5Checksum: 'x', modifiedTime: r.modifiedTime })).toBe(false);
      expect(remoteUnchangedSince(r, { md5Checksum: r.md5, modifiedTime: LATER })).toBe(false);
    });
    it('native needs modifiedTime equal', () => {
      const r = nativeEntry('g1', 'Plan.docx');
      expect(remoteUnchangedSince(r, { modifiedTime: r.modifiedTime })).toBe(true);
      expect(remoteUnchangedSince(r, { modifiedTime: LATER })).toBe(false);
    });
  });
  describe('localMatchesRemote', () => {
    it('binary: local md5 = Drive md5 (no record needed)', () => {
      const r = remoteEntry('r1', 'a.pdf');
      expect(localMatchesRemote('md5-r1', null, r)).toBe(true);
      expect(localMatchesRemote('other', null, r)).toBe(false);
      expect(localMatchesRemote('md5-r1', null, { ...r, md5: null })).toBe(false);
    });
    it('native: local md5 = md5 of the last export (record required)', () => {
      const k = nativeRecord('g1', 'Plan.docx', { localMd5: 'export-md5' });
      const r = nativeEntry('g1', 'Plan.docx');
      expect(localMatchesRemote('export-md5', k, r)).toBe(true);
      expect(localMatchesRemote('edited', k, r)).toBe(false);
      expect(() => localMatchesRemote('export-md5', null, r)).toThrow(/needs its record/);
    });
  });
  ```

- [ ] **Step 2: Run it.** `npx vitest run src/sync/__tests__/content-compare.test.ts`. Expected FAIL: `Failed to load url ../content-compare.js`.

- [ ] **Step 3: Implement** `src/sync/content-compare.ts`:
  ```ts
  import type { DriveFile } from '../drive/drive-adapter.js';
  import { ValidationError } from '../errors.js';
  import type { RemoteEntry, SyncRecord } from './types.js';

  /** R content vs the record: binary md5 (else size + modifiedTime, `weak`); native modifiedTime. */
  export function remoteChanged(
    record: SyncRecord,
    entry: RemoteEntry,
  ): { changed: boolean; weak: boolean } {
    if (entry.native !== null) {
      return { changed: entry.modifiedTime !== record.remoteModifiedTime, weak: false };
    }
    if (entry.md5 !== null && record.remoteMd5 !== null) {
      return { changed: entry.md5 !== record.remoteMd5, weak: false };
    }
    return {
      changed: entry.size !== record.remoteSize || entry.modifiedTime !== record.remoteModifiedTime,
      weak: true,
    };
  }

  /** Executor re-verification: binary md5 and modifiedTime equal; native modifiedTime equal. */
  export function remoteUnchangedSince(planned: RemoteEntry, current: DriveFile): boolean {
    if ((current.modifiedTime ?? '') !== planned.modifiedTime) return false;
    return planned.native !== null || (current.md5Checksum ?? null) === planned.md5;
  }

  /**
   * L equals R: binary by Drive md5 (record unused: U2/B4 adopt); native by the md5 of the
   * last export (record required — untracked natives with a local file are U0b).
   */
  export function localMatchesRemote(
    localMd5: string,
    record: SyncRecord | null,
    entry: RemoteEntry,
  ): boolean {
    if (entry.native === null) return entry.md5 !== null && localMd5 === entry.md5;
    if (record === null) {
      throw new ValidationError(`Internal: comparing ${entry.key} needs its record`);
    }
    return localMd5 === record.localMd5;
  }
  ```

- [ ] **Step 4: Wire it in.**
  - `plan-tracked.ts`: drop `remoteState` from the `./resolve.js` import, add `import { localMatchesRemote, remoteChanged } from './content-compare.js';`, `const rs = remoteChanged(record, remote);`, and B4 adopt becomes `if (lMd5 !== null && localMatchesRemote(lMd5, null, remote))`.
  - `plan-untracked.ts`: add the same import (`localMatchesRemote` only); U2 adopt condition `else if (R.md5 !== null && lMd5 === R.md5)` becomes `else if (localMatchesRemote(lMd5, null, R))`.
  - `resolve.ts`: delete `remoteState`.
  - `executor.ts`: add `import { remoteUnchangedSince } from './content-compare.js';`. `verifyRemote`'s condition becomes `if (current.trashed || !remoteUnchangedSince(planned, current))`. In `trashRemote` the inner condition becomes:
    ```ts
      if (
        !remoteUnchangedSince(remote, current) ||
        (current.parents?.[0] ?? '') !== remote.parentId
      ) {
    ```

- [ ] **Step 5: Add an executor guard test** (passes before and after; documents the strictness) to `describe('Executor (review regressions)')` in `executor.test.ts`:
  ```ts
  it('re-verification needs md5 and modifiedTime unchanged (remoteUnchangedSince)', async () => {
    const a = await put('a.pdf', 'L2');
    const r = remote('r1', 'a.pdf', 'R1');
    const k = record('r1', 'a.pdf');
    drive.getFile.mockResolvedValueOnce({
      id: 'r1',
      md5Checksum: r.md5,
      modifiedTime: '2026-11-03T09:00:00.000Z',
      parents: [ROOT_ID],
    });
    const out = await executor(pairFile([k])).run([
      action('update-remote', 'a.pdf', { record: k, local: a, localMd5: md5('L2'), remote: r }),
    ]);
    expect(out[0]).toMatchObject({ status: 'skipped' });
    expect(drive.updateFile).not.toHaveBeenCalled();
  });
  ```

- [ ] **Step 6: Run to pass.** `npx vitest run src/sync/__tests__/content-compare.test.ts src/sync/__tests__/resolve.test.ts src/sync/__tests__/executor.test.ts src/sync/__tests__/plan-tracked.test.ts src/sync/__tests__/plan-untracked.test.ts`. Expected PASS.

- [ ] **Step 7:** `npx prettier --write src/sync/content-compare.ts src/sync/resolve.ts src/sync/plan-tracked.ts src/sync/plan-untracked.ts src/sync/executor.ts src/sync/__tests__/content-compare.test.ts src/sync/__tests__/resolve.test.ts src/sync/__tests__/executor.test.ts && npm run check` → green.

- [ ] **Step 8: Commit.**
  ```bash
  git add src/sync/content-compare.ts src/sync/resolve.ts src/sync/plan-tracked.ts src/sync/plan-untracked.ts src/sync/executor.ts src/sync/__tests__/content-compare.test.ts src/sync/__tests__/resolve.test.ts src/sync/__tests__/executor.test.ts
  git commit -m "refactor(sync): decide content changes in content-compare" -m "remoteChanged, remoteUnchangedSince and localMatchesRemote replace remoteState and the inline md5 checks." -m "$TRAILER"
  ```

### Task 6: Scanner and probe classify natives; `native-unsupported`; `type-changed`

**Files:**
- Modify: `src/sync/remote-scanner.ts` (`toRemoteEntry`, `scanRemote`), `src/sync/remote-probe.ts` (`probeRecord`, `probeRecords`), `src/sync/types.ts` (`RemoteIgnoreReason`, `NoteCode`), `src/sync/report.ts` (`WARNING_CODES`), `src/sync/planner.ts` (ignored-notes loop ~l. 82–103), `src/sync/resolve.ts` (`resolveRemote` ignored message), `src/sync/plan-tracked.ts` (type-changed after (b)), `src/sync/plan-untracked.ts` (interim guard), `src/sync/scan-select.ts` (`scanRemoteTree` passes prefs), `src/sync/sync-service.ts` (`buildPlan` passes prefs to `probeRecords`)
- Tests: `remote-scanner.test.ts`, `remote-probe.test.ts`, `planner.test.ts`, `plan-tracked.test.ts`, `plan-untracked.test.ts`

- [ ] **Step 1: Write the failing tests.**

  `remote-scanner.test.ts` — add imports `DEFAULT_GOOGLE_EXPORT` from `../types.js`; in `'ignores shortcuts, native files, unrepresentable and dot names'` rename it to `'ignores shortcuts, unrepresentable and dot names'`, change `expect(scan.entries).toEqual([]);` to `expect(scan.entries.map((e) => e.key)).toEqual(['Plan.docx']);` and delete the `['g', 'Plan', 'native-skipped', false],` row. Add:
  ```ts
  it('keys Google-native files by their export name; unsupported types are ignored', async () => {
    const scan = await scanRemote(
      ROOT,
      treeLister([
        { id: 'g', name: 'Plan', mimeType: GOOGLE_MIME.document, parents: [ROOT] },
        { id: 's', name: 'Budget', mimeType: GOOGLE_MIME.spreadsheet, parents: [ROOT] },
        { id: 'f', name: 'Survey', mimeType: 'application/vnd.google-apps.form', parents: [ROOT] },
        { id: 'l', name: 'x'.repeat(252), mimeType: GOOGLE_MIME.document, parents: [ROOT] },
      ]),
      { ...DEFAULT_GOOGLE_EXPORT, spreadsheet: 'csv' },
    );
    expect(scan.entries.map((e) => [e.id, e.key, e.name, e.md5, e.size, e.native?.exportFormat])).toEqual([
      ['s', 'Budget.csv', 'Budget', null, null, 'csv'],
      ['g', 'Plan.docx', 'Plan', null, null, 'docx'],
    ]);
    expect(scan.ignored.map((i) => [i.id, i.reason])).toEqual([['f', 'native-unsupported'], ['l', 'unrepresentable']]);
  });
  it('a Drive native and a binary sharing the export key are both scanned under that key', async () => {
    const scan = await scanRemote(
      ROOT,
      treeLister([{ id: 'g', name: 'Plan', mimeType: GOOGLE_MIME.document, parents: [ROOT] }, binary('b', 'Plan.docx', ROOT)]),
    );
    expect(scan.entries.map((e) => [e.id, e.key])).toEqual([['b', 'Plan.docx'], ['g', 'Plan.docx']]);
  });
  ```
  `remote-probe.test.ts` — in `'is unknown when renamed to an unsyncable name or inside an ambiguous folder'` delete the last two lines (`const native = …` and its `expect`). Add:
  ```ts
  it('classifies Google-native files like the scanner (export key; unsupported → unknown)', async () => {
    const doc = { ...binary('r', 'Plan', 'f1'), mimeType: GOOGLE_MIME.document };
    expect(await probeRecord('r', scan(), getter({ r: doc }))).toMatchObject({
      state: 'present',
      entry: { key: 'docs/Plan.docx', md5: null, native: { exportFormat: 'docx' } },
    });
    const form = { ...binary('r', 'Survey', 'f1'), mimeType: 'application/vnd.google-apps.form' };
    expect(await probeRecord('r', scan(), getter({ r: form }))).toEqual({
      state: 'unknown',
      reason: 'is a Google file type that cannot be exported',
    });
    const dir = { ...binary('r', 'sub', 'f1'), mimeType: GOOGLE_MIME.folder };
    expect((await probeRecord('r', scan(), getter({ r: dir }))).state).toBe('unknown');
  });
  ```
  `planner.test.ts` — in `'reports native-skipped and unrepresentable Drive files'` rename to `'reports native-unsupported and unrepresentable Drive files'`, change the ignored row to `{ id: 'g1', path: 'Survey', reason: 'native-unsupported', isFolder: false }` and the expected first note to `['native-unsupported', 'Survey']`; add `expect(p.notes[0]?.message).toMatch(/cannot be exported/);`. In the baseline test change `reason: 'native-skipped'` to `reason: 'native-unsupported'`.

  `plan-tracked.test.ts` — import `nativeEntry, nativeRecord` from `./fixtures.js` and add to `describe('dispatch (spec §6.3)')`:
  ```ts
  it('type-changed: the Drive file switched between binary and Google-native', () => {
    const fromScan = run({ local: [L], remote: [nativeEntry('r1', 'a.pdf')] });
    expect(fromScan.actions).toEqual([]);
    expect(fromScan.notes[0]).toMatchObject({ code: 'unknown-state', rule: 'type-changed' });
    expect(fromScan.notes[0]?.message).toMatch(/^type-changed:/);
    const fromProbe = run({ local: [L], probes: [['r1', { state: 'present', entry: nativeEntry('r1', 'a.pdf') }]] });
    expect(fromProbe.notes[0]).toMatchObject({ rule: 'type-changed' });
    const nativeToBinary = run(
      { local: [localEntry('Plan.docx')], remote: [remoteEntry('g1', 'Plan.docx')] },
      nativeRecord('g1', 'Plan.docx'),
    );
    expect(nativeToBinary.notes[0]).toMatchObject({ rule: 'type-changed' });
  });
  ```
  `plan-untracked.test.ts` — import `nativeEntry` and add:
  ```ts
  it('interim: untracked Google-native files are candidates only', () => {
    const result = run({ selection: ['Plan.docx'], remote: [nativeEntry('g1', 'Plan.docx')] });
    expect(result.actions).toEqual([]);
    expect(result.candidates.remote.map((c) => c.path)).toEqual(['Plan.docx']);
  });
  it('a Drive native and a binary with the same export key are ambiguous (no action)', () => {
    const result = run({ remote: [nativeEntry('g1', 'Plan.docx'), remoteEntry('b1', 'Plan.docx')] });
    expect(result.actions).toEqual([]);
    expect(result.notes).toMatchObject([{ code: 'ambiguous', path: 'Plan.docx' }]);
  });
  ```

- [ ] **Step 2: Run them.** `npx vitest run src/sync/__tests__/remote-scanner.test.ts src/sync/__tests__/remote-probe.test.ts src/sync/__tests__/planner.test.ts src/sync/__tests__/plan-tracked.test.ts src/sync/__tests__/plan-untracked.test.ts`. Expected FAIL: scanner still reports `native-skipped` (entries empty), probe returns `unknown('is no longer a regular file')`, `native-unsupported` is not a valid reason (type error is reported by `npm run typecheck`; vitest shows the missing note), type-changed note missing, interim test gets a `download-new` action.

- [ ] **Step 3: Types and report.** In `types.ts`: `export type RemoteIgnoreReason = 'native-unsupported' | 'shortcut' | 'unrepresentable' | 'ignored-name';` and in `NoteCode` replace `'native-skipped'` with `'native-unsupported'`. In `report.ts` `WARNING_CODES` replace `'native-skipped'` with `'native-unsupported'`.

- [ ] **Step 4: Scanner.** `remote-scanner.ts`: imports become `import { GOOGLE_MIME } from '../files/export-formats.js';`, `import { classifyRemote, exportKey, type RemoteKind } from './remote-kinds.js';`, `import { baseName, foldKey, isIgnoredName, isRepresentable } from './paths.js';`, `import { DEFAULT_GOOGLE_EXPORT, SYNC_FILE_FIELDS, type GoogleExportPrefs, type RemoteEntry, type RemoteScan } from './types.js';`. Replace `toRemoteEntry`:
  ```ts
  export function toRemoteEntry(
    file: DriveFile,
    parentKeyValue: string,
    parentId: string,
    ancestorIds: string[],
    kind: RemoteKind = { kind: 'binary' },
  ): RemoteEntry {
    const name = file.name ?? '';
    const native =
      kind.kind === 'native'
        ? { mimeType: kind.mimeType, exportFormat: kind.exportFormat, exportMime: kind.exportMime }
        : null;
    const key =
      kind.kind === 'native'
        ? exportKey(parentKeyValue, name, kind.extension)
        : joinKey(parentKeyValue, name);
    return {
      id: file.id ?? '',
      key,
      foldKey: foldKey(key),
      name,
      parentId,
      ancestorIds,
      mimeType: file.mimeType ?? 'application/octet-stream',
      md5: native ? null : (file.md5Checksum ?? null),
      size: native || !file.size ? null : Number(file.size),
      modifiedTime: file.modifiedTime ?? '',
      createdTime: file.createdTime ?? '',
      canEdit: file.capabilities?.canEdit ?? false,
      canTrash: file.capabilities?.canTrash ?? false,
      native,
    };
  }
  ```
  `scanRemote(rootId: string, list: FolderLister, prefs: GoogleExportPrefs = DEFAULT_GOOGLE_EXPORT)`; replace the `isGoogleNative` branch and the final `else`:
  ```ts
      } else if (f.mimeType === GOOGLE_MIME.shortcut) {
        scan.ignored.push({ id, path: key, reason: 'shortcut', isFolder: false });
      } else {
        const kind = classifyRemote(f, prefs);
        if (kind.kind === 'unsupported') {
          scan.ignored.push({ id, path: key, reason: kind.reason, isFolder: false });
          continue;
        }
        const entry = toRemoteEntry(f, folder.key, folder.id, folder.ancestors, kind);
        if (!isRepresentable(baseName(entry.key))) {
          scan.ignored.push({ id, path: key, reason: 'unrepresentable', isFolder: false });
        } else {
          scan.entries.push(entry);
        }
      }
  ```
  Update the doc comment (no "Phase A" natives).

- [ ] **Step 5: Probe.** `remote-probe.ts`: import `classifyRemote` from `./remote-kinds.js`, `baseName` from `./paths.js`, `DEFAULT_GOOGLE_EXPORT, type GoogleExportPrefs` from `./types.js`; drop `isGoogleNative`. Signatures: `probeRecord(remoteId, scan, get, prefs: GoogleExportPrefs = DEFAULT_GOOGLE_EXPORT)` and `probeRecords(remoteIds, scan, get, prefs: GoogleExportPrefs = DEFAULT_GOOGLE_EXPORT)` (passes `prefs` on). Replace the shortcut/native block:
  ```ts
      if (mime === GOOGLE_MIME.shortcut || mime === GOOGLE_MIME.folder) {
        return unknown('is no longer a regular file');
      }
      const kind = classifyRemote(file, prefs);
      if (kind.kind === 'unsupported') return unknown('is a Google file type that cannot be exported');
      const entry = toRemoteEntry(file, parentKey, parent, [parent], kind);
      if (!isRepresentable(baseName(entry.key))) {
        return unknown('renamed in Drive to a name that cannot be synced');
      }
      return { state: 'present', entry };
  ```

- [ ] **Step 6: Service threading.** `scan-select.ts` `scanRemoteTree`: pass `pair.googleExport` as the third argument of `scanRemote`. `sync-service.ts` `buildPlan`: `probeRecords(missing, remote, (id, fields) => …, pair.googleExport)`.

- [ ] **Step 7: Planner notes.** In `planner.ts` replace the `native-skipped` branch of the ignored loop with:
  ```ts
      if (ignored.reason === 'native-unsupported') {
        notes.push({
          code: 'native-unsupported',
          path: ignored.path,
          rule: 'ignored',
          remoteId: ignored.id,
          message:
            'Google Forms, Sites, Apps Script and similar files cannot be exported; they are not synced',
        });
      } else if (ignored.reason === 'unrepresentable') {
  ```
  In `resolve.ts` `resolveRemote` replace the `ignoredById.has` check with:
  ```ts
    const ignored = ctx.ignoredById.get(record.remoteId);
    if (ignored) {
      return {
        kind: 'unknown',
        reason:
          ignored.reason === 'native-unsupported'
            ? 'is a Google file type that cannot be exported'
            : 'renamed in Drive to a name that cannot be synced',
      };
    }
  ```

- [ ] **Step 8: type-changed and interim guard.** In `plan-tracked.ts` add at module level:
  ```ts
  export const TYPE_CHANGED =
    'type-changed: the Drive file switched between a Google Docs/Sheets/Slides file and a regular file; remove it with sync_select remove and select it again';
  ```
  and right after the (b) ambiguous block (before `// (c), (d)`):
  ```ts
    if (R.kind === 'present' && (record.native !== null) !== (R.entry.native !== null)) {
      return note('unknown-state', 'type-changed', TYPE_CHANGED);
    }
  ```
  In `plan-untracked.ts`, right before `const base = { record: null, selection: {} as SelectionChange };`:
  ```ts
    // Interim (removed in Task 11): Google-native exports arrive with the native rules.
    if (R?.native) {
      out.candidates.remote.push({ path: R.key, size: R.size, modifiedTime: R.modifiedTime, remoteId: R.id });
      continue;
    }
  ```

- [ ] **Step 9: Run to pass.** Same command as Step 2. Expected PASS.

- [ ] **Step 10:** `npx prettier --write src/sync/*.ts src/sync/__tests__/*.ts && npm run check` → green.

- [ ] **Step 11: Commit.**
  ```bash
  git add src/sync/remote-scanner.ts src/sync/remote-probe.ts src/sync/types.ts src/sync/report.ts src/sync/planner.ts src/sync/resolve.ts src/sync/plan-tracked.ts src/sync/plan-untracked.ts src/sync/scan-select.ts src/sync/sync-service.ts src/sync/__tests__/remote-scanner.test.ts src/sync/__tests__/remote-probe.test.ts src/sync/__tests__/planner.test.ts src/sync/__tests__/plan-tracked.test.ts src/sync/__tests__/plan-untracked.test.ts
  git commit -m "feat(sync): scan Google-native files under their export names" -m "Scanner and probe classify through remote-kinds; unsupported types are reported native-unsupported; a record whose Drive file changed kind is unknown-state type-changed. Untracked natives stay candidates until the native rules land." -m "$TRAILER"
  ```

### Task 7: `nativeBaselineDone` upgrade guard (schema, baseline, memory Drive natives)

**Files:**
- Modify: `src/sync/types.ts` (`Pair.nativeBaselineDone`, `Plan.nativeBaseline`), `src/sync/pair-store.ts` (`pairSchema`), `src/sync/pair-admin.ts` (`createPair`), `src/sync/planner.ts` (`plan` return), `src/sync/sync-service.ts` (`run` after the executor), `src/sync/__tests__/fixtures.ts` (`makePair`), `src/sync/__tests__/memory-drive.ts` (natives), `src/sync/__tests__/report.test.ts` (`PLAN` literal)
- Tests: `pair-store.test.ts`, `planner.test.ts`, `sync-service.run.test.ts`, `sync-service.pairs.test.ts`

- [ ] **Step 1: Memory Drive natives** (test helper, needed by the tests below). In `memory-drive.ts` import `isGoogleNative` next to `GOOGLE_MIME`; in `toDrive` replace `...(isFolder ? {} : { md5Checksum…, size… })` with `...(isGoogleNative(f.mimeType) ? {} : { md5Checksum…, size… })` (folders are `google-apps` too; delete the now-unused `isFolder` only if `canAddChildren` no longer needs it — it does, so keep it). Add to `MemoryDrive`:
  ```ts
    /** A Google-native file; its export (any format) is `content`. */
    addNative(id: string, name: string, parent: string, content: string, mimeType?: string): MemFile;
  ```
  the mock
  ```ts
  drive.exportMedia.mockImplementation(async (id) => {
    const f = files.get(id);
    if (!f) throw httpError(404, 'notFound');
    return Readable.from([f.content]);
  });
  ```
  and in the returned object
  ```ts
    addNative: (id, name, parent, content, mimeType = GOOGLE_MIME.document) =>
      add({ id, name, mimeType, parents: [parent], content: Buffer.from(content) }),
  ```

- [ ] **Step 2: Write the failing tests.**

  `pair-store.test.ts` (inside the existing `describe('PairStore')`; `mkdir`, `writeFile`, `path` are already imported):
  ```ts
  it('loads a Phase A pair file without nativeBaselineDone as false', async () => {
    const store = new PairStore({ dir, logger: silentLogger() });
    const file = makePairFile();
    const oldPair: Record<string, unknown> = { ...file.pair };
    delete oldPair.nativeBaselineDone;
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'docs.json'), JSON.stringify({ ...file, pair: oldPair }));
    expect((await store.load('docs')).pair.nativeBaselineDone).toBe(false);
  });
  ```
  `planner.test.ts` (import `nativeEntry` from `./fixtures.js`), in `describe('plan composition')`:
  ```ts
  it('lists untracked Google-native Drive files for the upgrade baseline', () => {
    const p = plan(
      planInput({
        records: [record('r0', 'a.pdf')],
        local: [localEntry('a.pdf')],
        remote: [
          remoteEntry('r0', 'a.pdf'),
          nativeEntry('g2', 'B.docx'),
          nativeEntry('g1', 'A.docx'),
          remoteEntry('n1', 'new.pdf'),
        ],
      }),
    );
    expect(p.nativeBaseline).toEqual(['g1', 'g2']);
  });
  ```
  `sync-service.pairs.test.ts`, in `'binds an existing Drive folder…'` add `expect(file.pair.nativeBaselineDone).toBe(false);`.

  `sync-service.run.test.ts`, new block at the end:
  ```ts
  describe('upgrade from Phase A (nativeBaselineDone)', () => {
    async function phaseAPair(): Promise<void> {
      await apply();
      const file = await store.load('docs');
      file.pair.nativeBaselineDone = false;
      await store.save(file);
    }
    const done = async (): Promise<boolean> =>
      (await store.load('docs')).pair.nativeBaselineDone;

    it('dry runs and plan-changed aborts change nothing; an applied run baselines natives', async () => {
      await phaseAPair();
      mem.addNative('g1', 'Plan', 'ROOT', 'doc v1');
      const dry = await sync.run({ name: 'docs' });
      expect(await done()).toBe(false);
      await writeFile(at('new.pdf'), 'N');
      await sync.select({ name: 'docs', add: ['new.pdf'] });
      const changed = await sync.run({ name: 'docs', apply: true, planId: dry.planId });
      expect(changed.aborted?.reason).toBe('plan-changed');
      expect(await done()).toBe(false);
      await apply();
      const after = await store.load('docs');
      expect(after.pair.nativeBaselineDone).toBe(true);
      expect(after.pair.remoteBaseline).toContain('g1');
    });
    it('a mass-delete abort leaves it false', async () => {
      for (const n of ['a', 'b', 'c']) await writeFile(at(`${n}.pdf`), n);
      await sync.select({ name: 'docs', add: ['a.pdf', 'b.pdf', 'c.pdf'] });
      await phaseAPair();
      for (const f of mem.childrenOf('ROOT')) f.trashed = true;
      const braked = await apply();
      expect(braked.aborted?.reason).toBe('mass-delete');
      expect(await done()).toBe(false);
    });
  });
  ```

- [ ] **Step 3: Run them.** `npx vitest run src/sync/__tests__/pair-store.test.ts src/sync/__tests__/planner.test.ts src/sync/__tests__/sync-service.run.test.ts src/sync/__tests__/sync-service.pairs.test.ts -t "nativeBaselineDone|upgrade baseline|binds an existing"`. Expected FAIL: `nativeBaselineDone` is `undefined`, `p.nativeBaseline` is `undefined`, `remoteBaseline` lacks `g1`.

- [ ] **Step 4: Implement.**
  - `types.ts` `Pair`: after `firstAppliedRunAt` add
    ```ts
      /** Addendum §4.1: false until the first applied run that baselined Google-native files. */
      nativeBaselineDone: boolean;
    ```
    `Plan`: after `baseline` add
    ```ts
      /** Untracked Google-native files seen (upgrade baseline, addendum §4.1). */
      nativeBaseline: string[];
    ```
  - `pair-store.ts` `pairSchema`: add `nativeBaselineDone: z.boolean().default(false),` (pair-file `version` stays 1).
  - `pair-admin.ts` `createPair`: add `nativeBaselineDone: false,` to the new `Pair`.
  - `fixtures.ts` `makePair`: add `nativeBaselineDone: true,` before `...overrides` (fixtures model the steady state; upgrade tests override it).
  - `planner.ts` `plan` return: add
    ```ts
      nativeBaseline: [
        ...new Set(
          input.remote.entries
            .filter((r) => r.native !== null && !ctx.trackedIds.has(r.id))
            .map((r) => r.id),
        ),
      ].sort(),
    ```
  - `report.test.ts` `PLAN`: add `nativeBaseline: [],`.
  - `sync-service.ts` `run`, right after the `firstAppliedRunAt === null` block and before `await this.store.save(file);`:
    ```ts
      // Addendum §4.1: baseline the natives Phase A never recorded, in the same save.
      if (!file.pair.nativeBaselineDone) {
        file.pair.remoteBaseline = [
          ...new Set([...file.pair.remoteBaseline, ...plan.nativeBaseline]),
        ].sort();
        file.pair.baselineFolders = [
          ...new Set([...file.pair.baselineFolders, ...plan.baseline.folders]),
        ].sort();
        file.pair.nativeBaselineDone = true;
      }
    ```

- [ ] **Step 5: Run to pass.** Same command as Step 3. Expected PASS.

- [ ] **Step 6:** `npx prettier --write src/sync/types.ts src/sync/pair-store.ts src/sync/pair-admin.ts src/sync/planner.ts src/sync/sync-service.ts src/sync/__tests__/*.ts && npm run check` → green.

- [ ] **Step 7: Commit.**
  ```bash
  git add src/sync/types.ts src/sync/pair-store.ts src/sync/pair-admin.ts src/sync/planner.ts src/sync/sync-service.ts src/sync/__tests__/fixtures.ts src/sync/__tests__/memory-drive.ts src/sync/__tests__/report.test.ts src/sync/__tests__/pair-store.test.ts src/sync/__tests__/planner.test.ts src/sync/__tests__/sync-service.run.test.ts src/sync/__tests__/sync-service.pairs.test.ts
  git commit -m "feat(sync): baseline Google-native files once when upgrading from Phase A" -m "Pair.nativeBaselineDone defaults to false for old pair files; the first applied run adds untracked natives to remoteBaseline in the same save." -m "$TRAILER"
  ```

### Task 8: `googleExport` validation on pair creation

**Files:**
- Modify: `src/sync/pair-admin.ts` (`CreatePairInput`, `createPair`), `src/mcp/sync-tools.ts` (`sync_create_pair` schema)
- Tests: `sync-service.pairs.test.ts`, `src/mcp/__tests__/sync-tools.test.ts`

- [ ] **Step 1: Write the failing tests.** In `sync-service.pairs.test.ts` `describe('createPair')`:
  ```ts
  it('stores validated googleExport preferences (defaults for omitted types)', async () => {
    await sync.createPair({
      name: 'docs',
      localDir: local,
      remoteFolderId: 'ROOT',
      googleExport: { document: 'pdf', spreadsheet: 'csv' },
    });
    expect((await store.load('docs')).pair.googleExport).toEqual({
      document: 'pdf',
      spreadsheet: 'csv',
      presentation: 'pptx',
      drawing: 'pdf',
    });
  });
  it('rejects an export format the Google type cannot produce, before writing anything', async () => {
    const res = sync.createPair({
      name: 'docs',
      localDir: local,
      remoteFolderId: 'ROOT',
      googleExport: { spreadsheet: 'docx' },
    });
    await expect(res).rejects.toBeInstanceOf(ValidationError);
    await expect(res).rejects.toThrow('Google Sheets cannot be exported as "docx"');
    expect(await readdir(local)).toEqual([]);
  });
  ```
  In `sync-tools.test.ts` `describe('sync MCP tools')`:
  ```ts
  it('validates googleExport on sync_create_pair', async () => {
    const bad = await call('sync_create_pair', {
      name: 'docs',
      localDir: local,
      remoteFolderId: 'ROOT',
      googleExport: { presentation: 'csv' },
    });
    expect(bad.isError).toBe(true);
    expect(bad.text).toContain('Google Slides cannot be exported as "csv"');
  });
  ```

- [ ] **Step 2: Run them.** `npx vitest run src/sync/__tests__/sync-service.pairs.test.ts src/mcp/__tests__/sync-tools.test.ts -t "googleExport"`. Expected FAIL: preferences ignored (defaults stored); MCP rejects the unknown key or stores defaults (no error).

- [ ] **Step 3: Implement.** `pair-admin.ts`: `CreatePairInput` gains `googleExport?: Partial<GoogleExportPrefs>;` (import the type from `./types.js`). At the top of `createPair`, after the `remoteFolderId`/`remoteFolderName` check: `const googleExport = validateGoogleExport(input.googleExport ?? {});` (import from `./remote-kinds.js`), and the new `Pair` uses `googleExport,` instead of `{ ...DEFAULT_GOOGLE_EXPORT }` (drop the now-unused import). `sync-tools.ts`: import `EXPORT_FORMATS` from `../files/export-formats.js` and add to `sync_create_pair`'s `inputSchema`:
  ```ts
        googleExport: z
          .object({
            document: z.enum(EXPORT_FORMATS).optional(),
            spreadsheet: z.enum(EXPORT_FORMATS).optional(),
            presentation: z.enum(EXPORT_FORMATS).optional(),
            drawing: z.enum(EXPORT_FORMATS).optional(),
          })
          .optional()
          .describe(
            'Local export format of Google files (read-only copies). Defaults: docx, xlsx, pptx, pdf. Docs: docx/pdf/md/txt/odt/html; Sheets: xlsx/pdf/csv/ods; Slides: pptx/pdf/txt/odp; Drawings: png/pdf/svg/jpg',
          ),
  ```

- [ ] **Step 4: Run to pass.** Same command. Expected PASS.

- [ ] **Step 5:** `npx prettier --write src/sync/pair-admin.ts src/mcp/sync-tools.ts src/sync/__tests__/sync-service.pairs.test.ts src/mcp/__tests__/sync-tools.test.ts && npm run check` → green.

- [ ] **Step 6: Commit.**
  ```bash
  git add src/sync/pair-admin.ts src/mcp/sync-tools.ts src/sync/__tests__/sync-service.pairs.test.ts src/mcp/__tests__/sync-tools.test.ts
  git commit -m "feat(sync): validate googleExport formats when creating a pair" -m "$TRAILER"
  ```

### Task 9: No runtime `googleapis` import under `src/sync`

**Files:**
- Create: `src/sync/__tests__/no-googleapis.test.ts`

- [ ] **Step 1: Write the test:**
  ```ts
  import { readFile, readdir } from 'node:fs/promises';
  import path from 'node:path';
  import { fileURLToPath } from 'node:url';
  import { describe, expect, it } from 'vitest';

  const SYNC_DIR = fileURLToPath(new URL('..', import.meta.url));
  const SELF = path.basename(fileURLToPath(import.meta.url));

  /** Statements that load googleapis at runtime; `import type` / `export type` are allowed. */
  function runtimeGoogleapisImports(source: string): string[] {
    const hits: string[] = [];
    const fromRe = /(?:^|\n)\s*(import|export)\s+(type\s+)?[^;]*?from\s*['"]googleapis(?:\/[^'"]*)?['"]/g;
    for (const m of source.matchAll(fromRe)) if (m[2] === undefined) hits.push(m[0].trim());
    const bareRe = /(?:^|\n)\s*import\s*['"]googleapis[^'"]*['"]|import\s*\(\s*['"]googleapis|require\s*\(\s*['"]googleapis/g;
    for (const m of source.matchAll(bareRe)) hits.push(m[0].trim());
    return hits;
  }
  describe('provider boundary (addendum §4.4)', () => {
    it('detects runtime imports and allows type-only ones', () => {
      expect(runtimeGoogleapisImports("import { google } from 'googleapis';")).toHaveLength(1);
      expect(runtimeGoogleapisImports("import type { drive_v3 } from 'googleapis';")).toEqual([]);
      expect(runtimeGoogleapisImports("import type {\n  drive_v3,\n} from 'googleapis';")).toEqual([]);
      expect(runtimeGoogleapisImports("const g = await import('googleapis');")).toHaveLength(1);
      expect(
        runtimeGoogleapisImports("import type { DriveFile } from '../drive/drive-adapter.js';"),
      ).toEqual([]);
    });
    it('no file under src/sync imports googleapis at runtime', async () => {
      const files = (await readdir(SYNC_DIR, { recursive: true })).filter(
        (f) => f.endsWith('.ts') && path.basename(f) !== SELF,
      );
      expect(files.length).toBeGreaterThan(20);
      const offenders: string[] = [];
      for (const f of files) {
        const hits = runtimeGoogleapisImports(await readFile(path.join(SYNC_DIR, f), 'utf8'));
        if (hits.length > 0) offenders.push(`${f}: ${hits.join(' | ')}`);
      }
      expect(offenders).toEqual([]);
    });
  });
  ```

- [ ] **Step 2: Prove it can fail.** Create a scratch file `src/sync/zz-probe.ts` containing `import { google } from 'googleapis';\nexport const probe = google;` and run `npx vitest run src/sync/__tests__/no-googleapis.test.ts`. Expected FAIL listing `zz-probe.ts: import { google } from 'googleapis'`. Delete `src/sync/zz-probe.ts`.

- [ ] **Step 3: Run to pass.** Same command. Expected PASS.

- [ ] **Step 4:** `npx prettier --write src/sync/__tests__/no-googleapis.test.ts && npm run check` → green; `git status --short` shows no `zz-probe.ts`.

- [ ] **Step 5: Commit.**
  ```bash
  git add src/sync/__tests__/no-googleapis.test.ts
  git commit -m "test(sync): forbid runtime googleapis imports under src/sync" -m "$TRAILER"
  ```

---

## Chunk 3: Google-native rules N1–N9 and export actions

### Task 10: Export actions in the executor (`exec-export.ts`)

**Files:**
- Create: `src/sync/exec-export.ts`
- Modify: `src/sync/types.ts` (`ActionKind`, `Action.localEdit`), `src/sync/planner.ts` (`KIND_ORDER`), `src/sync/exec-records.ts` (`RemoteFields.native`, `fromEntry`, `fromDrive`, `makeRecord`, `localEditName`, `need`), `src/sync/errors.ts` (`LocalEditKeptError`), `src/sync/executor.ts` (`STAGES`, `run` catch, `execute`, `host()`, `move`), `src/sync/report.ts` (skip code, done messages)
- Tests: `src/sync/__tests__/executor.test.ts`, `src/sync/__tests__/report.test.ts`

- [ ] **Step 1: Write the failing tests.** In `executor.test.ts` add imports `type { DriveFile } from '../../drive/drive-adapter.js'`, `{ GOOGLE_MIME } from '../../files/export-formats.js'`, `{ SYNC_EXPORT_FIELDS } from '../exec-export.js'`, and `nativeEntry, nativeRecord` from `./fixtures.js`. Append:
  ```ts
  describe('Executor exports (Google-native)', () => {
    const NEWER = '2026-11-04T00:00:00.000Z';
    const DOC = nativeEntry('g1', 'Plan.docx');

    function current(r: RemoteEntry, extra: DriveFile = {}): DriveFile {
      return {
        id: r.id,
        name: r.name,
        mimeType: r.mimeType,
        modifiedTime: r.modifiedTime,
        parents: [r.parentId],
        trashed: false,
        webViewLink: `https://docs/${r.id}`,
        exportLinks: { [r.native?.exportMime ?? '']: `https://export/${r.id}` },
        ...extra,
      };
    }
    function exportServes(content: string): void {
      drive.exportMedia.mockImplementation(async () => Readable.from([Buffer.from(content)]));
    }
    it('export-new re-reads the file, writes the export and records a native record', async () => {
      drive.getFile.mockResolvedValueOnce(current(DOC));
      exportServes('DOCX v1');
      const out = await executor(pairFile([], ['Plan.docx'])).run([action('export-new', 'Plan.docx', { remote: DOC })]);
      expect(out).toEqual([{ kind: 'export-new', path: 'Plan.docx', status: 'done' }]);
      expect(drive.getFile).toHaveBeenCalledWith('g1', SYNC_EXPORT_FIELDS);
      expect(drive.exportMedia).toHaveBeenCalledWith('g1', DOC.native?.exportMime);
      expect(await readFile(path.join(dir, 'Plan.docx'), 'utf8')).toBe('DOCX v1');
      expect(saves.at(-1)?.records).toMatchObject([
        {
          remoteId: 'g1',
          path: 'Plan.docx',
          remoteName: 'Plan',
          localMd5: md5('DOCX v1'),
          remoteMd5: null,
          native: { mimeType: GOOGLE_MIME.document, exportFormat: 'docx' },
        },
      ]);
      expect(audit.entries.map((e) => e.op)).toEqual(['sync_download']);
    });
    it('skips an export when the re-read shows a change or the trash', async () => {
      const other = nativeEntry('g2', 'Other.docx');
      drive.getFile.mockResolvedValueOnce(current(DOC, { modifiedTime: NEWER }));
      drive.getFile.mockResolvedValueOnce(current(other, { trashed: true }));
      const out = await executor(pairFile([], ['Plan.docx', 'Other.docx'])).run([
        action('export-new', 'Plan.docx', { remote: DOC }),
        action('export-new', 'Other.docx', { remote: other }),
      ]);
      expect(out.map((o) => o.status)).toEqual(['skipped', 'skipped']);
      expect(drive.exportMedia).not.toHaveBeenCalled();
      expect(await readdir(dir)).toEqual([]);
    });
    it('export-replace overwrites the tracked export while it is unchanged', async () => {
      const l = await put('Plan.docx', 'DOCX v1');
      const k = nativeRecord('g1', 'Plan.docx', { localMd5: md5('DOCX v1') });
      const r = nativeEntry('g1', 'Plan.docx', { modifiedTime: NEWER });
      drive.getFile.mockResolvedValueOnce(current(r));
      exportServes('DOCX v2');
      const out = await executor(pairFile([k])).run([
        action('export-replace', 'Plan.docx', { record: k, local: l, localMd5: k.localMd5, remote: r }),
      ]);
      expect(out[0]?.status).toBe('done');
      expect(await readFile(path.join(dir, 'Plan.docx'), 'utf8')).toBe('DOCX v2');
      expect(saves.at(-1)?.records[0]).toMatchObject({ localMd5: md5('DOCX v2'), remoteModifiedTime: NEWER });
    });
    it('N5 moves the local edit aside after the re-read, then exports', async () => {
      const l = await put('Plan.docx', 'my edit');
      const k = nativeRecord('g1', 'Plan.docx');
      const r = nativeEntry('g1', 'Plan.docx', { modifiedTime: NEWER });
      drive.getFile.mockResolvedValueOnce(current(r));
      exportServes('DOCX v2');
      const out = await executor(pairFile([k])).run([
        action('export-new', 'Plan.docx', {
          record: k,
          local: l,
          localMd5: md5('my edit'),
          remote: r,
          localEdit: true,
        }),
      ]);
      const kept = 'Plan (local edit 2026-11-03 10.15).docx';
      expect(out[0]).toMatchObject({ status: 'done', conflictCopy: kept, warning: 'native-local-edit-kept' });
      expect(await readFile(path.join(dir, kept), 'utf8')).toBe('my edit');
      expect(await readFile(path.join(dir, 'Plan.docx'), 'utf8')).toBe('DOCX v2');
    });
    it('N5 leaves the local edit where it is when the re-read shows a change', async () => {
      const l = await put('Plan.docx', 'my edit');
      const k = nativeRecord('g1', 'Plan.docx');
      const r = nativeEntry('g1', 'Plan.docx', { modifiedTime: NEWER });
      drive.getFile.mockResolvedValueOnce(current(r, { modifiedTime: '2026-11-05T00:00:00.000Z' }));
      const out = await executor(pairFile([k])).run([
        action('export-new', 'Plan.docx', { record: k, local: l, remote: r, localEdit: true }),
      ]);
      expect(out[0]?.status).toBe('skipped');
      expect(await readdir(dir)).toEqual(['Plan.docx']);
      expect(await readFile(path.join(dir, 'Plan.docx'), 'utf8')).toBe('my edit');
    });
    it('N5 does not move the local edit when the export cannot be opened (too large)', async () => {
      const l = await put('Plan.docx', 'my edit');
      const k = nativeRecord('g1', 'Plan.docx');
      const r = nativeEntry('g1', 'Plan.docx', { modifiedTime: NEWER });
      drive.getFile.mockResolvedValueOnce(current(r));
      drive.exportMedia.mockRejectedValueOnce(httpError(403, 'exportSizeLimitExceeded'));
      drive.fetchExportLink.mockRejectedValueOnce(httpError(403));
      const out = await executor(pairFile([k])).run([
        action('export-new', 'Plan.docx', { record: k, local: l, remote: r, localEdit: true }),
      ]);
      expect(out[0]).toMatchObject({ status: 'skipped', warning: 'native-too-large' });
      expect(out[0]?.conflictCopy).toBeUndefined();
      expect(await readdir(dir)).toEqual(['Plan.docx']);
      expect(await readFile(path.join(dir, 'Plan.docx'), 'utf8')).toBe('my edit');
    });
    it('N5 reports the kept name when the export breaks after the edit was moved', async () => {
      const l = await put('Plan.docx', 'my edit');
      const k = nativeRecord('g1', 'Plan.docx');
      const r = nativeEntry('g1', 'Plan.docx', { modifiedTime: NEWER });
      drive.getFile.mockResolvedValueOnce(current(r));
      const broken = new Readable({ read() { this.destroy(new Error('connection reset')); } });
      drive.exportMedia.mockResolvedValueOnce(broken);
      const out = await executor(pairFile([k])).run([
        action('export-new', 'Plan.docx', { record: k, local: l, remote: r, localEdit: true }),
      ]);
      const kept = 'Plan (local edit 2026-11-03 10.15).docx';
      expect(out[0]).toMatchObject({ status: 'failed', conflictCopy: kept });
      expect(await readFile(path.join(dir, kept), 'utf8')).toBe('my edit');
      expect(saves).toEqual([]);
    });
    it('reports native-too-large and keeps the record when both export paths fail', async () => {
      drive.getFile.mockResolvedValueOnce(current(DOC));
      drive.exportMedia.mockRejectedValueOnce(httpError(403, 'exportSizeLimitExceeded'));
      drive.fetchExportLink.mockRejectedValueOnce(httpError(403));
      const out = await executor(pairFile([], ['Plan.docx'])).run([action('export-new', 'Plan.docx', { remote: DOC })]);
      expect(out[0]).toMatchObject({ status: 'skipped', warning: 'native-too-large' });
      expect(out[0]?.message).toContain('https://docs/g1');
      expect(saves).toEqual([]);
    });
    it('move-local of a native record exports the newer content after the move (N6)', async () => {
      const l = await put('Plan.docx', 'DOCX v1');
      const k = nativeRecord('g1', 'Plan.docx', { localMd5: md5('DOCX v1') });
      const r = nativeEntry('g1', 'sub/Plan.docx', { modifiedTime: NEWER });
      drive.getFile.mockResolvedValueOnce(current(r));
      exportServes('DOCX v2');
      const out = await executor(pairFile([k])).run([
        action('move-local', 'sub/Plan.docx', {
          record: k,
          local: l,
          localMd5: k.localMd5,
          remote: r,
          thenDownload: true,
          selection: { remove: ['Plan.docx'], add: ['sub/Plan.docx'] },
        }),
      ]);
      expect(out[0]?.status).toBe('done');
      expect(await readFile(path.join(dir, 'sub', 'Plan.docx'), 'utf8')).toBe('DOCX v2');
      expect(drive.downloadMedia).not.toHaveBeenCalled();
      expect(saves.at(-1)?.records[0]).toMatchObject({ path: 'sub/Plan.docx', native: { exportFormat: 'docx' } });
    });
  });
  ```
  In `report.test.ts` add:
  ```ts
  it('uses the outcome warning as the skip code and keeps done-outcome messages', () => {
    const kept = 'Plan (local edit 2026-11-03 10.15).docx';
    const report = buildReport('docs', PLAN, {
      dryRun: false,
      outcomes: [
        { kind: 'export-new', path: 'Big.docx', status: 'skipped', message: 'too large', warning: 'native-too-large' },
        {
          kind: 'export-new',
          path: 'Plan.docx',
          status: 'done',
          conflictCopy: kept,
          warning: 'native-local-edit-kept',
          message: `your local edit is kept as ${kept}`,
        },
      ],
    });
    expect(report.actions).toEqual({ 'export-new': ['Plan.docx'] });
    expect(report.warnings.slice(1)).toEqual([
      { path: 'Big.docx', code: 'native-too-large', message: 'too large' },
      { path: 'Plan.docx', code: 'native-local-edit-kept', message: `your local edit is kept as ${kept}` },
    ]);
  });
  it('names the kept local edit on a failed export', () => {
    const kept = 'Plan (local edit 2026-11-03 10.15).docx';
    const report = buildReport('docs', PLAN, {
      dryRun: false,
      outcomes: [{ kind: 'export-new', path: 'Plan.docx', status: 'failed', message: 'boom', conflictCopy: kept }],
    });
    expect(report.failures).toEqual([{ path: 'Plan.docx', kind: 'export-new', message: 'boom' }]);
    expect(report.warnings.at(-1)).toEqual({
      path: 'Plan.docx',
      code: 'native-local-edit-kept',
      message: `your local edit is kept as ${kept}`,
    });
  });
  ```

- [ ] **Step 2: Run them.** `npx vitest run src/sync/__tests__/executor.test.ts src/sync/__tests__/report.test.ts -t "Google-native|skip code|kept local edit"`. Expected FAIL: `Failed to load url ../exec-export.js`.

- [ ] **Step 3: Types and order.** `types.ts`: `ActionKind` gains `| 'export-new' | 'export-replace'`; `Action` gains
  ```ts
    /** export-new (N5): move the locally edited L aside as `<stem> (local edit …)<ext>` first. */
    localEdit?: boolean;
  ```
  `planner.ts` `KIND_ORDER`: insert `'export-new', 'export-replace',` after `'download-replace',`. `executor.ts` `STAGES`: the download stage becomes `['download-new', 'download-replace', 'export-new', 'export-replace'],`.

- [ ] **Step 4: Records carry `native`.** In `exec-records.ts`: `RemoteFields` gains `native: SyncRecord['native'];`; `fromEntry` adds `native: e.native ? { mimeType: e.native.mimeType, exportFormat: e.native.exportFormat } : null,`; `fromDrive` adds `native: null,` (uploads are binary); `makeRecord` uses `native: remote.native,`. Add the one shared field guard (the executor's private `need` method is deleted and every `this.need(` in `executor.ts` becomes `need(`, imported from here; drop `ValidationError` from executor's imports if it becomes unused):
  ```ts
  /** Internal guard: an action lacks a field its kind needs. */
  export function need<T>(value: T | null | undefined, what: string): T {
    if (value === null || value === undefined) {
      throw new ValidationError(`Internal: ${what} missing for sync action`);
    }
    return value;
  }
  ```
  (`import { ValidationError } from '../errors.js';`). In `src/sync/errors.ts` add:
  ```ts
  /** N5: an export failed after the local edit was moved aside; carries the kept name. */
  export class LocalEditKeptError extends AppError {
    readonly code = 'SYNC_LOCAL_EDIT_KEPT';

    constructor(
      readonly kept: string,
      readonly original: unknown,
    ) {
      super(`${messageOf(original)}; your local edit is kept as ${kept}`, { cause: original });
    }
  }
  ```
  Replace `conflictName` with a shared stamp:
  ```ts
  function stamped(base: string, label: string, at: Date, attempt: number): string {
    const dot = base.lastIndexOf('.');
    const stem = dot > 0 ? base.slice(0, dot) : base;
    const ext = dot > 0 ? base.slice(dot) : '';
    const stamp = `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}.${pad(at.getMinutes())}`;
    return `${stem} (${label} ${stamp})${attempt === 0 ? '' : ` ${attempt + 1}`}${ext}`;
  }

  /** `<stem> (Drive conflict YYYY-MM-DD HH.mm)<ext>`, then ` 2`, ` 3`… (spec §6.9, local time). */
  export function conflictName(base: string, at: Date, attempt: number): string {
    return stamped(base, 'Drive conflict', at, attempt);
  }

  /** `<stem> (local edit YYYY-MM-DD HH.mm)<ext>`, then ` 2`, ` 3`… (spec §6.6 N5). */
  export function localEditName(base: string, at: Date, attempt: number): string {
    return stamped(base, 'local edit', at, attempt);
  }
  ```

- [ ] **Step 5: Implement** `src/sync/exec-export.ts`:
  ```ts
  import path from 'node:path';
  import type { AuditOp } from '../audit/audit-log.js';
  import type { OperationRunner } from '../core/operation.js';
  import type { DriveFile } from '../drive/drive-adapter.js';
  import type { ExportPlan } from '../files/export-formats.js';
  import { openExport } from '../files/export-stream.js';
  import type { Logger } from '../logger.js';
  import { remoteUnchangedSince } from './content-compare.js';
  import { CollisionError, LocalEditKeptError, TargetChangedError } from './errors.js';
  import { fromEntry, localEditName, makeRecord, need, putRecord, statOf, type LocalFields } from './exec-records.js';
  import { absInside, prepareParent } from './paths.js';
  import {
    downloadReplace,
    moveLocal,
    placeExclusive,
    syncDir,
    type StatExpect,
    type Written,
  } from './transfer.js';
  import {
    SYNC_FILE_FIELDS,
    type Action,
    type ActionOutcome,
    type PairFile,
    type RemoteEntry,
  } from './types.js';

  /** The export re-read also needs the 10 MB fallback link and the web link (addendum §4.3). */
  export const SYNC_EXPORT_FIELDS = `${SYNC_FILE_FIELDS}, exportLinks, webViewLink`;
  const MAX_LOCAL_EDIT_NAMES = 100;

  /** What the export actions need from the Executor. */
  export interface ExportHost {
    file: PairFile;
    ops: OperationRunner;
    logger: Logger;
    clock: () => Date;
    commit(action: Action, mutate: () => void): Promise<void>;
    audit(op: AuditOp, action: Action, remoteId: string): Promise<void>;
    statFields(name: string, md5: string): Promise<LocalFields>;
  }

  function planOf(remote: RemoteEntry): ExportPlan {
    const native = need(remote.native, 'export settings');
    return { format: native.exportFormat, extension: native.exportFormat, mimeType: native.exportMime };
  }

  /** Re-read right before an export; doubles as re-verification (changed/trashed → skip). */
  async function reread(host: ExportHost, remote: RemoteEntry): Promise<DriveFile> {
    const current = await host.ops.exec(host.file.pair.account, 'idempotent', remote.id, (ctx) =>
      ctx.drive.getFile(remote.id, SYNC_EXPORT_FIELDS),
    );
    if (current.trashed || !remoteUnchangedSince(remote, current)) {
      throw new TargetChangedError(`${remote.key} changed in Drive since planning`);
    }
    return current;
  }

  /** Overwrites a tracked export at `abs` (re-stat guarded) with a fresh export of R. */
  export async function exportOver(
    host: ExportHost,
    abs: string,
    expect: StatExpect,
    remote: RemoteEntry,
  ): Promise<{ md5: string; size: number }> {
    const current = await reread(host, remote);
    return host.ops.exec(host.file.pair.account, 'idempotent', remote.id, (ctx) =>
      downloadReplace(abs, () => openExport(ctx.drive, current, planOf(remote), host.logger), {
        expect,
        expectedMd5: null,
      }),
    );
  }

  /**
   * N5: renames the edited L to `<stem> (local edit …)<ext>` (` 2`, ` 3`… when taken) with the
   * exclusive `moveLocal` (link + EEXIST, re-stat guarded; never overwrites, never unlinks the
   * only copy); returns the kept key.
   */
  async function moveLocalEditAside(host: ExportHost, action: Action): Promise<string> {
    const local = need(action.local, 'local');
    const root = host.file.pair.localDir;
    const from = absInside(root, local.name);
    const at = host.clock();
    const base = path.basename(from);
    for (let i = 0; i < MAX_LOCAL_EDIT_NAMES; i++) {
      const to = path.join(path.dirname(from), localEditName(base, at, i));
      try {
        await moveLocal(from, to, { inPlace: false, expect: statOf(local) });
      } catch (err) {
        if (err instanceof CollisionError) continue;
        throw err;
      }
      await syncDir(path.dirname(from));
      return path.relative(root, to).split(path.sep).join('/');
    }
    throw new CollisionError(path.join(path.dirname(from), localEditName(base, at, 0)));
  }

  /**
   * export-new (U3, U6, N4, N5, N6, O1): exclusive write of the export at the key. The export
   * stream (files.export / exportLinks response) is opened BEFORE a local edit is moved aside,
   * so a failed export (native-too-large, error after retries) leaves L where it is. Anything
   * that fails after the move is rethrown as LocalEditKeptError, so the outcome still names
   * the kept copy. A stream that breaks while writing is not retried; the next run plans again.
   */
  export async function exportNew(
    host: ExportHost,
    action: Action,
  ): Promise<Partial<ActionOutcome>> {
    const remote = need(action.remote, 'remote');
    const current = await reread(host, remote);
    const abs = await prepareParent(host.file.pair.localDir, action.key);
    const source = await host.ops.exec(host.file.pair.account, 'idempotent', remote.id, (ctx) =>
      openExport(ctx.drive, current, planOf(remote), host.logger),
    );
    let kept: string | null = null;
    try {
      if (action.localEdit) kept = await moveLocalEditAside(host, action);
      const written: Written = await placeExclusive(
        path.dirname(abs),
        () => path.basename(abs),
        async () => source,
      );
      const local = await host.statFields(action.key, written.md5);
      await host.commit(action, () =>
        putRecord(host.file, makeRecord(action.key, local, fromEntry(remote))),
      );
    } catch (err) {
      source.destroy();
      if (kept !== null) throw new LocalEditKeptError(kept, err);
      throw err;
    }
    await host.audit('sync_download', action, remote.id);
    if (kept === null) return {};
    return { conflictCopy: kept, warning: 'native-local-edit-kept', message: `your local edit is kept as ${kept}` };
  }

  /** export-replace (N4): the tracked export is replaced, only if unchanged since the scan. */
  export async function exportReplace(
    host: ExportHost,
    action: Action,
  ): Promise<Partial<ActionOutcome>> {
    const local = need(action.local, 'local');
    const remote = need(action.remote, 'remote');
    const abs = absInside(host.file.pair.localDir, local.name);
    const written = await exportOver(host, abs, statOf(local), remote);
    const after = await host.statFields(local.name, written.md5);
    await host.commit(action, () =>
      putRecord(host.file, makeRecord(action.key, after, fromEntry(remote))),
    );
    await host.audit('sync_download', action, remote.id);
    return {};
  }
  ```

- [ ] **Step 6: Wire the executor.** In `executor.ts`:
  - imports: `{ ExportTooLargeError }` added to the `../errors.js` import; `{ exportNew, exportOver, exportReplace, type ExportHost } from './exec-export.js'`.
  - `run` catch: unwrap `LocalEditKeptError` so every outcome (skipped, collision, failed) also carries the kept copy, and add the too-large branch before the `CollisionError` branch:
    ```ts
        } catch (caught) {
          const kept = caught instanceof LocalEditKeptError ? { conflictCopy: caught.kept } : {};
          const err = caught instanceof LocalEditKeptError ? caught.original : caught;
          if (err instanceof TargetChangedError) {
            outcomes.push({ ...base, ...kept, status: 'skipped', message: err.message });
          } else if (err instanceof ExportTooLargeError) {
            outcomes.push({ ...base, ...kept, status: 'skipped', message: err.message, warning: 'native-too-large' });
          } else if (err instanceof CollisionError) {
            /* as today, with ...kept */
          } else {
            /* as today (log, failed, isAbortError(err) → aborted), with ...kept */
          }
        }
    ```
    (import `LocalEditKeptError` from `./errors.js`).

  - `execute`: add `case 'export-new': return exportNew(this.host(), action);` and `case 'export-replace': return exportReplace(this.host(), action);`.
  - new method:
    ```ts
    private host(): ExportHost {
      return {
        file: this.file,
        ops: this.deps.ops,
        logger: this.deps.logger,
        clock: this.deps.clock,
        commit: (action, mutate) => this.commit(action, mutate),
        audit: (op, action, remoteId) => this.audit(op, action, remoteId),
        statFields: (name, md5) => this.statFields(name, md5),
      };
    }
    ```
  - `move`: replace the `const written = await this.deps.ops.exec(… downloadReplace(to, …) …)` statement with
    ```ts
      const written = remote.native
        ? await exportOver(this.host(), to, expect, remote)
        : await this.deps.ops.exec(this.pair.account, 'idempotent', remote.id, (ctx) =>
            downloadReplace(to, () => ctx.drive.downloadMedia(remote.id), { expect, expectedMd5: remote.md5 }),
          );
    ```

- [ ] **Step 7: Report.** In `report.ts` `buildReport`: the done branch's warning push becomes `report.warnings.push({ path: o.path, code: o.warning, ...(o.message ? { message: o.message } : {}) });`, the skipped branch uses `code: o.warning ?? 'skipped-changed',`, and after the status branches (inside the loop):
  ```ts
      if (o.status !== 'done' && o.conflictCopy) {
        report.warnings.push({ path: o.path, code: 'native-local-edit-kept', message: `your local edit is kept as ${o.conflictCopy}` });
      }
  ```

- [ ] **Step 8: Run to pass.** Same command as Step 2, then the whole `npx vitest run src/sync`. Expected PASS.

- [ ] **Step 9:** `npx prettier --write src/sync/*.ts src/sync/__tests__/executor.test.ts src/sync/__tests__/report.test.ts && npm run check` → green.

- [ ] **Step 10: Commit.**
  ```bash
  git add src/sync/exec-export.ts src/sync/exec-records.ts src/sync/errors.ts src/sync/executor.ts src/sync/types.ts src/sync/planner.ts src/sync/report.ts src/sync/__tests__/executor.test.ts src/sync/__tests__/report.test.ts
  git commit -m "feat(sync): export-new and export-replace actions for Google-native files" -m "Each export re-reads the file (SYNC_EXPORT_FIELDS) as re-verification and uses the shared openExport fallback; N5 opens the export before moving the local edit aside and names the kept copy on any later failure; ExportTooLargeError is reported as native-too-large." -m "$TRAILER"
  ```

### Task 11: Untracked natives (U0b, U3/U6 exports, U5 upgrade window)

**Files:**
- Modify: `src/sync/plan-untracked.ts` (`isBaseline`, interim guard, U0b, U3, U6), `src/sync/types.ts` (`NoteCode`), `src/sync/report.ts` (`WARNING_CODES`)
- Test: `src/sync/__tests__/plan-untracked.test.ts`

- [ ] **Step 1: Write the failing tests.** Delete the `'interim: untracked Google-native files are candidates only'` test (Task 6) and add:
  ```ts
  describe('untracked Google-native files (spec §6.5, §6.6)', () => {
    const DOC = nativeEntry('g1', 'Plan.docx');

    it('U0b a local file at the export path → ambiguous-native, nothing written', () => {
      for (const selection of [[], ['Plan.docx']]) {
        const result = run({ selection, local: [localEntry('Plan.docx')], remote: [DOC] });
        expect(result.actions).toEqual([]);
        expect(result.notes).toMatchObject([
          { code: 'ambiguous-native', rule: 'U0b', path: 'Plan.docx', remoteId: 'g1' },
        ]);
      }
    });
    it('U3 selected → export-new', () => {
      const result = run({ selection: ['Plan.docx'], remote: [DOC] });
      expect(result.actions.map((a) => [a.kind, a.rule, a.key])).toEqual([['export-new', 'U3', 'Plan.docx']]);
    });
    it('U6 new after the first applied run → export-new and selected', () => {
      expect(run({ remote: [DOC] }).actions).toMatchObject([
        { kind: 'export-new', rule: 'U6', key: 'Plan.docx', selection: { add: ['Plan.docx'] } },
      ]);
    });
    it('U5 upgrade window: unselected natives are candidates, binaries still adopt, selected natives export', () => {
      const pair = { nativeBaselineDone: false };
      const unselected = run({ pair, remote: [DOC, remoteEntry('n1', 'new.pdf')] });
      expect(unselected.actions.map((a) => [a.kind, a.key])).toEqual([['download-new', 'new.pdf']]);
      expect(unselected.candidates.remote.map((c) => c.path)).toEqual(['Plan.docx']);
      const selected = run({ pair, selection: ['Plan.docx'], remote: [DOC] });
      expect(selected.actions.map((a) => [a.kind, a.rule])).toEqual([['export-new', 'U3']]);
    });
  });
  ```

- [ ] **Step 2: Run them.** `npx vitest run src/sync/__tests__/plan-untracked.test.ts -t "Google-native"`. Expected FAIL: no `ambiguous-native` note, no actions (interim guard).

- [ ] **Step 3: Implement.**
  - `types.ts` `NoteCode` gains `| 'ambiguous-native'`; `report.ts` `WARNING_CODES` gains `'ambiguous-native'`.
  - `plan-untracked.ts` `isBaseline` gains the upgrade clause:
    ```ts
    function isBaseline(ctx: PlanContext, r: RemoteEntry): boolean {
      const { pair } = ctx.input;
      return (
        pair.firstAppliedRunAt === null ||
        (r.native !== null && !pair.nativeBaselineDone) ||
        pair.remoteBaseline.includes(r.id) ||
        r.ancestorIds.some((id) => pair.baselineFolders.includes(id))
      );
    }
    ```
  - Delete the interim guard block. Insert U0b right after the `if (isOccupied(ctx, key) && !L) { … }` block:
    ```ts
    // U0b: a local file already sits at a Google file's export path (never upload/adopt).
    if (R?.native && L) {
      note(
        'ambiguous-native',
        'U0b',
        'a local file has the export name of this Google file; rename one of them',
        R.key,
        R.id,
      );
      continue;
    }
    ```
  - U3 (`} else if (R) {` inside `if (sel !== undefined)`) and U6 (`out.actions.push({ … kind: 'download-new', rule: 'U6' …`) use `kind: R.native ? 'export-new' : 'download-new',`.

- [ ] **Step 4: Run to pass.** `npx vitest run src/sync/__tests__/plan-untracked.test.ts`. Expected PASS.

- [ ] **Step 5:** `npx prettier --write src/sync/plan-untracked.ts src/sync/types.ts src/sync/report.ts src/sync/__tests__/plan-untracked.test.ts && npm run check` → green.

- [ ] **Step 6: Commit.**
  ```bash
  git add src/sync/plan-untracked.ts src/sync/types.ts src/sync/report.ts src/sync/__tests__/plan-untracked.test.ts
  git commit -m "feat(sync): export selected and newly added Google files; ambiguous-native" -m "During the Phase A upgrade window unselected natives stay candidates (U5)." -m "$TRAILER"
  ```

### Task 12: Tracked natives N1–N9 (`plan-shared.ts`, `plan-native.ts`)

**Files:**
- Create: `src/sync/plan-shared.ts`, `src/sync/plan-native.ts`, `src/sync/__tests__/plan-native.test.ts`
- Modify: `src/sync/plan-tracked.ts` (whole file restructured), `src/sync/types.ts` (`NoteCode`), `src/sync/report.ts` (`WARNING_CODES`)

- [ ] **Step 1: Write the failing test** `src/sync/__tests__/plan-native.test.ts`:
  ```ts
  import { describe, expect, it } from 'vitest';
  import { plan } from '../planner.js';
  import { localEntry, nativeEntry, nativeRecord } from './fixtures.js';
  import { planInput, type InputOptions } from './plan-input.js';

  const NEWER = '2026-11-04T00:00:00.000Z';
  const K = nativeRecord('g1', 'Plan.docx');
  const L = localEntry('Plan.docx');
  const L_EDITED = localEntry('Plan.docx', { mtimeMs: 2000, size: 12 });
  const EDITED: InputOptions['md5s'] = [['Plan.docx', 'edited']];
  const R = nativeEntry('g1', 'Plan.docx');
  const R_MOD = nativeEntry('g1', 'Plan.docx', { modifiedTime: NEWER });
  const FOLDERS: InputOptions['folders'] = [['folder:sub', 'sub']];

  function run(o: InputOptions) {
    return plan(planInput({ records: [K], ...o }));
  }
  const kinds = (o: InputOptions) => run(o).actions.map((a) => [a.kind, a.rule, a.key]);

  describe('Google-native tracked records (spec §6.6)', () => {
    it('N1 unmodified and unchanged → nothing', () => {
      const p = run({ local: [L], remote: [R] });
      expect(p.actions).toEqual([]);
      expect(p.notes).toEqual([]);
    });
    it('N2 edited locally → native-readonly-edited, never uploaded', () => {
      const p = run({ local: [L_EDITED], remote: [R], md5s: EDITED });
      expect(p.actions).toEqual([]);
      expect(p.notes[0]).toMatchObject({ code: 'native-readonly-edited', rule: 'N2' });
      expect(p.notes[0]?.message).toMatch(/docs_\*/);
    });
    it('N3 local copy missing → native-local-missing, never trash-remote', () => {
      const p = run({ remote: [R] });
      expect(p.actions).toEqual([]);
      expect(p.notes[0]).toMatchObject({ code: 'native-local-missing', rule: 'N3' });
      expect(p.notes[0]?.message).toMatch(/sync_release/);
    });
    it('N4 modified in Drive → export-replace, or export-new when L is gone', () => {
      expect(kinds({ local: [L], remote: [R_MOD] })).toEqual([['export-replace', 'N4', 'Plan.docx']]);
      expect(kinds({ remote: [R_MOD] })).toEqual([['export-new', 'N4', 'Plan.docx']]);
    });
    it('N5 modified in Drive and edited locally → keep the edit, export-new', () => {
      expect(run({ local: [L_EDITED], remote: [R_MOD], md5s: EDITED }).actions).toMatchObject([
        { kind: 'export-new', rule: 'N5', key: 'Plan.docx', localEdit: true, local: L_EDITED },
      ]);
    });
    it('N6 moved in Drive → move-local (export after it when modified) or export-new', () => {
      const moved = nativeEntry('g1', 'sub/Plan.docx');
      const movedMod = nativeEntry('g1', 'sub/Plan.docx', { modifiedTime: NEWER });
      expect(run({ local: [L], remote: [movedMod], folders: FOLDERS }).actions).toMatchObject([
        { kind: 'move-local', rule: 'N6', key: 'sub/Plan.docx', thenDownload: true },
      ]);
      expect(run({ local: [L], remote: [moved], folders: FOLDERS }).actions).toMatchObject([
        { kind: 'move-local', thenDownload: false },
      ]);
      expect(kinds({ remote: [moved], folders: FOLDERS })).toEqual([['export-new', 'N6', 'sub/Plan.docx']]);
      const edited = run({ local: [L_EDITED], remote: [moved], md5s: EDITED, folders: FOLDERS });
      expect(edited.actions.map((a) => [a.kind, a.rule])).toEqual([['export-new', 'N6']]);
      expect(edited.notes[0]).toMatchObject({ code: 'conflict-rename' });
    });
    it('N6 also when the native is found only by the probe', () => {
      const probed = nativeEntry('g1', 'sub/Plan.docx');
      expect(
        kinds({ local: [L], probes: [['g1', { state: 'present', entry: probed }]], folders: FOLDERS }),
      ).toEqual([['move-local', 'N6', 'sub/Plan.docx']]);
    });
    it('N7 trashed → trash-local when unchanged, forget when gone', () => {
      const trashed: InputOptions['probes'] = [['g1', { state: 'trashed' }]];
      expect(kinds({ local: [L], probes: trashed })).toEqual([['trash-local', 'N7', 'Plan.docx']]);
      expect(kinds({ probes: trashed })).toEqual([['forget', 'N7', 'Plan.docx']]);
    });
    it('N8 trashed while edited → untrack, keep L, exclude the key', () => {
      const p = run({ local: [L_EDITED], md5s: EDITED, probes: [['g1', { state: 'trashed' }]] });
      expect(p.actions).toMatchObject([{ kind: 'untrack', rule: 'N8', selection: { exclude: ['Plan.docx'] } }]);
      expect(p.notes[0]).toMatchObject({ code: 'native-trashed-edited' });
    });
    it('N9 moved-out → untrack; unavailable → report only', () => {
      expect(kinds({ local: [L], probes: [['g1', { state: 'moved-out' }]] })).toEqual([['untrack', 'N9', 'Plan.docx']]);
      const p = run({ local: [L], probes: [['g1', { state: 'unavailable' }]] });
      expect(p.actions).toEqual([]);
      expect(p.notes[0]).toMatchObject({ code: 'remote-unavailable', rule: 'N9' });
    });
    it('never produces upload-new, update-remote, conflict or trash-remote', () => {
      const all = [
        run({ local: [L_EDITED], remote: [R], md5s: EDITED }),
        run({ remote: [R] }),
        run({ local: [L_EDITED], remote: [R_MOD], md5s: EDITED }),
      ].flatMap((p) => p.actions.map((a) => a.kind));
      for (const k of ['upload-new', 'update-remote', 'conflict', 'trash-remote']) {
        expect(all).not.toContain(k);
      }
    });
  });
  ```

- [ ] **Step 2: Run it.** `npx vitest run src/sync/__tests__/plan-native.test.ts`. Expected FAIL: every case gets the `phase-b` `unknown-state` note.

- [ ] **Step 3: Note codes.** `types.ts` `NoteCode` gains `| 'native-readonly-edited' | 'native-local-missing' | 'native-trashed-edited'`; add the same three to `WARNING_CODES` in `report.ts`.

- [ ] **Step 4: Create `src/sync/plan-shared.ts`.** `needsRefresh` moves here verbatim from `plan-tracked.ts` (exported); `planMoved` is the present-moved tail of today's `planTracked` (from `const target = remote.key;` to the end) moved verbatim with these edits: `ctx`/`record`/`note`/`act` come from the scope; `!rs.changed` → `!rChanged`, `thenDownload: rs.changed` → `thenDownload: rChanged`; both `kind: 'download-new'` → `kind: fresh`; every rule literal `'X'` → `rule('X')` — so for natives `B7-resume`, `B7`, `B8`, `B9` and `B7-B9` all become `N6`. Note codes stay as they are: the B8 analogue still emits `conflict-rename`, the excluded target still `moved-into-excluded`, blockers still `collision`.
  ```ts
  import { foldKey } from './paths.js';
  import { isExcluded, type PlanContext } from './resolve.js';
  import type {
    Action,
    ActionKind,
    LocalEntry,
    Note,
    NoteCode,
    RemoteEntry,
    SelectionChange,
    SyncRecord,
  } from './types.js';

  export interface TrackedResult {
    actions: Action[];
    notes: Note[];
    /** Folds this record occupies (its key and a remote move target). */
    claimedFolds: string[];
    /** On-disk name of the local file matched to this record. */
    claimedLocal: string | null;
  }

  /** One tracked record being classified (first match wins). */
  export interface TrackedScope {
    ctx: PlanContext;
    record: SyncRecord;
    out: TrackedResult;
    note(code: NoteCode, rule: string, message?: string): TrackedResult;
    act(action: Omit<Action, 'record'>): TrackedResult;
  }

  /** Fields every tracked action starts from. */
  export interface ActionBase {
    key: string;
    local: LocalEntry | null;
    localMd5: string | null;
    selection: SelectionChange;
  }

  export function makeScope(ctx: PlanContext, record: SyncRecord): TrackedScope {
    const out: TrackedResult = { actions: [], notes: [], claimedFolds: [foldKey(record.path)], claimedLocal: null };
    return {
      ctx,
      record,
      out,
      note: (code, rule, message) => {
        out.notes.push({ code, path: record.path, rule, remoteId: record.remoteId, ...(message ? { message } : {}) });
        return out;
      },
      act: (action) => {
        out.actions.push({ ...action, record });
        return out;
      },
    };
  }

  export function needsRefresh(record: SyncRecord, entry: LocalEntry, remote: RemoteEntry): boolean {
    /* moved verbatim from plan-tracked.ts */
  }

  /**
   * present-moved: B7–B9 (spec §6.4) and, for Google-native records, N6 (§6.6: exports
   * instead of downloads, never uploads). `lChanged`/`rChanged` compare with the record.
   */
  export function planMoved(
    s: TrackedScope,
    base: ActionBase,
    remote: RemoteEntry,
    lChanged: boolean,
    rChanged: boolean,
  ): TrackedResult {
    const { ctx, record, note, act } = s;
    const entry = base.local;
    const fresh: ActionKind = remote.native ? 'export-new' : 'download-new';
    const rule = (binary: string): string => (remote.native ? 'N6' : binary);
    const target = remote.key;
    /* … rest moved verbatim from planTracked with the edits listed above … */
  }
  ```

- [ ] **Step 5: Create `src/sync/plan-native.ts`:**
  ```ts
  import { remoteChanged } from './content-compare.js';
  import {
    needsRefresh,
    planMoved,
    type ActionBase,
    type TrackedResult,
    type TrackedScope,
  } from './plan-shared.js';
  import type { RemoteResolution } from './resolve.js';

  /** Google-native tracked records, table N1–N9 (spec §6.6). Pull-only: no uploads or Drive trash. */
  export function planNative(
    s: TrackedScope,
    base: ActionBase,
    R: RemoteResolution,
    lChanged: boolean,
  ): TrackedResult {
    const { record, out, note, act } = s;
    const entry = base.local;
    const drop = { remove: [record.path] };
    const untrack = { remove: [record.path], exclude: [record.path] };
    if (R.kind === 'trashed') {
      if (!entry) return act({ ...base, kind: 'forget', rule: 'N7', remote: null, selection: drop });
      if (!lChanged) {
        return act({ ...base, kind: 'trash-local', rule: 'N7', remote: null, selection: drop });
      }
      note(
        'native-trashed-edited',
        'N8',
        'trashed in Drive while edited locally; your copy is kept and no longer synced',
      );
      return act({ ...base, kind: 'untrack', rule: 'N8', remote: null, selection: untrack });
    }
    if (R.kind === 'moved-out') {
      note('moved-out', 'N9');
      return act({ ...base, kind: 'untrack', rule: 'N9', remote: null, selection: untrack });
    }
    if (R.kind === 'unavailable') {
      return note('remote-unavailable', 'N9', 'clear it with sync_select remove');
    }
    if (R.kind === 'unknown') return note('unknown-state', 'unknown', R.reason);
    const remote = R.entry;
    const changed = remoteChanged(record, remote).changed;
    if (R.moved) return planMoved(s, base, remote, lChanged, changed);
    if (!changed) {
      if (entry && !lChanged) {
        return needsRefresh(record, entry, remote)
          ? act({ ...base, kind: 'refresh', rule: 'N1', remote })
          : out;
      }
      if (entry) {
        return note(
          'native-readonly-edited',
          'N2',
          'Google Docs/Sheets/Slides sync is pull-only; edit the original in Drive or with docs_*/sheets_*/slides_*',
        );
      }
      return note(
        'native-local-missing',
        'N3',
        'it will be re-exported on the next remote change; use sync_select remove or sync_release to stop that',
      );
    }
    if (!entry) return act({ ...base, kind: 'export-new', rule: 'N4', remote });
    if (!lChanged) return act({ ...base, kind: 'export-replace', rule: 'N4', remote });
    return act({ ...base, kind: 'export-new', rule: 'N5', remote, localEdit: true });
  }
  ```

- [ ] **Step 6: Restructure `plan-tracked.ts`.** Final shape (B-rule bodies unchanged):
  ```ts
  import { localMatchesRemote, remoteChanged } from './content-compare.js';
  import { foldKey } from './paths.js';
  import { planNative } from './plan-native.js';
  import { makeScope, needsRefresh, planMoved, type TrackedResult } from './plan-shared.js';
  import {
    isUnknownKey,
    localState,
    resolveLocal,
    resolveRemote,
    type PlanContext,
  } from './resolve.js';
  import type { SyncRecord } from './types.js';

  export type { TrackedResult } from './plan-shared.js';

  export const TYPE_CHANGED = /* unchanged (Task 6) */;

  /** Classifies one tracked record: dispatch §6.3, then B1–B14 (§6.4) or N1–N9 (§6.6). */
  export function planTracked(ctx: PlanContext, record: SyncRecord): TrackedResult {
    const s = makeScope(ctx, record);
    const { out, note, act } = s;
    /* L, R, newKey, (a) unknown-state, (b) ambiguous, type-changed: unchanged */
    // (c) remote-only records: the O rules arrive in Task 14.
    if (record.remoteOnly) {
      return note('unknown-state', 'phase-b', 'needs release support (Phase B)');
    }
    /* entry / lChanged / lMd5 / base: unchanged */
    // (d)
    if (record.native) return planNative(s, base, R, lChanged);
    /* trashed (B10–B12), moved-out (B13), unavailable (B14): unchanged */
    const remote = R.entry;
    const rs = remoteChanged(record, remote);
    /* weak-compare note and the !R.moved block (B1–B6): unchanged */
    return planMoved(s, base, remote, lChanged, rs.changed);
  }
  ```
  The old local `out`/`note`/`act` definitions, `needsRefresh`, the B7–B9 tail and the `isExcluded` import are removed (they live in `plan-shared.ts`). `planner.ts` keeps importing `planTracked` from `./plan-tracked.js`.

- [ ] **Step 7: Run to pass.** `npx vitest run src/sync/__tests__/plan-native.test.ts src/sync/__tests__/plan-tracked.test.ts src/sync/__tests__/planner.test.ts`. Expected PASS (all B-rule tests unchanged and green).

- [ ] **Step 8:** `npx prettier --write src/sync/plan-*.ts src/sync/types.ts src/sync/report.ts src/sync/__tests__/plan-native.test.ts && npm run check` → green.

- [ ] **Step 9: Commit.**
  ```bash
  git add src/sync/plan-shared.ts src/sync/plan-native.ts src/sync/plan-tracked.ts src/sync/types.ts src/sync/report.ts src/sync/__tests__/plan-native.test.ts
  git commit -m "feat(sync): Google-native rules N1-N9" -m "Pull-only: edits are reported, modified files re-exported, local edits kept beside the new export; B7-B9 move logic is shared with N6." -m "$TRAILER"
  ```

### Task 13: Native sync through the service (integration and upgrade)

**Files:**
- Create: `src/sync/__tests__/sync-service.native.test.ts`
- Modify: production code only if a test exposes a gap (expected: none).

- [ ] **Step 1: Write the test** (complete file; only the imports it uses, so lint stays at zero warnings):
  ```ts
  import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
  import os from 'node:os';
  import path from 'node:path';
  import { afterEach, beforeEach, describe, expect, it } from 'vitest';
  import { createAudit, createRunner, noSleep, silentLogger } from '../../files/__tests__/fakes.js';
  import { PairStore } from '../pair-store.js';
  import { SyncService } from '../sync-service.js';
  import { dirTrash } from './fixtures.js';
  import { memoryDrive, type MemoryDrive } from './memory-drive.js';

  let tmp: string;
  let local: string;
  let trashDir: string;
  let mem: MemoryDrive;
  let store: PairStore;
  let sync: SyncService;
  let now: Date;

  beforeEach(async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), 'sync-native-'));
    local = path.join(tmp, 'Local');
    trashDir = path.join(tmp, 'Trash');
    await mkdir(local);
    await mkdir(trashDir);
    now = new Date('2026-11-03T12:00:00.000Z');
    mem = memoryDrive('ROOT');
    store = new PairStore({ dir: path.join(tmp, 'config', 'sync'), logger: silentLogger() });
    sync = new SyncService({
      runner: createRunner(mem.drive),
      audit: createAudit(),
      retry: noSleep,
      logger: silentLogger(),
      store,
      clock: () => now,
      trash: dirTrash(trashDir),
    });
    await sync.createPair({ name: 'docs', localDir: local, remoteFolderId: 'ROOT' });
  });
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  const at = (...parts: string[]): string => path.join(local, ...parts);

  async function apply() {
    const dry = await sync.run({ name: 'docs' });
    return sync.run({ name: 'docs', apply: true, planId: dry.planId });
  }

  const setDoc = (id: string, text: string, modifiedTime: string): void => {
    const f = mem.files.get(id)!;
    f.content = Buffer.from(text);
    f.modifiedTime = modifiedTime;
  };
  describe('Google-native files (spec §6.6)', () => {
    it('exports a Doc added after the first run and re-exports it on change (U6, N4)', async () => {
      await apply();
      mem.addNative('g1', 'Plan', 'ROOT', 'doc v1');
      expect((await apply()).actions).toEqual({ 'export-new': ['Plan.docx'] });
      expect(await readFile(at('Plan.docx'), 'utf8')).toBe('doc v1');
      expect((await sync.run({ name: 'docs' })).actions).toEqual({});
      setDoc('g1', 'doc v2', '2026-11-03T14:00:00.000Z');
      expect((await apply()).actions).toEqual({ 'export-replace': ['Plan.docx'] });
      expect(await readFile(at('Plan.docx'), 'utf8')).toBe('doc v2');
      expect((await store.load('docs')).records).toMatchObject([
        { remoteId: 'g1', path: 'Plan.docx', native: { exportFormat: 'docx' } },
      ]);
    });
    it('warns on a pull-only edit (N2) and keeps it beside the new export (N5)', async () => {
      await apply();
      mem.addNative('g1', 'Plan', 'ROOT', 'doc v1');
      await apply();
      await writeFile(at('Plan.docx'), 'my edit');
      const warned = await sync.run({ name: 'docs' });
      expect(warned.actions).toEqual({});
      expect(warned.warnings).toMatchObject([{ path: 'Plan.docx', code: 'native-readonly-edited' }]);
      setDoc('g1', 'doc v2', '2026-11-03T14:00:00.000Z');
      now = new Date('2026-11-03T15:30:00');
      const report = await apply();
      expect(report.actions).toEqual({ 'export-new': ['Plan.docx'] });
      expect(await readFile(at('Plan (local edit 2026-11-03 15.30).docx'), 'utf8')).toBe('my edit');
      expect(await readFile(at('Plan.docx'), 'utf8')).toBe('doc v2');
      expect(report.warnings).toContainEqual(
        expect.objectContaining({ path: 'Plan.docx', code: 'native-local-edit-kept' }),
      );
    });
    it('upgrade: Phase A natives stay candidates, later ones are adopted, selected ones export', async () => {
      await apply();
      const file = await store.load('docs');
      file.pair.nativeBaselineDone = false;
      await store.save(file);
      mem.addNative('g1', 'Old', 'ROOT', 'old doc');
      mem.addNative('g2', 'Chosen', 'ROOT', 'chosen doc');
      await sync.select({ name: 'docs', add: ['Chosen.docx'] });
      const upgrade = await apply();
      expect(upgrade.actions).toEqual({ 'export-new': ['Chosen.docx'] });
      expect(upgrade.candidates.remote.map((c) => c.path)).toEqual(['Old.docx']);
      mem.addNative('g3', 'Later', 'ROOT', 'later doc');
      const next = await apply();
      expect(next.actions).toEqual({ 'export-new': ['Later.docx'] });
      expect(next.candidates.remote.map((c) => c.path)).toEqual(['Old.docx']);
    });
  });
  ```

- [ ] **Step 2: Run it.** `npx vitest run src/sync/__tests__/sync-service.native.test.ts`. Expected PASS (Tasks 6–12 provide everything). If a case fails, fix the production gap with its own failing-test-first step before continuing.

- [ ] **Step 3:** `npx prettier --write src/sync/__tests__/sync-service.native.test.ts && npm run check` → green.

- [ ] **Step 4: Commit.**
  ```bash
  git add src/sync/__tests__/sync-service.native.test.ts
  git commit -m "test(sync): Google-native exports and the Phase A upgrade through SyncService" -m "$TRAILER"
  ```

---

## Chunk 4: Remote-only records O0–O8 and release (incl. R0)

### Task 14: Remote-only rules O0–O8 (`plan-remote-only.ts`, refresh patches)

**Files:**
- Create: `src/sync/plan-remote-only.ts`, `src/sync/__tests__/plan-remote-only.test.ts`
- Modify: `src/sync/types.ts` (`Action.patch`, `NoteCode`), `src/sync/report.ts` (`WARNING_CODES`), `src/sync/plan-tracked.ts` (dispatch (c)), `src/sync/executor.ts` (`refresh`)
- Tests: `plan-tracked.test.ts` (replace `'(c)/(d) Phase B records never act'`), `executor.test.ts`

- [ ] **Step 1: Write the failing tests.** `src/sync/__tests__/plan-remote-only.test.ts`:
  ```ts
  import { describe, expect, it } from 'vitest';
  import { plan } from '../planner.js';
  import type { SyncRecord } from '../types.js';
  import { localEntry, nativeEntry, nativeRecord, record, remoteEntry } from './fixtures.js';
  import { planInput, type InputOptions } from './plan-input.js';

  const NEWER = '2026-11-04T00:00:00.000Z';
  const K = record('r1', 'a.pdf', { remoteOnly: true });
  const PENDING = { ...K, restorePending: true };
  const R = remoteEntry('r1', 'a.pdf');
  const BACK = localEntry('a.pdf', { mtimeMs: 5000 });
  const FOLDERS: InputOptions['folders'] = [['folder:sub', 'sub']];
  const run = (o: InputOptions, k: SyncRecord = K) => plan(planInput({ records: [k], ...o }));
  const summary = (o: InputOptions, k: SyncRecord = K) =>
    run(o, k).actions.map((a) => [a.kind, a.rule, a.key]);

  describe('remote-only records (spec §6.7)', () => {
    it('O0 restorePending and the same file is back → adopt (binary: Drive md5, native: last export)', () => {
      expect(summary({ local: [BACK], remote: [R], md5s: [['a.pdf', 'md5-r1']] }, PENDING)).toEqual([
        ['adopt', 'O0', 'a.pdf'],
      ]);
      const n = nativeRecord('g1', 'Plan.docx', { remoteOnly: true, restorePending: true, localMd5: 'exp' });
      const back = localEntry('Plan.docx', { mtimeMs: 5000 });
      expect(
        summary({ local: [back], remote: [nativeEntry('g1', 'Plan.docx')], md5s: [['Plan.docx', 'exp']] }, n),
      ).toEqual([['adopt', 'O0', 'Plan.docx']]);
    });
    it('O1 restorePending → download-new / export-new at the current Drive key', () => {
      expect(summary({ remote: [R] }, PENDING)).toEqual([['download-new', 'O1', 'a.pdf']]);
      expect(run({ remote: [remoteEntry('r1', 'sub/a.pdf')], folders: FOLDERS }, PENDING).actions).toMatchObject([
        { kind: 'download-new', rule: 'O1', key: 'sub/a.pdf', selection: { remove: ['a.pdf'], add: ['sub/a.pdf'] } },
      ]);
      const n = nativeRecord('g1', 'Plan.docx', { remoteOnly: true, restorePending: true });
      expect(summary({ remote: [nativeEntry('g1', 'Plan.docx')] }, n)).toEqual([['export-new', 'O1', 'Plan.docx']]);
    });
    it('O1 a different local file at the key → collision, never trash-remote', () => {
      const p = run({ local: [BACK], remote: [R], md5s: [['a.pdf', 'other']] }, PENDING);
      expect(p.actions).toEqual([]);
      expect(p.notes[0]).toMatchObject({ code: 'collision', rule: 'O1' });
    });
    it('O2 restorePending but trashed or unavailable → report, flags kept', () => {
      for (const state of ['trashed', 'unavailable'] as const) {
        const p = run({ probes: [['r1', { state }]] }, PENDING);
        expect(p.actions).toEqual([]);
        expect(p.notes[0]?.rule).toBe('O2');
      }
    });
    it('O3 L absent, R present-same → nothing; a changed R only refreshes the record', () => {
      expect(run({ remote: [R] }).actions).toEqual([]);
      expect(run({ remote: [remoteEntry('r1', 'a.pdf', { md5: 'new', modifiedTime: NEWER })] }).actions).toMatchObject([
        { kind: 'refresh', rule: 'O3', patch: { remoteMd5: 'new', remoteModifiedTime: NEWER } },
      ]);
    });
    it('a released Google Doc modified in Drive is never exported', () => {
      const n = nativeRecord('g1', 'Plan.docx', { remoteOnly: true });
      const p = run({ remote: [nativeEntry('g1', 'Plan.docx', { modifiedTime: NEWER })] }, n);
      expect(p.actions.map((a) => a.kind)).toEqual(['refresh']);
    });
    it('O4 moved in Drive → record path and selection follow', () => {
      expect(run({ remote: [remoteEntry('r1', 'sub/a.pdf')], folders: FOLDERS }).actions).toMatchObject([
        {
          kind: 'refresh',
          rule: 'O4',
          key: 'sub/a.pdf',
          patch: { path: 'sub/a.pdf', localName: 'sub/a.pdf' },
          selection: { remove: ['a.pdf'], add: ['sub/a.pdf'] },
        },
      ]);
    });
    it('O5 trashed → remoteTrashed + warning every run; O6 present again → cleared', () => {
      const trashed: InputOptions['probes'] = [['r1', { state: 'trashed' }]];
      const first = run({ probes: trashed });
      expect(first.actions).toMatchObject([{ kind: 'refresh', rule: 'O5', patch: { remoteTrashed: true } }]);
      expect(first.notes[0]).toMatchObject({ code: 'remote-only-trashed', rule: 'O5' });
      const again = run({ probes: trashed }, { ...K, remoteTrashed: true });
      expect(again.actions).toEqual([]);
      expect(again.notes[0]?.code).toBe('remote-only-trashed');
      expect(run({ remote: [R] }, { ...K, remoteTrashed: true }).actions).toMatchObject([
        { kind: 'refresh', rule: 'O6', patch: { remoteTrashed: false } },
      ]);
    });
    it('O7 moved-out → untrack; unavailable → report', () => {
      expect(summary({ probes: [['r1', { state: 'moved-out' }]] })).toEqual([['untrack', 'O7', 'a.pdf']]);
      expect(run({ probes: [['r1', { state: 'unavailable' }]] }).notes[0]).toMatchObject({
        code: 'remote-unavailable',
        rule: 'O7',
      });
    });
    it('O8 the file is back locally: same content → adopt, else collision', () => {
      expect(summary({ local: [BACK], remote: [R], md5s: [['a.pdf', 'md5-r1']] })).toEqual([['adopt', 'O8', 'a.pdf']]);
      const p = run({ local: [BACK], remote: [R], md5s: [['a.pdf', 'different']] });
      expect(p.actions).toEqual([]);
      expect(p.notes[0]).toMatchObject({ code: 'collision', rule: 'O8' });
    });
  });
  ```
  In `plan-tracked.test.ts` delete `'(c)/(d) Phase B records never act'`. In `executor.test.ts` (`describe('Executor')`):
  ```ts
  it('applies a refresh patch to the record and its selection change (O4)', async () => {
    const k = record('r1', 'a.pdf', { remoteOnly: true });
    const file = pairFile([k]);
    await executor(file).run([
      action('refresh', 'sub/a.pdf', {
        record: k,
        patch: { path: 'sub/a.pdf', localName: 'sub/a.pdf' },
        selection: { remove: ['a.pdf'], add: ['sub/a.pdf'] },
      }),
    ]);
    expect(saves.at(-1)?.records).toMatchObject([{ path: 'sub/a.pdf', remoteOnly: true }]);
    expect(saves.at(-1)?.pair.selection).toEqual(['sub/a.pdf']);
  });
  ```

- [ ] **Step 2: Run them.** `npx vitest run src/sync/__tests__/plan-remote-only.test.ts src/sync/__tests__/executor.test.ts -t "remote-only|refresh patch"`. Expected FAIL: `phase-b` notes; the executor refresh throws `local missing`.

- [ ] **Step 3: Types.** `Action` gains
  ```ts
    /** refresh: record fields to set (remote-only bookkeeping O3–O6); no file is touched. */
    patch?: Partial<SyncRecord>;
  ```
  `NoteCode` gains `| 'remote-only-trashed'`; add it to `WARNING_CODES`.

- [ ] **Step 4: Implement** `src/sync/plan-remote-only.ts`:
  ```ts
  import { localMatchesRemote } from './content-compare.js';
  import { foldKey } from './paths.js';
  import type { ActionBase, TrackedResult, TrackedScope } from './plan-shared.js';
  import {
    isExcluded,
    localState,
    type LocalResolution,
    type RemoteResolution,
  } from './resolve.js';
  import type { RemoteEntry, SyncRecord } from './types.js';

  /** Remote-side record fields that differ from R (O3 record refresh). */
  function remotePatch(record: SyncRecord, remote: RemoteEntry): Partial<SyncRecord> {
    const patch: Partial<SyncRecord> = {};
    if (remote.name !== record.remoteName) patch.remoteName = remote.name;
    if (remote.parentId !== record.remoteParentId) patch.remoteParentId = remote.parentId;
    if (remote.md5 !== record.remoteMd5) patch.remoteMd5 = remote.md5;
    if (remote.size !== record.remoteSize) patch.remoteSize = remote.size;
    if (remote.modifiedTime !== record.remoteModifiedTime) patch.remoteModifiedTime = remote.modifiedTime;
    return patch;
  }

  /** Released records, table O0–O8 (spec §6.7). Never downloads/exports unless restorePending. */
  export function planRemoteOnly(
    s: TrackedScope,
    L: LocalResolution,
    R: RemoteResolution,
  ): TrackedResult {
    const { ctx, record, out, note, act } = s;
    const entry = L.kind === 'present' ? L.entry : null;
    let lMd5: string | null = null;
    if (entry) {
      const st = localState(ctx, record, entry);
      if (!st) return note('unknown-state', 'unknown', 'local file could not be hashed');
      lMd5 = st.md5;
    }
    const base: ActionBase = { key: record.path, local: entry, localMd5: lMd5, selection: {} };
    const untrack = { remove: [record.path], exclude: [record.path] };
    const present = R.kind === 'present' ? R.entry : null;
    const same = present !== null && lMd5 !== null && localMatchesRemote(lMd5, record, present);

    if (record.restorePending) {
      if (entry && same) return act({ ...base, kind: 'adopt', rule: 'O0', remote: present });
      if (present) {
        const target = present.key;
        if ((ctx.localByFold.get(foldKey(target)) ?? []).length > 0) {
          return note(
            'collision',
            'O1',
            `a different local file is at ${target}; move it away to restore the Drive copy`,
          );
        }
        return act({
          ...base,
          key: target,
          local: null,
          localMd5: null,
          kind: present.native ? 'export-new' : 'download-new',
          rule: 'O1',
          remote: present,
          selection: target === record.path ? {} : { remove: [record.path], add: [target] },
        });
      }
      if (R.kind === 'trashed') {
        return note(
          'remote-only-trashed',
          'O2',
          'cannot restore: the only copy is in the Drive trash; restore it there first',
        );
      }
      if (R.kind === 'unavailable') {
        return note('remote-unavailable', 'O2', 'cannot restore: the Drive file is not available');
      }
    }
    if (R.kind === 'trashed') {
      note('remote-only-trashed', 'O5', 'the only copy is in the Drive trash; it is purged after 30 days');
      return record.remoteTrashed
        ? out
        : act({ ...base, kind: 'refresh', rule: 'O5', remote: null, patch: { remoteTrashed: true } });
    }
    if (R.kind === 'moved-out') {
      note('moved-out', 'O7');
      return act({ ...base, kind: 'untrack', rule: 'O7', remote: null, selection: untrack });
    }
    if (R.kind === 'unavailable') {
      return note('remote-unavailable', 'O7', 'clear it with sync_select remove');
    }
    if (R.kind === 'unknown') return note('unknown-state', 'unknown', R.reason);
    const remote = R.entry;
    if (entry) {
      if (same) return act({ ...base, kind: 'adopt', rule: 'O8', remote });
      return note(
        'collision',
        'O8',
        'a different local file is at the path of this Drive-only file; nothing was written',
      );
    }
    const patch: Partial<SyncRecord> = {
      ...remotePatch(record, remote),
      ...(record.remoteTrashed ? { remoteTrashed: false } : {}),
    };
    if (R.moved) {
      if (isExcluded(ctx, remote.key)) {
        note('moved-into-excluded', 'O4', `moved in Drive to excluded ${remote.key}`);
        return act({ ...base, kind: 'untrack', rule: 'O4', remote: null, selection: untrack });
      }
      return act({
        ...base,
        key: remote.key,
        kind: 'refresh',
        rule: 'O4',
        remote: null,
        patch: { ...patch, path: remote.key, localName: remote.key },
        selection: { remove: [record.path], add: [remote.key] },
      });
    }
    if (Object.keys(patch).length === 0) return out;
    return act({ ...base, kind: 'refresh', rule: record.remoteTrashed ? 'O6' : 'O3', remote: null, patch });
  }
  ```

- [ ] **Step 5: Dispatch and executor.** In `plan-tracked.ts` replace the `phase-b` block with `if (record.remoteOnly) return planRemoteOnly(s, L, R);` (import from `./plan-remote-only.js`). In `executor.ts` `refresh`, before the existing body:
  ```ts
    if (action.patch) {
      const record = this.need(action.record, 'record');
      const patch = action.patch;
      await this.commit(action, () => putRecord(this.file, { ...record, ...patch }));
      return {};
    }
  ```

- [ ] **Step 6: Run to pass.** `npx vitest run src/sync`. Expected PASS (incl. `planner.test.ts` `'a remote-only record (Phase B data) is never trashed in Phase A'`, now O3).

- [ ] **Step 7:** `npx prettier --write src/sync/plan-remote-only.ts src/sync/plan-tracked.ts src/sync/executor.ts src/sync/types.ts src/sync/report.ts src/sync/__tests__/*.ts && npm run check` → green.

- [ ] **Step 8: Commit.**
  ```bash
  git add src/sync/plan-remote-only.ts src/sync/plan-tracked.ts src/sync/executor.ts src/sync/types.ts src/sync/report.ts src/sync/__tests__/plan-remote-only.test.ts src/sync/__tests__/plan-tracked.test.ts src/sync/__tests__/executor.test.ts
  git commit -m "feat(sync): remote-only rules O0-O8" -m "Released files stay in Drive: refreshed, moved and trash-flagged without touching local files; restored only after sync_select add." -m "$TRAILER"
  ```

### Task 15: `sync_select add` restores a released file

**Files:**
- Modify: `src/sync/scan-select.ts` (`selectPaths` add loop)
- Test: `src/sync/__tests__/sync-service.pairs.test.ts`

- [ ] **Step 1: Write the failing test** (in the `select` describe; add `record` to the `./fixtures.js` import):
  ```ts
  it('add on a released (remote-only) path sets restorePending', async () => {
    await createDocs();
    mem.addFile('r1', 'a.pdf', 'ROOT', 'A');
    await sync.select({ name: 'docs', add: ['a.pdf'] });
    const file = await store.load('docs');
    file.records.push(record('r1', 'a.pdf', { remoteOnly: true }));
    await store.save(file);
    const res = await sync.select({ name: 'docs', add: ['A.pdf'] });
    expect(res.added).toEqual(['a.pdf']);
    expect((await store.load('docs')).records[0]).toMatchObject({ remoteOnly: true, restorePending: true });
  });
  ```

- [ ] **Step 2: Run it.** `npx vitest run src/sync/__tests__/sync-service.pairs.test.ts -t "released"`. Expected FAIL: `added` is `[]` (already selected → skipped).

- [ ] **Step 3: Implement.** In `selectPaths`, insert before `else if (pair.selection.some((k) => foldKey(k) === fold)) continue;`:
  ```ts
          else if (file.records.some((r) => r.remoteOnly && foldKey(r.path) === fold)) {
            // Spec §8: add on a released file restores it on the next run (O0/O1).
            for (const r of file.records) {
              if (!r.remoteOnly || foldKey(r.path) !== fold) continue;
              r.restorePending = true;
              pair.excluded = pair.excluded.filter((k) => foldKey(k) !== fold);
              if (!pair.selection.some((k) => foldKey(k) === fold)) pair.selection.push(r.path);
              result.added.push(r.path);
            }
          }
  ```

- [ ] **Step 4: Run to pass.** Same command. Expected PASS.

- [ ] **Step 5:** `npx prettier --write src/sync/scan-select.ts src/sync/__tests__/sync-service.pairs.test.ts && npm run check` → green.

- [ ] **Step 6: Commit.**
  ```bash
  git add src/sync/scan-select.ts src/sync/__tests__/sync-service.pairs.test.ts
  git commit -m "feat(sync): sync_select add restores released files" -m "$TRAILER"
  ```

### Task 16: Release selection (pure, incl. R0)

**Files:**
- Create: `src/sync/release.ts` (types + `selectReleasable` + `releaseStatus`), `src/sync/__tests__/release.test.ts`

- [ ] **Step 1: Write the failing test** `src/sync/__tests__/release.test.ts`:
  ```ts
  import { describe, expect, it } from 'vitest';
  import { selectReleasable, type ReleaseSelection } from '../release.js';
  import { localEntry, nativeEntry, nativeRecord, record, remoteEntry } from './fixtures.js';
  import { planInput, type InputOptions } from './plan-input.js';

  const A = record('r1', 'a.pdf');
  const RA = remoteEntry('r1', 'a.pdf');
  const sel = (o: InputOptions, request: { paths?: string[]; all?: boolean }) =>
    selectReleasable(planInput(o), request);
  const eligible = (r: ReleaseSelection) => r.eligible.map((c) => [c.record.path, c.kind]);

  describe('selectReleasable (spec §10, addendum §3)', () => {
    it('all: true takes only files in sync on both sides; deleted ones need their name', () => {
      const r = sel(
        {
          records: [A, record('r2', 'b.pdf'), record('r3', 'c.pdf')],
          local: [localEntry('a.pdf'), localEntry('b.pdf', { mtimeMs: 9 })],
          md5s: [['b.pdf', 'edited']],
          remote: [RA, remoteEntry('r2', 'b.pdf'), remoteEntry('r3', 'c.pdf')],
        },
        { all: true },
      );
      expect(eligible(r)).toEqual([['a.pdf', 'present']]);
      expect(r.skipped.map((s) => s.path)).toEqual(['b.pdf', 'c.pdf']);
      expect(r.skipped[1]?.reason).toMatch(/name it in paths/);
    });
    it('binary needs L = record = Drive md5; native needs L = last export', () => {
      const r = sel(
        {
          records: [A, nativeRecord('g1', 'Plan.docx')],
          local: [localEntry('a.pdf'), localEntry('Plan.docx')],
          remote: [
            remoteEntry('r1', 'a.pdf', { md5: 'other' }),
            nativeEntry('g1', 'Plan.docx', { modifiedTime: '2026-11-04T00:00:00.000Z' }),
          ],
        },
        { all: true },
      );
      expect(eligible(r)).toEqual([['Plan.docx', 'present']]);
    });
    it('R0: a named, locally deleted file whose Drive copy is unchanged', () => {
      expect(eligible(sel({ records: [A], remote: [RA] }, { paths: ['a.pdf'] }))).toEqual([['a.pdf', 'deleted']]);
    });
    it('R0 refusals: unknown local subtree, fold-only match, Drive changed or trashed', () => {
      const sub = record('r1', 'locked/a.pdf');
      const locked = sel(
        { records: [sub], remote: [remoteEntry('r1', 'locked/a.pdf')], unknownLocal: ['locked'] },
        { paths: ['locked/a.pdf'] },
      );
      expect(locked.skipped[0]?.reason).toMatch(/could not be read/);
      const fold = sel({ records: [A], local: [localEntry('A.pdf', { ino: 7 })], remote: [RA] }, { paths: ['a.pdf'] });
      expect(fold.eligible).toEqual([]);
      const changed = sel({ records: [A], remote: [remoteEntry('r1', 'a.pdf', { md5: 'new' })] }, { paths: ['a.pdf'] });
      expect(changed.skipped[0]?.reason).toMatch(/changed in Drive/);
      const trashed = sel({ records: [A], probes: [['r1', { state: 'trashed' }]] }, { paths: ['a.pdf'] });
      expect(trashed.skipped[0]?.reason).toMatch(/trashed/);
    });
    it('skips released records, Drive moves, unknown and invalid paths', () => {
      const r = sel(
        {
          records: [{ ...A, remoteOnly: true }, record('r2', 'b.pdf')],
          local: [localEntry('b.pdf')],
          remote: [RA, remoteEntry('r2', 'sub/b.pdf')],
          folders: [['folder:sub', 'sub']],
        },
        { paths: ['a.pdf', 'b.pdf', 'zzz.pdf', '../x'] },
      );
      expect(r.eligible).toEqual([]);
      expect(r.skipped.map((s) => s.path)).toEqual(['a.pdf', 'b.pdf', 'zzz.pdf', '../x']);
    });
  });
  ```

- [ ] **Step 2: Run it.** `npx vitest run src/sync/__tests__/release.test.ts`. Expected FAIL: `Failed to load url ../release.js`.

- [ ] **Step 3: Implement** `src/sync/release.ts` (selection part):
  ```ts
  import { AppError } from '../errors.js';
  import { localMatchesRemote, remoteChanged } from './content-compare.js';
  import { foldKey, validateRelPath } from './paths.js';
  import { TYPE_CHANGED } from './plan-tracked.js';
  import {
    buildContext,
    isUnknownKey,
    localState,
    resolveLocal,
    resolveRemote,
    type PlanContext,
    type PlanInput,
  } from './resolve.js';
  import type { RemoteEntry, SyncRecord } from './types.js';

  export type ReleaseStatus = 'released' | 'would release' | 'released (already deleted locally)' | 'would release (already deleted locally)';

  export interface ReleaseInput { name: string; paths?: string[]; all?: boolean; apply?: boolean }

  export interface ReleaseCandidate {
    record: SyncRecord;
    remote: RemoteEntry;
    /** present: local copy goes to the trash; deleted: R0, only the flag is set. */
    kind: 'present' | 'deleted';
    localName: string | null;
  }

  export interface ReleaseSelection { eligible: ReleaseCandidate[]; skipped: Array<{ path: string; reason: string }> }

  export interface ReleaseResult {
    pair: string;
    dryRun: boolean;
    released: Array<{ path: string; status: ReleaseStatus }>;
    skipped: Array<{ path: string; reason: string }>;
    failed: Array<{ path: string; reason: string }>;
    removedDirs: string[];
  }

  export function releaseStatus(kind: ReleaseCandidate['kind'], dryRun: boolean): ReleaseStatus {
    const verb = dryRun ? 'would release' : 'released';
    return kind === 'present' ? verb : `${verb} (already deleted locally)`;
  }

  /** Spec §10 eligibility, or R0 (addendum §3.2) for an explicitly named, deleted file. */
  function check(ctx: PlanContext, record: SyncRecord, explicit: boolean): ReleaseCandidate | string {
    if (record.remoteOnly) return 'already in Drive only';
    if (isUnknownKey(ctx, record.path)) return 'inside a folder that could not be read';
    if (ctx.ambiguousFolds.has(foldKey(record.path))) return 'several files share this name';
    const R = resolveRemote(ctx, record);
    if (R.kind === 'unknown') return R.reason;
    if (R.kind !== 'present') return `the Drive file is ${R.kind}`;
    if (R.moved) return 'moved or renamed in Drive since the last sync; run sync_run first';
    if ((record.native !== null) !== (R.entry.native !== null)) return TYPE_CHANGED;
    const L = resolveLocal(ctx, record.path);
    // Native: a Drive change since the last export does not block release — intentional (sync
    // spec §10 only requires L unchanged and R present-same); Drive holds the newer version.
    if (L.kind === 'present') {
      const st = localState(ctx, record, L.entry);
      if (!st) return 'local file could not be hashed';
      if (st.changed || !localMatchesRemote(st.md5, record, R.entry)) {
        return 'not in sync (changed locally or in Drive); run sync_run first';
      }
      return { record, remote: R.entry, kind: 'present', localName: L.entry.name };
    }
    if (L.kind === 'unknown') return L.reason;
    if (L.kind === 'ambiguous') return 'a local file with a similar name exists';
    if (!explicit) return 'deleted locally; name it in paths to keep it in Drive only';
    if (remoteChanged(record, R.entry).changed) {
      return 'changed in Drive since the last sync; run sync_run first';
    }
    return { record, remote: R.entry, kind: 'deleted', localName: null };
  }

  /** PURE: which records sync_release may release; `all` never includes R0 paths. */
  export function selectReleasable(
    input: PlanInput,
    request: { paths?: readonly string[]; all?: boolean },
  ): ReleaseSelection {
    const ctx = buildContext(input);
    const out: ReleaseSelection = { eligible: [], skipped: [] };
    const take = (record: SyncRecord, explicit: boolean): void => {
      const verdict = check(ctx, record, explicit);
      if (typeof verdict === 'string') out.skipped.push({ path: record.path, reason: verdict });
      else out.eligible.push(verdict);
    };
    if (request.all) {
      const records = [...input.records].sort((a, b) => (a.path < b.path ? -1 : 1));
      for (const r of records) if (!r.remoteOnly) take(r, false);
      return out;
    }
    const seen = new Set<string>();
    for (const raw of request.paths ?? []) {
      let key: string;
      try {
        key = validateRelPath(raw);
      } catch (err) {
        out.skipped.push({ path: raw, reason: err instanceof AppError ? err.message : 'invalid path' });
        continue;
      }
      const fold = foldKey(key);
      if (seen.has(fold)) continue;
      seen.add(fold);
      const record = input.records.find((r) => foldKey(r.path) === fold);
      if (record) take(record, true);
      else out.skipped.push({ path: key, reason: 'not a synced file of this pair' });
    }
    return out;
  }
  ```

- [ ] **Step 4: Run to pass.** Same command. Expected PASS.

- [ ] **Step 5:** `npx prettier --write src/sync/release.ts src/sync/__tests__/release.test.ts && npm run check` → green.

- [ ] **Step 6: Commit.**
  ```bash
  git add src/sync/release.ts src/sync/__tests__/release.test.ts
  git commit -m "feat(sync): release eligibility incl. R0 for locally deleted files" -m "$TRAILER"
  ```

### Task 17: Release execution through `LocalTrash` and `SyncService.release`

**Files:**
- Modify: `src/sync/release.ts` (append `applyRelease`), `src/sync/scan-select.ts` (new `gatherInput`, body moved from `SyncService.buildPlan`), `src/sync/sync-service.ts` (`buildPlan`, new `release`)
- Create: `src/sync/__tests__/sync-service.release.test.ts`

- [ ] **Step 1: Write the failing test** `src/sync/__tests__/sync-service.release.test.ts` (complete file; only the imports it uses):
  ```ts
  import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
  import os from 'node:os';
  import path from 'node:path';
  import { afterEach, beforeEach, describe, expect, it } from 'vitest';
  import { createAudit, createRunner, noSleep, silentLogger } from '../../files/__tests__/fakes.js';
  import { LocalTrashError } from '../errors.js';
  import { PairStore } from '../pair-store.js';
  import { SyncService } from '../sync-service.js';
  import { dirTrash } from './fixtures.js';
  import { memoryDrive, type MemoryDrive } from './memory-drive.js';

  let tmp: string;
  let local: string;
  let trashDir: string;
  let mem: MemoryDrive;
  let store: PairStore;
  let sync: SyncService;
  let now: Date;

  beforeEach(async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), 'sync-release-'));
    local = path.join(tmp, 'Local');
    trashDir = path.join(tmp, 'Trash');
    await mkdir(local);
    await mkdir(trashDir);
    now = new Date('2026-11-03T12:00:00.000Z');
    mem = memoryDrive('ROOT');
    store = new PairStore({ dir: path.join(tmp, 'config', 'sync'), logger: silentLogger() });
    sync = new SyncService({
      runner: createRunner(mem.drive),
      audit: createAudit(),
      retry: noSleep,
      logger: silentLogger(),
      store,
      clock: () => now,
      trash: dirTrash(trashDir),
    });
    await sync.createPair({ name: 'docs', localDir: local, remoteFolderId: 'ROOT' });
  });
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  const at = (...parts: string[]): string => path.join(local, ...parts);

  async function apply() {
    const dry = await sync.run({ name: 'docs' });
    return sync.run({ name: 'docs', apply: true, planId: dry.planId });
  }

  const idOf = async (p: string): Promise<string> =>
    (await store.load('docs')).records.find((r) => r.path === p)?.remoteId ?? '';

  describe('sync_release', () => {
    beforeEach(async () => {
      await writeFile(at('a.pdf'), 'A');
      await mkdir(at('sub'));
      await writeFile(at('sub', 'b.pdf'), 'B');
      await sync.select({ name: 'docs', add: ['a.pdf', 'sub/b.pdf'] });
      await apply();
    });
    it('dry run changes nothing; apply trashes local copies and keeps them in Drive', async () => {
      const dry = await sync.release({ name: 'docs', all: true });
      expect(dry).toMatchObject({ pair: 'docs', dryRun: true, skipped: [], failed: [], removedDirs: [] });
      expect(dry.released).toEqual([
        { path: 'a.pdf', status: 'would release' },
        { path: 'sub/b.pdf', status: 'would release' },
      ]);
      expect(await readdir(local)).toContain('a.pdf');
      const res = await sync.release({ name: 'docs', all: true, apply: true });
      expect(res.released.map((r) => r.status)).toEqual(['released', 'released']);
      expect(res.removedDirs).toEqual(['sub']);
      expect((await readdir(trashDir)).sort()).toEqual(['a.pdf', 'b.pdf']);
      expect(mem.childrenOf('ROOT').map((f) => f.name)).toContain('a.pdf');
      const file = await store.load('docs');
      expect(file.records.every((r) => r.remoteOnly)).toBe(true);
      expect(file.pair.selection.sort()).toEqual(['a.pdf', 'sub/b.pdf']);
      expect((await sync.run({ name: 'docs' })).actions).toEqual({});
    });
    it('sync_select add brings a released file back (O1)', async () => {
      await sync.release({ name: 'docs', paths: ['a.pdf'], apply: true });
      await sync.select({ name: 'docs', add: ['a.pdf'] });
      expect((await apply()).actions).toEqual({ 'download-new': ['a.pdf'] });
      expect(await readFile(at('a.pdf'), 'utf8')).toBe('A');
    });
    it('a failing trash keeps the file and the record', async () => {
      const failing = new SyncService({
        runner: createRunner(mem.drive),
        audit: createAudit(),
        retry: noSleep,
        logger: silentLogger(),
        store,
        clock: () => now,
        trash: {
          trash: async () => {
            throw new LocalTrashError('no trash on this volume; nothing was deleted');
          },
        },
      });
      const res = await failing.release({ name: 'docs', paths: ['a.pdf'], apply: true });
      expect(res.failed).toEqual([{ path: 'a.pdf', reason: 'no trash on this volume; nothing was deleted' }]);
      expect(await readFile(at('a.pdf'), 'utf8')).toBe('A');
      expect((await store.load('docs')).records.find((r) => r.path === 'a.pdf')?.remoteOnly).toBe(false);
    });
    it('R0 releases a locally deleted file without touching anything', async () => {
      await rm(at('a.pdf'));
      const id = await idOf('a.pdf');
      const res = await sync.release({ name: 'docs', paths: ['a.pdf'], apply: true });
      expect(res.released).toEqual([{ path: 'a.pdf', status: 'released (already deleted locally)' }]);
      expect(await readdir(trashDir)).toEqual([]);
      expect(mem.files.get(id)?.trashed).toBe(false);
      expect((await sync.run({ name: 'docs' })).actions).toEqual({});
    });
    it('R0 refuses when the file reappears before the flag is set', async () => {
      await rm(at('a.pdf'));
      const id = await idOf('a.pdf');
      const original = mem.drive.getFile.getMockImplementation()!;
      mem.drive.getFile.mockImplementation(async (fileId, fields) => {
        if (fileId === id) await writeFile(at('a.pdf'), 'back');
        return original(fileId, fields);
      });
      const res = await sync.release({ name: 'docs', paths: ['a.pdf'], apply: true });
      expect(res.failed[0]?.reason).toMatch(/exists locally again/);
      expect((await store.load('docs')).records.find((r) => r.path === 'a.pdf')?.remoteOnly).toBe(false);
    });
    it('needs exactly one of paths or all', async () => {
      await expect(sync.release({ name: 'docs' })).rejects.toThrow('Give paths or all: true');
    });
  });
  ```

- [ ] **Step 2: Run it.** `npx vitest run src/sync/__tests__/sync-service.release.test.ts`. Expected FAIL: `sync.release is not a function`.

- [ ] **Step 3: Move plan gathering.** Create `gatherInput` in `scan-select.ts` from the body of `SyncService.buildPlan` (scan, `probeOnDisk`, `hashLocal`, unknown subtrees for failed hashes, `probeRecords` with `pair.googleExport`):
  ```ts
  /** Spec §5 steps 3–4: scan both sides, lstat, hash and probe → the planner's input. */
  export async function gatherInput(
    env: SyncEnv,
    file: PairFile,
  ): Promise<{ input: PlanInput; local: LocalScan; remote: RemoteScan }> {
    /* body moved verbatim from SyncService.buildPlan with this.ops → env.ops,
       ending with: return { input: { ...base, probes, md5s }, local, remote }; */
  }
  ```
  `SyncService.buildPlan` becomes:
  ```ts
    private async buildPlan(
      file: PairFile,
    ): Promise<{ plan: Plan; remote: RemoteScan; local: LocalScan }> {
      const { input, local, remote } = await gatherInput(this.env, file);
      return { plan: makePlan(input), remote, local };
    }
  ```
  (Move the now-unused imports of `probeOnDisk`, `hashLocal`, `probeRecords`, `hashTargets`, `onDiskProbeKeys`, `toKey` from `sync-service.ts` to `scan-select.ts`.)

- [ ] **Step 4: Implement `applyRelease`** (append to `release.ts`; extra imports: `lstat`, `readdir`, `rmdir` from `node:fs/promises`, `path`, `type AuditSink`, `type OperationRunner`, `hasErrorCode`, `type Logger`, `remoteUnchangedSince`, `isAbortError, messageOf, PersistenceError, TargetChangedError` from `./errors.js`, `md5File` from `./local-scanner.js`, `absInside, baseName, parentKey, toKey` from `./paths.js`, `type LocalTrash` from `./trash.js`, `SYNC_FILE_FIELDS, type Pair, type PairFile` from `./types.js`):
  ```ts
  export interface ReleaseDeps {
    ops: OperationRunner;
    audit: AuditSink;
    logger: Logger;
    trash: LocalTrash;
    save: (file: PairFile) => Promise<void>;
  }

  const KEEP_DIR = ['ENOTEMPTY', 'EEXIST', 'ENOENT', 'ENOTDIR'];

  async function verifyRemote(deps: ReleaseDeps, pair: Pair, planned: RemoteEntry): Promise<void> {
    const current = await deps.ops.exec(pair.account, 'idempotent', planned.id, (ctx) =>
      ctx.drive.getFile(planned.id, SYNC_FILE_FIELDS),
    );
    if (
      current.trashed ||
      !remoteUnchangedSince(planned, current) ||
      (current.parents?.[0] ?? '') !== planned.parentId
    ) {
      throw new TargetChangedError(`${planned.key} changed, moved or was trashed in Drive since the scan`);
    }
  }

  /** R0: L must still be absent — the key, and on a case-insensitive volume any fold match. */
  async function assertStillAbsent(pair: Pair, key: string): Promise<void> {
    const abs = absInside(pair.localDir, key);
    const exists = await lstat(abs).then(
      () => true,
      (err: unknown) => {
        if (hasErrorCode(err, 'ENOENT')) return false;
        throw new TargetChangedError(`${key} cannot be checked locally`, { cause: err });
      },
    );
    if (exists) throw new TargetChangedError(`${key} exists locally again`);
    if (!pair.caseInsensitive) return;
    const names = await readdir(path.dirname(abs)).catch((err: unknown) => {
      if (hasErrorCode(err, 'ENOENT')) return [] as string[];
      throw new TargetChangedError(`${key} cannot be checked locally`, { cause: err });
    });
    const parent = parentKey(key);
    const fold = foldKey(key);
    if (names.some((n) => foldKey(parent === '' ? toKey(n) : `${parent}/${toKey(n)}`) === fold)) {
      throw new TargetChangedError(`${key} exists locally again under another spelling`);
    }
  }

  async function removeEmptyDirs(deps: ReleaseDeps, root: string, dirs: Set<string>): Promise<string[]> {
    const removed: string[] = [];
    const queue = [...dirs].sort((a, b) => b.split('/').length - a.split('/').length);
    const tried = new Set<string>();
    for (let dir = queue.shift(); dir !== undefined; dir = queue.shift()) {
      if (dir === '' || tried.has(dir)) continue;
      tried.add(dir);
      try {
        await rmdir(absInside(root, dir));
      } catch (err) {
        if (!KEEP_DIR.some((c) => hasErrorCode(err, c))) {
          deps.logger.warn('Could not remove an emptied folder', { dir, error: err });
        }
        continue;
      }
      removed.push(dir);
      queue.push(parentKey(dir));
    }
    return removed.sort();
  }

  /** Spec §10 + addendum §3: re-verify, trash (or R0 flag only), persist after each, audit. */
  export async function applyRelease(
    deps: ReleaseDeps,
    file: PairFile,
    eligible: readonly ReleaseCandidate[],
  ): Promise<Pick<ReleaseResult, 'released' | 'failed' | 'removedDirs'>> {
    const { pair } = file;
    const out: Pick<ReleaseResult, 'released' | 'failed' | 'removedDirs'> = { released: [], failed: [], removedDirs: [] };
    const emptied = new Set<string>();
    for (const c of eligible) {
      const key = c.record.path;
      try {
        await verifyRemote(deps, pair, c.remote);
        if (c.kind === 'present') {
          const name = c.localName ?? key;
          const abs = absInside(pair.localDir, name);
          const md5 = await md5File(abs).catch((err: unknown) => {
            if (hasErrorCode(err, 'ENOENT')) throw new TargetChangedError(`${key} is already gone`);
            throw err;
          });
          if (md5 !== c.record.localMd5) {
            throw new TargetChangedError(`${key} changed locally since the scan`);
          }
          await deps.trash.trash(abs);
          emptied.add(parentKey(name));
        } else {
          await assertStillAbsent(pair, key);
        }
      } catch (err) {
        if (isAbortError(err)) throw err;
        out.failed.push({ path: key, reason: messageOf(err) });
        continue;
      }
      const target = file.records.find((r) => r.remoteId === c.record.remoteId);
      if (target) {
        target.remoteOnly = true;
        target.restorePending = false;
      }
      try {
        await deps.save(file);
      } catch (err) {
        throw new PersistenceError(`Could not save the pair file: ${messageOf(err)}`, { cause: err });
      }
      try {
        await deps.audit.record({
          account: pair.account,
          op: 'sync_release',
          fileId: c.record.remoteId,
          name: baseName(key),
          details: { pair: pair.name, path: key, remoteId: c.record.remoteId },
        });
      } catch (err) {
        deps.logger.warn('Audit log write failed', { op: 'sync_release', error: err });
      }
      out.released.push({ path: key, status: releaseStatus(c.kind, false) });
    }
    out.removedDirs = await removeEmptyDirs(deps, pair.localDir, emptied);
    return out;
  }
  ```
  Re-read of R comes first, the local check (re-hash, or R0 re-`lstat`) last, immediately before the trash call / setting the flag. A trash failure (`LocalTrashError`) lands in `failed`; the file and record stay; nothing is unlinked.

- [ ] **Step 5: Service.** In `sync-service.ts` import `applyRelease, releaseStatus, selectReleasable, type ReleaseInput, type ReleaseResult` from `./release.js`, `gatherInput` from `./scan-select.js`, re-export `export type { ReleaseInput, ReleaseResult } from './release.js';` (keep/restore `ValidationError` in the `../errors.js` import) and add:
  ```ts
    /** sync_release (spec §10, addendum §3): dry run by default. */
    async release(input: ReleaseInput): Promise<ReleaseResult> {
      const all = input.all === true;
      if (all === (input.paths ?? []).length > 0) {
        throw new ValidationError('Give paths or all: true (exactly one of them)');
      }
      return this.store.withLock(input.name, async () => {
        const file = await this.store.load(input.name);
        await checkRoots(this.env, file.pair);
        const { input: planInput } = await gatherInput(this.env, file);
        const selection = selectReleasable(planInput, all ? { all } : { paths: input.paths ?? [] });
        const pair = file.pair.name;
        if (!(input.apply ?? false)) {
          return {
            pair,
            dryRun: true,
            released: selection.eligible.map((c) => ({ path: c.record.path, status: releaseStatus(c.kind, true) })),
            skipped: selection.skipped,
            failed: [],
            removedDirs: [],
          };
        }
        const done = await applyRelease(
          {
            ops: this.ops,
            audit: this.deps.audit,
            logger: this.log,
            trash: this.deps.trash,
            save: (f): Promise<void> => this.store.save(f),
          },
          file,
          selection.eligible,
        );
        return { pair, dryRun: false, skipped: selection.skipped, ...done };
      });
    }
  ```

- [ ] **Step 6: Run to pass.** `npx vitest run src/sync/__tests__/sync-service.release.test.ts src/sync/__tests__/sync-service.run.test.ts`. Expected PASS.

- [ ] **Step 7:** `npx prettier --write src/sync/release.ts src/sync/scan-select.ts src/sync/sync-service.ts src/sync/__tests__/sync-service.release.test.ts && npm run check` → green.

- [ ] **Step 8: Commit.**
  ```bash
  git add src/sync/release.ts src/sync/scan-select.ts src/sync/sync-service.ts src/sync/__tests__/sync-service.release.test.ts
  git commit -m "feat(sync): sync release moves local copies to the OS trash, keeps files in Drive" -m "Each file is re-read in Drive and re-hashed (R0: re-lstat) immediately before removal; trash failures keep file and record; emptied folders are removed." -m "$TRAILER"
  ```

---

## Chunk 5: `releasable` and the `sync_release` tool / CLI

### Task 18: `releasable` after an applied run

**Files:**
- Modify: `src/sync/plan-shared.ts` (`TrackedResult.inSync`), `src/sync/plan-tracked.ts` (B1), `src/sync/plan-native.ts` (N1), `src/sync/planner.ts` (`Plan.inSync`), `src/sync/types.ts` (`Plan.inSync`, `SyncReport.releasable`), `src/sync/report.ts` (`ReportOptions.releasable`), `src/sync/sync-service.ts` (`run`), `src/sync/__tests__/report.test.ts` (`PLAN.inSync: []`)
- Tests: `planner.test.ts`, `sync-service.release.test.ts`

- [ ] **Step 1: Write the failing tests.** `planner.test.ts`:
  ```ts
  it('lists records in sync (B1, N1) for releasable', () => {
    const p = plan(
      planInput({
        records: [record('r1', 'a.pdf'), record('r2', 'b.pdf'), nativeRecord('g1', 'Plan.docx')],
        local: [localEntry('a.pdf'), localEntry('Plan.docx')],
        remote: [remoteEntry('r1', 'a.pdf'), remoteEntry('r2', 'b.pdf'), nativeEntry('g1', 'Plan.docx')],
      }),
    );
    expect(p.inSync).toEqual(['Plan.docx', 'a.pdf']);
  });
  ```
  (import `nativeRecord` too). In `sync-service.release.test.ts` add to `describe('sync_release')`:
  ```ts
  it('an applied run lists releasable files; a dry run does not', async () => {
    await writeFile(at('c.pdf'), 'C');
    await sync.select({ name: 'docs', add: ['c.pdf'] });
    const dry = await sync.run({ name: 'docs' });
    expect(dry.releasable).toBeUndefined();
    const applied = await sync.run({ name: 'docs', apply: true, planId: dry.planId });
    expect(applied.releasable).toEqual(['a.pdf', 'c.pdf', 'sub/b.pdf']);
  });
  ```

- [ ] **Step 2: Run them.** `npx vitest run src/sync/__tests__/planner.test.ts src/sync/__tests__/sync-service.release.test.ts -t "releasable"`. Expected FAIL: `inSync`/`releasable` undefined.

- [ ] **Step 3: Implement.**
  - `plan-shared.ts`: `TrackedResult` gains `/** B1/N1: in sync on both sides (releasable hint). */ inSync: boolean;`, initialised `false` in `makeScope`.
  - `plan-tracked.ts` B1: insert `out.inSync = true;` as the first line inside `if (!rs.changed && !lChanged) {`. `plan-native.ts` N1: insert `s.out.inSync = true;` as the first line inside `if (entry && !lChanged) {`.
  - `types.ts`: `Plan` gains `/** Record paths in sync at planning (B1/N1). */ inSync: string[];`; `SyncReport` gains `/** Applied runs: files sync_release could release now (spec §10). */ releasable?: string[];`.
  - `planner.ts`: collect `const inSync: string[] = [];` and `if (result.inSync) inSync.push(record.path);` in the records loop; return `inSync: inSync.sort(),`.
  - `report.ts`: `ReportOptions` gains `releasable?: readonly string[];`; after the `report` literal: `if (opts.releasable) report.releasable = [...opts.releasable];`.
  - `sync-service.ts` `run`, before `return buildReport(name, plan, { dryRun: false, outcomes })`:
    ```ts
      const done = new Set(outcomes.filter((o) => o.status === 'done').map((o) => o.path));
      const inSync = new Set(plan.inSync);
      const releasable = file.records
        .filter((r) => !r.remoteOnly && (inSync.has(r.path) || done.has(r.path)))
        .map((r) => r.path)
        .sort();
    ```
    and pass `releasable` in the options.

- [ ] **Step 4: Run to pass.** Same command. Expected PASS.

- [ ] **Step 5:** `npx prettier --write src/sync/*.ts src/sync/__tests__/*.ts && npm run check` → green.

- [ ] **Step 6: Commit.**
  ```bash
  git add src/sync/plan-shared.ts src/sync/plan-tracked.ts src/sync/plan-native.ts src/sync/planner.ts src/sync/types.ts src/sync/report.ts src/sync/sync-service.ts src/sync/__tests__/report.test.ts src/sync/__tests__/planner.test.ts src/sync/__tests__/sync-service.release.test.ts
  git commit -m "feat(sync): applied runs list releasable files" -m "$TRAILER"
  ```

### Task 19: `sync_release` MCP tool and `marvin-drive sync release`

**Files:**
- Modify: `src/mcp/sync-tools.ts` (`SYNC_TOOL_NAMES`, new tool), `src/cli/sync-commands.ts` (`SyncCliDeps`, `release` command), `src/cli/sync-format.ts` (`formatRelease`)
- Tests: `src/mcp/__tests__/sync-tools.test.ts`, `src/mcp/__tests__/server.test.ts` (31 → 32 tools), `src/cli/__tests__/sync-commands.test.ts`

- [ ] **Step 1: Write the failing tests.** `server.test.ts`: `'exposes the 32 tools from all specs'` and `toHaveLength(32)`. `sync-tools.test.ts`: replace `expect(byName.has('sync_release')).toBe(false);` with
  ```ts
    expect(byName.get('sync_release')).toContain('DRY RUN BY DEFAULT');
    expect(byName.get('sync_release')).toContain('pendingConfirmation');
  ```
  and add:
  ```ts
  it('sync_release dry run lists files and needs paths or all', async () => {
    await writeFile(path.join(local, 'voyage.txt'), 'Seafaring log');
    await call('sync_create_pair', { name: 'docs', localDir: local, remoteFolderId: 'ROOT' });
    await call('sync_select', { name: 'docs', add: ['voyage.txt'] });
    const dry = await call('sync_run', { name: 'docs' });
    await call('sync_run', { name: 'docs', apply: true, planId: (dry.data as { planId: string }).planId });
    const rel = await call('sync_release', { name: 'docs', all: true });
    expect(rel.data).toMatchObject({ dryRun: true, released: [{ path: 'voyage.txt', status: 'would release' }] });
    const bad = await call('sync_release', { name: 'docs' });
    expect(bad).toMatchObject({ isError: true });
  });
  ```
  `sync-commands.test.ts`: add `import type { ReleaseResult } from '../../sync/release.js';`, a constant
  ```ts
  const RELEASE: ReleaseResult = {
    pair: 'docs',
    dryRun: true,
    released: [{ path: 'a.pdf', status: 'would release' }],
    skipped: [{ path: 'b.pdf', reason: 'not in sync' }],
    failed: [],
    removedDirs: [],
  };
  ```
  `release: vi.fn(async () => release)` in `setup`'s service (give `setup` a third parameter `release: ReleaseResult = RELEASE`), and:
  ```ts
  it('releases named paths or --all, dry run unless --apply', async () => {
    const { service, run, lines, deps } = setup();
    await run('release', 'docs', 'a.pdf', 'b.pdf');
    expect(service.release).toHaveBeenLastCalledWith({ name: 'docs', apply: false, paths: ['a.pdf', 'b.pdf'] });
    expect(lines.at(-1)).toContain('would release: a.pdf');
    expect(lines.at(-1)).toContain('b.pdf — not in sync');
    await run('release', 'docs', '--all', '--apply');
    expect(service.release).toHaveBeenLastCalledWith({ name: 'docs', apply: true, all: true });
    await run('release', 'docs', '--all', 'a.pdf');
    expect(service.release).toHaveBeenLastCalledWith({ name: 'docs', apply: false, all: true, paths: ['a.pdf'] });
    expect(deps.setExitCode).not.toHaveBeenCalled();
  });
  it('release exits 1 when a file could not be released', async () => {
    const failed = { ...RELEASE, dryRun: false, released: [], failed: [{ path: 'a.pdf', reason: 'no trash' }] };
    const { run, deps } = setup(REPORT, true, failed);
    await run('release', 'docs', 'a.pdf', '--apply');
    expect(deps.setExitCode).toHaveBeenCalledWith(1);
  });
  ```

- [ ] **Step 2: Run them.** `npx vitest run src/mcp/__tests__ src/cli/__tests__ -t "release|32 tools|conversational"`. Expected FAIL: tool and command missing.

- [ ] **Step 3: Implement.** `sync-tools.ts`: add `'sync_release'` to `SYNC_TOOL_NAMES` (after `'sync_run'`) and register:
  ```ts
  server.registerTool(
    'sync_release',
    {
      description:
        'Move to Drive: remove the local copies of synced files and keep them in Drive only (they stay selected; sync_select add brings a copy back). DRY RUN BY DEFAULT. Pass paths — e.g. from releasable after an applied sync_run, or from pendingConfirmation for files the user already deleted locally and wants to keep in Drive — or all: true for every file that is in sync. Ask the user first ("Yerel kopyaları silmek ister misiniz? Hepsi / bazıları / hayır"), then call again with apply: true. Local copies go to the system Trash / Recycle Bin, never deleted permanently; every file is re-checked right before removal.',
      inputSchema: {
        name,
        paths: relPaths.optional(),
        all: z.boolean().optional().describe('Release every file that is in sync'),
        apply: z.boolean().optional().describe('Default false (dry run)'),
      },
    },
    async (args) => respond(log, () => sync.release(args)),
  );
  ```
  `sync-format.ts`:
  ```ts
  export function formatRelease(r: ReleaseResult): string {
    const lines = [`${r.pair} — ${r.dryRun ? 'release dry run' : 'release applied'}`];
    lines.push(...section('Release', r.released.map((x) => `${x.status}: ${x.path}`)));
    lines.push(...section('Skipped', r.skipped.map((s) => `${s.path} — ${s.reason}`)));
    lines.push(...section('Failed (nothing changed)', r.failed.map((f) => `${f.path} — ${f.reason}`)));
    lines.push(...section('Removed empty folders', r.removedDirs));
    if (r.dryRun && r.released.length > 0) lines.push('Run again with --apply to release.');
    if (lines.length === 1) lines.push('Nothing to release.');
    return lines.join('\n');
  }
  ```
  (`import type { ReleaseResult } from '../sync/release.js';`). `sync-commands.ts`: the import becomes `import { formatPairs, formatRelease, formatReport, reportFailed } from './sync-format.js';`; `SyncCliDeps.sync` becomes `() => Pick<SyncService, 'listPairs' | 'run' | 'repairMarker' | 'release'>`; doc comment lists `release`; add:
  ```ts
  sync
    .command('release')
    .description('Remove local copies of synced files and keep them in Drive only (dry run unless --apply)')
    .argument('<name>', 'pair name')
    .argument('[paths...]', 'relative paths to release')
    .option('--all', 'every file that is in sync')
    .option('--apply', 'release (default: dry run)')
    .action(async (name: string, paths: string[], opts: { all?: boolean; apply?: boolean }) => {
      const res = await deps.sync().release({
        name,
        apply: opts.apply ?? false,
        // Pass both through: `--all a.pdf` hits the service's "exactly one" ValidationError.
        ...(opts.all ? { all: true } : {}),
        ...(paths.length > 0 ? { paths } : {}),
      });
      deps.out(formatRelease(res));
      if (res.failed.length > 0) deps.setExitCode(1);
    });
  ```

- [ ] **Step 4: Run to pass.** Same command. Expected PASS.

- [ ] **Step 5:** `npx prettier --write src/mcp/sync-tools.ts src/cli/*.ts src/mcp/__tests__/*.ts src/cli/__tests__/*.ts && npm run check` → green.

- [ ] **Step 6: Commit.**
  ```bash
  git add src/mcp/sync-tools.ts src/cli/sync-commands.ts src/cli/sync-format.ts src/mcp/__tests__/sync-tools.test.ts src/mcp/__tests__/server.test.ts src/cli/__tests__/sync-commands.test.ts
  git commit -m "feat(sync): sync_release tool and marvin-drive sync release" -m "$TRAILER"
  ```

---

## Chunk 6: Confirmation before a local deletion trashes the Drive copy (B5)

### Task 20: `reason: 'local-deleted'` and `brakeUnconfirmed`

**Files:**
- Modify: `src/sync/types.ts` (`Action.reason`, `Plan.brakeUnconfirmed`), `src/sync/plan-tracked.ts` (B5 `act`), `src/sync/planner.ts` (`plan` return), `src/sync/__tests__/report.test.ts` (`PLAN.brakeUnconfirmed`)
- Tests: `plan-tracked.test.ts`, `planner.test.ts`

- [ ] **Step 1: Write the failing tests.** `plan-tracked.test.ts` (binary describe):

  ```ts
  it('B5 trash-remote carries reason local-deleted', () => {
    expect(only({ remote: [R] })).toMatchObject({
      kind: 'trash-remote',
      rule: 'B5',
      reason: 'local-deleted',
    });
  });
  ```

  `planner.test.ts` (`describe('mass-delete brake (spec §6.8)')`):

  ```ts
  it('brake counts every deletion; brakeUnconfirmed only those not awaiting confirmation', () => {
    const records = ['a', 'b', 'c'].map((n, i) => record(`r${i}`, `${n}.pdf`));
    const p = plan(planInput({ records, remote: records.map((r) => remoteEntry(r.remoteId, r.path)) }));
    expect(p.actions.map((a) => a.reason)).toEqual(['local-deleted', 'local-deleted', 'local-deleted']);
    expect(p.brake.tripped).toBe(true);
    expect(p.brakeUnconfirmed).toEqual({ tripped: false, trashRemote: 0, trashLocal: 0, tracked: 3 });
  });

  it('planId does not depend on the reason', () => {
    const [a] = trash('trash-remote', 1);
    expect(computePlanId([{ ...a!, reason: 'local-deleted' }])).toBe(computePlanId([a!]));
  });
  ```

- [ ] **Step 2: Run them.** `npx vitest run src/sync/__tests__/plan-tracked.test.ts src/sync/__tests__/planner.test.ts -t "local-deleted|brakeUnconfirmed|reason"`. Expected FAIL: `reason` undefined, `brakeUnconfirmed` undefined (the planId test already passes — it guards the invariant).

- [ ] **Step 3: Implement.** `types.ts` `Action` gains

  ```ts
    /** B5 only: the local copy was deleted; trash-remote waits for confirmRemoteTrash (addendum §2). */
    reason?: 'local-deleted';
  ```

  and `Plan` gains `/** Brake over deletions that run without confirmation (addendum §2.6). */ brakeUnconfirmed: BrakeInfo;`. `plan-tracked.ts` B5: add `reason: 'local-deleted',` to the `trash-remote` action. `planner.ts` return: `brakeUnconfirmed: brakeFor(actions.filter((a) => a.reason !== 'local-deleted'), tracked),`. `report.test.ts` `PLAN`: `brakeUnconfirmed: { tripped: false, trashRemote: 0, trashLocal: 0, tracked: 0 },`.

- [ ] **Step 4: Run to pass.** Same command. Expected PASS.

- [ ] **Step 5:** `npx prettier --write src/sync/types.ts src/sync/plan-tracked.ts src/sync/planner.ts src/sync/__tests__/*.ts && npm run check` → green.

- [ ] **Step 6: Commit.**

  ```bash
  git add src/sync/types.ts src/sync/plan-tracked.ts src/sync/planner.ts src/sync/__tests__/report.test.ts src/sync/__tests__/plan-tracked.test.ts src/sync/__tests__/planner.test.ts
  git commit -m "feat(sync): mark B5 deletions local-deleted and brake them separately" -m "$TRAILER"
  ```

### Task 21: `confirmRemoteTrash`, `pendingConfirmation`, `confirm-needs-mass-delete`

**Files:**
- Modify: `src/sync/sync-service.ts` (`RunInput`, `run`), `src/sync/report.ts` (`ReportOptions.pendingConfirmation`), `src/sync/types.ts` (`SyncReport.pendingConfirmation`)
- Tests: `sync-service.run.test.ts` (new block + two existing tests), `report.test.ts` (first test's `toEqual`), `src/cli/__tests__/sync-commands.test.ts` (`REPORT` gains `pendingConfirmation: []`), `tests/e2e/sync.e2e.test.ts` (third run)

- [ ] **Step 1: Write the failing tests.** In `sync-service.run.test.ts` widen the helper to `async function apply(extra: { allowMassDelete?: boolean; confirmRemoteTrash?: boolean } = {})`. Existing tests now need the flag where they expect B5 to run: in `'brakes mass deletion unless allowed'` use `apply({ confirmRemoteTrash: true })` and `apply({ allowMassDelete: true, confirmRemoteTrash: true })`; in `'propagates edits both ways…'` use `apply({ confirmRemoteTrash: true })`. Add:

  ```ts
  describe('confirmation before a local deletion trashes the Drive copy (addendum §2)', () => {
    const idOf = async (p: string): Promise<string> =>
      (await store.load('docs')).records.find((r) => r.path === p)?.remoteId ?? '';

    beforeEach(async () => {
      for (const n of ['a', 'b']) await writeFile(at(`${n}.pdf`), n);
      await sync.select({ name: 'docs', add: ['a.pdf', 'b.pdf'] });
      await apply();
    });

    it('a dry run lists B5 in actions and pendingConfirmation; with the flag in actions only', async () => {
      await rm(at('a.pdf'));
      const dry = await sync.run({ name: 'docs' });
      expect(dry.actions['trash-remote']).toEqual(['a.pdf']);
      expect(dry.pendingConfirmation).toEqual([{ path: 'a.pdf', remoteId: await idOf('a.pdf') }]);
      const flagged = await sync.run({ name: 'docs', confirmRemoteTrash: true });
      expect(flagged.actions['trash-remote']).toEqual(['a.pdf']);
      expect(flagged.pendingConfirmation).toEqual([]);
      expect(flagged.planId).toBe(dry.planId);
    });

    it('an unconfirmed apply leaves B5 pending and untouched while other actions run', async () => {
      await rm(at('a.pdf'));
      await writeFile(at('b.pdf'), 'b v2');
      const id = await idOf('a.pdf');
      const report = await apply();
      expect(report.actions).toEqual({ 'update-remote': ['b.pdf'] });
      expect(report.pendingConfirmation).toEqual([{ path: 'a.pdf', remoteId: id }]);
      expect(report.failures).toEqual([]);
      expect(report.notRun).toEqual([]);
      expect(mem.files.get(id)?.trashed).toBe(false);
      expect((await store.load('docs')).records.map((r) => r.path).sort()).toEqual(['a.pdf', 'b.pdf']);
      expect((await sync.run({ name: 'docs' })).pendingConfirmation).toMatchObject([{ path: 'a.pdf' }]);
    });

    it('a confirmed apply bound to the dry-run planId trashes the Drive copy', async () => {
      await rm(at('a.pdf'));
      const id = await idOf('a.pdf');
      const dry = await sync.run({ name: 'docs' });
      const res = await sync.run({
        name: 'docs',
        apply: true,
        planId: dry.planId,
        confirmRemoteTrash: true,
      });
      expect(res.aborted).toBeNull();
      expect(res.actions['trash-remote']).toEqual(['a.pdf']);
      expect(mem.files.get(id)?.trashed).toBe(true);
    });

    it('a pending B5 becomes B6 when Drive changes, and B1 when the file comes back', async () => {
      await rm(at('a.pdf'));
      await apply();
      const f = mem.files.get(await idOf('a.pdf'))!;
      f.content = Buffer.from('a remote v2');
      f.modifiedTime = '2026-11-03T14:00:00.000Z';
      expect((await apply()).actions).toEqual({ 'download-new': ['a.pdf'] });
      await rm(at('b.pdf'));
      await apply();
      await writeFile(at('b.pdf'), 'b');
      const back = await sync.run({ name: 'docs' });
      expect(back.actions).toEqual({});
      expect(back.pendingConfirmation).toEqual([]);
    });

    it('warns confirm-needs-mass-delete when the confirmed apply would brake', async () => {
      await writeFile(at('c.pdf'), 'c');
      await sync.select({ name: 'docs', add: ['c.pdf'] });
      await apply();
      for (const n of ['a', 'b', 'c']) await rm(at(`${n}.pdf`));
      const dry = await sync.run({ name: 'docs' });
      expect(dry.warnings).toContainEqual({
        path: '',
        code: 'confirm-needs-mass-delete',
        message: 'confirming these deletions would also need allowMassDelete',
      });
      const unconfirmed = await sync.run({ name: 'docs', apply: true, planId: dry.planId });
      expect(unconfirmed.aborted).toBeNull();
      expect(unconfirmed.pendingConfirmation).toHaveLength(3);
      const confirmed = await sync.run({ name: 'docs', apply: true, confirmRemoteTrash: true });
      expect(confirmed.aborted?.reason).toBe('mass-delete');
    });
  });
  ```

  In `report.test.ts` add `pendingConfirmation: [],` to the first test's expected object. In `sync-commands.test.ts` add `pendingConfirmation: [],` to `REPORT`. In `tests/e2e/sync.e2e.test.ts` the third run becomes `sync.run({ name: 'e2e', apply: true, confirmRemoteTrash: true })`.

- [ ] **Step 2: Run them.** `npx vitest run src/sync/__tests__/sync-service.run.test.ts`. Expected FAIL: `pendingConfirmation` undefined; the unconfirmed apply trashes `a.pdf`.

- [ ] **Step 3: Types and report.** `types.ts` `SyncReport` gains

  ```ts
    /** B5 deletions waiting for confirmRemoteTrash (addendum §2.3). */
    pendingConfirmation: Array<{ path: string; remoteId: string }>;
  ```

  `report.ts`: `ReportOptions` gains `pendingConfirmation?: SyncReport['pendingConfirmation'];` and the report literal gets `pendingConfirmation: [...(opts.pendingConfirmation ?? [])],` (after `candidates`).

- [ ] **Step 4: Service.** `RunInput` gains `/** Addendum §2: also run B5 trash-remote actions. */ confirmRemoteTrash?: boolean;`. Add at module level:

  ```ts
  const CONFIRM_NEEDS_MASS_DELETE = {
    path: '',
    code: 'confirm-needs-mass-delete',
    message: 'confirming these deletions would also need allowMassDelete',
  };
  ```

  In `run`, after `const name = file.pair.name;`:

  ```ts
      const confirm = input.confirmRemoteTrash ?? false;
      const awaiting = confirm ? [] : plan.actions.filter((a) => a.reason === 'local-deleted');
      const pendingConfirmation = awaiting.map((a) => ({
        path: a.key,
        remoteId: a.record?.remoteId ?? a.remote?.id ?? '',
      }));
      if (!apply) {
        const report = buildReport(name, plan, { dryRun: true, pendingConfirmation });
        // Only when confirming is what would trip the brake (the unconfirmed plan passes).
        if (awaiting.length > 0 && plan.brake.tripped && !plan.brakeUnconfirmed.tripped) {
          report.warnings.push(CONFIRM_NEEDS_MASS_DELETE);
        }
        return report;
      }
  ```

  (replacing `if (!apply) return buildReport(name, plan, { dryRun: true });`). Pass `pendingConfirmation` to the `plan-changed` and `mass-delete` `buildReport` calls and to the final one. The brake check becomes:

  ```ts
      const brake = confirm ? plan.brake : plan.brakeUnconfirmed;
      if (brake.tripped && !input.allowMassDelete) {
        const { trashRemote, trashLocal, tracked } = brake;
        /* same abort report as today, plus pendingConfirmation */
      }
  ```

  and execution runs only confirmed actions:

  ```ts
      const toRun = confirm ? plan.actions : plan.actions.filter((a) => a.reason !== 'local-deleted');
      const outcomes = await executor.run(toRun);
  ```

  Unconfirmed B5 records and both sides stay untouched; the next run plans them again.

- [ ] **Step 5: Run to pass.** `npx vitest run src/sync src/cli src/mcp`. Expected PASS.

- [ ] **Step 6:** `npx prettier --write src/sync/sync-service.ts src/sync/report.ts src/sync/types.ts src/sync/__tests__/*.ts src/cli/__tests__/sync-commands.test.ts tests/e2e/sync.e2e.test.ts && npm run check` → green.

- [ ] **Step 7: Commit.**

  ```bash
  git add src/sync/sync-service.ts src/sync/report.ts src/sync/types.ts src/sync/__tests__/sync-service.run.test.ts src/sync/__tests__/report.test.ts src/cli/__tests__/sync-commands.test.ts tests/e2e/sync.e2e.test.ts
  git commit -m "feat(sync): a local deletion trashes the Drive copy only with confirmRemoteTrash" -m "Unconfirmed B5 deletions are listed in pendingConfirmation and left untouched; the brake checks only what will run; a dry run warns confirm-needs-mass-delete." -m "$TRAILER"
  ```

### Task 22: MCP flag, tool description, CLI flag and pending section

**Files:**
- Modify: `src/mcp/sync-tools.ts` (`sync_run`), `src/cli/sync-commands.ts` (`run`), `src/cli/sync-format.ts` (`formatReport`)
- Tests: `src/mcp/__tests__/sync-tools.test.ts`, `src/cli/__tests__/sync-commands.test.ts`

- [ ] **Step 1: Write the failing tests.** `sync-tools.test.ts`, in `'describe the conversational flow…'` add:

  ```ts
    expect(byName.get('sync_run')).toContain('pendingConfirmation');
    expect(byName.get('sync_run')).toContain('ask the user');
    expect(byName.get('sync_run')).toContain('sync_release');
  ```

  and a flow test:

  ```ts
  it('trashes the Drive copy of a locally deleted file only with confirmRemoteTrash', async () => {
    await writeFile(path.join(local, 'voyage.txt'), 'log');
    await call('sync_create_pair', { name: 'docs', localDir: local, remoteFolderId: 'ROOT' });
    await call('sync_select', { name: 'docs', add: ['voyage.txt'] });
    const first = await call('sync_run', { name: 'docs' });
    await call('sync_run', { name: 'docs', apply: true, planId: (first.data as { planId: string }).planId });
    await rm(path.join(local, 'voyage.txt'));
    const dry = await call('sync_run', { name: 'docs' });
    expect(dry.data).toMatchObject({ pendingConfirmation: [{ path: 'voyage.txt' }] });
    const planId = (dry.data as { planId: string }).planId;
    const res = await call('sync_run', { name: 'docs', apply: true, planId, confirmRemoteTrash: true });
    expect(res.data).toMatchObject({ actions: { 'trash-remote': ['voyage.txt'] } });
    expect(mem.childrenOf('ROOT')).toEqual([]);
  });
  ```

  `sync-commands.test.ts`:

  ```ts
  it('passes --confirm-remote-trash and prints pending deletions without failing', async () => {
    const pending: SyncReport = {
      ...REPORT,
      dryRun: true,
      pendingConfirmation: [{ path: 'gone.pdf', remoteId: 'r9' }],
    };
    const { service, run, lines, deps } = setup(pending);
    await run('run', 'docs', '--apply', '--plan-id', 'abc', '--confirm-remote-trash');
    expect(service.run).toHaveBeenLastCalledWith({
      name: 'docs',
      apply: true,
      allowMassDelete: false,
      planId: 'abc',
      confirmRemoteTrash: true,
    });
    const text = lines.at(-1) ?? '';
    expect(text).toContain('Deleted locally');
    expect(text).toContain('gone.pdf');
    expect(text).toContain(`--plan-id ${pending.planId} --confirm-remote-trash`);
    expect(text).toContain('marvin-drive sync release docs');
    expect(deps.setExitCode).not.toHaveBeenCalled();
  });
  it('refuses --confirm-remote-trash without --plan-id', async () => {
    const { service, run } = setup();
    await expect(run('run', 'docs', '--apply', '--confirm-remote-trash')).rejects.toThrow(
      'pass the planId of the dry run you reviewed',
    );
    expect(service.run).not.toHaveBeenCalled();
  });
  ```

- [ ] **Step 2: Run them.** `npx vitest run src/mcp/__tests__/sync-tools.test.ts src/cli/__tests__/sync-commands.test.ts`. Expected FAIL: description lacks the words; the MCP input drops `confirmRemoteTrash` (nothing trashed); the CLI rejects the unknown option and does not require `--plan-id`.

- [ ] **Step 3: Implement.** `sync-tools.ts` `sync_run`: append to `description`:

  ```
   Files the user deleted locally are listed in pendingConfirmation; their Drive copies are NOT trashed unless you pass confirmRemoteTrash: true. For those, ask the user first: delete them in Drive too (pass confirmRemoteTrash: true together with the planId of the dry run the user saw; after an applied run, do a new dry run first), or keep them in Drive only (sync_release with those paths). Confirmation covers every pending path of the run; to keep some, release them first.
  ```

  and add to `inputSchema`:

  ```ts
        confirmRemoteTrash: z
          .boolean()
          .optional()
          .describe(
            'Also move the Drive copies of locally deleted files (pendingConfirmation) to the Drive trash; only after the user agreed, with the planId of the dry run they saw',
          ),
  ```

  `sync-commands.ts` `run`: `.option('--confirm-remote-trash', 'also trash the Drive copies of files deleted locally')`, opts type gains `confirmRemoteTrash?: boolean`, call gains `...(opts.confirmRemoteTrash ? { confirmRemoteTrash: true } : {}),`, and the action starts with
  ```ts
      if (opts.confirmRemoteTrash && !opts.planId) {
        throw new ValidationError(
          '--confirm-remote-trash: pass the planId of the dry run you reviewed (--plan-id <id>)',
        );
      }
  ```
  (`import { ValidationError } from '../errors.js';`; the error reaches `main.ts`'s `parseAsync().catch` → stderr, exit code 1). `sync-format.ts` `formatReport`, before the `Candidates` line:

  ```ts
    if (r.pendingConfirmation.length > 0) {
      lines.push(
        ...section(
          'Deleted locally — Drive copy kept until you decide',
          r.pendingConfirmation.map((p) => p.path),
        ),
        r.dryRun
          ? `  Delete in Drive too: marvin-drive sync run ${r.pair} --apply --plan-id ${r.planId} --confirm-remote-trash`
          : '  Delete in Drive too: run a new dry run, then apply it with its --plan-id and --confirm-remote-trash',
        `  Keep in Drive only: marvin-drive sync release ${r.pair} <paths…> --apply`,
        '  (Confirming covers all of them; release the ones to keep first.)',
      );
    }
  ```

  and the warnings line becomes `` `${w.path ? `${w.path}: ` : ''}${w.code}${w.message ? ` — ${w.message}` : ''}` ``. `reportFailed` stays unchanged (pending alone never exits 1).

- [ ] **Step 4: Run to pass.** Same command. Expected PASS.

- [ ] **Step 5:** `npx prettier --write src/mcp/sync-tools.ts src/cli/sync-commands.ts src/cli/sync-format.ts src/mcp/__tests__/sync-tools.test.ts src/cli/__tests__/sync-commands.test.ts && npm run check` → green.

- [ ] **Step 6: Commit.**

  ```bash
  git add src/mcp/sync-tools.ts src/cli/sync-commands.ts src/cli/sync-format.ts src/mcp/__tests__/sync-tools.test.ts src/cli/__tests__/sync-commands.test.ts
  git commit -m "feat(sync): confirmRemoteTrash in sync_run and --confirm-remote-trash in the CLI" -m "The tool description tells Claude to ask first and to pass the planId the user saw; the CLI report offers both choices." -m "$TRAILER"
  ```

---

## Chunk 7: Wording, docs, live E2E

### Task 23: Human report wording for Phase B

**Files:**
- Modify: `src/cli/sync-format.ts` (`formatPairs`, `formatReport`)
- Test: `src/cli/__tests__/sync-commands.test.ts`

- [ ] **Step 1: Write the failing test:**

  ```ts
  it('shows remote-only counts and the releasable hint', () => {
    const text = formatReport({ ...REPORT, releasable: ['a.pdf', 'b.pdf'] });
    expect(text).toContain('Releasable: 2 file(s) are in sync — marvin-drive sync release docs --all (dry run first)');
    const { lines, run } = setup();
    return run('list').then(() => expect(lines[0]).toContain('remote-only 0'));
  });
  ```

- [ ] **Step 2: Run it.** `npx vitest run src/cli/__tests__/sync-commands.test.ts -t "releasable hint"`. Expected FAIL.

- [ ] **Step 3: Implement.** In `formatPairs` the counts line becomes `` `  selected ${c.selected} · tracked ${c.tracked} · remote-only ${c.remoteOnly} · excluded ${c.excluded} · baseline ${c.baseline} · last applied ${last}` ``. In `formatReport`, after the pending section:

  ```ts
    if (r.releasable && r.releasable.length > 0) {
      lines.push(
        `Releasable: ${r.releasable.length} file(s) are in sync — marvin-drive sync release ${r.pair} --all (dry run first)`,
      );
    }
  ```

- [ ] **Step 4: Run to pass.** Same command. Expected PASS (the `'lists pairs'` test still finds `baseline 3`).

- [ ] **Step 5:** `npx prettier --write src/cli/sync-format.ts src/cli/__tests__/sync-commands.test.ts && npm run check` → green.

- [ ] **Step 6: Commit.**

  ```bash
  git add src/cli/sync-format.ts src/cli/__tests__/sync-commands.test.ts
  git commit -m "feat(cli): remote-only counts and releasable hint in sync reports" -m "$TRAILER"
  ```

### Task 24: README, CHANGELOG (Unreleased), FEATURES

**Files:**
- Modify: `README.md` (CLI table ~l. 81–83, Sync tools table ~l. 131–138, "Syncing safely" ~l. 142–149), `docs/CHANGELOG.md` (`## Unreleased`), `docs/FEATURES.md` (§5)

- [ ] **Step 1: README.**
  - CLI table: change the `sync run` row to `` `marvin-drive sync run <name> [--apply] [--plan-id <id>] [--allow-mass-delete] [--confirm-remote-trash]` `` and add a row `` | `marvin-drive sync release <name> [--all \| <paths…>] [--apply]` | Keep files in Drive only: local copies go to the system trash (dry run by default) | ``.
  - Sync tools table: `sync_create_pair` purpose gains "; `googleExport` picks the local format of Google Docs/Sheets/Slides/Drawings"; `sync_run` gains "; locally deleted files wait in `pendingConfirmation` until you confirm (`confirmRemoteTrash`)"; new row `` | `sync_release` | "Move to Drive": remove local copies (to the system trash) of files that are in sync; they stay in Drive and selected; `sync_select add` restores them | ``.
  - "Syncing safely": replace the `native-skipped` sentence with three bullets:
    - "**Google Docs, Sheets, Slides and Drawings** sync one way, as read-only exports (default `.docx`, `.xlsx`, `.pptx`, `.pdf`; set `googleExport` when creating the pair). A changed Drive original is exported again; local edits are never uploaded — they are reported, and if the original also changed your copy is kept as `<name> (local edit YYYY-MM-DD HH.mm).<ext>`. Forms, Sites and Apps Script files are listed as `native-unsupported`. Exports over Drive's 10 MB limit use the export link; if that fails too they are reported `native-too-large`."
    - "**Deleting a synced file locally does not delete it in Drive by itself.** The run lists it under `pendingConfirmation`; Claude asks whether to delete the Drive copy too (`confirmRemoteTrash` with the dry run's `planId`, Drive trash for 30 days) or to keep it in Drive only (`sync_release`)."
    - "**Upgrading from 0.3:** on the first run after the upgrade, Google files already in a synced Drive folder are listed as candidates (not exported); select the ones you want. Google files added later are exported automatically."
  - Add a short "Move to Drive" paragraph after the bullets: "After an applied run Claude can offer to free disk space: `sync_release` (or `marvin-drive sync release <name> --all`) re-checks every file, moves the local copy to the system trash and keeps the Drive file; released files are never downloaded again unless you `sync_select add` them. A file you already deleted locally can be released by name, so it stays in Drive."

- [ ] **Step 2: CHANGELOG** — under `## Unreleased` → `### Added`:

  ```markdown
  - Sync Phase B: Google Docs/Sheets/Slides/Drawings sync as read-only exports (rules N1–N9), with per-pair `googleExport` formats (validated at `sync_create_pair`), the 10 MB `exportLinks` fallback and `native-too-large` reporting.
  - `sync_release` / `marvin-drive sync release`: keep files in Drive only; local copies go to the OS trash after re-verification; `sync_select add` restores them (rules O0–O8). Locally deleted files can be released by name (R0). Applied runs list `releasable` files.
  - `sync_run` `confirmRemoteTrash` / `--confirm-remote-trash` and the report field `pendingConfirmation`.
  ```

  `### Changed`:

  ```markdown
  - Sync: deleting a tracked file locally no longer trashes its Drive copy automatically; it waits in `pendingConfirmation` until confirmed (`confirm-needs-mass-delete` warns when the confirmed run would also need `allowMassDelete`).
  - Sync: Google files are no longer reported `native-skipped`; unsupported Google types are reported `native-unsupported`. Pair files gain `nativeBaselineDone` (old files load as `false`): the first applied run after the upgrade baselines existing Google files as candidates instead of exporting them.
  - `sync_scan` reads the local folder once instead of twice.
  ```

- [ ] **Step 3: FEATURES §5.** Rename the heading to `### 5. Selective sync (spec: `docs/superpowers/specs/2026-11-03-selective-sync-design.md`, Phase B addendum `2026-11-07-sync-phase-b-addendum.md`)` and replace the ⬜ Phase B line with:

  ```markdown
  - ✅ Phase B: Google-native exports (N1–N9, `googleExport`, upgrade baseline), release / "move to Drive" (`sync_release`, O0–O8, R0, `releasable`)
  - ✅ Confirmation before a local deletion trashes the Drive copy (`confirmRemoteTrash`, `pendingConfirmation`)
  - ✅ Provider boundary for a later OneDrive provider: `remote-kinds`, `content-compare`, no runtime `googleapis` under `src/sync`
  ```

- [ ] **Step 4:** `npx prettier --write README.md docs/CHANGELOG.md docs/FEATURES.md && npm run check` → green.

- [ ] **Step 5: Commit.**

  ```bash
  git add README.md docs/CHANGELOG.md docs/FEATURES.md
  git commit -m "docs(sync): Phase B — Google exports, release, deletion confirmation" -m "$TRAILER"
  ```

### Task 25: Live E2E for Phase B

**Files:**
- Modify: `tests/e2e/sync.e2e.test.ts` (shared `e2eSetup()` helper, first test uses it, second `it`)

- [ ] **Step 1: Extract the shared setup.** Add `import { DocsService } from '../../src/content/docs-service.js';` and, above `describe.runIf(account)`:

  ```ts
  /** Temp local + trash dirs, a temp audit log and services on the live account; never the real trash. */
  async function e2eSetup() {
    const app = buildApp();
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'marvin-sync-e2e-'));
    const local = path.join(tmp, 'local');
    const trashDir = path.join(tmp, 'trash');
    await mkdir(local);
    await mkdir(trashDir);
    const trash: LocalTrash = {
      trash: async (abs) => {
        await rename(abs, path.join(trashDir, path.basename(abs)));
      },
    };
    const runner = new DriveClientFactory(app.auth);
    const audit = new FileAuditLog(path.join(tmp, 'audit.jsonl'));
    const files = new FileService({ runner, audit, downloadsDir: path.join(tmp, 'downloads') });
    const sync = new SyncService({
      runner,
      audit,
      store: new PairStore({ dir: path.join(tmp, 'sync') }),
      trash,
    });
    const at = (name: string): string => path.join(local, name);
    /** Purges every child of the test folder (incl. ones trashed by the test), the folder, then tmp. */
    const cleanup = async (rootId: string): Promise<void> => {
      const children = await files.list({ account, folderId: rootId, includeTrashed: true, pageSize: 200 });
      for (const child of children.files) {
        await files.delete({ account, fileId: child.id, permanent: true }).catch(() => undefined);
      }
      await files.delete({ account, fileId: rootId, permanent: true });
      await rm(tmp, { recursive: true, force: true });
    };
    return { app, tmp, local, trashDir, trash, runner, audit, files, sync, at, cleanup };
  }
  ```

  In the first test replace everything from `const app = buildApp();` through `const at = …` with `const { tmp, local, trashDir, runner, files, sync, at, cleanup } = await e2eSetup();` (its `setRemote` helper stays), and replace the body of its `finally` block with `await cleanup(root.id);`.

- [ ] **Step 2: Write the Phase B test** as a second `it` inside `describe.runIf(account)`:

  ```ts
  it('Phase B: Google Doc export → release → no re-export → restore; confirmation; R0', async () => {
    const { tmp, local, trashDir, runner, audit, files, sync, at, cleanup } = await e2eSetup();
    const docs = new DocsService({ runner, audit }); // audit entries go to the temp log
    const root = await files.createFolder({ account, name: `marvin-sync-e2e-b-${Date.now()}` });
    try {
      await sync.createPair({ name: 'e2eb', localDir: local, remoteFolderId: root.id, account });
      await sync.run({ name: 'e2eb', apply: true }); // first applied run: later files are adopted
      const src = path.join(tmp, 'Plan.txt');
      await writeFile(src, 'plan v1');
      const doc = await files.upload({
        account,
        localPath: src,
        parentId: root.id,
        name: 'Plan',
        convertToGoogle: true,
      });
      const exported = await sync.run({ name: 'e2eb', apply: true });
      expect(exported.actions).toEqual({ 'export-new': ['Plan.docx'] });
      expect((await readFile(at('Plan.docx'))).subarray(0, 2).toString()).toBe('PK');

      // release → a later Drive edit is not exported
      const released = await sync.release({ name: 'e2eb', paths: ['Plan.docx'], apply: true });
      expect(released.released).toEqual([{ path: 'Plan.docx', status: 'released' }]);
      expect(await readdir(trashDir)).toEqual(['Plan.docx']);
      await docs.insertText({ account, fileId: doc.id, text: ' more', position: { at: 'end' } });
      expect((await sync.run({ name: 'e2eb', apply: true })).actions).toEqual({});
      await expect(readFile(at('Plan.docx'))).rejects.toThrow();

      // select add restores it
      await sync.select({ name: 'e2eb', add: ['Plan.docx'] });
      expect((await sync.run({ name: 'e2eb', apply: true })).actions).toEqual({
        'export-new': ['Plan.docx'],
      });

      // local deletion: unconfirmed → pending; confirmed → Drive trash
      await writeFile(at('note.txt'), 'note');
      await sync.select({ name: 'e2eb', add: ['note.txt'] });
      await sync.run({ name: 'e2eb', apply: true });
      await rm(at('note.txt'));
      const pending = await sync.run({ name: 'e2eb', apply: true });
      expect(pending.pendingConfirmation.map((p) => p.path)).toEqual(['note.txt']);
      const dry = await sync.run({ name: 'e2eb' });
      const confirmed = await sync.run({
        name: 'e2eb',
        apply: true,
        planId: dry.planId,
        confirmRemoteTrash: true,
      });
      expect(confirmed.actions['trash-remote']).toEqual(['note.txt']);

      // R0: a file deleted locally is kept in Drive only
      await writeFile(at('keep.txt'), 'keep');
      await sync.select({ name: 'e2eb', add: ['keep.txt'] });
      await sync.run({ name: 'e2eb', apply: true });
      await rm(at('keep.txt'));
      const r0 = await sync.release({ name: 'e2eb', paths: ['keep.txt'], apply: true });
      expect(r0.released).toEqual([{ path: 'keep.txt', status: 'released (already deleted locally)' }]);
      const final = await sync.run({ name: 'e2eb' });
      expect(final.actions).toEqual({});
      expect(final.pendingConfirmation).toEqual([]);
      await sync.removePair({ name: 'e2eb' });
    } finally {
      await cleanup(root.id);
    }
  });
  ```

- [ ] **Step 3: Typecheck and unit gate.** `npm run check` → green (E2E is skipped without `MARVIN_E2E_ACCOUNT`).

- [ ] **Step 4: Run live** (only when an authorised test account is available; the OAuth app is in Testing mode, tokens last 7 days): `MARVIN_E2E_ACCOUNT=<alias> npm run test:e2e -- -t "Phase B"`. Expected PASS; the user's real trash is untouched (temp trash dir). If the account is not available, note "live E2E pending" in the hand-off instead of claiming it passed.

- [ ] **Step 5: Commit.**

  ```bash
  git add tests/e2e/sync.e2e.test.ts
  git commit -m "test(e2e): live Phase B sync — export, release, restore, confirmation, R0" -m "$TRAILER"
  ```

- [ ] **Step 6: Final verification.** `npm run check` → green; `git log --oneline main..HEAD` shows the Phase B commits on `feat/sync-phase-b`; **do not push** (GitHub account suspended; push happens later).
