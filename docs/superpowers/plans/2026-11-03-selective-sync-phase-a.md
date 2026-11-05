# Selective Sync — Phase A (Sub-project 5) Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On-demand, selective, two-way sync of binary files between a local folder and a Drive folder, with Claude-assisted selection (`sync_scan` → `sync_select`), dry-run-by-default runs bound to a `planId`, conflicts kept as copies, and deletions only ever to the Drive trash / macOS Trash.

**Architecture:** A new `src/sync/` module. Two scanners (local walk without following symlinks; breadth-first Drive walk) and a probe for records missing from the Drive scan feed a **pure planner** (`resolve.ts` → `plan-tracked.ts` B1–B14 → `plan-untracked.ts` U0–U8 → `planner.ts` brake/planId/baseline). An `Executor` runs the plan in spec §7 order with re-verification, isolation and an atomic pair-file save after every success, using `transfer.ts` (exclusive `link`+`EEXIST` writes, guarded replace, Drive upload/update) and `trash.ts` (`/usr/bin/trash -s`, injectable). `SyncService` wires lock → root checks → scan → hash → probe → plan → (apply) execute, reusing the shared `OperationRunner` (retry, error mapping) and audit sink. Six MCP tools and three CLI commands sit on top.

**Tech Stack:** TypeScript (strict, ESM/NodeNext), Node ≥ 22, `googleapis` Drive v3, `@modelcontextprotocol/sdk`, `zod` v4, `commander`, Vitest. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-11-03-selective-sync-design.md` — read it first. Phase A scope is its §12. Phase B (§6.6 native exports, §6.7 remote-only, release, `sync_release`, `googleExport` validation) is **out of scope**; its data-model fields exist but are never set.

---

## Ground rules (read before Task 1)

- Run everything from the repository root. Work on the branch you were given; never push.
- Quality gate after every task: `npm run check` (typecheck + eslint + prettier check + vitest). It must be fully green — and eslint must stay at **zero warnings** — before committing. Run `npx prettier --write <changed files>` before every `npm run check` (the code below is prettier-formatted, but re-run it anyway).
- Imports use the `.js` suffix (ESM, NodeNext), e.g. `import { x } from './y.js';`.
- Existing test helpers: `src/files/__tests__/fakes.ts` (`createFakeDrive`, `createRunner`, `createAudit`, `noSleep`, `silentLogger`, `httpError`). New sync helpers live in `src/sync/__tests__/` and are **not** `*.test.ts` files: `fixtures.ts` (pairs, records, entries, `refuseTrash`), `drive-tree.ts` (fake folder lister), `plan-input.ts` (planner input builder), `memory-drive.ts` (in-memory Drive behind `FakeDrive`).
- Tests never touch the real Trash or real Drive: local trash goes through an injected `ExecFn`; Drive is a `FakeDrive`; pair files live in temp dirs (`PairStore({ dir })`).
- Commit messages: Conventional Commits; every commit ends with a blank line and `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` (the commit steps pass it as a second `-m`). Never push.
- Expected-failure wording: for a test of a module that does not exist yet, Vitest fails the file with an import-resolution error naming the missing module (e.g. `Failed to load url ../paths.js` / `Cannot find module`). That is the expected red.
- Every task leaves `npm run check` green — this ordering was verified by replaying the tasks one by one.

### Declared refinements vs the spec (all intentional)

- **`foldKey`** = NFC → per character `c === 'ı' ? c : c.toUpperCase()` → join → `toLowerCase()` → NFC. This matches APFS for `ı`/`I`/`i` (dotless `ı` stays distinct: `ılık` ≠ `ilik`, `ilik` ≡ `ILIK`), `İ`/`i̇`, `ß`/`SS`, `ﬀ`, `ﬅ`, `ſ` and `Σ`/`ς` (all covered by tests).
- **Filesystem-agreement rule.** Our fold alone never decides that two spellings are the same file. On a case-insensitive volume a fold-only match (a record key vs a differently spelled local file, or a selected/Drive key vs a local file in U2/U3/U6/U7) counts only when the service's `lstat` of that key hits **the same inode** as the scanned local entry; otherwise the key is `ambiguous` (report, no action). The service probes exactly those keys (`onDiskProbeKeys`: record keys without an exact scan match, plus Drive/selected keys that match a local file only by fold). Folder-spelling reuse for uploads (`uploadKey`, `ensureRemoteFolder`) may use the fold alone, since it only picks an existing Drive folder and writes nothing locally. (Regression P5: tracked `ilik.pdf` deleted locally next to an unrelated `ılık.pdf` → `trash-remote` for `ilik.pdf`, `ılık.pdf` is a local candidate, never `update-remote`/conflict.)
- **On-disk probe and blocking ancestors (§6.1 step 4, hardened).** `LocalScan` = `{ entries, occupied, unknownSubtrees, blocking, partFiles }`: `occupied` holds keys of existing non-regular or ignored entries; `blocking` holds symlinks, special files and dot-named folders — nothing below them is ever "absent". Before planning, the service `lstat`s every record key without an exact scan match and passes `PlanInput.onDisk` (key → `{ kind, ino }`). `resolveLocal`: exact → fold (case-insensitive **and confirmed by the volume**, else ambiguous) → unknown subtree → **blocked ancestor → unknown-state** → occupied → **on disk: same inode as a scanned entry ⇒ that entry (renamed-case), else unknown-state** → absent. U0 also treats blocked keys as `unknown-state`, and `sync_select add` rejects them. (Regression: a folder moved to another disk and replaced by a symlink — reachable or dangling — never yields `trash-remote`.)
- **`moveLocal` never deletes the only copy.** `link` → `EEXIST` with the same inode drops the source only when it is a genuine second link (`nlink ≥ 2` **and** two distinct directory entries); otherwise the two names are one entry folded by the volume (`straße`/`STRASSE`, `report`/`Report`) and it is `rename`d. In place (case-only) moves require the target to be absent or the same inode. A crash after `unlink` but before persistence is resumed by adopting the file at the target when its md5 equals the record (`B7-resume`).
- **Remote folder spelling (U1).** On a case-insensitive volume each parent folder of an upload takes the spelling of an existing Drive folder with the same fold (local `docs/a.pdf` uploads into Drive `Docs/`, record key `Docs/a.pdf`); on a case-sensitive volume a case-only folder mismatch is `ambiguous`. The executor's `folderFor`/`ensureRemoteFolder` match by fold on case-insensitive volumes (the folder query lists all folders of the parent, following `nextPageToken`, and filters by fold / exact NFC name).
- **U8 recency** uses `max(mtimeMs, ctimeMs) > lastAppliedRunAt` (`cp -p`, `mv`, `ditto` keep the old mtime), and `lastAppliedRunAt`/`firstAppliedRunAt` are the **scan start** time of the applied run, not its end.
- **Ignored names are symmetric:** Drive items whose name starts with `.` or ends with `.marvin-part` are ignored like local ones (§6.10 lists them only for local). Dot-named and unrepresentable Drive folders are not descended; their ids are added to `baselineFolders` on the first applied run (with the ambiguous/unlistable ones), so files that appear later under them stay candidates.
- **Types:** `LocalEntry` gains `ino`. `RemoteScan` gains `ignored` (with ids, for the baseline and for records renamed to ignored names) and `unknownFolderIds`. `RemoteEntry.ancestorIds` lets U5 test `baselineFolders` membership.
- **Planner has no clock.** Conflict-copy names (`YYYY-MM-DD HH.mm`, local time) are generated by the executor. `planId` = SHA-256 (64 hex) over the sorted JSON rows `[kind, remoteId, key, localMd5, remoteMd5]` of every non-`refresh` action — the spec's tuple plus the target key.
- **`planId` binding:** the MCP `sync_run` rejects `apply: true` without a `planId` (Claude must apply exactly the approved dry run). The CLI keeps `sync run <name> --apply` (re-plans) and gains `--plan-id <id>`.
- **Internal action `refresh`** (record bookkeeping only — touched-but-identical file, a changed on-disk name (`localName`), Drive metadata change with the same md5). Emitted only when something actually differs (a renamed-case match whose `localName` already matches needs nothing). It is executed, but excluded from `planId` and from report `actions`.
- **Phase B records** (`remoteOnly` or `native` set) cannot exist in Phase A; if found they get `unknown-state` (rule `phase-b`) and are never acted on.
- **Case-sensitive volume:** besides tracked fold-only matches (§6.1 step 2), an untracked fold group whose exact keys differ (selected key vs local vs Drive) is `ambiguous`. On a case-insensitive volume such a group pairs up (when the volume confirms it, see above) and the **Drive key** becomes the record path / selection key.
- **Claimed keys:** an untracked Drive file whose fold equals a tracked record's path or Drive-move target is reported `collision` (rule `U-tracked`). B7–B9 targets occupied by a different local file are `collision` (planner check; placeExclusive still guards).
- **B11:** an untracked Drive file at the key with md5 = L is adopted (crash between upload and persistence); a *different* untracked Drive file at the key is a `collision` report (no second same-name upload).
- **U2 with a read-only Drive file** and differing content → `remote-readonly` report only. B4 with `!canEdit` writes the conflict copy once and updates the record's remote side so it does not repeat.
- **U0:** excluded keys are skipped silently. An occupied (non-regular) local path: selected → `unknown-state`; unselected with a new Drive file → `collision`.
- **Probe (§6.2):** the parent chain is walked (max 32): direct parent scanned → `present`; parent or any ancestor ambiguous, or an ancestor (not the direct parent) scanned → `unknown-state`; chain ends outside → `moved-out`; 404/403 on the file → `unavailable`, on an ancestor → `unknown`; other errors → `unknown`; run-aborting errors rethrown. A record whose id appears among ignored Drive items is `unknown-state` without probing.
- **Duplicate Drive folders** are detected by fold of the name (`Dup` vs `dup` → both unknown).
- **B5 / B10** also remove the key from the selection (as in B12).
- **Executor:** state-only actions (`adopt`, `forget`, `untrack`, `refresh`) run first. `move-local` with a changed R persists the move (old remote md5), then downloads inline. Remote folders for uploads are ensured in a pre-pass. **`trash-remote` re-verification** also `lstat`s the local key (skip if the file is back) and checks R's parent is unchanged. Every exclusive local write (incl. conflict copies) **fsyncs the parent directory** after the link, i.e. before the conflict's `update-remote`.
- **Uploads** record the *planned* local stat and `localMd5 = response md5` (a change during upload is re-detected next run, `changed-during-upload` warning). Duplicate-safe adoption compares name, md5 and `createdTime` within ±10 min.
- **Re-verification outcomes:** skips are warnings with code `skipped-changed`; execution-time `EEXIST` lands in `collisions`; `trash-local` of a vanished file is a skip; `trash-remote` of an already-trashed file is success.
- **Report:** `SyncReport` adds `pair`, `dryRun`, `aborted`, `notRun`; `unknown` is `{ path, reason? }[]`; no `releasable` (Phase B). Brake and `planId` mismatch return a report with `aborted`; root-check failures throw `SyncRootError` with the `repair-marker` hint.
- **Lock** is also taken by dry runs. An unreadable lock counts as busy until 60 s old. A stale lock is broken by renaming it to a unique name and re-reading it: if it is no longer the stale content (another process re-locked meanwhile) it is put back and the caller gets "busy", so two processes can never both hold the lock. The lock content carries `{ pid, startedAt, token }`; after acquiring, the holder reads it back and verifies it is its own, and release removes the file only if it still holds exactly that content.
- **`trashExec` is required** in `SyncServiceDeps`/`ExecutorDeps`: the app passes `defaultExec` (`/usr/bin/trash`), every test passes a fake (`refuseTrash` or a move-into-temp-dir), so no test can reach the real Trash by omission.
- **`createPair`** stores the resolved account **alias**; writes the marker before touching Drive and removes it if the Drive step fails. **`repair-marker`** also re-probes and stores `caseInsensitive`.
- **`sync_select`:** `remove` accepts any clean relative path; `add` canonicalises to the existing local key (else the Drive key) and skips already-selected folds.
- **`sync_scan`** lists local regular files (sorted), previews only for text MIME types without NUL bytes; `truncated` when either list exceeds `limit`.
- **Stale `*.marvin-part`** files (older than 1 h) are removed during applied runs, right after the local scan. Temp files are `.<uuid>.marvin-part`.
- **CLI** exit code 1 when the report has `aborted`, `failures` or `notRun`.
- **Audit:** sync-created folders use `create_folder`; one entry per applied action with `{ pair, path, remoteId }`; state-only actions are not audited; `sync_release` is in the union for Phase B. The E2E writes all of its audit entries (sync and file operations) to a temp file.
- Candidate cap 200 applies per list (`local`, `remote`).

## File map

| File | Status | Responsibility |
|---|---|---|
| `src/sync/types.ts` | create | Pair, SyncRecord, scans, Probe, Action, Note, Plan, SyncReport, `SYNC_FILE_FIELDS` |
| `src/sync/paths.ts` | create | key/foldKey, ignored/representable names, `validateRelPath`, containment (`absInside`, `prepareParent`) |
| `src/sync/errors.ts` | create | `SyncRootError`, `CollisionError`, `TargetChangedError`, `ChecksumMismatchError`, `LocalTrashError`, `isAbortError` |
| `src/audit/audit-log.ts` | modify | widen `AuditOp` with `sync_*` |
| `src/drive/drive-adapter.ts` | modify | `updateFile` gains optional `media` |
| `src/config/paths.ts` | modify | `syncDir` |
| `src/sync/pair-store.ts` | create | atomic load/save/list/remove, lock, marker, case probe, overlap check |
| `src/sync/local-scanner.ts` | create | `scanLocal` (incl. `blocking`), `probeOnDisk`, `md5File`, `hashLocal` |
| `src/sync/remote-scanner.ts` | create | `scanRemote` (BFS), `toRemoteEntry`, `childrenQuery` |
| `src/sync/remote-probe.ts` | create | `probeRecord(s)` |
| `src/sync/resolve.ts` | create | planner context, §6.1/§6.2 resolution, content state, `hashTargets` |
| `src/sync/plan-tracked.ts` | create | dispatch §6.3 + table B1–B14 |
| `src/sync/plan-untracked.ts` | create | table U0–U8, ambiguity, candidates |
| `src/sync/planner.ts` | create | `plan`, `brakeFor`, `computePlanId` |
| `src/sync/trash.ts` | create | `/usr/bin/trash -s` via injectable `ExecFn` |
| `src/sync/transfer.ts` | create | `placeExclusive`, `downloadReplace`, `moveLocal`, `uploadNew`, `updateContent` |
| `src/sync/executor.ts` | create | ordered execution, re-verification, isolation, persistence, audit |
| `src/sync/report.ts` | create | plan/outcomes → `SyncReport` |
| `src/sync/sync-service.ts` | create | createPair, listPairs, scan, select, run, removePair, repairMarker |
| `src/mcp/sync-tools.ts` | create | 6 MCP tools |
| `src/mcp/server.ts`, `src/app.ts` | modify | wire `SyncService`; `TOOL_NAMES` = 31 |
| `src/cli/sync-format.ts`, `src/cli/sync-commands.ts`, `src/cli/main.ts` | create/modify | `sync list`, `sync run`, `sync repair-marker` |
| `tests/e2e/sync.e2e.test.ts` | create | live E2E (temp local dir, temp Drive folder, redirected trash) |
| `README.md`, `docs/FEATURES.md`, `docs/CHANGELOG.md`, `package.json`, `package-lock.json`, `src/version.ts` | modify | docs + 0.3.0 |

---

## Chunk 1: Foundations (types, paths, errors, adapter media)

### Task 1: Sync types and path keys

**Files:**
- Create: `src/sync/types.ts`, `src/sync/paths.ts`
- Test: `src/sync/__tests__/paths.test.ts`

`types.ts` is the final shape used by every later task (Phase B fields included, unused). It has no runtime logic beyond constants, so it is covered through the modules that use it.

- [ ] **Step 1: Write the failing tests.**

`src/sync/__tests__/paths.test.ts`:

```ts
import { mkdir, mkdtemp, rm, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ValidationError } from '../../errors.js';
import {
  absInside,
  ancestorKeys,
  baseName,
  foldKey,
  isIgnoredName,
  isRepresentable,
  isUnder,
  parentKey,
  prepareParent,
  toKey,
  validateRelPath,
} from '../paths.js';

const NFD = 'şartname.pdf'.normalize('NFD');

describe('keys', () => {
  it('normalizes to NFC and folds case', () => {
    expect(toKey(`a/${NFD}`)).toBe('a/şartname.pdf');
    expect(foldKey('Report.PDF')).toBe('report.pdf');
    expect(foldKey(NFD)).toBe(foldKey('ŞARTNAME.pdf'));
  });

  it('folds like APFS: ß/SS, ligatures, long s and final sigma', () => {
    expect(foldKey('straße.pdf')).toBe(foldKey('STRASSE.pdf'));
    expect(foldKey('ﬀ.pdf')).toBe(foldKey('FF.pdf'));
    expect(foldKey('ﬅ.pdf')).toBe(foldKey('st.pdf'));
    expect(foldKey('ſ.pdf')).toBe(foldKey('s.pdf'));
    expect(foldKey('ΟΔΟΣ.pdf')).toBe(foldKey('οδος.pdf'));
    expect(foldKey('οδοσ.pdf')).toBe(foldKey('οδος.pdf'));
  });

  it('keeps Turkish dotless ı distinct like APFS (ılık ≠ ilik, ilik ≡ ILIK, İ ≡ i̇)', () => {
    expect(foldKey('ılık.pdf')).not.toBe(foldKey('ilik.pdf'));
    expect(foldKey('sıcak.pdf')).not.toBe(foldKey('sicak.pdf'));
    expect(foldKey('ilik.pdf')).toBe(foldKey('ILIK.pdf'));
    expect(foldKey('I')).toBe(foldKey('i'));
    expect(foldKey('İ')).toBe(foldKey('i\u0307'));
  });

  it('lists proper ancestors', () => {
    expect(ancestorKeys('a/b/c.pdf')).toEqual(['a', 'a/b']);
    expect(ancestorKeys('c.pdf')).toEqual([]);
  });

  it('splits parent and base names', () => {
    expect(parentKey('a/b/c.pdf')).toBe('a/b');
    expect(parentKey('c.pdf')).toBe('');
    expect(baseName('a/b/c.pdf')).toBe('c.pdf');
  });

  it('isUnder compares folded path prefixes', () => {
    expect(isUnder('A/b.pdf', 'a')).toBe(true);
    expect(isUnder('a', 'a')).toBe(true);
    expect(isUnder('ab/c', 'a')).toBe(false);
    expect(isUnder('x', '')).toBe(true);
  });
});

describe('names', () => {
  it('ignores dot-files and part files', () => {
    expect(isIgnoredName('.marvin-sync-x')).toBe(true);
    expect(isIgnoredName('a.pdf.1234.marvin-part')).toBe(true);
    expect(isIgnoredName('a.pdf')).toBe(false);
  });

  it('rejects unrepresentable Drive names', () => {
    expect(isRepresentable('a/b')).toBe(false);
    expect(isRepresentable('a\0b')).toBe(false);
    expect(isRepresentable('')).toBe(false);
    expect(isRepresentable('ş'.repeat(128))).toBe(false); // 256 bytes
    expect(isRepresentable('ş'.repeat(127))).toBe(true);
  });
});

describe('validateRelPath', () => {
  it('accepts clean relative paths and returns NFC', () => {
    expect(validateRelPath(`docs/${NFD}`)).toBe('docs/şartname.pdf');
  });

  it.each(['', '/abs', '~/x', '../x', 'a/../b', 'a//b', './a', 'a/'])('rejects %j', (p) => {
    expect(() => validateRelPath(p)).toThrow(ValidationError);
  });
});

describe('filesystem containment', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'sync-paths-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('absInside rejects traversal', () => {
    expect(absInside(root, 'a/b.pdf')).toBe(path.join(root, 'a', 'b.pdf'));
    expect(() => absInside(root, '../x')).toThrow(ValidationError);
  });

  it('prepareParent creates plain directories', async () => {
    const abs = await prepareParent(root, 'a/b/c.pdf');
    expect(abs).toBe(path.join(root, 'a', 'b', 'c.pdf'));
    expect((await stat(path.join(root, 'a', 'b'))).isDirectory()).toBe(true);
  });

  it('prepareParent refuses symlinked and file components', async () => {
    const outside = await mkdtemp(path.join(os.tmpdir(), 'sync-out-'));
    try {
      await symlink(outside, path.join(root, 'link'));
      await expect(prepareParent(root, 'link/x.pdf')).rejects.toThrow(ValidationError);
      await writeFile(path.join(root, 'file'), 'x');
      await expect(prepareParent(root, 'file/x.pdf')).rejects.toThrow(ValidationError);
      await mkdir(path.join(root, 'ok'));
      await expect(prepareParent(root, 'ok/x.pdf')).resolves.toBe(path.join(root, 'ok', 'x.pdf'));
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run and see it fail** — `npx vitest run src/sync/__tests__/paths.test.ts` → FAIL: `../paths.js` cannot be resolved.

- [ ] **Step 3: Implement.**

`src/sync/types.ts`:

```ts
import type { ExportFormat } from '../files/export-formats.js';

/** Pair names: lower-case letters, digits and dashes (spec §3). */
export const PAIR_NAME = /^[a-z0-9-]{1,40}$/;

/** Drive fields every sync read requests (spec §4). */
export const SYNC_FILE_FIELDS =
  'id, name, mimeType, md5Checksum, size, modifiedTime, createdTime, parents, trashed, capabilities(canEdit, canTrash, canAddChildren)';

export interface GoogleExportPrefs {
  document: ExportFormat;
  spreadsheet: ExportFormat;
  presentation: ExportFormat;
  drawing: ExportFormat;
}

/** Phase B uses these; Phase A stores the defaults unvalidated. */
export const DEFAULT_GOOGLE_EXPORT: GoogleExportPrefs = {
  document: 'docx',
  spreadsheet: 'xlsx',
  presentation: 'pptx',
  drawing: 'pdf',
};

export interface Pair {
  name: string;
  id: string;
  account: string;
  localDir: string;
  caseInsensitive: boolean;
  remoteFolderId: string;
  googleExport: GoogleExportPrefs;
  selection: string[];
  excluded: string[];
  remoteBaseline: string[];
  baselineFolders: string[];
  createdAt: string;
  lastAppliedRunAt: string | null;
  firstAppliedRunAt: string | null;
}

export interface SyncRecord {
  remoteId: string;
  path: string;
  localName: string;
  remoteName: string;
  remoteParentId: string;
  localMd5: string;
  localSize: number;
  localMtimeMs: number;
  localCtimeMs: number;
  remoteMd5: string | null;
  remoteSize: number | null;
  remoteModifiedTime: string;
  native: null | { mimeType: string; exportFormat: ExportFormat };
  remoteOnly: boolean;
  restorePending: boolean;
  remoteTrashed: boolean;
}

export interface PairFile {
  version: 1;
  pair: Pair;
  records: SyncRecord[];
}

/** A regular local file. `name` is the on-disk relative POSIX path; `key` its NFC form. */
export interface LocalEntry {
  key: string;
  foldKey: string;
  name: string;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  ino: number;
}

export interface LocalScan {
  entries: LocalEntry[];
  /** Keys of existing non-regular or ignored entries (dirs, symlinks, dot-files…). */
  occupied: string[];
  /** Keys of directories/entries that could not be read. */
  unknownSubtrees: string[];
  /** Keys that block everything below them: symlinks, special files, dot-named folders. */
  blocking: string[];
  /** `*.marvin-part` temp files (on-disk relative names). */
  partFiles: Array<{ name: string; mtimeMs: number }>;
}

/** `lstat` of a record key that has no exact scan match (spec §6.1 step 4). */
export interface OnDiskProbe {
  kind: 'file' | 'dir' | 'symlink' | 'other' | 'error';
  ino: number;
}

export interface RemoteEntry {
  id: string;
  key: string;
  foldKey: string;
  name: string;
  parentId: string;
  /** Folder ids from the parent up to the pair root (inclusive). */
  ancestorIds: string[];
  mimeType: string;
  md5: string | null;
  size: number | null;
  modifiedTime: string;
  createdTime: string;
  canEdit: boolean;
  canTrash: boolean;
}

export type RemoteIgnoreReason = 'native-skipped' | 'shortcut' | 'unrepresentable' | 'ignored-name';

export interface RemoteIgnored {
  id: string;
  /** Relative path when representable, else the raw name. */
  path: string;
  reason: RemoteIgnoreReason;
  isFolder: boolean;
}

export interface RemoteScan {
  entries: RemoteEntry[];
  ignored: RemoteIgnored[];
  /** Scanned folder id → key ('' for the pair root). */
  folders: Map<string, string>;
  unknownSubtrees: string[];
  unknownFolderIds: string[];
}

export type Probe =
  | { state: 'trashed' }
  | { state: 'present'; entry: RemoteEntry }
  | { state: 'moved-out' }
  | { state: 'unavailable' }
  | { state: 'unknown'; reason: string };

export type ActionKind =
  | 'upload-new'
  | 'update-remote'
  | 'download-new'
  | 'download-replace'
  | 'move-local'
  | 'conflict'
  | 'trash-remote'
  | 'trash-local'
  | 'adopt'
  | 'forget'
  | 'untrack'
  | 'refresh';

/** Selection/excluded edits applied only after the action succeeds (spec §6.3). */
export interface SelectionChange {
  add?: string[];
  remove?: string[];
  exclude?: string[];
}

export interface Action {
  kind: ActionKind;
  /** Spec rule that produced it (B3, U1…). */
  rule: string;
  /** Final key (record path after success). */
  key: string;
  record: SyncRecord | null;
  local: LocalEntry | null;
  localMd5: string | null;
  remote: RemoteEntry | null;
  selection: SelectionChange;
  /** move-local: rename in place (case-only change on a case-insensitive volume). */
  inPlace?: boolean;
  /** move-local: download R over the moved file afterwards (R changed too). */
  thenDownload?: boolean;
  /** conflict: also upload L over R (false when R is read-only). */
  updateRemote?: boolean;
  /** upload-new: replaces this trashed record (B11). */
  rebaseFrom?: string;
}

export type NoteCode =
  | 'unknown-state'
  | 'ambiguous'
  | 'collision'
  | 'conflict-rename'
  | 'moved-out'
  | 'moved-into-excluded'
  | 'remote-unavailable'
  | 'remote-readonly'
  | 'cannot-trash'
  | 'missing'
  | 'native-skipped'
  | 'unrepresentable'
  | 'weak-compare'
  | 'ignored';

export interface Note {
  code: NoteCode;
  path: string;
  rule: string;
  remoteId?: string;
  message?: string;
}

export interface Candidate {
  path: string;
  size: number | null;
  modifiedTime: string;
  remoteId?: string;
}

export interface BrakeInfo {
  tripped: boolean;
  trashRemote: number;
  trashLocal: number;
  tracked: number;
}

export interface Plan {
  planId: string;
  actions: Action[];
  notes: Note[];
  candidates: { local: Candidate[]; remote: Candidate[]; truncated: boolean };
  brake: BrakeInfo;
  /** What the first applied run stores as remoteBaseline / baselineFolders (spec §5 step 7). */
  baseline: { files: string[]; folders: string[] };
}

export interface ActionOutcome {
  kind: ActionKind;
  path: string;
  status: 'done' | 'skipped' | 'collision' | 'failed' | 'not-run';
  message?: string;
  conflictCopy?: string;
  /** e.g. `changed-during-upload`. */
  warning?: string;
}

export interface SyncReport {
  pair: string;
  dryRun: boolean;
  planId: string;
  aborted: null | { reason: 'plan-changed' | 'mass-delete'; message: string };
  actions: Partial<Record<ActionKind, string[]>>;
  conflicts: Array<{ path: string; conflictCopy?: string }>;
  collisions: string[];
  ambiguous: string[];
  unknown: Array<{ path: string; reason?: string }>;
  warnings: Array<{ path: string; code: string; message?: string }>;
  failures: Array<{ path: string; kind: ActionKind; message: string }>;
  notRun: string[];
  candidates: { local: Candidate[]; remote: Candidate[]; truncated: boolean };
}
```

`src/sync/paths.ts`:

```ts
import { lstat, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { ValidationError, hasErrorCode } from '../errors.js';

export const PART_SUFFIX = '.marvin-part';
const MAX_SEGMENT_BYTES = 255;

/** NFC key of a relative path (POSIX separators). */
export function toKey(relPath: string): string {
  return relPath.split(path.sep).join('/').normalize('NFC');
}

/**
 * NFC + case fold matching APFS (spec §3): per-character upper-casing first folds ß/SS,
 * ligatures (ﬀ, ﬅ), long s and final sigma; Turkish dotless ı stays distinct from i
 * (APFS keeps `ılık` ≠ `ilik` while `ilik` ≡ `ILIK`).
 */
export function foldKey(key: string): string {
  return Array.from(key.normalize('NFC'))
    .map((c) => (c === 'ı' ? c : c.toUpperCase()))
    .join('')
    .toLowerCase()
    .normalize('NFC');
}

/** Proper ancestor keys of `key`, shortest first (`a/b/c` → `a`, `a/b`). */
export function ancestorKeys(key: string): string[] {
  const segments = key.split('/');
  return segments.slice(1).map((_, i) => segments.slice(0, i + 1).join('/'));
}

/** Dot-files (incl. the marker) and our own temp files are never synced (spec §6.10). */
export function isIgnoredName(name: string): boolean {
  return name.startsWith('.') || name.endsWith(PART_SUFFIX);
}

/** A Drive name that cannot be a single local path segment (spec §3). */
export function isRepresentable(name: string): boolean {
  return (
    name !== '' &&
    !name.includes('/') &&
    !name.includes('\0') &&
    Buffer.byteLength(name.normalize('NFC')) <= MAX_SEGMENT_BYTES
  );
}

/** Validates a user-supplied relative path and returns its key. */
export function validateRelPath(input: string): string {
  if (input === '' || input.includes('\0')) throw new ValidationError('Path must not be empty');
  if (path.posix.isAbsolute(input) || input.startsWith('~')) {
    throw new ValidationError(`"${input}" must be relative to the pair folder`);
  }
  const segments = input.split('/');
  for (const seg of segments) {
    if (seg === '' || seg === '.' || seg === '..') {
      throw new ValidationError(`"${input}" is not a clean relative path`);
    }
    if (Buffer.byteLength(seg.normalize('NFC')) > MAX_SEGMENT_BYTES) {
      throw new ValidationError(`"${input}" has a name longer than 255 bytes`);
    }
  }
  return input.normalize('NFC');
}

/** True when `key` equals `prefix` or lies below it (compared by foldKey). */
export function isUnder(key: string, prefix: string): boolean {
  if (prefix === '') return true;
  const k = foldKey(key);
  const p = foldKey(prefix);
  return k === p || k.startsWith(`${p}/`);
}

export function parentKey(key: string): string {
  const i = key.lastIndexOf('/');
  return i === -1 ? '' : key.slice(0, i);
}

export function baseName(key: string): string {
  return key.slice(key.lastIndexOf('/') + 1);
}

/** Absolute path of a relative name inside `root`; throws on traversal. */
export function absInside(root: string, rel: string): string {
  const abs = path.resolve(root, ...rel.split('/'));
  const back = path.relative(root, abs);
  if (back === '' || back.startsWith('..') || path.isAbsolute(back)) {
    throw new ValidationError(`Refusing to touch a path outside the pair folder: ${rel}`);
  }
  return abs;
}

/**
 * Creates the parent directories of `rel` inside `root`, refusing symlinked or
 * non-directory components, and returns the absolute path of `rel`.
 */
export async function prepareParent(root: string, rel: string): Promise<string> {
  const abs = absInside(root, rel);
  const segments = rel.split('/').slice(0, -1);
  let current = root;
  for (const seg of segments) {
    current = path.join(current, seg);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink() || !info.isDirectory()) {
        throw new ValidationError(`Refusing to write through ${current} (not a plain directory)`);
      }
    } catch (err) {
      if (!hasErrorCode(err, 'ENOENT')) throw err;
      await mkdir(current);
    }
  }
  return abs;
}
```

- [ ] **Step 4: Run and see it pass** — `npx vitest run src/sync/__tests__/paths.test.ts` → PASS.

- [ ] **Step 5: Quality gate** — `npx prettier --write src/sync` then `npm run check` → typecheck, eslint (0 warnings), prettier and all tests green.

- [ ] **Step 6: Commit** —

```bash
git add src/sync
git commit -m "feat(sync): types, NFC/fold keys and path containment" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 2: Sync errors, audit ops, Drive update with media, sync config dir

**Files:**
- Create: `src/sync/errors.ts`
- Modify: `src/audit/audit-log.ts`, `src/drive/drive-adapter.ts`, `src/config/paths.ts`, `src/config/__tests__/paths.test.ts`
- Test: `src/sync/__tests__/errors.test.ts`

- [ ] **Step 1: Write the failing tests.**

`src/sync/__tests__/errors.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  ApiDisabledError,
  NotFoundError,
  QuotaExceededError,
  RateLimitError,
  ReauthRequiredError,
} from '../../errors.js';
import { ChecksumMismatchError, CollisionError, isAbortError } from '../errors.js';

describe('sync errors', () => {
  it('formats collision and checksum messages', () => {
    expect(new CollisionError('/x/a.pdf').message).toBe(
      '/x/a.pdf already exists; nothing was overwritten',
    );
    expect(new ChecksumMismatchError('a.pdf', 'aa', 'bb').message).toBe(
      'a.pdf: expected md5 aa, got bb',
    );
  });

  it('classifies run-aborting errors', () => {
    expect(isAbortError(new ReauthRequiredError('emco'))).toBe(true);
    expect(isAbortError(new QuotaExceededError('emco'))).toBe(true);
    expect(isAbortError(new ApiDisabledError('drive'))).toBe(true);
    expect(isAbortError(new RateLimitError())).toBe(true);
    expect(isAbortError(new NotFoundError('x'))).toBe(false);
    expect(isAbortError(new Error('x'))).toBe(false);
  });
});
```

In `src/config/__tests__/paths.test.ts`, add `syncDir` to the expected object of the first test (after `audit`):

```ts
      syncDir: path.join(dir, 'sync'),
```

and in the `'honours MARVIN_DRIVE_CONFIG_DIR'` test, after the `accounts` assertion:

```ts
    expect(p.syncDir).toBe('/tmp/x/sync');
```

- [ ] **Step 2: Run and see it fail** — `npx vitest run src/sync/__tests__/errors.test.ts src/config` → FAIL: `../errors.js` cannot be resolved; the paths tests fail because `syncDir` is missing.

- [ ] **Step 3: Implement.**

`src/sync/errors.ts`:

```ts
import {
  ApiDisabledError,
  AppError,
  QuotaExceededError,
  RateLimitError,
  ReauthRequiredError,
} from '../errors.js';

/** A root check failed (spec §5 step 2); the whole run is aborted. */
export class SyncRootError extends AppError {
  readonly code = 'SYNC_ROOT_CHECK';
}

/** An exclusive local write found its target taken (spec §7). */
export class CollisionError extends AppError {
  readonly code = 'SYNC_COLLISION';

  constructor(readonly target: string) {
    super(`${target} already exists; nothing was overwritten`);
  }
}

/** A re-verification found the file changed since planning; the action is skipped. */
export class TargetChangedError extends AppError {
  readonly code = 'SYNC_TARGET_CHANGED';
}

export class ChecksumMismatchError extends AppError {
  readonly code = 'SYNC_CHECKSUM_MISMATCH';

  constructor(what: string, expected: string, actual: string) {
    super(`${what}: expected md5 ${expected}, got ${actual}`);
  }
}

export class LocalTrashError extends AppError {
  readonly code = 'SYNC_LOCAL_TRASH';
}

/** Errors that stop the whole run; remaining actions are reported `not-run` (spec §7). */
export function isAbortError(err: unknown): boolean {
  return (
    err instanceof ReauthRequiredError ||
    err instanceof QuotaExceededError ||
    err instanceof ApiDisabledError ||
    err instanceof RateLimitError
  );
}
```

`src/config/paths.ts` — add `syncDir: string;` to `Paths` (after `audit`), and in `resolvePaths` after the `audit` line:

```ts
    syncDir: path.join(configDir, 'sync'),
```

`src/audit/audit-log.ts` — replace the last member `| 'slides_batch_update';` of `AuditOp` with:

```ts
  | 'slides_batch_update'
  | 'sync_upload'
  | 'sync_update'
  | 'sync_download'
  | 'sync_move_local'
  | 'sync_conflict'
  | 'sync_trash_remote'
  | 'sync_trash_local'
  | 'sync_release';
```

`src/drive/drive-adapter.ts` — the spec §4 change. In the `DriveAdapter` interface, `updateFile` params gain (after `requestBody?`):

```ts
    /** New content for the same fileId (Drive keeps the previous revision). */
    media?: { mimeType: string; body: Readable };
```

and in `createDriveAdapter` pass it through:

```ts
    async updateFile({ fileId, requestBody, media, addParents, removeParents, fields }) {
      const res = await drive.files.update({
        fileId,
        requestBody,
        media,
        addParents,
        removeParents,
        fields,
        ...allDrives,
      });
      return res.data;
    },
```

(The adapter is a thin googleapis passthrough; `media` is exercised by `transfer.updateContent` tests with a fake Drive in Task 11 and live by the E2E in Task 17.)

- [ ] **Step 4: Run and see it pass** — `npx vitest run src/sync src/config` → PASS.

- [ ] **Step 5: Quality gate** — `npx prettier --write src/sync src/audit src/drive src/config` then `npm run check` → typecheck, eslint (0 warnings), prettier and all tests green.

- [ ] **Step 6: Commit** —

```bash
git add src/sync src/audit src/drive src/config
git commit -m "feat(sync): sync errors, audit ops, Drive content update and sync config dir" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

## Chunk 2: Pair store and local scanner

### Task 3: Pair store: atomic files, lock, marker, case probe, overlap

**Files:**
- Create: `src/sync/pair-store.ts`, `src/sync/__tests__/fixtures.ts`
- Test: `src/sync/__tests__/pair-store.test.ts`

`fixtures.ts` is a shared test helper (pairs, records and scan entries that are mutually "in sync": same md5 `md5-<remoteId>`, stat `10/1000/1000`); create it first — the test imports it.

`src/sync/__tests__/fixtures.ts`:

```ts
import type { LocalEntry, Pair, PairFile, RemoteEntry, SyncRecord } from '../types.js';
import { DEFAULT_GOOGLE_EXPORT } from '../types.js';
import { foldKey } from '../paths.js';

/** trashExec for tests that must never trash anything. */
export const refuseTrash = async (): Promise<never> => {
  throw new Error('unexpected local trash in this test');
};

export const ROOT_ID = 'root-folder';

export function makePair(overrides: Partial<Pair> = {}): Pair {
  return {
    name: 'docs',
    id: 'pair-id-1',
    account: 'emco',
    localDir: '/tmp/sync-docs',
    caseInsensitive: true,
    remoteFolderId: ROOT_ID,
    googleExport: { ...DEFAULT_GOOGLE_EXPORT },
    selection: [],
    excluded: [],
    remoteBaseline: [],
    baselineFolders: [],
    createdAt: '2026-11-01T00:00:00.000Z',
    lastAppliedRunAt: '2026-11-02T00:00:00.000Z',
    firstAppliedRunAt: '2026-11-02T00:00:00.000Z',
    ...overrides,
  };
}

export function makePairFile(pair: Partial<Pair> = {}, records: SyncRecord[] = []): PairFile {
  return { version: 1, pair: makePair(pair), records };
}

export function localEntry(name: string, overrides: Partial<LocalEntry> = {}): LocalEntry {
  const key = name.normalize('NFC');
  return {
    key,
    foldKey: foldKey(key),
    name,
    size: 10,
    mtimeMs: 1000,
    ctimeMs: 1000,
    ino: 1,
    ...overrides,
  };
}

export function remoteEntry(
  id: string,
  key: string,
  overrides: Partial<RemoteEntry> = {},
): RemoteEntry {
  const nfc = key.normalize('NFC');
  const slash = nfc.lastIndexOf('/');
  return {
    id,
    key: nfc,
    foldKey: foldKey(nfc),
    name: key.slice(key.lastIndexOf('/') + 1),
    parentId: slash === -1 ? ROOT_ID : `folder:${nfc.slice(0, slash)}`,
    ancestorIds: slash === -1 ? [ROOT_ID] : [`folder:${nfc.slice(0, slash)}`, ROOT_ID],
    mimeType: 'application/pdf',
    md5: `md5-${id}`,
    size: 10,
    modifiedTime: '2026-11-02T00:00:00.000Z',
    createdTime: '2026-11-01T00:00:00.000Z',
    canEdit: true,
    canTrash: true,
    ...overrides,
  };
}

/** A record in sync with `localEntry(key)` and `remoteEntry(remoteId, key)`. */
export function record(
  remoteId: string,
  key: string,
  overrides: Partial<SyncRecord> = {},
): SyncRecord {
  const nfc = key.normalize('NFC');
  const slash = nfc.lastIndexOf('/');
  return {
    remoteId,
    path: nfc,
    localName: key,
    remoteName: key.slice(key.lastIndexOf('/') + 1),
    remoteParentId: slash === -1 ? ROOT_ID : `folder:${nfc.slice(0, slash)}`,
    localMd5: `md5-${remoteId}`,
    localSize: 10,
    localMtimeMs: 1000,
    localCtimeMs: 1000,
    remoteMd5: `md5-${remoteId}`,
    remoteSize: 10,
    remoteModifiedTime: '2026-11-02T00:00:00.000Z',
    native: null,
    remoteOnly: false,
    restorePending: false,
    remoteTrashed: false,
    ...overrides,
  };
}
```

- [ ] **Step 1: Write the failing tests.**

`src/sync/__tests__/pair-store.test.ts`:

```ts
import { writeFileSync } from 'node:fs';
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  utimes,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ValidationError } from '../../errors.js';
import { silentLogger } from '../../files/__tests__/fakes.js';
import {
  PairStore,
  checkOverlap,
  markerName,
  probeCaseInsensitive,
  readMarker,
  removeMarker,
  writeMarker,
} from '../pair-store.js';
import { makePair, makePairFile, record } from './fixtures.js';

let tmp: string;
let dir: string;

beforeEach(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), 'sync-store-'));
  dir = path.join(tmp, 'sync');
});
afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

function store(isAlive: (pid: number) => boolean = () => true): PairStore {
  return new PairStore({ dir, isAlive, logger: silentLogger() });
}

describe('PairStore', () => {
  it('saves atomically with 0600 file and 0700 dir, and loads it back', async () => {
    const s = store();
    const data = makePairFile({}, [record('r1', 'a.pdf')]);
    await s.save(data);
    expect((await stat(dir)).mode & 0o777).toBe(0o700);
    expect((await stat(path.join(dir, 'docs.json'))).mode & 0o777).toBe(0o600);
    expect(await s.load('docs')).toEqual(data);
    expect(await s.exists('docs')).toBe(true);
    expect((await s.list()).map((p) => p.pair.name)).toEqual(['docs']);
    await s.save({ ...data, records: [] });
    expect((await s.load('docs')).records).toEqual([]);
  });

  it('reports a missing pair, invalid JSON and invalid content', async () => {
    const s = store();
    await expect(s.load('nope')).rejects.toThrow('No sync pair named "nope"');
    await s.save(makePairFile());
    await writeFile(path.join(dir, 'docs.json'), '{');
    await expect(s.load('docs')).rejects.toThrow('not valid JSON');
    await writeFile(path.join(dir, 'docs.json'), JSON.stringify({ version: 2 }));
    await expect(s.load('docs')).rejects.toThrow('is invalid');
  });

  it('rejects invalid pair names', async () => {
    await expect(store().load('../x')).rejects.toThrow(ValidationError);
  });

  it('lists nothing when the dir is missing and removes pairs', async () => {
    const s = store();
    expect(await s.list()).toEqual([]);
    await s.save(makePairFile());
    await s.remove('docs');
    expect(await s.exists('docs')).toBe(false);
  });

  it('locks exclusively and releases', async () => {
    const s = store();
    const release = await s.lock('docs');
    const held = JSON.parse(await readFile(path.join(dir, 'docs.lock'), 'utf8')) as {
      pid: number;
    };
    expect(held.pid).toBe(process.pid);
    await expect(s.lock('docs')).rejects.toThrow('sync is busy for docs');
    await release();
    await expect(s.withLock('docs', async () => 42)).resolves.toBe(42);
    await expect(lstat(path.join(dir, 'docs.lock'))).rejects.toThrow();
  });

  it('breaks a lock held by a dead process with a warning', async () => {
    const logger = silentLogger();
    const s = new PairStore({ dir, isAlive: () => false, logger });
    await s.lock('docs');
    const release = await s.lock('docs');
    expect(logger.warn).toHaveBeenCalledWith('Breaking a stale sync lock', { name: 'docs' });
    await release();
  });

  it('does not steal a fresh lock taken while it was breaking a stale one', async () => {
    const lockFile = path.join(dir, 'docs.lock');
    const fresh = JSON.stringify({ pid: 4242, startedAt: 'now' });
    const racing = new PairStore({
      dir,
      logger: silentLogger(),
      isAlive: () => {
        writeFileSync(lockFile, fresh); // another process broke the stale lock and re-locked
        return false;
      },
    });
    await mkdir(dir, { recursive: true });
    await writeFile(lockFile, JSON.stringify({ pid: 1, startedAt: 'old' }));
    await expect(racing.lock('docs')).rejects.toThrow('sync is busy for docs');
    expect(await readFile(lockFile, 'utf8')).toBe(fresh);
    expect((await readdir(dir)).filter((n) => n.endsWith('.stale'))).toEqual([]);
  });

  it('releases only its own lock (pid + token)', async () => {
    const s = store();
    const lockFile = path.join(dir, 'docs.lock');
    const release = await s.lock('docs');
    expect(JSON.parse(await readFile(lockFile, 'utf8'))).toMatchObject({
      pid: process.pid,
      token: expect.any(String),
    });
    const foreign = JSON.stringify({ pid: 4242, startedAt: 'x', token: 'theirs' });
    await writeFile(lockFile, foreign);
    await release();
    expect(await readFile(lockFile, 'utf8')).toBe(foreign);
  });

  it('treats an unreadable lock as busy until it is a minute old', async () => {
    const s = store();
    await s.save(makePairFile());
    const lockFile = path.join(dir, 'docs.lock');
    await writeFile(lockFile, '');
    await expect(s.lock('docs')).rejects.toThrow('busy');
    const old = new Date(Date.now() - 120_000);
    await utimes(lockFile, old, old);
    const release = await s.lock('docs');
    await release();
  });
});

describe('marker', () => {
  it('writes, reads and removes the marker', async () => {
    expect(await readMarker(tmp, 'docs')).toBeNull();
    await writeMarker(tmp, 'docs', 'pair-id-1');
    expect(await readFile(path.join(tmp, markerName('docs')), 'utf8')).toBe('pair-id-1\n');
    expect(await readMarker(tmp, 'docs')).toBe('pair-id-1');
    await removeMarker(tmp, 'docs');
    expect(await readMarker(tmp, 'docs')).toBeNull();
  });

  it('probes case sensitivity read-only via the flipped marker name', async () => {
    await writeMarker(tmp, 'docs', 'id');
    let expected: boolean;
    try {
      await lstat(path.join(tmp, '.MARVIN-SYNC-DOCS'));
      expected = true;
    } catch {
      expected = false;
    }
    expect(await probeCaseInsensitive(tmp, 'docs')).toBe(expected);
  });
});

describe('checkOverlap', () => {
  const existing = [makePair({ name: 'a', localDir: '/Users/x/Docs', remoteFolderId: 'F1' })];

  it('rejects duplicate names, nested local folders and a reused Drive folder', () => {
    const base = { localDir: '/Users/x/Other', remoteFolderId: 'F2' };
    expect(() => checkOverlap(existing, { ...base, name: 'a' })).toThrow('already exists');
    expect(() => checkOverlap(existing, { ...base, name: 'b', localDir: '/Users/x/Docs' })).toThrow(
      'overlaps',
    );
    expect(() =>
      checkOverlap(existing, { ...base, name: 'b', localDir: '/Users/x/docs/sub' }),
    ).toThrow('overlaps');
    expect(() => checkOverlap(existing, { ...base, name: 'b', localDir: '/Users/x' })).toThrow(
      'overlaps',
    );
    expect(() => checkOverlap(existing, { ...base, name: 'b', remoteFolderId: 'F1' })).toThrow(
      'already used',
    );
    expect(() => checkOverlap(existing, { ...base, name: 'b' })).not.toThrow();
    expect(() =>
      checkOverlap(existing, { ...base, name: 'b', localDir: '/Users/x/Docs2' }),
    ).not.toThrow();
  });
});
```

- [ ] **Step 2: Run and see it fail** — `npx vitest run src/sync/__tests__/pair-store.test.ts` → FAIL: `../pair-store.js` cannot be resolved.

- [ ] **Step 3: Implement.**

`src/sync/pair-store.ts`:

```ts
import { randomUUID } from 'node:crypto';
import { link, lstat, mkdir, open, readFile, readdir, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { ValidationError, hasErrorCode } from '../errors.js';
import { EXPORT_FORMATS } from '../files/export-formats.js';
import { logger as defaultLogger, type Logger } from '../logger.js';
import { PAIR_NAME, type Pair, type PairFile } from './types.js';

const exportFormat = z.enum(EXPORT_FORMATS);

const pairSchema = z.object({
  name: z.string().regex(PAIR_NAME),
  id: z.string().min(1),
  account: z.string().min(1),
  localDir: z.string().min(1),
  caseInsensitive: z.boolean(),
  remoteFolderId: z.string().min(1),
  googleExport: z.object({
    document: exportFormat,
    spreadsheet: exportFormat,
    presentation: exportFormat,
    drawing: exportFormat,
  }),
  selection: z.array(z.string()),
  excluded: z.array(z.string()),
  remoteBaseline: z.array(z.string()),
  baselineFolders: z.array(z.string()),
  createdAt: z.string(),
  lastAppliedRunAt: z.string().nullable(),
  firstAppliedRunAt: z.string().nullable(),
});

const recordSchema = z.object({
  remoteId: z.string().min(1),
  path: z.string().min(1),
  localName: z.string().min(1),
  remoteName: z.string(),
  remoteParentId: z.string(),
  localMd5: z.string(),
  localSize: z.number(),
  localMtimeMs: z.number(),
  localCtimeMs: z.number(),
  remoteMd5: z.string().nullable(),
  remoteSize: z.number().nullable(),
  remoteModifiedTime: z.string(),
  native: z.object({ mimeType: z.string(), exportFormat }).nullable(),
  remoteOnly: z.boolean(),
  restorePending: z.boolean(),
  remoteTrashed: z.boolean(),
});

const pairFileSchema = z.object({
  version: z.literal(1),
  pair: pairSchema,
  records: z.array(recordSchema),
});

const STALE_UNREADABLE_LOCK_MS = 60_000;

export interface PairStoreOptions {
  dir: string;
  isAlive?: (pid: number) => boolean;
  now?: () => Date;
  logger?: Logger;
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return hasErrorCode(err, 'EPERM');
  }
}

/** Pair files under `<configDir>/sync` (spec §3, §10): atomic writes, 0600 files, 0700 dir. */
export class PairStore {
  private readonly isAlive: (pid: number) => boolean;
  private readonly now: () => Date;
  private readonly log: Logger;

  constructor(private readonly opts: PairStoreOptions) {
    this.isAlive = opts.isAlive ?? processAlive;
    this.now = opts.now ?? ((): Date => new Date());
    this.log = opts.logger ?? defaultLogger;
  }

  get dir(): string {
    return this.opts.dir;
  }

  private file(name: string): string {
    if (!PAIR_NAME.test(name)) {
      throw new ValidationError(`Invalid pair name "${name}" (use a-z, 0-9 and -, max 40)`);
    }
    return path.join(this.opts.dir, `${name}.json`);
  }

  private async ensureDir(): Promise<void> {
    await mkdir(this.opts.dir, { recursive: true, mode: 0o700 });
  }

  async exists(name: string): Promise<boolean> {
    try {
      await stat(this.file(name));
      return true;
    } catch (err) {
      if (hasErrorCode(err, 'ENOENT')) return false;
      throw err;
    }
  }

  async load(name: string): Promise<PairFile> {
    let text: string;
    try {
      text = await readFile(this.file(name), 'utf8');
    } catch (err) {
      if (hasErrorCode(err, 'ENOENT')) {
        throw new ValidationError(`No sync pair named "${name}". List pairs with sync_list_pairs.`);
      }
      throw err;
    }
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch (err) {
      throw new ValidationError(`Sync pair file for "${name}" is not valid JSON`, { cause: err });
    }
    const parsed = pairFileSchema.safeParse(json);
    if (!parsed.success) {
      throw new ValidationError(`Sync pair file for "${name}" is invalid: ${parsed.error.message}`);
    }
    return parsed.data;
  }

  async list(): Promise<PairFile[]> {
    let names: string[];
    try {
      names = await readdir(this.opts.dir);
    } catch (err) {
      if (hasErrorCode(err, 'ENOENT')) return [];
      throw err;
    }
    const pairs = names
      .filter((n) => n.endsWith('.json'))
      .map((n) => n.slice(0, -'.json'.length))
      .filter((n) => PAIR_NAME.test(n))
      .sort();
    return Promise.all(pairs.map((n) => this.load(n)));
  }

  /** Atomic: temp file (0600, fsynced) + rename. */
  async save(data: PairFile): Promise<void> {
    await this.ensureDir();
    const target = this.file(data.pair.name);
    const tmp = path.join(this.opts.dir, `.${data.pair.name}.${randomUUID()}.tmp`);
    const handle = await open(tmp, 'wx', 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(data, null, 2)}\n`);
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await rename(tmp, target);
    } catch (err) {
      await rm(tmp, { force: true });
      throw err;
    }
  }

  async remove(name: string): Promise<void> {
    await rm(this.file(name), { force: true });
  }

  /**
   * `<name>.lock` via O_EXCL with `{ pid, startedAt }`; returns the release function.
   * A stale lock is moved aside under a unique name and re-checked, so two processes
   * breaking the same stale lock cannot both end up holding it.
   */
  async lock(name: string): Promise<() => Promise<void>> {
    await this.ensureDir();
    this.file(name); // validates the name
    const lockFile = path.join(this.opts.dir, `${name}.lock`);
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const content = JSON.stringify({
          pid: process.pid,
          startedAt: this.now().toISOString(),
          token: randomUUID(),
        });
        const handle = await open(lockFile, 'wx', 0o600);
        try {
          await handle.writeFile(content);
        } finally {
          await handle.close();
        }
        if (!(await this.holds(lockFile, content))) {
          throw new ValidationError(`sync is busy for ${name}`);
        }
        return async () => {
          // Release only our own lock (a stale-lock breaker may have replaced it).
          if (await this.holds(lockFile, content)) await rm(lockFile, { force: true });
          else this.log.warn('Sync lock was taken over; not removing it', { name });
        };
      } catch (err) {
        if (!hasErrorCode(err, 'EEXIST')) throw err;
        const raw = await readFile(lockFile, 'utf8').catch((readErr: unknown) => {
          if (hasErrorCode(readErr, 'ENOENT')) return null;
          throw readErr;
        });
        if (raw === null) continue; // released meanwhile
        if (!(await this.isStale(lockFile, raw)) || !(await this.breakStale(lockFile, raw))) {
          throw new ValidationError(`sync is busy for ${name}`);
        }
        this.log.warn('Breaking a stale sync lock', { name });
      }
    }
    throw new ValidationError(`sync is busy for ${name}`);
  }

  async withLock<T>(name: string, fn: () => Promise<T>): Promise<T> {
    const release = await this.lock(name);
    try {
      return await fn();
    } finally {
      await release();
    }
  }

  private async holds(lockFile: string, content: string): Promise<boolean> {
    try {
      return (await readFile(lockFile, 'utf8')) === content;
    } catch (err) {
      if (hasErrorCode(err, 'ENOENT')) return false;
      throw err;
    }
  }

  private async isStale(lockFile: string, raw: string): Promise<boolean> {
    try {
      const holder = JSON.parse(raw) as { pid?: unknown };
      if (typeof holder.pid === 'number') return !this.isAlive(holder.pid);
    } catch {
      // partial or corrupt content: decided by age below
    }
    // Unreadable/partial lock: stale only once it is old (a writer may be mid-create).
    try {
      const info = await stat(lockFile);
      return this.now().getTime() - info.mtimeMs > STALE_UNREADABLE_LOCK_MS;
    } catch (err) {
      if (hasErrorCode(err, 'ENOENT')) return true;
      throw err;
    }
  }

  /** Moves the stale lock aside; false (and restored) if it was replaced by a fresh one. */
  private async breakStale(lockFile: string, raw: string): Promise<boolean> {
    const aside = `${lockFile}.${randomUUID()}.stale`;
    try {
      await rename(lockFile, aside);
    } catch (err) {
      if (hasErrorCode(err, 'ENOENT')) return true; // someone else broke it; retry O_EXCL
      throw err;
    }
    try {
      if ((await readFile(aside, 'utf8')) === raw) return true;
      // A fresh lock was taken after our staleness check: put it back untouched.
      await link(aside, lockFile).catch((err: unknown) => {
        if (!hasErrorCode(err, 'EEXIST')) throw err;
      });
      return false;
    } finally {
      await rm(aside, { force: true });
    }
  }
}

export function markerName(name: string): string {
  return `.marvin-sync-${name}`;
}

/** Writes `<localDir>/.marvin-sync-<name>` containing the pair id (atomic). */
export async function writeMarker(localDir: string, name: string, id: string): Promise<void> {
  const target = path.join(localDir, markerName(name));
  const tmp = `${target}.${randomUUID()}.marvin-part`;
  const handle = await open(tmp, 'wx', 0o644);
  try {
    await handle.writeFile(`${id}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(tmp, target);
}

/** The marker's pair id, or null when it is missing. */
export async function readMarker(localDir: string, name: string): Promise<string | null> {
  try {
    return (await readFile(path.join(localDir, markerName(name)), 'utf8')).trim();
  } catch (err) {
    if (hasErrorCode(err, 'ENOENT') || hasErrorCode(err, 'ENOTDIR')) return null;
    throw err;
  }
}

export async function removeMarker(localDir: string, name: string): Promise<void> {
  await rm(path.join(localDir, markerName(name)), { force: true });
}

/** Read-only probe: does the case-flipped marker name resolve to the marker? (spec §3) */
export async function probeCaseInsensitive(localDir: string, name: string): Promise<boolean> {
  try {
    await lstat(path.join(localDir, markerName(name).toUpperCase()));
    return true;
  } catch (err) {
    if (hasErrorCode(err, 'ENOENT')) return false;
    throw err;
  }
}

function contains(parent: string, child: string): boolean {
  const rel = path.relative(parent.toLowerCase(), child.toLowerCase());
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

/** Rejects a new pair whose name exists or whose folders overlap an existing pair (spec §8). */
export function checkOverlap(
  existing: readonly Pair[],
  candidate: Pick<Pair, 'name' | 'localDir' | 'remoteFolderId'>,
): void {
  for (const p of existing) {
    if (p.name === candidate.name) {
      throw new ValidationError(`A sync pair named "${candidate.name}" already exists`);
    }
    if (contains(p.localDir, candidate.localDir) || contains(candidate.localDir, p.localDir)) {
      throw new ValidationError(
        `${candidate.localDir} overlaps the folder of pair "${p.name}" (${p.localDir})`,
      );
    }
    if (p.remoteFolderId === candidate.remoteFolderId) {
      throw new ValidationError(
        `Drive folder ${p.remoteFolderId} is already used by pair "${p.name}"`,
      );
    }
  }
}
```

- [ ] **Step 4: Run and see it pass** — `npx vitest run src/sync/__tests__/pair-store.test.ts` → PASS.

- [ ] **Step 5: Quality gate** — `npx prettier --write src/sync` then `npm run check` → typecheck, eslint (0 warnings), prettier and all tests green.

- [ ] **Step 6: Commit** —

```bash
git add src/sync
git commit -m "feat(sync): pair store with atomic writes, lock, marker and overlap check" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 4: Local scanner and hashing

**Files:**
- Create: `src/sync/local-scanner.ts`
- Test: `src/sync/__tests__/local-scanner.test.ts`

The scan never follows symlinks (`lstat` on every entry) and records symlinks, special files and dot-named folders as `blocking`. `probeOnDisk` is the service-side `lstat` of record keys without an exact scan match (it does follow a symlinked parent — that is the point: such a key is not absent). The unreadable-directory test is skipped when running as root.

- [ ] **Step 1: Write the failing tests.**

`src/sync/__tests__/local-scanner.test.ts`:

```ts
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { hashLocal, md5File, probeOnDisk, scanLocal } from '../local-scanner.js';

const NFD = 'şartname.pdf'.normalize('NFD');
const isRoot = process.getuid?.() === 0;
let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'sync-local-'));
});
afterEach(async () => {
  await chmod(path.join(root, 'locked'), 0o755).catch(() => undefined);
  await rm(root, { recursive: true, force: true });
});

describe('scanLocal', () => {
  it('lists regular files with NFC keys and on-disk names', async () => {
    await mkdir(path.join(root, 'sub'));
    await writeFile(path.join(root, 'sub', NFD), 'pdf');
    await writeFile(path.join(root, 'a.txt'), 'hello');
    const scan = await scanLocal(root);
    expect(scan.entries.map((e) => [e.key, e.name, e.foldKey, e.size])).toEqual([
      ['a.txt', 'a.txt', 'a.txt', 5],
      ['sub/şartname.pdf', `sub/${NFD}`, 'sub/şartname.pdf', 3],
    ]);
    expect(scan.entries[0]?.ino).toBeGreaterThan(0);
    expect(scan.occupied).toEqual(['sub']);
  });

  it('records ignored and non-regular entries as occupied and collects part files', async () => {
    await writeFile(path.join(root, '.marvin-sync-docs'), 'id');
    await writeFile(path.join(root, 'x.pdf.ab12.marvin-part'), 'partial');
    await symlink('/etc/hosts', path.join(root, 'link.pdf'));
    await mkdir(path.join(root, '.git'));
    await writeFile(path.join(root, '.git', 'config'), 'x');
    const scan = await scanLocal(root);
    expect(scan.entries).toEqual([]);
    expect(scan.occupied.sort()).toEqual(
      ['.git', '.marvin-sync-docs', 'link.pdf', 'x.pdf.ab12.marvin-part'].sort(),
    );
    expect(scan.partFiles.map((p) => p.name)).toEqual(['x.pdf.ab12.marvin-part']);
    expect(scan.blocking.sort()).toEqual(['.git', 'link.pdf']);
  });

  it('marks symlinked folders as blocking without following them', async () => {
    const outside = await mkdtemp(path.join(os.tmpdir(), 'sync-ext-'));
    try {
      await writeFile(path.join(outside, 'x.pdf'), 'x');
      await symlink(outside, path.join(root, 'a'));
      const scan = await scanLocal(root);
      expect(scan.entries).toEqual([]);
      expect(scan.blocking).toEqual(['a']);
      const onDisk = await probeOnDisk(root, ['a/x.pdf', 'gone.pdf']);
      expect([...onDisk.keys()]).toEqual(['a/x.pdf']);
      expect(onDisk.get('a/x.pdf')?.kind).toBe('file');
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('probeOnDisk reports errors (a parent that is a file) as kind error', async () => {
    await writeFile(path.join(root, 'f'), 'x');
    const onDisk = await probeOnDisk(root, ['f/x.pdf']);
    expect(onDisk.get('f/x.pdf')).toEqual({ kind: 'error', ino: 0 });
  });

  it.skipIf(isRoot)('reports unreadable directories as unknown subtrees', async () => {
    await mkdir(path.join(root, 'locked'));
    await writeFile(path.join(root, 'locked', 'secret.pdf'), 'x');
    await chmod(path.join(root, 'locked'), 0o000);
    const scan = await scanLocal(root);
    expect(scan.unknownSubtrees).toEqual(['locked']);
    expect(scan.entries).toEqual([]);
  });

  it('restricts the walk to a subdir and rejects a missing one', async () => {
    await mkdir(path.join(root, 'a'));
    await writeFile(path.join(root, 'a', 'in.pdf'), 'x');
    await writeFile(path.join(root, 'out.pdf'), 'x');
    const scan = await scanLocal(root, { subdir: 'a' });
    expect(scan.entries.map((e) => e.key)).toEqual(['a/in.pdf']);
    await expect(scanLocal(root, { subdir: 'nope' })).rejects.toThrow('is not a folder');
  });
});

describe('hashing', () => {
  it('computes md5 and reports failures', async () => {
    await writeFile(path.join(root, 'a.txt'), 'hello');
    const expected = createHash('md5').update('hello').digest('hex');
    expect(await md5File(path.join(root, 'a.txt'))).toBe(expected);
    const { md5s, failed } = await hashLocal(root, ['a.txt', 'gone.txt']);
    expect(md5s.get('a.txt')).toBe(expected);
    expect(failed).toEqual(['gone.txt']);
  });
});
```

- [ ] **Step 2: Run and see it fail** — `npx vitest run src/sync/__tests__/local-scanner.test.ts` → FAIL: `../local-scanner.js` cannot be resolved.

- [ ] **Step 3: Implement.**

`src/sync/local-scanner.ts`:

```ts
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readdir } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { ValidationError, hasErrorCode } from '../errors.js';
import { PART_SUFFIX, absInside, foldKey, isIgnoredName, toKey } from './paths.js';
import type { LocalScan, OnDiskProbe } from './types.js';

export interface LocalScanOptions {
  /** On-disk relative directory to restrict the scan to (sync_scan `subdir`). */
  subdir?: string;
}

/**
 * Walks `root` without following symlinks (spec §4 local-scanner). Unreadable or
 * vanishing entries become unknown subtrees; ignored and non-regular entries are
 * recorded as `occupied` so the planner never treats their keys as absent, and
 * symlinks/specials/dot-named folders as `blocking` (nothing below them is absent).
 */
export async function scanLocal(root: string, options: LocalScanOptions = {}): Promise<LocalScan> {
  const out: LocalScan = {
    entries: [],
    occupied: [],
    unknownSubtrees: [],
    blocking: [],
    partFiles: [],
  };
  const start = options.subdir ?? '';
  if (start !== '') {
    const abs = absInside(root, start);
    const info = await lstat(abs).catch(() => null);
    if (!info?.isDirectory()) throw new ValidationError(`${start} is not a folder in the pair`);
  }
  await walk(root, start, out, true);
  out.entries.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return out;
}

async function walk(
  root: string,
  dirName: string,
  out: LocalScan,
  isStart: boolean,
): Promise<void> {
  const dirAbs = dirName === '' ? root : absInside(root, dirName);
  let names: string[];
  try {
    names = (await readdir(dirAbs)).sort();
  } catch (err) {
    if (isStart) throw err;
    out.unknownSubtrees.push(toKey(dirName));
    return;
  }
  for (const base of names) {
    const name = dirName === '' ? base : `${dirName}/${base}`;
    const key = toKey(name);
    const abs = path.join(dirAbs, base);
    let info;
    try {
      info = await lstat(abs);
    } catch {
      out.unknownSubtrees.push(key); // vanished or unreadable during the scan
      continue;
    }
    if (isIgnoredName(base)) {
      out.occupied.push(key);
      if (!info.isFile()) out.blocking.push(key); // dot-named folder, symlink or special
      if (base.endsWith(PART_SUFFIX) && info.isFile()) {
        out.partFiles.push({ name, mtimeMs: info.mtimeMs });
      }
      continue;
    }
    if (info.isDirectory()) {
      out.occupied.push(key);
      await walk(root, name, out, false);
    } else if (info.isFile()) {
      out.entries.push({
        key,
        foldKey: foldKey(key),
        name,
        size: info.size,
        mtimeMs: info.mtimeMs,
        ctimeMs: info.ctimeMs,
        ino: info.ino,
      });
    } else {
      out.occupied.push(key); // symlink, socket, FIFO, device
      out.blocking.push(key);
    }
  }
}

/** lstat of keys without an exact scan match; ENOENT keys are omitted (spec §6.1 step 4). */
export async function probeOnDisk(
  root: string,
  keys: readonly string[],
): Promise<Map<string, OnDiskProbe>> {
  const found = new Map<string, OnDiskProbe>();
  for (const key of keys) {
    try {
      const info = await lstat(absInside(root, key));
      const kind = info.isFile()
        ? 'file'
        : info.isDirectory()
          ? 'dir'
          : info.isSymbolicLink()
            ? 'symlink'
            : 'other';
      found.set(key, { kind, ino: info.ino });
    } catch (err) {
      if (!hasErrorCode(err, 'ENOENT')) found.set(key, { kind: 'error', ino: 0 });
    }
  }
  return found;
}

export async function md5File(abs: string): Promise<string> {
  const hash = createHash('md5');
  await pipeline(createReadStream(abs), hash);
  return hash.digest('hex');
}

/** Hashes the given on-disk relative names; failures are returned, not thrown. */
export async function hashLocal(
  root: string,
  names: readonly string[],
): Promise<{ md5s: Map<string, string>; failed: string[] }> {
  const md5s = new Map<string, string>();
  const failed: string[] = [];
  for (const name of names) {
    try {
      md5s.set(name, await md5File(absInside(root, name)));
    } catch {
      failed.push(name);
    }
  }
  return { md5s, failed };
}
```

- [ ] **Step 4: Run and see it pass** — `npx vitest run src/sync/__tests__/local-scanner.test.ts` → PASS.

- [ ] **Step 5: Quality gate** — `npx prettier --write src/sync` then `npm run check` → typecheck, eslint (0 warnings), prettier and all tests green.

- [ ] **Step 6: Commit** —

```bash
git add src/sync
git commit -m "feat(sync): local scanner with NFC keys, unknown subtrees and md5" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

## Chunk 3: Remote scanner, probe and planner resolution

### Task 5: Remote scanner

**Files:**
- Create: `src/sync/remote-scanner.ts`, `src/sync/__tests__/drive-tree.ts`
- Test: `src/sync/__tests__/remote-scanner.test.ts`

The scanner takes a `FolderLister` (one page of one folder) so the service can wrap every listing in `OperationRunner.exec` (retry + error mapping per folder). `drive-tree.ts` is a test helper: an in-memory tree behind a `FolderLister`.

`src/sync/__tests__/drive-tree.ts`:

```ts
import type { DriveFile, DriveFileList } from '../../drive/drive-adapter.js';
import { GOOGLE_MIME } from '../../files/export-formats.js';
import type { FolderLister } from '../remote-scanner.js';

export function folder(id: string, name: string, parent: string): DriveFile {
  return { id, name, mimeType: GOOGLE_MIME.folder, parents: [parent] };
}

export function binary(id: string, name: string, parent: string, extra: DriveFile = {}): DriveFile {
  return {
    id,
    name,
    mimeType: 'application/pdf',
    parents: [parent],
    md5Checksum: `md5-${id}`,
    size: '10',
    modifiedTime: '2026-11-02T00:00:00.000Z',
    createdTime: '2026-11-01T00:00:00.000Z',
    capabilities: { canEdit: true, canTrash: true, canAddChildren: false },
    ...extra,
  };
}

/** A FolderLister over an in-memory tree; folders listed in `failing` throw `failWith`. */
export function treeLister(
  files: DriveFile[],
  opts: { failing?: string[]; failWith?: Error; pageSize?: number } = {},
): FolderLister & { calls: string[] } {
  const calls: string[] = [];
  const lister = async (
    folderId: string,
    pageToken: string | undefined,
  ): Promise<DriveFileList> => {
    calls.push(folderId);
    if (opts.failing?.includes(folderId)) throw opts.failWith ?? new Error('listing failed');
    const children = files.filter((f) => f.parents?.includes(folderId) && !f.trashed);
    const size = opts.pageSize ?? 1000;
    const start = pageToken ? Number(pageToken) : 0;
    const page = children.slice(start, start + size);
    const next = start + size < children.length ? String(start + size) : undefined;
    return { files: page, ...(next ? { nextPageToken: next } : {}) };
  };
  return Object.assign(lister, { calls });
}
```

- [ ] **Step 1: Write the failing tests.**

`src/sync/__tests__/remote-scanner.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { NotFoundError, ReauthRequiredError } from '../../errors.js';
import { GOOGLE_MIME } from '../../files/export-formats.js';
import { childrenQuery, scanRemote } from '../remote-scanner.js';
import { binary, folder, treeLister } from './drive-tree.js';

const ROOT = 'root';
const NFD = 'şartname.pdf'.normalize('NFD');

describe('childrenQuery', () => {
  it('escapes the folder id', () => {
    expect(childrenQuery("a'b")).toBe("'a\\'b' in parents and trashed = false");
  });
});

describe('scanRemote', () => {
  it('walks nested folders with NFC keys, ancestors and capabilities', async () => {
    const list = treeLister([
      folder('f1', 'docs', ROOT),
      folder('f2', 'inner', 'f1'),
      binary('a', 'a.pdf', ROOT),
      binary('b', NFD, 'f2', { capabilities: { canEdit: false, canTrash: false } }),
    ]);
    const scan = await scanRemote(ROOT, list);
    expect(scan.entries.map((e) => [e.id, e.key, e.parentId, e.ancestorIds])).toEqual([
      ['a', 'a.pdf', ROOT, [ROOT]],
      ['b', 'docs/inner/şartname.pdf', 'f2', ['f2', 'f1', ROOT]],
    ]);
    expect(scan.entries[1]).toMatchObject({
      canEdit: false,
      canTrash: false,
      md5: 'md5-b',
      size: 10,
    });
    expect([...scan.folders.entries()]).toEqual([
      [ROOT, ''],
      ['f1', 'docs'],
      ['f2', 'docs/inner'],
    ]);
  });

  it('follows pagination', async () => {
    const files = Array.from({ length: 5 }, (_, i) => binary(`id${i}`, `f${i}.pdf`, ROOT));
    const scan = await scanRemote(ROOT, treeLister(files, { pageSize: 2 }));
    expect(scan.entries).toHaveLength(5);
  });

  it('marks duplicate folder names as unknown subtrees without descending', async () => {
    const list = treeLister([
      folder('d1', 'dup', ROOT),
      folder('d2', 'Dup', ROOT),
      binary('x', 'x.pdf', 'd1'),
    ]);
    const scan = await scanRemote(ROOT, list);
    expect(scan.unknownSubtrees).toEqual(['Dup', 'dup']);
    expect(scan.unknownFolderIds.sort()).toEqual(['d1', 'd2']);
    expect(scan.entries).toEqual([]);
    expect(list.calls).toEqual([ROOT]);
  });

  it('ignores shortcuts, native files, unrepresentable and dot names', async () => {
    const scan = await scanRemote(
      ROOT,
      treeLister([
        { id: 's', name: 'link', mimeType: GOOGLE_MIME.shortcut, parents: [ROOT] },
        { id: 'g', name: 'Plan', mimeType: GOOGLE_MIME.document, parents: [ROOT] },
        binary('u', 'a/b.pdf', ROOT),
        binary('h', '.hidden', ROOT),
        folder('hf', '.git', ROOT),
      ]),
    );
    expect(scan.entries).toEqual([]);
    expect(scan.ignored.map((i) => [i.id, i.path, i.reason, i.isFolder])).toEqual([
      ['s', 'link', 'shortcut', false],
      ['g', 'Plan', 'native-skipped', false],
      ['u', 'a/b.pdf', 'unrepresentable', false],
      ['h', '.hidden', 'ignored-name', false],
      ['hf', '.git', 'ignored-name', true],
    ]);
  });

  it('turns a failed sub-folder listing into an unknown subtree', async () => {
    const scan = await scanRemote(
      ROOT,
      treeLister([folder('f1', 'bad', ROOT), binary('a', 'a.pdf', ROOT)], {
        failing: ['f1'],
        failWith: new NotFoundError('f1'),
      }),
    );
    expect(scan.unknownSubtrees).toEqual(['bad']);
    expect(scan.unknownFolderIds).toEqual(['f1']);
    expect(scan.folders.has('f1')).toBe(false);
    expect(scan.entries.map((e) => e.id)).toEqual(['a']);
  });

  it('rethrows root failures and run-aborting errors', async () => {
    await expect(
      scanRemote(ROOT, treeLister([], { failing: [ROOT], failWith: new NotFoundError(ROOT) })),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      scanRemote(
        ROOT,
        treeLister([folder('f1', 'sub', ROOT)], {
          failing: ['f1'],
          failWith: new ReauthRequiredError('emco'),
        }),
      ),
    ).rejects.toBeInstanceOf(ReauthRequiredError);
  });
});
```

- [ ] **Step 2: Run and see it fail** — `npx vitest run src/sync/__tests__/remote-scanner.test.ts` → FAIL: `../remote-scanner.js` cannot be resolved.

- [ ] **Step 3: Implement.**

`src/sync/remote-scanner.ts`:

```ts
import type { DriveFile, DriveFileList } from '../drive/drive-adapter.js';
import { GOOGLE_MIME, isGoogleNative } from '../files/export-formats.js';
import { escapeQueryValue } from '../files/query.js';
import { isAbortError } from './errors.js';
import { foldKey, isIgnoredName, isRepresentable } from './paths.js';
import { SYNC_FILE_FIELDS, type RemoteEntry, type RemoteScan } from './types.js';

export const SYNC_LIST_FIELDS = `nextPageToken, files(${SYNC_FILE_FIELDS})`;
export const SYNC_PAGE_SIZE = 1000;

/** Lists one page of a folder's non-trashed children. */
export type FolderLister = (
  folderId: string,
  pageToken: string | undefined,
) => Promise<DriveFileList>;

export function childrenQuery(folderId: string): string {
  return `'${escapeQueryValue(folderId)}' in parents and trashed = false`;
}

function joinKey(parent: string, name: string): string {
  const nfc = name.normalize('NFC');
  return parent === '' ? nfc : `${parent}/${nfc}`;
}

export function toRemoteEntry(
  file: DriveFile,
  parentKeyValue: string,
  parentId: string,
  ancestorIds: string[],
): RemoteEntry {
  const key = joinKey(parentKeyValue, file.name ?? '');
  return {
    id: file.id ?? '',
    key,
    foldKey: foldKey(key),
    name: file.name ?? '',
    parentId,
    ancestorIds,
    mimeType: file.mimeType ?? 'application/octet-stream',
    md5: file.md5Checksum ?? null,
    size: file.size ? Number(file.size) : null,
    modifiedTime: file.modifiedTime ?? '',
    createdTime: file.createdTime ?? '',
    canEdit: file.capabilities?.canEdit ?? false,
    canTrash: file.capabilities?.canTrash ?? false,
  };
}

async function listAll(list: FolderLister, folderId: string): Promise<DriveFile[]> {
  const files: DriveFile[] = [];
  let pageToken: string | undefined;
  do {
    const page = await list(folderId, pageToken);
    files.push(...(page.files ?? []));
    pageToken = page.nextPageToken ?? undefined;
  } while (pageToken);
  return files;
}

/**
 * Breadth-first walk of the pair's Drive folder (spec §4 remote-scanner). Duplicate
 * folder names and failed listings become unknown subtrees; shortcuts, Google-native
 * files (Phase A), unrepresentable and dot/part names are ignored and reported.
 */
export async function scanRemote(rootId: string, list: FolderLister): Promise<RemoteScan> {
  const scan: RemoteScan = {
    entries: [],
    ignored: [],
    folders: new Map([[rootId, '']]),
    unknownSubtrees: [],
    unknownFolderIds: [],
  };
  const queue: Array<{ id: string; key: string; ancestors: string[] }> = [
    { id: rootId, key: '', ancestors: [rootId] },
  ];
  for (let next = queue.shift(); next; next = queue.shift()) {
    const folder = next;
    let children: DriveFile[];
    try {
      children = await listAll(list, folder.id);
    } catch (err) {
      if (isAbortError(err) || folder.id === rootId) throw err;
      scan.folders.delete(folder.id);
      scan.unknownSubtrees.push(folder.key);
      scan.unknownFolderIds.push(folder.id);
      continue;
    }
    const folderFolds = new Map<string, number>();
    for (const f of children) {
      if (f.mimeType === GOOGLE_MIME.folder) {
        const fold = foldKey(f.name ?? '');
        folderFolds.set(fold, (folderFolds.get(fold) ?? 0) + 1);
      }
    }
    for (const f of children) {
      const id = f.id ?? '';
      const name = f.name ?? '';
      const representable = isRepresentable(name);
      const key = representable
        ? joinKey(folder.key, name)
        : folder.key === ''
          ? name
          : `${folder.key}/${name}`;
      const isFolder = f.mimeType === GOOGLE_MIME.folder;
      if (!representable) {
        scan.ignored.push({ id, path: key, reason: 'unrepresentable', isFolder });
      } else if (isIgnoredName(name)) {
        scan.ignored.push({ id, path: key, reason: 'ignored-name', isFolder });
      } else if (isFolder) {
        if ((folderFolds.get(foldKey(name)) ?? 0) > 1) {
          scan.unknownSubtrees.push(key);
          scan.unknownFolderIds.push(id);
        } else {
          scan.folders.set(id, key);
          queue.push({ id, key, ancestors: [id, ...folder.ancestors] });
        }
      } else if (f.mimeType === GOOGLE_MIME.shortcut) {
        scan.ignored.push({ id, path: key, reason: 'shortcut', isFolder: false });
      } else if (isGoogleNative(f.mimeType ?? '')) {
        scan.ignored.push({ id, path: key, reason: 'native-skipped', isFolder: false });
      } else {
        scan.entries.push(toRemoteEntry(f, folder.key, folder.id, folder.ancestors));
      }
    }
  }
  scan.entries.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : a.id < b.id ? -1 : 1));
  scan.unknownSubtrees = [...new Set(scan.unknownSubtrees)].sort();
  return scan;
}
```

- [ ] **Step 4: Run and see it pass** — `npx vitest run src/sync/__tests__/remote-scanner.test.ts` → PASS.

- [ ] **Step 5: Quality gate** — `npx prettier --write src/sync` then `npm run check` → typecheck, eslint (0 warnings), prettier and all tests green.

- [ ] **Step 6: Commit** —

```bash
git add src/sync
git commit -m "feat(sync): breadth-first Drive scanner with unknown subtrees and ignored items" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 6: Remote probe for records missing from the scan

**Files:**
- Create: `src/sync/remote-probe.ts`
- Test: `src/sync/__tests__/remote-probe.test.ts`

- [ ] **Step 1: Write the failing tests.**

`src/sync/__tests__/remote-probe.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { DriveFile } from '../../drive/drive-adapter.js';
import {
  DriveApiError,
  NotFoundError,
  PermissionDeniedError,
  QuotaExceededError,
} from '../../errors.js';
import { GOOGLE_MIME } from '../../files/export-formats.js';
import { probeRecord, probeRecords, type FileGetter } from '../remote-probe.js';
import type { RemoteScan } from '../types.js';
import { binary } from './drive-tree.js';

const ROOT = 'root';

function scan(overrides: Partial<RemoteScan> = {}): RemoteScan {
  return {
    entries: [],
    ignored: [],
    folders: new Map([
      [ROOT, ''],
      ['f1', 'docs'],
    ]),
    unknownSubtrees: ['dup'],
    unknownFolderIds: ['d1'],
    ...overrides,
  };
}

function getter(files: Record<string, DriveFile | Error>): FileGetter {
  return async (id) => {
    const f = files[id];
    if (f === undefined) throw new NotFoundError(id);
    if (f instanceof Error) throw f;
    return f;
  };
}

describe('probeRecord', () => {
  it('reports trashed files', async () => {
    const get = getter({ r: binary('r', 'a.pdf', ROOT, { trashed: true }) });
    expect(await probeRecord('r', scan(), get)).toEqual({ state: 'trashed' });
  });

  it('resolves a file whose parent was scanned as present with its key', async () => {
    const probe = await probeRecord('r', scan(), getter({ r: binary('r', 'b.pdf', 'f1') }));
    expect(probe).toMatchObject({ state: 'present', entry: { key: 'docs/b.pdf', parentId: 'f1' } });
  });

  it('is unknown when renamed to an unsyncable name or inside an ambiguous folder', async () => {
    expect((await probeRecord('r', scan(), getter({ r: binary('r', 'a/b', 'f1') }))).state).toBe(
      'unknown',
    );
    expect((await probeRecord('r', scan(), getter({ r: binary('r', '.x', 'f1') }))).state).toBe(
      'unknown',
    );
    expect((await probeRecord('r', scan(), getter({ r: binary('r', 'a.pdf', 'd1') }))).state).toBe(
      'unknown',
    );
    const native = { ...binary('r', 'a', 'f1'), mimeType: GOOGLE_MIME.document };
    expect((await probeRecord('r', scan(), getter({ r: native }))).state).toBe('unknown');
  });

  it('is unknown when nested under an unscanned folder inside the pair', async () => {
    const get = getter({
      r: binary('r', 'a.pdf', 'hidden-sub'),
      'hidden-sub': { id: 'hidden-sub', parents: ['dot-folder'] },
      'dot-folder': { id: 'dot-folder', parents: [ROOT] },
    });
    expect(await probeRecord('r', scan(), get)).toEqual({
      state: 'unknown',
      reason: 'inside a Drive folder that was not scanned',
    });
  });

  it('reports moved-out when the ancestry leaves the pair', async () => {
    const get = getter({
      r: binary('r', 'a.pdf', 'elsewhere'),
      elsewhere: { id: 'elsewhere', parents: ['my-drive'] },
      'my-drive': { id: 'my-drive' },
    });
    expect(await probeRecord('r', scan(), get)).toEqual({ state: 'moved-out' });
    const orphan = getter({ r: { ...binary('r', 'a.pdf', ROOT), parents: [] } });
    expect(await probeRecord('r', scan(), orphan)).toEqual({ state: 'moved-out' });
  });

  it('maps 404/403 to unavailable and other failures to unknown', async () => {
    expect(await probeRecord('r', scan(), getter({}))).toEqual({ state: 'unavailable' });
    const denied = getter({ r: new PermissionDeniedError('r') });
    expect(await probeRecord('r', scan(), denied)).toEqual({ state: 'unavailable' });
    const flaky = getter({ r: new DriveApiError(500, 'boom') });
    expect((await probeRecord('r', scan(), flaky)).state).toBe('unknown');
    const parentGone = getter({ r: binary('r', 'a.pdf', 'x') });
    expect(await probeRecord('r', scan(), parentGone)).toEqual({
      state: 'unknown',
      reason: 'a parent folder cannot be read',
    });
  });

  it('rethrows run-aborting errors', async () => {
    const get = getter({ r: new QuotaExceededError('emco') });
    await expect(probeRecord('r', scan(), get)).rejects.toBeInstanceOf(QuotaExceededError);
  });

  it('probes many ids', async () => {
    const get = getter({ a: binary('a', 'a.pdf', ROOT, { trashed: true }) });
    const probes = await probeRecords(['a', 'b'], scan(), get);
    expect([...probes.entries()]).toEqual([
      ['a', { state: 'trashed' }],
      ['b', { state: 'unavailable' }],
    ]);
  });
});
```

- [ ] **Step 2: Run and see it fail** — `npx vitest run src/sync/__tests__/remote-probe.test.ts` → FAIL: `../remote-probe.js` cannot be resolved.

- [ ] **Step 3: Implement.**

`src/sync/remote-probe.ts`:

```ts
import type { DriveFile } from '../drive/drive-adapter.js';
import { AppError, NotFoundError, PermissionDeniedError } from '../errors.js';
import { GOOGLE_MIME, isGoogleNative } from '../files/export-formats.js';
import { isAbortError } from './errors.js';
import { isIgnoredName, isRepresentable } from './paths.js';
import { toRemoteEntry } from './remote-scanner.js';
import { SYNC_FILE_FIELDS, type Probe, type RemoteScan } from './types.js';

export type FileGetter = (fileId: string, fields: string) => Promise<DriveFile>;

const MAX_DEPTH = 32;

function unknown(reason: string): Probe {
  return { state: 'unknown', reason };
}

function failure(err: unknown, what: string): Probe {
  if (isAbortError(err)) throw err;
  if (err instanceof NotFoundError || err instanceof PermissionDeniedError) {
    return what === 'file' ? { state: 'unavailable' } : unknown('a parent folder cannot be read');
  }
  return unknown(err instanceof AppError ? err.message : 'probe failed');
}

/** Classifies one record missing from the scan (spec §6.2). */
export async function probeRecord(
  remoteId: string,
  scan: RemoteScan,
  get: FileGetter,
): Promise<Probe> {
  let file: DriveFile;
  try {
    file = await get(remoteId, SYNC_FILE_FIELDS);
  } catch (err) {
    return failure(err, 'file');
  }
  if (file.trashed) return { state: 'trashed' };
  const parent = file.parents?.[0];
  if (!parent) return { state: 'moved-out' };
  if (scan.unknownFolderIds.includes(parent)) return unknown('inside an ambiguous Drive folder');
  const parentKey = scan.folders.get(parent);
  if (parentKey !== undefined) {
    const name = file.name ?? '';
    const mime = file.mimeType ?? '';
    if (!isRepresentable(name) || isIgnoredName(name)) {
      return unknown('renamed in Drive to a name that cannot be synced');
    }
    if (mime === GOOGLE_MIME.shortcut || isGoogleNative(mime)) {
      return unknown('is no longer a regular file');
    }
    return { state: 'present', entry: toRemoteEntry(file, parentKey, parent, [parent]) };
  }
  let current = parent;
  for (let depth = 0; depth < MAX_DEPTH; depth++) {
    let folder: DriveFile;
    try {
      folder = await get(current, 'id, parents');
    } catch (err) {
      return failure(err, 'folder');
    }
    const up = folder.parents?.[0];
    if (!up) return { state: 'moved-out' };
    if (scan.folders.has(up) || scan.unknownFolderIds.includes(up)) {
      return unknown('inside a Drive folder that was not scanned');
    }
    current = up;
  }
  return unknown('folder nesting too deep');
}

/** Probes every record id (sequentially) and returns id → probe. */
export async function probeRecords(
  remoteIds: readonly string[],
  scan: RemoteScan,
  get: FileGetter,
): Promise<Map<string, Probe>> {
  const probes = new Map<string, Probe>();
  for (const id of remoteIds) probes.set(id, await probeRecord(id, scan, get));
  return probes;
}
```

- [ ] **Step 4: Run and see it pass** — `npx vitest run src/sync/__tests__/remote-probe.test.ts` → PASS.

- [ ] **Step 5: Quality gate** — `npx prettier --write src/sync` then `npm run check` → typecheck, eslint (0 warnings), prettier and all tests green.

- [ ] **Step 6: Commit** —

```bash
git add src/sync
git commit -m "feat(sync): probe trashed, moved, moved-out and unavailable Drive files" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 7: Planner resolution (§6.1, §6.2) and hash targets

**Files:**
- Create: `src/sync/resolve.ts`, `src/sync/__tests__/plan-input.ts`
- Test: `src/sync/__tests__/resolve.test.ts`

`resolve.ts` is pure. `plan-input.ts` builds a `PlanInput` from small option objects (record paths are always selected; default pair is case-insensitive with a completed first run).

`src/sync/__tests__/plan-input.ts`:

```ts
import type { PlanInput } from '../resolve.js';
import type {
  LocalEntry,
  OnDiskProbe,
  Pair,
  Probe,
  RemoteEntry,
  RemoteIgnored,
  SyncRecord,
} from '../types.js';
import { ROOT_ID, makePair } from './fixtures.js';

export interface InputOptions {
  pair?: Partial<Pair>;
  records?: SyncRecord[];
  /** Extra selection keys (record paths are always selected). */
  selection?: string[];
  local?: LocalEntry[];
  remote?: RemoteEntry[];
  ignored?: RemoteIgnored[];
  probes?: Array<[string, Probe]>;
  md5s?: Array<[string, string]>;
  onDisk?: Array<[string, OnDiskProbe]>;
  blocking?: string[];
  folders?: Array<[string, string]>;
  occupied?: string[];
  unknownLocal?: string[];
  unknownRemote?: string[];
  unknownFolderIds?: string[];
}

export function planInput(o: InputOptions = {}): PlanInput {
  const records = o.records ?? [];
  const pair = makePair({
    selection: [...records.map((r) => r.path), ...(o.selection ?? [])],
    ...o.pair,
  });
  return {
    pair,
    records,
    local: {
      entries: o.local ?? [],
      occupied: o.occupied ?? [],
      unknownSubtrees: o.unknownLocal ?? [],
      blocking: o.blocking ?? [],
      partFiles: [],
    },
    remote: {
      entries: o.remote ?? [],
      ignored: o.ignored ?? [],
      folders: new Map([[ROOT_ID, ''], ...(o.folders ?? [])]),
      unknownSubtrees: o.unknownRemote ?? [],
      unknownFolderIds: o.unknownFolderIds ?? [],
    },
    probes: new Map(o.probes ?? []),
    md5s: new Map(o.md5s ?? []),
    onDisk: new Map(o.onDisk ?? []),
  };
}
```

- [ ] **Step 1: Write the failing tests.**

`src/sync/__tests__/resolve.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  buildContext,
  hashTargets,
  onDiskProbeKeys,
  localState,
  remoteState,
  resolveLocal,
  resolveRemote,
} from '../resolve.js';
import { localEntry, record, remoteEntry } from './fixtures.js';
import { planInput } from './plan-input.js';

const NFD = 'şartname.pdf'.normalize('NFD');

describe('resolveLocal (spec §6.1)', () => {
  it('1: exact key match (NFD on disk matches the NFC key)', () => {
    const ctx = buildContext(planInput({ local: [localEntry(NFD)] }));
    expect(resolveLocal(ctx, 'şartname.pdf')).toMatchObject({
      kind: 'present',
      renamedCase: false,
      entry: { name: NFD },
    });
  });

  it('2: fold match on a case-insensitive volume is renamed-case when the volume agrees', () => {
    const agreed = buildContext(
      planInput({
        local: [localEntry('report.pdf')],
        onDisk: [['Report.pdf', { kind: 'file', ino: 1 }]],
      }),
    );
    expect(resolveLocal(agreed, 'Report.pdf')).toMatchObject({
      kind: 'present',
      renamedCase: true,
    });
    const unprobed = buildContext(planInput({ local: [localEntry('report.pdf')] }));
    expect(resolveLocal(unprobed, 'Report.pdf')).toEqual({ kind: 'ambiguous' });
    const other = buildContext(
      planInput({
        local: [localEntry('report.pdf')],
        onDisk: [['Report.pdf', { kind: 'file', ino: 2 }]],
      }),
    );
    expect(resolveLocal(other, 'Report.pdf')).toEqual({ kind: 'ambiguous' });
  });

  it('2: fold-only match on a case-sensitive volume is ambiguous', () => {
    const ctx = buildContext(
      planInput({ pair: { caseInsensitive: false }, local: [localEntry('report.pdf')] }),
    );
    expect(resolveLocal(ctx, 'Report.pdf')).toEqual({ kind: 'ambiguous' });
  });

  it('3: under an unreadable local folder is unknown', () => {
    const ctx = buildContext(planInput({ unknownLocal: ['locked'] }));
    expect(resolveLocal(ctx, 'locked/a.pdf').kind).toBe('unknown');
  });

  it('4: a non-regular entry at the key is unknown', () => {
    const ctx = buildContext(planInput({ occupied: ['a.pdf'] }));
    expect(resolveLocal(ctx, 'a.pdf')).toEqual({
      kind: 'unknown',
      reason: 'local path is occupied by a non-regular or ignored entry',
    });
  });

  it('5: otherwise absent', () => {
    expect(resolveLocal(buildContext(planInput()), 'a.pdf')).toEqual({ kind: 'absent' });
  });
});

describe('resolveRemote (spec §6.2)', () => {
  const k = record('r1', 'a.pdf');

  it('present-same and present-moved from the scan', () => {
    const same = buildContext(planInput({ remote: [remoteEntry('r1', 'a.pdf')] }));
    expect(resolveRemote(same, k)).toMatchObject({ kind: 'present', moved: false });
    const moved = buildContext(planInput({ remote: [remoteEntry('r1', 'sub/a.pdf')] }));
    expect(resolveRemote(moved, k)).toMatchObject({ kind: 'present', moved: true });
  });

  it('uses probes for records missing from the scan', () => {
    for (const state of ['trashed', 'moved-out', 'unavailable'] as const) {
      const ctx = buildContext(planInput({ probes: [['r1', { state }]] }));
      expect(resolveRemote(ctx, k)).toEqual({ kind: state });
    }
    const probed = buildContext(
      planInput({ probes: [['r1', { state: 'present', entry: remoteEntry('r1', 'b.pdf') }]] }),
    );
    expect(resolveRemote(probed, k)).toMatchObject({ kind: 'present', moved: true });
    const unknown = buildContext(
      planInput({ probes: [['r1', { state: 'unknown', reason: 'x' }]] }),
    );
    expect(resolveRemote(unknown, k)).toEqual({ kind: 'unknown', reason: 'x' });
    expect(resolveRemote(buildContext(planInput()), k).kind).toBe('unknown');
  });

  it('is unknown when the file was renamed to an ignored name', () => {
    const ctx = buildContext(
      planInput({
        ignored: [{ id: 'r1', path: '.a.pdf', reason: 'ignored-name', isFolder: false }],
      }),
    );
    expect(resolveRemote(ctx, k).kind).toBe('unknown');
  });
});

describe('content state', () => {
  it('local: unchanged by stat, else by md5; null when not hashed', () => {
    const k = record('r1', 'a.pdf');
    const ctx = buildContext(planInput({ md5s: [['b.pdf', 'md5-r1']] }));
    expect(localState(ctx, k, localEntry('a.pdf'))).toEqual({ changed: false, md5: 'md5-r1' });
    expect(localState(ctx, k, localEntry('b.pdf', { mtimeMs: 5 }))).toEqual({
      changed: false,
      md5: 'md5-r1',
    });
    expect(localState(ctx, k, localEntry('a.pdf', { mtimeMs: 5 }))).toBeNull();
  });

  it('remote: md5 compare, else weak size + modifiedTime', () => {
    const k = record('r1', 'a.pdf');
    expect(remoteState(k, remoteEntry('r1', 'a.pdf', { md5: 'other' }))).toEqual({
      changed: true,
      weak: false,
    });
    expect(remoteState(k, remoteEntry('r1', 'a.pdf', { md5: null }))).toEqual({
      changed: false,
      weak: true,
    });
    expect(remoteState(k, remoteEntry('r1', 'a.pdf', { md5: null, size: 11 })).changed).toBe(true);
  });
});

describe('hashTargets', () => {
  it('hashes tracked files with a changed stat and unrecorded selected files only', () => {
    const input = planInput({
      records: [record('r1', 'same.pdf'), record('r2', 'touched.pdf')],
      selection: ['New.pdf'],
      local: [
        localEntry('same.pdf'),
        localEntry('touched.pdf', { ctimeMs: 2 }),
        localEntry('new.pdf'),
        localEntry('unselected.pdf'),
      ],
    });
    expect(hashTargets(input)).toEqual(['new.pdf', 'touched.pdf']);
  });
});

describe('resolveLocal safety (blocking ancestors, on-disk probe)', () => {
  it('a key below a symlinked, special or dot-named folder is unknown, never absent', () => {
    const ctx = buildContext(planInput({ blocking: ['a'] }));
    expect(resolveLocal(ctx, 'a/x.pdf')).toEqual({
      kind: 'unknown',
      reason: 'a parent folder is a symlink, special file or ignored folder',
    });
  });

  it('a key that exists on disk but was not scanned is unknown', () => {
    const ctx = buildContext(planInput({ onDisk: [['a/x.pdf', { kind: 'file', ino: 99 }]] }));
    expect(resolveLocal(ctx, 'a/x.pdf').kind).toBe('unknown');
  });

  it('an on-disk inode equal to a scanned entry is that entry, renamed by case folding', () => {
    const ctx = buildContext(
      planInput({
        // A volume that folds more than foldKey: the scan sees `alias.pdf`, lstat(`x.pdf`) hits it.
        local: [localEntry('alias.pdf', { ino: 7 })],
        onDisk: [['x.pdf', { kind: 'file', ino: 7 }]],
      }),
    );
    expect(resolveLocal(ctx, 'x.pdf')).toMatchObject({
      kind: 'present',
      renamedCase: true,
      entry: { name: 'alias.pdf' },
    });
  });
});

describe('onDiskProbeKeys', () => {
  it('asks the volume about record keys without an exact match and fold-only matches', () => {
    const input = planInput({
      records: [record('r1', 'kept.pdf'), record('r2', 'Gone.pdf')],
      selection: ['Sel.pdf', 'nowhere.pdf'],
      local: [localEntry('kept.pdf'), localEntry('sel.pdf'), localEntry('drive.pdf')],
      remote: [remoteEntry('n1', 'Drive.pdf'), remoteEntry('n2', 'other.pdf')],
    });
    expect(onDiskProbeKeys(input)).toEqual(['Drive.pdf', 'Gone.pdf', 'Sel.pdf']);
  });
});
```

- [ ] **Step 2: Run and see it fail** — `npx vitest run src/sync/__tests__/resolve.test.ts` → FAIL: `../resolve.js` cannot be resolved.

- [ ] **Step 3: Implement.**

`src/sync/resolve.ts`:

```ts
import { ancestorKeys, foldKey, isUnder } from './paths.js';
import type {
  LocalEntry,
  LocalScan,
  OnDiskProbe,
  Pair,
  Probe,
  RemoteEntry,
  RemoteIgnored,
  RemoteScan,
  SyncRecord,
} from './types.js';

export interface PlanInput {
  pair: Pair;
  records: readonly SyncRecord[];
  local: LocalScan;
  remote: RemoteScan;
  /** Probe results for records missing from the remote scan (spec §6.2). */
  probes: ReadonlyMap<string, Probe>;
  /** md5 by on-disk relative name, for the names `hashTargets` asked for. */
  md5s: ReadonlyMap<string, string>;
  /** lstat of record keys that have no exact scan match (absent keys are omitted). */
  onDisk: ReadonlyMap<string, OnDiskProbe>;
}

export interface PlanContext {
  input: PlanInput;
  ci: boolean;
  localByKey: Map<string, LocalEntry>;
  localByFold: Map<string, LocalEntry[]>;
  remoteById: Map<string, RemoteEntry>;
  remoteByFold: Map<string, RemoteEntry[]>;
  ignoredById: Map<string, RemoteIgnored>;
  trackedIds: Set<string>;
  /** Folds with two entries on one side (spec §6.5 last paragraph). */
  ambiguousFolds: Set<string>;
  occupiedKeys: Set<string>;
  occupiedFolds: Set<string>;
  blockingKeys: Set<string>;
  blockingFolds: Set<string>;
  localByIno: Map<number, LocalEntry>;
  excludedFolds: Set<string>;
  /** Selected key by fold. */
  selectionByFold: Map<string, string>;
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

export function buildContext(input: PlanInput): PlanContext {
  const localByKey = new Map<string, LocalEntry>();
  const localByFold = new Map<string, LocalEntry[]>();
  for (const e of input.local.entries) {
    localByKey.set(e.key, e);
    push(localByFold, e.foldKey, e);
  }
  const remoteById = new Map<string, RemoteEntry>();
  const remoteByFold = new Map<string, RemoteEntry[]>();
  for (const r of input.remote.entries) {
    remoteById.set(r.id, r);
    push(remoteByFold, r.foldKey, r);
  }
  const ambiguousFolds = new Set<string>();
  for (const [fold, list] of localByFold) if (list.length > 1) ambiguousFolds.add(fold);
  for (const [fold, list] of remoteByFold) if (list.length > 1) ambiguousFolds.add(fold);
  return {
    input,
    ci: input.pair.caseInsensitive,
    localByKey,
    localByFold,
    remoteById,
    remoteByFold,
    ignoredById: new Map(input.remote.ignored.map((i) => [i.id, i])),
    trackedIds: new Set(input.records.map((r) => r.remoteId)),
    ambiguousFolds,
    occupiedKeys: new Set(input.local.occupied),
    occupiedFolds: new Set(input.local.occupied.map(foldKey)),
    blockingKeys: new Set(input.local.blocking),
    blockingFolds: new Set(input.local.blocking.map(foldKey)),
    localByIno: new Map(input.local.entries.map((e) => [e.ino, e])),
    excludedFolds: new Set(input.pair.excluded.map(foldKey)),
    selectionByFold: new Map(input.pair.selection.map((k) => [foldKey(k), k])),
  };
}

/** Under a local or remote unknown subtree (spec §4). */
export function isUnknownKey(ctx: PlanContext, key: string): boolean {
  return (
    ctx.input.local.unknownSubtrees.some((u) => isUnder(key, u)) ||
    ctx.input.remote.unknownSubtrees.some((u) => isUnder(key, u))
  );
}

export function isOccupied(ctx: PlanContext, key: string): boolean {
  return ctx.ci ? ctx.occupiedFolds.has(foldKey(key)) : ctx.occupiedKeys.has(key);
}

/** An ancestor of `key` is a symlink, special file or dot-named folder (never treat as absent). */
export function isBlocked(ctx: PlanContext, key: string): boolean {
  return ancestorKeys(key).some((a) =>
    ctx.ci ? ctx.blockingFolds.has(foldKey(a)) : ctx.blockingKeys.has(a),
  );
}

export function isExcluded(ctx: PlanContext, key: string): boolean {
  return ctx.excludedFolds.has(foldKey(key));
}

export type LocalResolution =
  | { kind: 'present'; entry: LocalEntry; renamedCase: boolean }
  | { kind: 'absent' }
  | { kind: 'ambiguous' }
  | { kind: 'unknown'; reason: string };

/** The volume resolves `key` to `entry` itself (from the service's lstat probe). */
export function sameFileOnDisk(ctx: PlanContext, key: string, entry: LocalEntry): boolean {
  const probe = ctx.input.onDisk.get(key);
  return probe?.kind === 'file' && probe.ino === entry.ino;
}

/** Spec §6.1. */
export function resolveLocal(ctx: PlanContext, key: string): LocalResolution {
  const exact = ctx.localByKey.get(key);
  if (exact) return { kind: 'present', entry: exact, renamedCase: false };
  const folded = ctx.localByFold.get(foldKey(key)) ?? [];
  if (folded.length > 0) {
    const [only] = folded;
    // A fold-only match counts as the same file only when the volume agrees: lstat(key)
    // must hit exactly that inode (protects against any fold/APFS mismatch).
    if (ctx.ci && folded.length === 1 && only && sameFileOnDisk(ctx, key, only)) {
      return { kind: 'present', entry: only, renamedCase: true };
    }
    return { kind: 'ambiguous' };
  }
  if (ctx.input.local.unknownSubtrees.some((u) => isUnder(key, u))) {
    return { kind: 'unknown', reason: 'local folder could not be read' };
  }
  if (isBlocked(ctx, key)) {
    return {
      kind: 'unknown',
      reason: 'a parent folder is a symlink, special file or ignored folder',
    };
  }
  if (isOccupied(ctx, key)) {
    return { kind: 'unknown', reason: 'local path is occupied by a non-regular or ignored entry' };
  }
  const probe = ctx.input.onDisk.get(key);
  if (probe) {
    // The volume resolves the key to a scanned file our fold missed (APFS folding is fuller).
    const same = probe.kind === 'file' ? ctx.localByIno.get(probe.ino) : undefined;
    if (same) return { kind: 'present', entry: same, renamedCase: true };
    return { kind: 'unknown', reason: 'exists on disk but was not seen by the scan' };
  }
  return { kind: 'absent' };
}

export type RemoteResolution =
  | { kind: 'present'; entry: RemoteEntry; moved: boolean }
  | { kind: 'trashed' }
  | { kind: 'moved-out' }
  | { kind: 'unavailable' }
  | { kind: 'unknown'; reason: string };

/** Spec §6.2. */
export function resolveRemote(ctx: PlanContext, record: SyncRecord): RemoteResolution {
  const scanned = ctx.remoteById.get(record.remoteId);
  if (scanned) return { kind: 'present', entry: scanned, moved: scanned.key !== record.path };
  if (ctx.ignoredById.has(record.remoteId)) {
    return { kind: 'unknown', reason: 'renamed in Drive to a name that cannot be synced' };
  }
  const probe = ctx.input.probes.get(record.remoteId);
  if (!probe) return { kind: 'unknown', reason: 'Drive file was not probed' };
  switch (probe.state) {
    case 'present':
      return { kind: 'present', entry: probe.entry, moved: probe.entry.key !== record.path };
    case 'unknown':
      return { kind: 'unknown', reason: probe.reason };
    default:
      return { kind: probe.state };
  }
}

function statMatches(entry: LocalEntry, record: SyncRecord): boolean {
  return (
    entry.size === record.localSize &&
    entry.mtimeMs === record.localMtimeMs &&
    entry.ctimeMs === record.localCtimeMs
  );
}

/** L content vs the record; null when a needed hash is missing. */
export function localState(
  ctx: PlanContext,
  record: SyncRecord,
  entry: LocalEntry,
): { changed: boolean; md5: string } | null {
  if (statMatches(entry, record)) return { changed: false, md5: record.localMd5 };
  const md5 = ctx.input.md5s.get(entry.name);
  if (md5 === undefined) return null;
  return { changed: md5 !== record.localMd5, md5 };
}

/** R content vs the record (md5, else size + modifiedTime with `weak`). */
export function remoteState(
  record: SyncRecord,
  entry: RemoteEntry,
): { changed: boolean; weak: boolean } {
  if (entry.md5 !== null && record.remoteMd5 !== null) {
    return { changed: entry.md5 !== record.remoteMd5, weak: false };
  }
  return {
    changed: entry.size !== record.remoteSize || entry.modifiedTime !== record.remoteModifiedTime,
    weak: true,
  };
}

/**
 * Keys the service must `lstat` before planning (`PlanInput.onDisk`): record keys without
 * an exact scan match, and Drive/selected keys that match a local file only by fold.
 */
export function onDiskProbeKeys(
  input: Pick<PlanInput, 'pair' | 'records' | 'local' | 'remote'>,
): string[] {
  const exact = new Set(input.local.entries.map((e) => e.key));
  const folds = new Set(input.local.entries.map((e) => e.foldKey));
  const keys = new Set<string>();
  for (const r of input.records) if (!exact.has(r.path)) keys.add(r.path);
  for (const r of input.remote.entries) {
    if (!exact.has(r.key) && folds.has(r.foldKey)) keys.add(r.key);
  }
  for (const k of input.pair.selection) {
    if (!exact.has(k) && folds.has(foldKey(k))) keys.add(k);
  }
  return [...keys].sort();
}

/**
 * On-disk names the service must hash before planning (spec §5 step 3): tracked
 * files whose stat differs from the record, selected files not yet recorded, and a
 * local file already at a vanished record's Drive-move target (crash after a move).
 */
export function hashTargets(input: Omit<PlanInput, 'md5s'>): string[] {
  const ctx = buildContext({ ...input, md5s: new Map() });
  const names = new Set<string>();
  const recordFolds = new Set<string>();
  for (const record of input.records) {
    recordFolds.add(foldKey(record.path));
    const l = resolveLocal(ctx, record.path);
    if (l.kind === 'present' && !statMatches(l.entry, record)) names.add(l.entry.name);
    const moved = ctx.remoteById.get(record.remoteId);
    if (l.kind === 'absent' && moved && moved.key !== record.path) {
      for (const e of ctx.localByFold.get(moved.foldKey) ?? []) names.add(e.name);
    }
  }
  for (const key of input.pair.selection) {
    const fold = foldKey(key);
    if (recordFolds.has(fold)) continue;
    for (const e of ctx.localByFold.get(fold) ?? []) names.add(e.name);
  }
  return [...names].sort();
}
```

- [ ] **Step 4: Run and see it pass** — `npx vitest run src/sync/__tests__/resolve.test.ts` → PASS.

- [ ] **Step 5: Quality gate** — `npx prettier --write src/sync` then `npm run check` → typecheck, eslint (0 warnings), prettier and all tests green.

- [ ] **Step 6: Commit** —

```bash
git add src/sync
git commit -m "feat(sync): pure local/remote resolution for the planner" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

## Chunk 4: Planner — tracked records

### Task 8: Tracked records: dispatch §6.3 and B1–B14

**Files:**
- Create: `src/sync/plan-tracked.ts`
- Test: `src/sync/__tests__/plan-tracked.test.ts`

One test per rule, in table order (first match wins). Selection changes are attached to actions and only applied by the executor after success.

- [ ] **Step 1: Write the failing tests.**

`src/sync/__tests__/plan-tracked.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { planTracked } from '../plan-tracked.js';
import { buildContext } from '../resolve.js';
import type { SyncRecord } from '../types.js';
import { localEntry, record, remoteEntry } from './fixtures.js';
import { planInput, type InputOptions } from './plan-input.js';

const K = record('r1', 'a.pdf');
const L = localEntry('a.pdf');
const L_EDITED = localEntry('a.pdf', { mtimeMs: 2000, size: 12 });
const R = remoteEntry('r1', 'a.pdf');
const R_EDITED = remoteEntry('r1', 'a.pdf', {
  md5: 'md5-remote-edit',
  modifiedTime: '2026-11-03T00:00:00.000Z',
});

function run(o: InputOptions, k: SyncRecord = K) {
  return planTracked(buildContext(planInput({ records: [k], ...o })), k);
}

function only(o: InputOptions, k: SyncRecord = K) {
  const result = run(o, k);
  expect(result.actions).toHaveLength(1);
  return result.actions[0];
}

describe('dispatch (spec §6.3)', () => {
  it('(a) unknown subtree beats everything', () => {
    const result = run({ local: [L], remote: [R], unknownLocal: [''] });
    expect(result.actions).toEqual([]);
    expect(result.notes[0]).toMatchObject({ code: 'unknown-state', path: 'a.pdf' });
  });

  it('(a) unknown remote probe', () => {
    const result = run({ local: [L], probes: [['r1', { state: 'unknown', reason: 'x' }]] });
    expect(result.notes[0]).toMatchObject({ code: 'unknown-state', message: 'x' });
  });

  it('(b) ambiguous key', () => {
    const result = run({ local: [L], remote: [R, remoteEntry('r9', 'A.pdf')] });
    expect(result.actions).toEqual([]);
    expect(result.notes[0]).toMatchObject({ code: 'ambiguous', path: 'a.pdf' });
  });

  it('(c)/(d) Phase B records never act', () => {
    const remoteOnly = { ...K, remoteOnly: true };
    const result = run({ remote: [R] }, remoteOnly);
    expect(result.actions).toEqual([]);
    expect(result.notes[0]).toMatchObject({ code: 'unknown-state', rule: 'phase-b' });
  });
});

describe('binary tracked records (spec §6.4)', () => {
  it('B1 unchanged → nothing', () => {
    expect(run({ local: [L], remote: [R] })).toMatchObject({
      actions: [],
      notes: [],
      claimedLocal: 'a.pdf',
    });
  });

  it('B1 with a touched-but-identical file → refresh', () => {
    const a = only({
      local: [localEntry('a.pdf', { ctimeMs: 5 })],
      remote: [R],
      md5s: [['a.pdf', 'md5-r1']],
    });
    expect(a).toMatchObject({ kind: 'refresh', rule: 'B1' });
  });

  it('B2 local edit → update-remote', () => {
    const a = only({ local: [L_EDITED], remote: [R], md5s: [['a.pdf', 'md5-local-edit']] });
    expect(a).toMatchObject({ kind: 'update-remote', rule: 'B2', localMd5: 'md5-local-edit' });
  });

  it('B2 without canEdit → remote-readonly report', () => {
    const result = run({
      local: [L_EDITED],
      remote: [remoteEntry('r1', 'a.pdf', { canEdit: false })],
      md5s: [['a.pdf', 'x']],
    });
    expect(result.actions).toEqual([]);
    expect(result.notes[0]).toMatchObject({ code: 'remote-readonly', rule: 'B2' });
  });

  it('B3 remote edit → download-replace', () => {
    expect(only({ local: [L], remote: [R_EDITED] })).toMatchObject({
      kind: 'download-replace',
      rule: 'B3',
    });
  });

  it('B4 both edited with equal md5 → adopt', () => {
    const a = only({ local: [L_EDITED], remote: [R_EDITED], md5s: [['a.pdf', 'md5-remote-edit']] });
    expect(a).toMatchObject({ kind: 'adopt', rule: 'B4' });
  });

  it('B4 both edited differently → conflict', () => {
    const a = only({ local: [L_EDITED], remote: [R_EDITED], md5s: [['a.pdf', 'md5-local-edit']] });
    expect(a).toMatchObject({ kind: 'conflict', rule: 'B4', updateRemote: true });
  });

  it('B4 conflict without canEdit → conflict copy only + remote-readonly', () => {
    const result = run({
      local: [L_EDITED],
      remote: [{ ...R_EDITED, canEdit: false }],
      md5s: [['a.pdf', 'md5-local-edit']],
    });
    expect(result.actions[0]).toMatchObject({ kind: 'conflict', updateRemote: false });
    expect(result.notes[0]).toMatchObject({ code: 'remote-readonly' });
  });

  it('B5 deleted locally → trash-remote and unselect', () => {
    expect(only({ remote: [R] })).toMatchObject({
      kind: 'trash-remote',
      rule: 'B5',
      selection: { remove: ['a.pdf'] },
    });
  });

  it('B5 without canTrash → cannot-trash report', () => {
    const result = run({ remote: [remoteEntry('r1', 'a.pdf', { canTrash: false })] });
    expect(result.actions).toEqual([]);
    expect(result.notes[0]).toMatchObject({ code: 'cannot-trash' });
  });

  it('B6 deleted locally but edited remotely → download-new (change beats deletion)', () => {
    expect(only({ remote: [R_EDITED] })).toMatchObject({
      kind: 'download-new',
      rule: 'B6',
      key: 'a.pdf',
    });
  });

  it('B7 moved remotely, local unchanged → move-local and rename the selection', () => {
    const a = only({ local: [L], remote: [remoteEntry('r1', 'sub/b.pdf')] });
    expect(a).toMatchObject({
      kind: 'move-local',
      rule: 'B7',
      key: 'sub/b.pdf',
      inPlace: false,
      thenDownload: false,
      selection: { remove: ['a.pdf'], add: ['sub/b.pdf'] },
    });
  });

  it('B7 moved and edited remotely → move-local then download', () => {
    const a = only({ local: [L], remote: [remoteEntry('r1', 'b.pdf', { md5: 'new' })] });
    expect(a).toMatchObject({ kind: 'move-local', thenDownload: true });
  });

  it('B7 remote case-only rename on a case-insensitive volume → rename in place', () => {
    const a = only({ local: [L], remote: [remoteEntry('r1', 'A.pdf')] });
    expect(a).toMatchObject({ kind: 'move-local', inPlace: true, key: 'A.pdf' });
  });

  it('B7 resumes a crashed move (same inode already at the target)', () => {
    const a = only({
      local: [L, localEntry('b.pdf', { ino: 1 })],
      remote: [remoteEntry('r1', 'b.pdf')],
    });
    expect(a).toMatchObject({ kind: 'move-local', key: 'b.pdf' });
  });

  it('B7 target taken by another local file → collision', () => {
    const result = run({
      local: [L, localEntry('b.pdf', { ino: 2 })],
      remote: [remoteEntry('r1', 'b.pdf')],
    });
    expect(result.actions).toEqual([]);
    expect(result.notes[0]).toMatchObject({ code: 'collision' });
  });

  it('B8 moved remotely, edited locally → download-new at the new key, old key excluded', () => {
    const result = run({
      local: [L_EDITED],
      remote: [remoteEntry('r1', 'b.pdf')],
      md5s: [['a.pdf', 'md5-local-edit']],
    });
    expect(result.actions[0]).toMatchObject({
      kind: 'download-new',
      rule: 'B8',
      key: 'b.pdf',
      selection: { remove: ['a.pdf'], add: ['b.pdf'], exclude: ['a.pdf'] },
    });
    expect(result.notes[0]).toMatchObject({ code: 'conflict-rename' });
  });

  it('B9 moved remotely, gone locally → download-new at the new key', () => {
    expect(only({ remote: [remoteEntry('r1', 'b.pdf')] })).toMatchObject({
      kind: 'download-new',
      rule: 'B9',
      key: 'b.pdf',
      selection: { remove: ['a.pdf'], add: ['b.pdf'] },
    });
  });

  it('B7–B9 into an excluded key → untrack with moved-into-excluded', () => {
    const result = run({
      pair: { excluded: ['b.pdf'] },
      local: [L],
      remote: [remoteEntry('r1', 'b.pdf')],
    });
    expect(result.actions[0]).toMatchObject({ kind: 'untrack' });
    expect(result.notes[0]).toMatchObject({ code: 'moved-into-excluded' });
  });

  it('B10 trashed remotely, local unchanged → trash-local', () => {
    expect(only({ local: [L], probes: [['r1', { state: 'trashed' }]] })).toMatchObject({
      kind: 'trash-local',
      rule: 'B10',
      selection: { remove: ['a.pdf'] },
    });
  });

  it('B11 trashed remotely, edited locally → upload-new rebased', () => {
    const a = only({
      local: [L_EDITED],
      probes: [['r1', { state: 'trashed' }]],
      md5s: [['a.pdf', 'edit']],
    });
    expect(a).toMatchObject({ kind: 'upload-new', rule: 'B11', rebaseFrom: 'r1' });
  });

  it('B11 after a crash adopts the identical re-upload instead of uploading twice', () => {
    const a = only({
      local: [L_EDITED],
      remote: [remoteEntry('r2', 'a.pdf', { md5: 'edit' })],
      probes: [['r1', { state: 'trashed' }]],
      md5s: [['a.pdf', 'edit']],
    });
    expect(a).toMatchObject({ kind: 'adopt', rule: 'B11', rebaseFrom: 'r1', remote: { id: 'r2' } });
  });

  it('B12 trashed remotely, gone locally → forget', () => {
    expect(only({ probes: [['r1', { state: 'trashed' }]] })).toMatchObject({
      kind: 'forget',
      rule: 'B12',
    });
  });

  it('B13 moved out of the pair → untrack, exclude, keep L', () => {
    const result = run({ local: [L], probes: [['r1', { state: 'moved-out' }]] });
    expect(result.actions[0]).toMatchObject({
      kind: 'untrack',
      rule: 'B13',
      selection: { remove: ['a.pdf'], exclude: ['a.pdf'] },
    });
    expect(result.notes[0]).toMatchObject({ code: 'moved-out' });
  });

  it('B14 unavailable → report only', () => {
    const result = run({ local: [L], probes: [['r1', { state: 'unavailable' }]] });
    expect(result.actions).toEqual([]);
    expect(result.notes[0]).toMatchObject({ code: 'remote-unavailable', rule: 'B14' });
  });

  it('warns weak-compare when Drive has no md5', () => {
    const result = run(
      { local: [L], remote: [remoteEntry('r1', 'a.pdf', { md5: null })] },
      { ...K, remoteMd5: null },
    );
    expect(result.notes.map((n) => n.code)).toEqual(['weak-compare']);
  });
});

describe('review regressions', () => {
  const KA = record('r1', 'a/x.pdf');
  const RA = remoteEntry('r1', 'a/x.pdf');

  it('a folder replaced by a symlink (moved to another disk) never trashes Drive files', () => {
    const viaSymlink = run({ remote: [RA], blocking: ['a'], occupied: ['a'] }, KA);
    expect(viaSymlink.actions).toEqual([]);
    expect(viaSymlink.notes[0]).toMatchObject({ code: 'unknown-state' });
    const reachable = run({ remote: [RA], onDisk: [['a/x.pdf', { kind: 'file', ino: 42 }]] }, KA);
    expect(reachable.actions).toEqual([]);
    expect(reachable.notes[0]).toMatchObject({ code: 'unknown-state' });
  });

  it('a local ß → SS rename is the same file (no trash-remote)', () => {
    const k = record('r1', 'straße.pdf');
    const result = run(
      {
        local: [localEntry('STRASSE.pdf')],
        remote: [remoteEntry('r1', 'straße.pdf')],
        onDisk: [['straße.pdf', { kind: 'file', ino: 1 }]],
      },
      k,
    );
    expect(result.actions.map((a) => [a.kind, a.local?.name])).toEqual([
      ['refresh', 'STRASSE.pdf'],
    ]);
  });

  it('a Drive ß → SS rename moves the local file in place', () => {
    const k = record('r1', 'straße.pdf');
    const a = only(
      { local: [localEntry('straße.pdf')], remote: [remoteEntry('r1', 'STRASSE.pdf')] },
      k,
    );
    expect(a).toMatchObject({ kind: 'move-local', key: 'STRASSE.pdf', inPlace: true });
  });

  it('renamed-case needs no refresh when localName already matches', () => {
    const k = record('r1', 'Report.pdf', { localName: 'report.pdf' });
    const result = run(
      {
        local: [localEntry('report.pdf')],
        remote: [remoteEntry('r1', 'Report.pdf')],
        onDisk: [['Report.pdf', { kind: 'file', ino: 1 }]],
      },
      k,
    );
    expect(result).toMatchObject({ actions: [], notes: [] });
  });

  it('B11 with a different Drive file now at the key → collision, no duplicate upload', () => {
    const result = run({
      local: [L_EDITED],
      remote: [remoteEntry('r2', 'a.pdf', { md5: 'someone-else' })],
      probes: [['r1', { state: 'trashed' }]],
      md5s: [['a.pdf', 'edit']],
    });
    expect(result.actions).toEqual([]);
    expect(result.notes[0]).toMatchObject({ code: 'collision', rule: 'B11' });
  });

  it('resumes a move that crashed after unlink: adopts the file already at the target', () => {
    const result = run({
      local: [localEntry('b.pdf', { ino: 7, ctimeMs: 5 })],
      remote: [remoteEntry('r1', 'b.pdf')],
      md5s: [['b.pdf', 'md5-r1']],
    });
    expect(result.actions[0]).toMatchObject({
      kind: 'adopt',
      rule: 'B7-resume',
      key: 'b.pdf',
      selection: { remove: ['a.pdf'], add: ['b.pdf'] },
    });
  });
});
```

- [ ] **Step 2: Run and see it fail** — `npx vitest run src/sync/__tests__/plan-tracked.test.ts` → FAIL: `../plan-tracked.js` cannot be resolved.

- [ ] **Step 3: Implement.**

`src/sync/plan-tracked.ts`:

```ts
import { foldKey } from './paths.js';
import {
  isExcluded,
  isUnknownKey,
  localState,
  remoteState,
  resolveLocal,
  resolveRemote,
  type PlanContext,
} from './resolve.js';
import type { Action, LocalEntry, Note, NoteCode, RemoteEntry, SyncRecord } from './types.js';

export interface TrackedResult {
  actions: Action[];
  notes: Note[];
  /** Folds this record occupies (its key and a remote move target). */
  claimedFolds: string[];
  /** On-disk name of the local file matched to this record. */
  claimedLocal: string | null;
}

function needsRefresh(record: SyncRecord, entry: LocalEntry, remote: RemoteEntry): boolean {
  return (
    entry.name !== record.localName ||
    entry.size !== record.localSize ||
    entry.mtimeMs !== record.localMtimeMs ||
    entry.ctimeMs !== record.localCtimeMs ||
    remote.name !== record.remoteName ||
    remote.parentId !== record.remoteParentId ||
    remote.md5 !== record.remoteMd5 ||
    remote.size !== record.remoteSize ||
    remote.modifiedTime !== record.remoteModifiedTime
  );
}

/** Classifies one tracked record: dispatch §6.3, then table B1–B14 (§6.4). First match wins. */
export function planTracked(ctx: PlanContext, record: SyncRecord): TrackedResult {
  const out: TrackedResult = {
    actions: [],
    notes: [],
    claimedFolds: [foldKey(record.path)],
    claimedLocal: null,
  };
  const note = (code: NoteCode, rule: string, message?: string): TrackedResult => {
    out.notes.push({
      code,
      path: record.path,
      rule,
      remoteId: record.remoteId,
      ...(message ? { message } : {}),
    });
    return out;
  };
  const act = (action: Omit<Action, 'record'>): TrackedResult => {
    out.actions.push({ ...action, record });
    return out;
  };

  const L = resolveLocal(ctx, record.path);
  if (L.kind === 'present') out.claimedLocal = L.entry.name;
  const R = resolveRemote(ctx, record);
  const newKey = R.kind === 'present' && R.moved ? R.entry.key : null;
  if (newKey !== null) out.claimedFolds.push(foldKey(newKey));

  // (a) unknown-state
  if (isUnknownKey(ctx, record.path) || (newKey !== null && isUnknownKey(ctx, newKey))) {
    return note('unknown-state', 'unknown', 'inside a folder that could not be read');
  }
  if (L.kind === 'unknown') return note('unknown-state', 'unknown', L.reason);
  if (R.kind === 'unknown') return note('unknown-state', 'unknown', R.reason);
  // (b) ambiguous
  if (
    L.kind === 'ambiguous' ||
    ctx.ambiguousFolds.has(foldKey(record.path)) ||
    (newKey !== null && ctx.ambiguousFolds.has(foldKey(newKey)))
  ) {
    return note('ambiguous', 'ambiguous');
  }
  // (c), (d): Phase B records cannot exist in Phase A — never act on them.
  if (record.remoteOnly || record.native) {
    return note('unknown-state', 'phase-b', 'needs Google-native/release support (Phase B)');
  }

  const entry = L.kind === 'present' ? L.entry : null;
  let lChanged = false;
  let lMd5: string | null = null;
  if (entry) {
    const s = localState(ctx, record, entry);
    if (!s) return note('unknown-state', 'unknown', 'local file could not be hashed');
    lChanged = s.changed;
    lMd5 = s.md5;
  }
  const base = { key: record.path, local: entry, localMd5: lMd5, selection: {} };

  if (R.kind === 'trashed') {
    if (!entry) {
      return act({
        ...base,
        kind: 'forget',
        rule: 'B12',
        remote: null,
        selection: { remove: [record.path] },
      });
    }
    if (!lChanged) {
      return act({
        ...base,
        kind: 'trash-local',
        rule: 'B10',
        remote: null,
        selection: { remove: [record.path] },
      });
    }
    // Resume after a crash between upload and persistence: adopt the identical new upload.
    const others = (ctx.remoteByFold.get(foldKey(record.path)) ?? []).filter(
      (r) => !ctx.trackedIds.has(r.id),
    );
    const reuploaded = others.find((r) => r.md5 !== null && r.md5 === lMd5);
    if (reuploaded)
      return act({
        ...base,
        kind: 'adopt',
        rule: 'B11',
        remote: reuploaded,
        rebaseFrom: record.remoteId,
      });
    if (others.length > 0) {
      return note(
        'collision',
        'B11',
        'trashed in Drive, and a different Drive file now uses this name',
      );
    }
    return act({
      ...base,
      kind: 'upload-new',
      rule: 'B11',
      remote: null,
      rebaseFrom: record.remoteId,
    });
  }
  if (R.kind === 'moved-out') {
    note('moved-out', 'B13');
    return act({
      ...base,
      kind: 'untrack',
      rule: 'B13',
      remote: null,
      selection: { remove: [record.path], exclude: [record.path] },
    });
  }
  if (R.kind === 'unavailable') {
    return note('remote-unavailable', 'B14', 'clear it with sync_select remove');
  }

  const remote = R.entry;
  const rs = remoteState(record, remote);
  if (rs.weak) note('weak-compare', 'R', 'Drive has no md5; compared size and modifiedTime');

  if (!R.moved) {
    if (entry) {
      if (!rs.changed && !lChanged) {
        if (needsRefresh(record, entry, remote)) {
          return act({ ...base, kind: 'refresh', rule: 'B1', remote });
        }
        return out;
      }
      if (!rs.changed && lChanged) {
        if (!remote.canEdit) return note('remote-readonly', 'B2', 'no edit permission in Drive');
        return act({ ...base, kind: 'update-remote', rule: 'B2', remote });
      }
      if (rs.changed && !lChanged)
        return act({ ...base, kind: 'download-replace', rule: 'B3', remote });
      if (lMd5 !== null && lMd5 === remote.md5)
        return act({ ...base, kind: 'adopt', rule: 'B4', remote });
      if (!remote.canEdit)
        note('remote-readonly', 'B4', 'no edit permission; kept a conflict copy only');
      return act({ ...base, kind: 'conflict', rule: 'B4', remote, updateRemote: remote.canEdit });
    }
    if (!rs.changed) {
      if (!remote.canTrash) return note('cannot-trash', 'B5', 'no permission to trash it in Drive');
      return act({
        ...base,
        kind: 'trash-remote',
        rule: 'B5',
        remote,
        selection: { remove: [record.path] },
      });
    }
    return act({ ...base, kind: 'download-new', rule: 'B6', remote });
  }

  // present-moved (B7–B9)
  const target = remote.key;
  if (isExcluded(ctx, target)) {
    note('moved-into-excluded', 'B7-B9', `moved in Drive to excluded ${target}`);
    return act({
      ...base,
      kind: 'untrack',
      rule: 'B7-B9',
      remote: null,
      selection: { remove: [record.path], exclude: [record.path] },
    });
  }
  const blockers = (ctx.localByFold.get(foldKey(target)) ?? []).filter(
    (e) => !entry || e.ino !== entry.ino,
  );
  const [moved] = blockers;
  if (!entry && !rs.changed && blockers.length === 1 && moved) {
    // Resume after a crash between the local move and persistence: the file is already there.
    const md5 = ctx.input.md5s.get(moved.name);
    if (md5 === record.localMd5) {
      return act({
        ...base,
        key: target,
        kind: 'adopt',
        rule: 'B7-resume',
        local: moved,
        localMd5: md5,
        remote,
        selection: { remove: [record.path], add: [target] },
      });
    }
  }
  if (blockers.length > 0) {
    return note('collision', 'B7-B9', `moved in Drive to ${target}, which exists locally`);
  }
  const move = { remove: [record.path], add: [target] };
  if (entry && !lChanged) {
    const inPlace = ctx.ci && foldKey(record.path) === foldKey(target);
    return act({
      ...base,
      key: target,
      kind: 'move-local',
      rule: 'B7',
      remote,
      selection: move,
      inPlace,
      thenDownload: rs.changed,
    });
  }
  if (entry) {
    note(
      'conflict-rename',
      'B8',
      `renamed in Drive to ${target} while edited locally; local copy kept and excluded`,
    );
    return act({
      ...base,
      key: target,
      kind: 'download-new',
      rule: 'B8',
      remote,
      selection: { remove: [record.path], add: [target], exclude: [record.path] },
    });
  }
  return act({ ...base, key: target, kind: 'download-new', rule: 'B9', remote, selection: move });
}
```

- [ ] **Step 4: Run and see it pass** — `npx vitest run src/sync/__tests__/plan-tracked.test.ts` → PASS.

- [ ] **Step 5: Quality gate** — `npx prettier --write src/sync` then `npm run check` → typecheck, eslint (0 warnings), prettier and all tests green.

- [ ] **Step 6: Commit** —

```bash
git add src/sync
git commit -m "feat(sync): planner rules B1-B14 for tracked files" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

## Chunk 5: Planner — untracked keys and composition

### Task 9: Untracked keys: U0–U8, ambiguity and candidates

**Files:**
- Create: `src/sync/plan-untracked.ts`
- Test: `src/sync/__tests__/plan-untracked.test.ts`

- [ ] **Step 1: Write the failing tests.**

`src/sync/__tests__/plan-untracked.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { CANDIDATE_CAP, planUntracked, type Claims } from '../plan-untracked.js';
import { buildContext } from '../resolve.js';
import { localEntry, remoteEntry } from './fixtures.js';
import { planInput, type InputOptions } from './plan-input.js';

const NO_CLAIMS: Claims = { folds: new Set(), localNames: new Set() };
const NEW = '2026-11-03T00:00:00.000Z';
const RECENT = Date.parse('2026-11-02T12:00:00.000Z');

function run(o: InputOptions, claims: Claims = NO_CLAIMS) {
  return planUntracked(buildContext(planInput(o)), claims);
}

describe('untracked keys (spec §6.5)', () => {
  it('U0 excluded keys are ignored silently', () => {
    const result = run({
      pair: { excluded: ['a.pdf'] },
      local: [localEntry('a.pdf')],
      remote: [remoteEntry('n1', 'a.pdf')],
    });
    expect(result).toEqual({
      actions: [],
      notes: [],
      candidates: { local: [], remote: [], truncated: false },
    });
  });

  it('U0 under an unknown subtree → unknown-state', () => {
    const result = run({
      selection: ['dup/a.pdf'],
      unknownRemote: ['dup'],
      local: [localEntry('dup/a.pdf')],
    });
    expect(result.actions).toEqual([]);
    expect(result.notes[0]).toMatchObject({ code: 'unknown-state', rule: 'U0' });
  });

  it('U0 selected key occupied by a non-regular entry → unknown-state', () => {
    const result = run({ selection: ['a.pdf'], occupied: ['a.pdf'] });
    expect(result.notes[0]).toMatchObject({ code: 'unknown-state', rule: 'U0' });
  });

  it('U1 selected local file, nothing in Drive → upload-new', () => {
    const result = run({
      selection: ['a.pdf'],
      local: [localEntry('a.pdf')],
      md5s: [['a.pdf', 'm']],
    });
    expect(result.actions[0]).toMatchObject({
      kind: 'upload-new',
      rule: 'U1',
      key: 'a.pdf',
      localMd5: 'm',
      selection: {},
    });
  });

  it('U2 same content on both sides → adopt', () => {
    const result = run({
      selection: ['a.pdf'],
      local: [localEntry('a.pdf')],
      remote: [remoteEntry('n1', 'a.pdf', { md5: 'm' })],
      md5s: [['a.pdf', 'm']],
    });
    expect(result.actions[0]).toMatchObject({ kind: 'adopt', rule: 'U2', remote: { id: 'n1' } });
  });

  it('U2 different content → conflict', () => {
    const result = run({
      selection: ['a.pdf'],
      local: [localEntry('a.pdf')],
      remote: [remoteEntry('n1', 'a.pdf')],
      md5s: [['a.pdf', 'm']],
    });
    expect(result.actions[0]).toMatchObject({ kind: 'conflict', rule: 'U2', updateRemote: true });
  });

  it('U2 different content and read-only Drive file → report only', () => {
    const result = run({
      selection: ['a.pdf'],
      local: [localEntry('a.pdf')],
      remote: [remoteEntry('n1', 'a.pdf', { canEdit: false })],
      md5s: [['a.pdf', 'm']],
    });
    expect(result.actions).toEqual([]);
    expect(result.notes[0]).toMatchObject({ code: 'remote-readonly', rule: 'U2' });
  });

  it('U3 selected Drive file, no local → download-new', () => {
    const result = run({ selection: ['a.pdf'], remote: [remoteEntry('n1', 'a.pdf')] });
    expect(result.actions[0]).toMatchObject({ kind: 'download-new', rule: 'U3', key: 'a.pdf' });
  });

  it('U4 selected but nowhere → missing', () => {
    const result = run({ selection: ['a.pdf'] });
    expect(result.notes[0]).toMatchObject({ code: 'missing', rule: 'U4', path: 'a.pdf' });
  });

  it('U5 baseline Drive files stay candidates (by id, by baseline folder, before the first run)', () => {
    const byId = run({ pair: { remoteBaseline: ['n1'] }, remote: [remoteEntry('n1', 'a.pdf')] });
    expect(byId.actions).toEqual([]);
    expect(byId.candidates.remote).toEqual([
      { path: 'a.pdf', size: 10, modifiedTime: '2026-11-02T00:00:00.000Z', remoteId: 'n1' },
    ]);
    const byFolder = run({
      pair: { baselineFolders: ['folder:old'] },
      remote: [remoteEntry('n2', 'old/b.pdf')],
    });
    expect(byFolder.candidates.remote.map((c) => c.path)).toEqual(['old/b.pdf']);
    const firstRun = run({
      pair: { firstAppliedRunAt: null, lastAppliedRunAt: null },
      remote: [remoteEntry('n3', 'c.pdf')],
    });
    expect(firstRun.candidates.remote.map((c) => c.path)).toEqual(['c.pdf']);
  });

  it('U6 new Drive file after the first run → download-new and select', () => {
    const result = run({ remote: [remoteEntry('n1', 'a.pdf', { modifiedTime: NEW })] });
    expect(result.actions[0]).toMatchObject({
      kind: 'download-new',
      rule: 'U6',
      selection: { add: ['a.pdf'] },
    });
  });

  it('U7 new Drive file colliding with a local file → collision', () => {
    const result = run({
      remote: [remoteEntry('n1', 'a.pdf')],
      local: [localEntry('A.pdf')],
      onDisk: [['a.pdf', { kind: 'file', ino: 1 }]],
    });
    expect(result.actions).toEqual([]);
    expect(result.notes[0]).toMatchObject({ code: 'collision', rule: 'U7', remoteId: 'n1' });
  });

  it('U8 unselected local files are candidates when modified since the last run', () => {
    const result = run({
      local: [localEntry('old.pdf', { mtimeMs: 1000 }), localEntry('new.pdf', { mtimeMs: RECENT })],
    });
    expect(result.candidates.local).toEqual([
      { path: 'new.pdf', size: 10, modifiedTime: new Date(RECENT).toISOString() },
    ]);
    const first = run({
      pair: { lastAppliedRunAt: null },
      local: [localEntry('old.pdf', { mtimeMs: 1000 })],
    });
    expect(first.candidates.local.map((c) => c.path)).toEqual(['old.pdf']);
  });

  it(`U8 caps candidates at ${CANDIDATE_CAP}`, () => {
    const local = Array.from({ length: CANDIDATE_CAP + 1 }, (_, i) =>
      localEntry(`f${String(i).padStart(3, '0')}.pdf`, { mtimeMs: RECENT }),
    );
    const result = run({ local });
    expect(result.candidates.local).toHaveLength(CANDIDATE_CAP);
    expect(result.candidates.truncated).toBe(true);
  });

  it('duplicate keys on one side make every involved key ambiguous', () => {
    const result = run({
      selection: ['a.pdf'],
      local: [localEntry('a.pdf')],
      remote: [remoteEntry('n1', 'a.pdf'), remoteEntry('n2', 'a.pdf')],
      md5s: [['a.pdf', 'md5-n1']],
    });
    expect(result.actions).toEqual([]);
    expect(result.notes.map((n) => n.code)).toEqual(['ambiguous']);
  });

  it('keys claimed by a tracked record are collisions for untracked Drive files', () => {
    const claims: Claims = { folds: new Set(['a.pdf']), localNames: new Set(['a.pdf']) };
    const result = run(
      { local: [localEntry('a.pdf')], remote: [remoteEntry('n1', 'a.pdf')] },
      claims,
    );
    expect(result.actions).toEqual([]);
    expect(result.notes[0]).toMatchObject({ code: 'collision', rule: 'U-tracked' });
  });
});

describe('case and normalization across sides', () => {
  const NFD = 'şartname.pdf'.normalize('NFD');

  it('NFD local + NFC Drive name are the same key → adopt on equal md5', () => {
    const result = run({
      selection: ['şartname.pdf'],
      local: [localEntry(NFD)],
      remote: [remoteEntry('n1', 'şartname.pdf', { md5: 'm' })],
      md5s: [[NFD, 'm']],
    });
    expect(result.actions[0]).toMatchObject({ kind: 'adopt', key: 'şartname.pdf' });
  });

  it('Report.pdf vs report.pdf on a case-insensitive volume pairs them (record key = Drive key)', () => {
    const result = run({
      selection: ['Report.pdf'],
      local: [localEntry('Report.pdf')],
      remote: [remoteEntry('n1', 'report.pdf', { md5: 'm' })],
      md5s: [['Report.pdf', 'm']],
      onDisk: [['report.pdf', { kind: 'file', ino: 1 }]],
    });
    expect(result.actions[0]).toMatchObject({
      kind: 'adopt',
      key: 'report.pdf',
      selection: { remove: ['Report.pdf'], add: ['report.pdf'] },
    });
  });

  it('Report.pdf vs report.pdf without the volume confirming the match is ambiguous', () => {
    const result = run({
      selection: ['Report.pdf'],
      local: [localEntry('Report.pdf')],
      remote: [remoteEntry('n1', 'report.pdf', { md5: 'm' })],
      md5s: [['Report.pdf', 'm']],
    });
    expect(result.actions).toEqual([]);
    expect(result.notes.map((n) => n.code)).toEqual(['ambiguous', 'ambiguous']);
  });

  it('Report.pdf vs report.pdf on a case-sensitive volume is ambiguous', () => {
    const result = run({
      pair: { caseInsensitive: false },
      selection: ['Report.pdf'],
      local: [localEntry('Report.pdf')],
      remote: [remoteEntry('n1', 'report.pdf')],
      md5s: [['Report.pdf', 'm']],
    });
    expect(result.actions).toEqual([]);
    expect(result.notes.map((n) => [n.code, n.path])).toEqual([
      ['ambiguous', 'Report.pdf'],
      ['ambiguous', 'report.pdf'],
    ]);
  });
});

describe('review regressions', () => {
  it('U0: a selected key below a symlinked folder is unknown-state', () => {
    const result = run({
      selection: ['a/x.pdf'],
      blocking: ['a'],
      remote: [remoteEntry('n1', 'a/x.pdf')],
    });
    expect(result.actions).toEqual([]);
    expect(result.notes[0]).toMatchObject({ code: 'unknown-state', rule: 'U0' });
  });

  it('U1 reuses the Drive folder spelling on a case-insensitive volume (no second folder)', () => {
    const result = run({
      selection: ['docs/a.pdf'],
      local: [localEntry('docs/a.pdf')],
      folders: [['F-Docs', 'Docs']],
      md5s: [['docs/a.pdf', 'm']],
    });
    expect(result.actions[0]).toMatchObject({
      kind: 'upload-new',
      key: 'Docs/a.pdf',
      selection: { remove: ['docs/a.pdf'], add: ['Docs/a.pdf'] },
    });
  });

  it('U1 with a case-only folder mismatch on a case-sensitive volume is ambiguous', () => {
    const result = run({
      pair: { caseInsensitive: false },
      selection: ['docs/a.pdf'],
      local: [localEntry('docs/a.pdf')],
      folders: [['F-Docs', 'Docs']],
      md5s: [['docs/a.pdf', 'm']],
    });
    expect(result.actions).toEqual([]);
    expect(result.notes[0]).toMatchObject({ code: 'ambiguous', rule: 'U1' });
  });

  it('U8 counts ctime: a copied file with an old mtime is still a candidate', () => {
    const result = run({ local: [localEntry('copied.pdf', { mtimeMs: 1000, ctimeMs: RECENT })] });
    expect(result.candidates.local.map((c) => c.path)).toEqual(['copied.pdf']);
  });
});
```

- [ ] **Step 2: Run and see it fail** — `npx vitest run src/sync/__tests__/plan-untracked.test.ts` → FAIL: `../plan-untracked.js` cannot be resolved.

- [ ] **Step 3: Implement.**

`src/sync/plan-untracked.ts`:

```ts
import { baseName, foldKey, parentKey } from './paths.js';
import {
  isBlocked,
  isExcluded,
  isOccupied,
  isUnknownKey,
  sameFileOnDisk,
  type PlanContext,
} from './resolve.js';
import type { Action, Candidate, LocalEntry, Note, RemoteEntry, SelectionChange } from './types.js';

export const CANDIDATE_CAP = 200;

export interface UntrackedResult {
  actions: Action[];
  notes: Note[];
  candidates: { local: Candidate[]; remote: Candidate[]; truncated: boolean };
}

export interface Claims {
  folds: ReadonlySet<string>;
  localNames: ReadonlySet<string>;
}

function rename(from: string, to: string): SelectionChange {
  return from === to ? {} : { remove: [from], add: [to] };
}

function isBaseline(ctx: PlanContext, r: RemoteEntry): boolean {
  const { pair } = ctx.input;
  return (
    pair.firstAppliedRunAt === null ||
    pair.remoteBaseline.includes(r.id) ||
    r.ancestorIds.some((id) => pair.baselineFolders.includes(id))
  );
}

function isRecentLocal(ctx: PlanContext, l: LocalEntry): boolean {
  const last = ctx.input.pair.lastAppliedRunAt;
  // ctime too: cp -p, mv and ditto keep the old mtime of files that are new here.
  return last === null || Math.max(l.mtimeMs, l.ctimeMs) > Date.parse(last);
}

/**
 * Upload key for a local file: each parent folder takes the spelling of an existing Drive
 * folder with the same fold (case-insensitive volume), so a remote `Docs/` is reused for a
 * local `docs/`. Returns null on a case-sensitive volume when only the case differs.
 */
export function uploadKey(ctx: PlanContext, localKey: string): string | null {
  const folderByFold = new Map<string, string>();
  for (const key of ctx.input.remote.folders.values()) folderByFold.set(foldKey(key), key);
  let rebuilt = '';
  for (const seg of parentKey(localKey) === '' ? [] : parentKey(localKey).split('/')) {
    const candidate = rebuilt === '' ? seg : `${rebuilt}/${seg}`;
    const existing = folderByFold.get(foldKey(candidate));
    if (existing !== undefined && existing !== candidate && !ctx.ci) return null;
    rebuilt = existing ?? candidate;
  }
  return rebuilt === '' ? baseName(localKey) : `${rebuilt}/${baseName(localKey)}`;
}

/** Classifies every untracked key by fold (spec §6.5, U0–U8). First match wins. */
export function planUntracked(ctx: PlanContext, claims: Claims): UntrackedResult {
  const out: UntrackedResult = {
    actions: [],
    notes: [],
    candidates: { local: [], remote: [], truncated: false },
  };
  const recordFolds = new Set(ctx.input.records.map((r) => foldKey(r.path)));
  const folds = new Set<string>();
  for (const [fold] of ctx.selectionByFold) if (!recordFolds.has(fold)) folds.add(fold);
  for (const e of ctx.input.local.entries) if (!claims.localNames.has(e.name)) folds.add(e.foldKey);
  for (const r of ctx.input.remote.entries) if (!ctx.trackedIds.has(r.id)) folds.add(r.foldKey);

  for (const fold of [...folds].sort()) {
    const sel = recordFolds.has(fold) ? undefined : ctx.selectionByFold.get(fold);
    const locals = (ctx.localByFold.get(fold) ?? []).filter((e) => !claims.localNames.has(e.name));
    const remotes = (ctx.remoteByFold.get(fold) ?? []).filter((r) => !ctx.trackedIds.has(r.id));
    const key = sel ?? remotes[0]?.key ?? locals[0]?.key;
    if (key === undefined) continue;
    const note = (
      code: Note['code'],
      rule: string,
      message?: string,
      path = key,
      remoteId?: string,
    ): void => {
      out.notes.push({
        code,
        path,
        rule,
        ...(remoteId ? { remoteId } : {}),
        ...(message ? { message } : {}),
      });
    };

    if (claims.folds.has(fold)) {
      for (const r of remotes)
        note('collision', 'U-tracked', 'a tracked file uses this path', r.key, r.id);
      continue;
    }
    if (ctx.ambiguousFolds.has(fold)) {
      const paths = new Set([...locals.map((l) => l.key), ...remotes.map((r) => r.key)]);
      for (const p of [...paths].sort())
        note('ambiguous', 'ambiguous', 'several files share this name', p);
      continue;
    }
    // U0
    if (isExcluded(ctx, key)) continue;
    if (isUnknownKey(ctx, key)) {
      note('unknown-state', 'U0', 'inside a folder that could not be read');
      continue;
    }
    if (isBlocked(ctx, key)) {
      note('unknown-state', 'U0', 'a parent folder is a symlink, special file or ignored folder');
      continue;
    }
    const L = locals[0];
    const R = remotes[0];
    if (isOccupied(ctx, key) && !L) {
      if (sel !== undefined)
        note('unknown-state', 'U0', 'local path is occupied by a non-regular or ignored entry');
      else if (R)
        note('collision', 'U7', 'a local folder or special file uses this path', R.key, R.id);
      continue;
    }
    // Fold-only matches across sides (spec §6.1 step 2): ambiguous on a case-sensitive
    // volume; on a case-insensitive one only when the volume itself maps the other spelling
    // onto the local file (lstat hits the same inode) — never on our fold alone.
    const exact = new Set([sel, L?.key, R?.key].filter((k): k is string => k !== undefined));
    if (exact.size > 1) {
      const agreed =
        ctx.ci && (!L || [...exact].every((k) => k === L.key || sameFileOnDisk(ctx, k, L)));
      if (!agreed) {
        for (const p of [...exact].sort())
          note('ambiguous', 'ambiguous', 'names differ only in case', p);
        continue;
      }
    }
    const base = { record: null, selection: {} as SelectionChange };

    if (sel !== undefined) {
      if (L && !R) {
        const target = uploadKey(ctx, L.key);
        if (target === null) {
          note('ambiguous', 'U1', 'a Drive folder name differs only in case');
          continue;
        }
        out.actions.push({
          ...base,
          kind: 'upload-new',
          rule: 'U1',
          key: target,
          local: L,
          localMd5: ctx.input.md5s.get(L.name) ?? null,
          remote: null,
          selection: rename(sel, target),
        });
      } else if (L && R) {
        const lMd5 = ctx.input.md5s.get(L.name);
        if (lMd5 === undefined) note('unknown-state', 'U2', 'local file could not be hashed');
        else if (R.md5 !== null && lMd5 === R.md5) {
          out.actions.push({
            ...base,
            kind: 'adopt',
            rule: 'U2',
            key: R.key,
            local: L,
            localMd5: lMd5,
            remote: R,
            selection: rename(sel, R.key),
          });
        } else if (!R.canEdit) {
          note('remote-readonly', 'U2', 'differs from the Drive file, which you cannot edit');
        } else {
          out.actions.push({
            ...base,
            kind: 'conflict',
            rule: 'U2',
            key: R.key,
            local: L,
            localMd5: lMd5,
            remote: R,
            updateRemote: true,
            selection: rename(sel, R.key),
          });
        }
      } else if (R) {
        out.actions.push({
          ...base,
          kind: 'download-new',
          rule: 'U3',
          key: R.key,
          local: null,
          localMd5: null,
          remote: R,
          selection: rename(sel, R.key),
        });
      } else {
        note('missing', 'U4', 'selected but present on neither side');
      }
      continue;
    }
    if (R) {
      if (isBaseline(ctx, R)) {
        out.candidates.remote.push({
          path: R.key,
          size: R.size,
          modifiedTime: R.modifiedTime,
          remoteId: R.id,
        });
      } else if (L) {
        note('collision', 'U7', 'new in Drive, but a local file has the same name', R.key, R.id);
      } else {
        out.actions.push({
          ...base,
          kind: 'download-new',
          rule: 'U6',
          key: R.key,
          local: null,
          localMd5: null,
          remote: R,
          selection: { add: [R.key] },
        });
      }
      continue;
    }
    if (L && isRecentLocal(ctx, L)) {
      out.candidates.local.push({
        path: L.key,
        size: L.size,
        modifiedTime: new Date(L.mtimeMs).toISOString(),
      });
    }
  }
  const { local, remote } = out.candidates;
  out.candidates = {
    local: local.slice(0, CANDIDATE_CAP),
    remote: remote.slice(0, CANDIDATE_CAP),
    truncated: local.length > CANDIDATE_CAP || remote.length > CANDIDATE_CAP,
  };
  return out;
}
```

- [ ] **Step 4: Run and see it pass** — `npx vitest run src/sync/__tests__/plan-untracked.test.ts` → PASS.

- [ ] **Step 5: Quality gate** — `npx prettier --write src/sync` then `npm run check` → typecheck, eslint (0 warnings), prettier and all tests green.

- [ ] **Step 6: Commit** —

```bash
git add src/sync
git commit -m "feat(sync): planner rules U0-U8, ambiguity and candidates" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 10: Planner: composition, brake, planId, baseline, §11 regressions

**Files:**
- Create: `src/sync/planner.ts`
- Test: `src/sync/__tests__/planner.test.ts`

- [ ] **Step 1: Write the failing tests.**

`src/sync/__tests__/planner.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { brakeFor, computePlanId, plan } from '../planner.js';
import type { Action } from '../types.js';
import { localEntry, record, remoteEntry } from './fixtures.js';
import { planInput } from './plan-input.js';

function trash(kind: 'trash-remote' | 'trash-local', n: number): Action[] {
  return Array.from({ length: n }, (_, i) => ({
    kind,
    rule: kind === 'trash-remote' ? 'B5' : 'B10',
    key: `f${i}`,
    record: null,
    local: null,
    localMd5: null,
    remote: null,
    selection: {},
  }));
}

afterEach(() => {
  vi.useRealTimers();
});

describe('plan composition', () => {
  it('orders actions by execution stage, then key', () => {
    const p = plan(
      planInput({
        records: [record('r1', 'b.pdf'), record('r2', 'a.pdf')],
        selection: ['up.pdf'],
        local: [localEntry('b.pdf'), localEntry('up.pdf')],
        remote: [remoteEntry('r2', 'a.pdf', { md5: 'changed' })],
        probes: [['r1', { state: 'trashed' }]],
        md5s: [['up.pdf', 'u']],
      }),
    );
    expect(p.actions.map((a) => [a.kind, a.key])).toEqual([
      ['upload-new', 'up.pdf'],
      ['download-new', 'a.pdf'],
      ['trash-local', 'b.pdf'],
    ]);
  });

  it('reports native-skipped and unrepresentable Drive files', () => {
    const p = plan(
      planInput({
        ignored: [
          { id: 'g1', path: 'Plan', reason: 'native-skipped', isFolder: false },
          { id: 'u1', path: 'a/b', reason: 'unrepresentable', isFolder: false },
          { id: 's1', path: 'link', reason: 'shortcut', isFolder: false },
        ],
      }),
    );
    expect(p.notes.map((n) => [n.code, n.path])).toEqual([
      ['native-skipped', 'Plan'],
      ['unrepresentable', 'a/b'],
    ]);
  });

  it('computes the first-run baseline from every untracked Drive file, unknown and ignored folder', () => {
    const p = plan(
      planInput({
        pair: { firstAppliedRunAt: null, lastAppliedRunAt: null },
        records: [record('r1', 'a.pdf')],
        local: [localEntry('a.pdf')],
        remote: [
          remoteEntry('r1', 'a.pdf'),
          remoteEntry('n1', 'n.pdf'),
          remoteEntry('d1', 'x.pdf'),
          remoteEntry('d2', 'X.pdf'),
        ],
        ignored: [
          { id: 'g1', path: 'Plan', reason: 'native-skipped', isFolder: false },
          { id: 'f9', path: '.git', reason: 'ignored-name', isFolder: true },
        ],
        unknownFolderIds: ['dupF'],
      }),
    );
    expect(p.baseline).toEqual({ files: ['d1', 'd2', 'g1', 'n1'], folders: ['dupF', 'f9'] });
  });
});

describe('mass-delete brake (spec §6.8)', () => {
  it('trips above max(10, 20% of tracked)', () => {
    expect(brakeFor(trash('trash-remote', 10), 100).tripped).toBe(false);
    expect(brakeFor(trash('trash-remote', 11), 30).tripped).toBe(true);
    expect(brakeFor([...trash('trash-remote', 10), ...trash('trash-local', 10)], 100).tripped).toBe(
      false,
    );
    expect(brakeFor([...trash('trash-remote', 11), ...trash('trash-local', 10)], 100).tripped).toBe(
      true,
    );
  });

  it('trips when every tracked file of one side would go (≥ 3 tracked)', () => {
    expect(brakeFor(trash('trash-local', 3), 3)).toEqual({
      tripped: true,
      trashRemote: 0,
      trashLocal: 3,
      tracked: 3,
    });
    expect(brakeFor(trash('trash-remote', 3), 3).tripped).toBe(true);
    expect(brakeFor(trash('trash-remote', 2), 2).tripped).toBe(false);
    expect(brakeFor(trash('trash-remote', 2), 3).tripped).toBe(false);
  });

  it('is computed for a plan, ignoring remote-only records in the count', () => {
    const records = ['a', 'b', 'c'].map((n) => record(`r-${n}`, `${n}.pdf`));
    const p = plan(
      planInput({ records, remote: records.map((k) => remoteEntry(k.remoteId, k.path)) }),
    );
    expect(p.brake).toEqual({ tripped: true, trashRemote: 3, trashLocal: 0, tracked: 3 });
  });
});

describe('planId (spec §5)', () => {
  const input = () =>
    planInput({
      records: [record('r1', 'a.pdf')],
      selection: ['b.pdf'],
      local: [localEntry('a.pdf', { size: 12, mtimeMs: 5 }), localEntry('b.pdf')],
      remote: [remoteEntry('r1', 'a.pdf', { md5: 'remote' })],
      md5s: [
        ['a.pdf', 'local'],
        ['b.pdf', 'bb'],
      ],
    });

  it('is stable across minute boundaries and ignores refresh-only changes', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-03T10:59:59.900Z'));
    const first = plan(input());
    vi.setSystemTime(new Date('2026-11-03T11:00:00.100Z'));
    const second = plan(input());
    expect(second.planId).toBe(first.planId);
    expect(first.planId).toMatch(/^[0-9a-f]{64}$/);
    expect(first.actions.map((a) => a.kind)).toEqual(['upload-new', 'conflict']);
    const withRefresh: Action = { ...first.actions[0]!, kind: 'refresh' };
    expect(computePlanId([...first.actions, withRefresh])).toBe(first.planId);
  });

  it('changes when content changes', () => {
    const changed = input();
    const md5s = new Map(changed.md5s);
    md5s.set('a.pdf', 'local-2');
    expect(plan({ ...changed, md5s }).planId).not.toBe(plan(input()).planId);
  });
});

describe('regressions (spec §11, Phase A)', () => {
  it('baseline candidates never auto-download on later runs (U5)', () => {
    const p = plan(
      planInput({ pair: { remoteBaseline: ['n1'] }, remote: [remoteEntry('n1', 'old.pdf')] }),
    );
    expect(p.actions).toEqual([]);
    expect(p.candidates.remote.map((c) => c.path)).toEqual(['old.pdf']);
  });

  it('a local case-only rename does not trash the Drive file', () => {
    const k = record('r1', 'Report.pdf');
    const ci = plan(
      planInput({
        records: [k],
        local: [localEntry('report.pdf')],
        remote: [remoteEntry('r1', 'Report.pdf')],
        onDisk: [['Report.pdf', { kind: 'file', ino: 1 }]],
      }),
    );
    expect(ci.actions.map((a) => [a.kind, a.local?.name])).toEqual([['refresh', 'report.pdf']]);
    const cs = plan(
      planInput({
        pair: { caseInsensitive: false },
        records: [k],
        local: [localEntry('report.pdf')],
        remote: [remoteEntry('r1', 'Report.pdf')],
      }),
    );
    expect(cs.actions).toEqual([]);
    expect(cs.notes.map((n) => n.code)).toContain('ambiguous');
  });

  it('an unknown local subtree never yields trash-remote', () => {
    const k = record('r1', 'locked/a.pdf');
    const p = plan(
      planInput({
        records: [k],
        unknownLocal: ['locked'],
        remote: [remoteEntry('r1', 'locked/a.pdf')],
      }),
    );
    expect(p.actions).toEqual([]);
    expect(p.notes[0]).toMatchObject({ code: 'unknown-state', path: 'locked/a.pdf' });
  });

  it('an ambiguous Drive folder never yields untrack', () => {
    const k = record('r1', 'dup/a.pdf');
    const p = plan(
      planInput({
        records: [k],
        local: [localEntry('dup/a.pdf')],
        unknownRemote: ['dup'],
        unknownFolderIds: ['d1', 'd2'],
        probes: [['r1', { state: 'moved-out' }]],
      }),
    );
    expect(p.actions).toEqual([]);
    expect(p.notes[0]).toMatchObject({ code: 'unknown-state' });
  });

  it('P5: Turkish ılık.pdf is not the deleted ilik.pdf (no upload of unrelated content)', () => {
    const k = record('r1', 'ilik.pdf');
    const p = plan(
      planInput({
        pair: { lastAppliedRunAt: null },
        records: [k],
        local: [localEntry('ılık.pdf', { ino: 9 })],
        remote: [remoteEntry('r1', 'ilik.pdf')],
      }),
    );
    expect(p.actions.map((a) => [a.kind, a.key])).toEqual([['trash-remote', 'ilik.pdf']]);
    expect(p.candidates.local.map((c) => c.path)).toEqual(['ılık.pdf']);
    expect(p.actions.some((a) => a.kind === 'update-remote' || a.kind === 'conflict')).toBe(false);
  });

  it('a fold match the volume does not confirm is ambiguous, never written over', () => {
    const k = record('r1', 'Report.pdf', { localMd5: 'old' });
    const p = plan(
      planInput({
        records: [k],
        local: [localEntry('report.pdf', { size: 99 })],
        remote: [remoteEntry('r1', 'Report.pdf', { md5: 'old' })],
        md5s: [['report.pdf', 'unrelated']],
        onDisk: [['Report.pdf', { kind: 'file', ino: 2 }]],
      }),
    );
    expect(p.actions).toEqual([]);
    expect(p.notes.map((n) => n.code)).toEqual(['ambiguous']);
  });

  it('a remote-only record (Phase B data) is never trashed in Phase A', () => {
    const k = record('r1', 'a.pdf', { remoteOnly: true });
    const p = plan(planInput({ records: [k], remote: [remoteEntry('r1', 'a.pdf')] }));
    expect(p.actions).toEqual([]);
  });
});
```

- [ ] **Step 2: Run and see it fail** — `npx vitest run src/sync/__tests__/planner.test.ts` → FAIL: `../planner.js` cannot be resolved.

- [ ] **Step 3: Implement.**

`src/sync/planner.ts`:

```ts
import { createHash } from 'node:crypto';
import { planTracked } from './plan-tracked.js';
import { planUntracked } from './plan-untracked.js';
import { buildContext, type PlanInput } from './resolve.js';
import type { Action, ActionKind, BrakeInfo, Note, Plan } from './types.js';

export type { PlanInput } from './resolve.js';

const KIND_ORDER: ActionKind[] = [
  'adopt',
  'forget',
  'untrack',
  'refresh',
  'upload-new',
  'update-remote',
  'move-local',
  'download-new',
  'download-replace',
  'conflict',
  'trash-remote',
  'trash-local',
];

function byKindThenKey(a: Action, b: Action): number {
  const k = KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind);
  if (k !== 0) return k;
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
}

/** Spec §6.8. */
export function brakeFor(actions: readonly Action[], tracked: number): BrakeInfo {
  const trashRemote = actions.filter((a) => a.kind === 'trash-remote').length;
  const trashLocal = actions.filter((a) => a.kind === 'trash-local').length;
  const tripped =
    trashRemote + trashLocal > Math.max(10, 0.2 * tracked) ||
    (tracked >= 3 && (trashRemote === tracked || trashLocal === tracked));
  return { tripped, trashRemote, trashLocal, tracked };
}

/**
 * SHA-256 over the canonical `(kind, remoteId, key, local md5, remote md5)` list of
 * every non-refresh action — no generated names or timestamps (spec §5 step 5).
 */
export function computePlanId(actions: readonly Action[]): string {
  const rows = actions
    .filter((a) => a.kind !== 'refresh')
    .map((a) =>
      JSON.stringify([
        a.kind,
        a.record?.remoteId ?? a.remote?.id ?? '',
        a.key,
        a.localMd5 ?? '',
        a.remote?.md5 ?? '',
      ]),
    )
    .sort();
  return createHash('sha256').update(rows.join('\n')).digest('hex');
}

/** PURE planner (spec §6): tracked records first, then untracked keys. */
export function plan(input: PlanInput): Plan {
  const ctx = buildContext(input);
  const actions: Action[] = [];
  const notes: Note[] = [];
  const claimedFolds = new Set<string>();
  const claimedLocal = new Set<string>();
  const records = [...input.records].sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
  );
  for (const record of records) {
    const result = planTracked(ctx, record);
    actions.push(...result.actions);
    notes.push(...result.notes);
    for (const f of result.claimedFolds) claimedFolds.add(f);
    if (result.claimedLocal !== null) claimedLocal.add(result.claimedLocal);
  }
  const untracked = planUntracked(ctx, { folds: claimedFolds, localNames: claimedLocal });
  actions.push(...untracked.actions);
  notes.push(...untracked.notes);

  for (const ignored of input.remote.ignored) {
    if (ctx.trackedIds.has(ignored.id)) continue;
    if (ignored.reason === 'native-skipped') {
      notes.push({
        code: 'native-skipped',
        path: ignored.path,
        rule: 'ignored',
        remoteId: ignored.id,
        message: 'Google Docs/Sheets/Slides sync arrives in Phase B',
      });
    } else if (ignored.reason === 'unrepresentable') {
      notes.push({
        code: 'unrepresentable',
        path: ignored.path,
        rule: 'ignored',
        remoteId: ignored.id,
        message: 'name cannot be a local file name',
      });
    }
  }

  actions.sort(byKindThenKey);
  const tracked = input.records.filter((r) => !r.remoteOnly).length;
  const baselineFiles = [
    ...input.remote.entries.map((r) => r.id),
    ...input.remote.ignored.filter((i) => !i.isFolder).map((i) => i.id),
  ].filter((id) => !ctx.trackedIds.has(id));
  return {
    planId: computePlanId(actions),
    actions,
    notes,
    candidates: untracked.candidates,
    brake: brakeFor(actions, tracked),
    baseline: {
      files: [...new Set(baselineFiles)].sort(),
      folders: [
        ...input.remote.unknownFolderIds,
        ...input.remote.ignored.filter((i) => i.isFolder).map((i) => i.id),
      ].sort(),
    },
  };
}
```

- [ ] **Step 4: Run and see it pass** — `npx vitest run src/sync/__tests__/planner.test.ts` → PASS.

- [ ] **Step 5: Quality gate** — `npx prettier --write src/sync` then `npm run check` → typecheck, eslint (0 warnings), prettier and all tests green.

- [ ] **Step 6: Commit** —

```bash
git add src/sync
git commit -m "feat(sync): pure planner with mass-delete brake, stable planId and baseline" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

## Chunk 6: Local trash and transfers

### Task 11: Local trash and transfers

**Files:**
- Create: `src/sync/trash.ts`, `src/sync/transfer.ts`
- Test: `src/sync/__tests__/trash.test.ts`, `src/sync/__tests__/transfer.test.ts`

`trashLocal` is the only way sync deletes a local user file; it never unlinks. Tests inject the `ExecFn`, so the real `/usr/bin/trash` is never run.

- [ ] **Step 1: Write the failing tests.**

`src/sync/__tests__/trash.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { ValidationError } from '../../errors.js';
import { LocalTrashError } from '../errors.js';
import { TRASH_BIN, trashLocal, type ExecFn } from '../trash.js';

describe('trashLocal', () => {
  it('runs /usr/bin/trash -s with exactly one path, no shell', async () => {
    const exec = vi.fn<ExecFn>(async () => ({ stdout: '', stderr: '' }));
    await trashLocal('/Users/x/Docs/a b.pdf', exec);
    expect(TRASH_BIN).toBe('/usr/bin/trash');
    expect(exec).toHaveBeenCalledWith('/usr/bin/trash', ['-s', '/Users/x/Docs/a b.pdf']);
  });

  it('fails the action on a non-zero exit', async () => {
    const exec = vi.fn<ExecFn>(async () => {
      throw Object.assign(new Error('Command failed'), { code: 1 });
    });
    await expect(trashLocal('/Volumes/smb/a.pdf', exec)).rejects.toBeInstanceOf(LocalTrashError);
  });

  it('rejects relative paths', async () => {
    const exec = vi.fn<ExecFn>();
    await expect(trashLocal('a.pdf', exec)).rejects.toBeInstanceOf(ValidationError);
    expect(exec).not.toHaveBeenCalled();
  });
});
```

`src/sync/__tests__/transfer.test.ts`:

```ts
import { createHash } from 'node:crypto';
import { link, lstat, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createFakeDrive } from '../../files/__tests__/fakes.js';
import { ChecksumMismatchError, CollisionError, TargetChangedError } from '../errors.js';
import {
  downloadReplace,
  moveLocal,
  placeExclusive,
  updateContent,
  uploadNew,
  type StatExpect,
} from '../transfer.js';
import { SYNC_FILE_FIELDS } from '../types.js';

const md5 = (s: string): string => createHash('md5').update(s).digest('hex');
const source = (s: string) => async (): Promise<Readable> => Readable.from([Buffer.from(s)]);
let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'sync-transfer-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function statOf(p: string): Promise<StatExpect> {
  const s = await lstat(p);
  return { size: s.size, mtimeMs: s.mtimeMs, ctimeMs: s.ctimeMs };
}

async function leftovers(): Promise<string[]> {
  return (await readdir(dir)).filter((n) => n.endsWith('.marvin-part'));
}

describe('placeExclusive', () => {
  it('writes a new file and verifies md5', async () => {
    const out = await placeExclusive(dir, () => 'a.pdf', source('hello'), {
      expectedMd5: md5('hello'),
    });
    expect(out).toEqual({ path: path.join(dir, 'a.pdf'), md5: md5('hello'), size: 5 });
    expect(await readFile(out.path, 'utf8')).toBe('hello');
    expect(await leftovers()).toEqual([]);
  });

  it('never overwrites: an existing target is a collision', async () => {
    await writeFile(path.join(dir, 'a.pdf'), 'mine');
    await expect(placeExclusive(dir, () => 'a.pdf', source('theirs'))).rejects.toBeInstanceOf(
      CollisionError,
    );
    expect(await readFile(path.join(dir, 'a.pdf'), 'utf8')).toBe('mine');
    expect(await leftovers()).toEqual([]);
  });

  it('tries numbered names when allowed', async () => {
    await writeFile(path.join(dir, 'c.pdf'), 'x');
    const names = (i: number): string => (i === 0 ? 'c.pdf' : `c ${i + 1}.pdf`);
    const out = await placeExclusive(dir, names, source('y'), { maxAttempts: 5 });
    expect(path.basename(out.path)).toBe('c 2.pdf');
  });

  it('removes the temp file on a checksum mismatch', async () => {
    await expect(
      placeExclusive(dir, () => 'a.pdf', source('hello'), { expectedMd5: 'nope' }),
    ).rejects.toBeInstanceOf(ChecksumMismatchError);
    expect(await readdir(dir)).toEqual([]);
  });

  it('falls back to exists-check + rename where hard links are unsupported', async () => {
    const noLink = async (): Promise<void> => {
      throw Object.assign(new Error('nope'), { code: 'ENOTSUP' });
    };
    const out = await placeExclusive(dir, () => 'a.pdf', source('hi'), { link: noLink });
    expect(await readFile(out.path, 'utf8')).toBe('hi');
    await expect(
      placeExclusive(dir, () => 'a.pdf', source('again'), { link: noLink }),
    ).rejects.toBeInstanceOf(CollisionError);
  });
});

describe('downloadReplace', () => {
  it('replaces the tracked file when unchanged since the scan', async () => {
    const target = path.join(dir, 'a.pdf');
    await writeFile(target, 'old');
    const res = await downloadReplace(target, source('new'), {
      expect: await statOf(target),
      expectedMd5: md5('new'),
    });
    expect(res).toEqual({ md5: md5('new'), size: 3 });
    expect(await readFile(target, 'utf8')).toBe('new');
    expect(await leftovers()).toEqual([]);
  });

  it('aborts before downloading when the file changed', async () => {
    const target = path.join(dir, 'a.pdf');
    await writeFile(target, 'old');
    const expect0 = await statOf(target);
    await writeFile(target, 'edited!');
    await expect(
      downloadReplace(target, source('new'), { expect: expect0, expectedMd5: null }),
    ).rejects.toBeInstanceOf(TargetChangedError);
    expect(await readFile(target, 'utf8')).toBe('edited!');
  });

  it('aborts at rename time when the file changed during the download', async () => {
    const target = path.join(dir, 'a.pdf');
    await writeFile(target, 'old');
    const expect0 = await statOf(target);
    const racing = async (): Promise<Readable> => {
      await writeFile(target, 'edited during download');
      return Readable.from([Buffer.from('new')]);
    };
    await expect(
      downloadReplace(target, racing, { expect: expect0, expectedMd5: null }),
    ).rejects.toBeInstanceOf(TargetChangedError);
    expect(await readFile(target, 'utf8')).toBe('edited during download');
    expect(await leftovers()).toEqual([]);
  });

  it('keeps the old file on a checksum mismatch', async () => {
    const target = path.join(dir, 'a.pdf');
    await writeFile(target, 'old');
    await expect(
      downloadReplace(target, source('new'), { expect: await statOf(target), expectedMd5: 'x' }),
    ).rejects.toBeInstanceOf(ChecksumMismatchError);
    expect(await readFile(target, 'utf8')).toBe('old');
  });
});

describe('moveLocal', () => {
  it('moves via link + unlink', async () => {
    const from = path.join(dir, 'a.pdf');
    await writeFile(from, 'x');
    await moveLocal(from, path.join(dir, 'b.pdf'), { inPlace: false, expect: await statOf(from) });
    expect(await readdir(dir)).toEqual(['b.pdf']);
  });

  it('renames in place for case-only changes', async () => {
    const from = path.join(dir, 'a.pdf');
    await writeFile(from, 'x');
    await moveLocal(from, path.join(dir, 'A.pdf'), { inPlace: true, expect: await statOf(from) });
    expect(await readdir(dir)).toEqual(['A.pdf']);
  });

  it('resumes after a crash between link and unlink', async () => {
    const from = path.join(dir, 'a.pdf');
    await writeFile(from, 'x');
    await link(from, path.join(dir, 'b.pdf'));
    await moveLocal(from, path.join(dir, 'b.pdf'), { inPlace: false, expect: await statOf(from) });
    expect(await readdir(dir)).toEqual(['b.pdf']);
  });

  it('refuses to overwrite another file and skips a changed source', async () => {
    const from = path.join(dir, 'a.pdf');
    await writeFile(from, 'x');
    await writeFile(path.join(dir, 'b.pdf'), 'other');
    await expect(
      moveLocal(from, path.join(dir, 'b.pdf'), { inPlace: false, expect: await statOf(from) }),
    ).rejects.toBeInstanceOf(CollisionError);
    await expect(
      moveLocal(from, path.join(dir, 'c.pdf'), {
        inPlace: false,
        expect: { size: 99, mtimeMs: 0, ctimeMs: 0 },
      }),
    ).rejects.toBeInstanceOf(TargetChangedError);
    expect((await readdir(dir)).sort()).toEqual(['a.pdf', 'b.pdf']);
  });
});

describe('Drive transfers', () => {
  it('uploadNew creates the file with media and sync fields', async () => {
    const drive = createFakeDrive();
    drive.createFile.mockResolvedValueOnce({ id: 'n1' });
    const abs = path.join(dir, 'a.pdf');
    await writeFile(abs, 'x');
    await expect(uploadNew(drive, { abs, name: 'a.pdf', parentId: 'P' })).resolves.toEqual({
      id: 'n1',
    });
    const call = drive.createFile.mock.calls[0]?.[0];
    expect(call?.requestBody).toEqual({ name: 'a.pdf', parents: ['P'] });
    expect(call?.media?.mimeType).toBe('application/pdf');
    expect(call?.fields).toBe(SYNC_FILE_FIELDS);
  });

  it('updateContent sends new media for the same fileId', async () => {
    const drive = createFakeDrive();
    drive.updateFile.mockResolvedValueOnce({ id: 'r1' });
    const abs = path.join(dir, 'a.txt');
    await writeFile(abs, 'x');
    await updateContent(drive, { fileId: 'r1', abs });
    const call = drive.updateFile.mock.calls[0]?.[0];
    expect(call).toMatchObject({ fileId: 'r1', fields: SYNC_FILE_FIELDS });
    expect(call?.media?.mimeType).toBe('text/plain');
  });
});

describe('moveLocal on folding volumes (review regressions)', () => {
  it('never deletes the only copy when the volume folds the two names (ß → SS)', async () => {
    const from = path.join(dir, 'straße.pdf');
    await writeFile(from, 'only copy');
    await moveLocal(from, path.join(dir, 'STRASSE.pdf'), {
      inPlace: false,
      expect: await statOf(from),
    });
    expect(await readdir(dir)).toEqual(['STRASSE.pdf']);
    expect(await readFile(path.join(dir, 'STRASSE.pdf'), 'utf8')).toBe('only copy');
  });

  it('never deletes the only copy on a case-only change either', async () => {
    const from = path.join(dir, 'report.pdf');
    await writeFile(from, 'only copy');
    await moveLocal(from, path.join(dir, 'Report.pdf'), {
      inPlace: false,
      expect: await statOf(from),
    });
    expect(await readdir(dir)).toEqual(['Report.pdf']);
    expect(await readFile(path.join(dir, 'Report.pdf'), 'utf8')).toBe('only copy');
  });

  it('in place: refuses a target that is another file', async () => {
    const from = path.join(dir, 'a.pdf');
    await writeFile(from, 'x');
    await writeFile(path.join(dir, 'b.pdf'), 'other');
    await expect(
      moveLocal(from, path.join(dir, 'b.pdf'), { inPlace: true, expect: await statOf(from) }),
    ).rejects.toBeInstanceOf(CollisionError);
    expect(await readFile(path.join(dir, 'b.pdf'), 'utf8')).toBe('other');
  });
});
```

- [ ] **Step 2: Run and see it fail** — `npx vitest run src/sync/__tests__/trash.test.ts src/sync/__tests__/transfer.test.ts` → FAIL: `../trash.js` and `../transfer.js` cannot be resolved.

- [ ] **Step 3: Implement.**

`src/sync/trash.ts`:

```ts
import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { ValidationError } from '../errors.js';
import { LocalTrashError } from './errors.js';

/** Runs a program without a shell; rejects on a non-zero exit. */
export type ExecFn = (file: string, args: readonly string[]) => Promise<unknown>;

export const TRASH_BIN = '/usr/bin/trash';

const execFileAsync = promisify(execFile);

export const defaultExec: ExecFn = (file, args) => execFileAsync(file, [...args]);

/** Moves one path to the macOS Trash via `/usr/bin/trash -s` (spec §7). Never unlinks. */
export async function trashLocal(absPath: string, exec: ExecFn = defaultExec): Promise<void> {
  if (!path.isAbsolute(absPath)) {
    throw new ValidationError(`trash needs an absolute path (got "${absPath}")`);
  }
  try {
    await exec(TRASH_BIN, ['-s', absPath]);
  } catch (err) {
    throw new LocalTrashError(
      `Could not move ${absPath} to the Trash (volumes without a Trash are not supported)`,
      { cause: err },
    );
  }
}
```

`src/sync/transfer.ts`:

```ts
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { link as fsLink, lstat, open, readdir, rename, rm, unlink } from 'node:fs/promises';
import path from 'node:path';
import type { Readable } from 'node:stream';
import type { DriveAdapter, DriveFile } from '../drive/drive-adapter.js';
import { hasErrorCode } from '../errors.js';
import { uploadMimeType } from '../files/upload-mime.js';
import { ChecksumMismatchError, CollisionError, TargetChangedError } from './errors.js';
import { PART_SUFFIX } from './paths.js';
import { SYNC_FILE_FIELDS } from './types.js';

export type LinkFn = (existingPath: string, newPath: string) => Promise<void>;

export interface StatExpect {
  size: number;
  mtimeMs: number;
  ctimeMs: number;
}

export interface Written {
  path: string;
  md5: string;
  size: number;
}

const LINK_UNSUPPORTED = ['EPERM', 'ENOTSUP', 'EXDEV', 'ENOSYS'];

async function exists(p: string): Promise<boolean> {
  try {
    await lstat(p);
    return true;
  } catch (err) {
    if (hasErrorCode(err, 'ENOENT')) return false;
    throw err;
  }
}

/** Streams `source` into a fresh `.<uuid>.marvin-part` in `dir`, hashing and fsyncing it. */
async function writeTemp(
  dir: string,
  source: Readable,
): Promise<{ tmp: string; md5: string; size: number }> {
  const tmp = path.join(dir, `.${randomUUID()}${PART_SUFFIX}`);
  const handle = await open(tmp, 'wx', 0o644);
  const hash = createHash('md5');
  let size = 0;
  try {
    for await (const chunk of source) {
      const buf = typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer);
      hash.update(buf);
      size += buf.length;
      await handle.write(buf);
    }
    await handle.sync();
  } catch (err) {
    source.destroy();
    await handle.close().catch(() => undefined);
    await rm(tmp, { force: true });
    throw err;
  }
  await handle.close();
  return { tmp, md5: hash.digest('hex'), size };
}

/** fsync a directory so a new entry survives a crash (best effort where unsupported). */
export async function syncDir(dir: string): Promise<void> {
  const handle = await open(dir, 'r');
  try {
    await handle.sync();
  } catch (err) {
    if (!['EINVAL', 'ENOTSUP', 'EISDIR', 'EBADF'].some((c) => hasErrorCode(err, c))) throw err;
  } finally {
    await handle.close();
  }
}

/** Throws TargetChangedError unless `target` is a regular file with the expected stat. */
export async function assertUnchanged(target: string, expect: StatExpect): Promise<void> {
  let info;
  try {
    info = await lstat(target);
  } catch (err) {
    if (hasErrorCode(err, 'ENOENT')) throw new TargetChangedError(`${target} was removed`);
    throw err;
  }
  if (
    !info.isFile() ||
    info.size !== expect.size ||
    info.mtimeMs !== expect.mtimeMs ||
    info.ctimeMs !== expect.ctimeMs
  ) {
    throw new TargetChangedError(`${target} changed since it was scanned`);
  }
}

export interface PlaceOptions {
  /** Verify the written bytes (null/undefined: no check). */
  expectedMd5?: string | null;
  /** Names tried: nameFor(0), nameFor(1)…; default 1 (plain exclusive create). */
  maxAttempts?: number;
  link?: LinkFn;
}

/**
 * Exclusive local write (spec §7): temp `.marvin-part` + `link` + EEXIST → next name or
 * CollisionError. Never overwrites. `dir` must already exist (see prepareParent).
 */
export async function placeExclusive(
  dir: string,
  nameFor: (attempt: number) => string,
  openSource: () => Promise<Readable>,
  opts: PlaceOptions = {},
): Promise<Written> {
  const link = opts.link ?? fsLink;
  const { tmp, md5, size } = await writeTemp(dir, await openSource());
  try {
    if (opts.expectedMd5 && md5 !== opts.expectedMd5) {
      throw new ChecksumMismatchError(nameFor(0), opts.expectedMd5, md5);
    }
    const attempts = opts.maxAttempts ?? 1;
    for (let i = 0; i < attempts; i++) {
      const target = path.join(dir, nameFor(i));
      try {
        await link(tmp, target);
      } catch (err) {
        if (hasErrorCode(err, 'EEXIST')) continue;
        if (!LINK_UNSUPPORTED.some((code) => hasErrorCode(err, code))) throw err;
        if (await exists(target)) continue;
        await rename(tmp, target);
      }
      await syncDir(dir);
      return { path: target, md5, size };
    }
    throw new CollisionError(path.join(dir, nameFor(0)));
  } finally {
    await rm(tmp, { force: true });
  }
}

/**
 * Overwrites a tracked file's own path (spec §7): only if its stat still matches the
 * scan, both before the download and right before the rename.
 */
export async function downloadReplace(
  target: string,
  openSource: () => Promise<Readable>,
  opts: { expect: StatExpect; expectedMd5: string | null },
): Promise<{ md5: string; size: number }> {
  await assertUnchanged(target, opts.expect);
  const { tmp, md5, size } = await writeTemp(path.dirname(target), await openSource());
  try {
    if (opts.expectedMd5 && md5 !== opts.expectedMd5) {
      throw new ChecksumMismatchError(target, opts.expectedMd5, md5);
    }
    await assertUnchanged(target, opts.expect);
    await rename(tmp, target);
  } finally {
    await rm(tmp, { force: true });
  }
  return { md5, size };
}

/** True when `a` and `b` are two different directory entries (not one name folded twice). */
async function distinctEntries(a: string, b: string): Promise<boolean> {
  const [dirA, dirB] = await Promise.all([lstat(path.dirname(a)), lstat(path.dirname(b))]);
  if (dirA.ino !== dirB.ino) return true;
  const names = await readdir(path.dirname(a));
  const nameA = path.basename(a);
  const nameB = path.basename(b);
  return nameA !== nameB && names.includes(nameA) && names.includes(nameB);
}

/**
 * Moves a tracked file to its new key without overwriting (spec §7). A target that is
 * the same inode with two links (crash between link and unlink) only drops the source;
 * the same inode with one link is the same directory entry under a name the volume
 * folds together (e.g. straße/STRASSE on APFS) and is renamed, never unlinked.
 */
export async function moveLocal(
  from: string,
  to: string,
  opts: { inPlace: boolean; expect: StatExpect; link?: LinkFn },
): Promise<void> {
  await assertUnchanged(from, opts.expect);
  const source = await lstat(from);
  if (opts.inPlace) {
    const existing = await lstat(to).catch((err: unknown) => {
      if (hasErrorCode(err, 'ENOENT')) return null;
      throw err;
    });
    if (existing && existing.ino !== source.ino) throw new CollisionError(to);
    await rename(from, to);
    return;
  }
  const link = opts.link ?? fsLink;
  try {
    await link(from, to);
  } catch (err) {
    if (hasErrorCode(err, 'EEXIST')) {
      if ((await lstat(to)).ino !== source.ino) throw new CollisionError(to);
      if (source.nlink < 2 || !(await distinctEntries(from, to))) {
        await rename(from, to);
        return;
      }
    } else if (LINK_UNSUPPORTED.some((code) => hasErrorCode(err, code))) {
      if (await exists(to)) throw new CollisionError(to);
      await rename(from, to);
      return;
    } else {
      throw err;
    }
  }
  await unlink(from);
}

export async function uploadNew(
  drive: DriveAdapter,
  input: { abs: string; name: string; parentId: string },
): Promise<DriveFile> {
  const body = createReadStream(input.abs);
  try {
    return await drive.createFile({
      requestBody: { name: input.name, parents: [input.parentId] },
      media: { mimeType: uploadMimeType(input.abs), body },
      fields: SYNC_FILE_FIELDS,
    });
  } catch (err) {
    body.destroy();
    throw err;
  }
}

/** New content for the same fileId (Drive keeps a revision). */
export async function updateContent(
  drive: DriveAdapter,
  input: { fileId: string; abs: string },
): Promise<DriveFile> {
  const body = createReadStream(input.abs);
  try {
    return await drive.updateFile({
      fileId: input.fileId,
      media: { mimeType: uploadMimeType(input.abs), body },
      fields: SYNC_FILE_FIELDS,
    });
  } catch (err) {
    body.destroy();
    throw err;
  }
}
```

- [ ] **Step 4: Run and see it pass** — `npx vitest run src/sync/__tests__/trash.test.ts src/sync/__tests__/transfer.test.ts` → PASS.

- [ ] **Step 5: Quality gate** — `npx prettier --write src/sync` then `npm run check` → typecheck, eslint (0 warnings), prettier and all tests green.

- [ ] **Step 6: Commit** —

```bash
git add src/sync
git commit -m "feat(sync): exclusive placement, guarded replace, local move and /usr/bin/trash" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

## Chunk 7: Executor

### Task 12: Executor: order, re-verification, conflicts, isolation, persistence

**Files:**
- Create: `src/sync/executor.ts`
- Test: `src/sync/__tests__/executor.test.ts`

Uses a real `OperationRunner` over a `FakeDrive` and real temp dirs; local trash is redirected into a temp "Trash" dir by the injected exec. Conflict names use **local** time — the test clock is a local-time `Date` so assertions are timezone-independent.

- [ ] **Step 1: Write the failing tests.**

`src/sync/__tests__/executor.test.ts`:

```ts
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { OperationRunner } from '../../core/operation.js';
import { QuotaExceededError } from '../../errors.js';
import {
  createAudit,
  createFakeDrive,
  createRunner,
  httpError,
  noSleep,
  silentLogger,
  type FakeDrive,
} from '../../files/__tests__/fakes.js';
import { Executor, conflictName } from '../executor.js';
import { foldKey } from '../paths.js';
import type { Action, LocalEntry, PairFile, RemoteEntry, SyncRecord } from '../types.js';
import { ROOT_ID, makePairFile, record, remoteEntry } from './fixtures.js';

const NOW = new Date('2026-11-03T10:15:00');
const md5 = (s: string): string => createHash('md5').update(s).digest('hex');

let dir: string;
let trashDir: string;
let drive: FakeDrive;
let audit: ReturnType<typeof createAudit>;
let saves: PairFile[];

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'sync-exec-'));
  trashDir = await mkdtemp(path.join(os.tmpdir(), 'sync-trash-'));
  drive = createFakeDrive();
  audit = createAudit();
  saves = [];
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
  await rm(trashDir, { recursive: true, force: true });
});

function executor(file: PairFile, folders = new Map([[ROOT_ID, '']])): Executor {
  const ops = new OperationRunner({
    runner: createRunner(drive),
    audit,
    retry: noSleep,
    logger: silentLogger(),
  });
  return new Executor(
    {
      ops,
      audit,
      logger: silentLogger(),
      clock: () => NOW,
      save: async (f) => {
        saves.push(structuredClone(f));
      },
      trashExec: async (_bin, args) => {
        const target = args[1] ?? '';
        await rename(target, path.join(trashDir, path.basename(target)));
      },
    },
    file,
    folders,
  );
}

function pairFile(
  records: SyncRecord[] = [],
  selection: string[] = records.map((r) => r.path),
): PairFile {
  return makePairFile({ localDir: dir, selection }, records);
}

async function put(name: string, content: string): Promise<LocalEntry> {
  const abs = path.join(dir, ...name.split('/'));
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, content);
  const s = await lstat(abs);
  return {
    key: name,
    foldKey: foldKey(name),
    name,
    size: s.size,
    mtimeMs: s.mtimeMs,
    ctimeMs: s.ctimeMs,
    ino: s.ino,
  };
}

function remote(
  id: string,
  key: string,
  content: string,
  extra: Partial<RemoteEntry> = {},
): RemoteEntry {
  return remoteEntry(id, key, { md5: md5(content), size: content.length, ...extra });
}

function action(kind: Action['kind'], key: string, fields: Partial<Action> = {}): Action {
  return {
    kind,
    rule: 'test',
    key,
    record: null,
    local: null,
    localMd5: null,
    remote: null,
    selection: {},
    ...fields,
  };
}

function serve(content: string): void {
  drive.downloadMedia.mockImplementation(async () => Readable.from([Buffer.from(content)]));
}

describe('Executor', () => {
  it('runs stages in spec order regardless of plan order', async () => {
    const a = await put('a.pdf', 'A');
    const r = remote('r2', 'b.pdf', 'B');
    const k1 = record('r1', 'a.pdf', { localMd5: md5('A') });
    drive.getFile.mockResolvedValueOnce({
      id: 'r2',
      md5Checksum: md5('B'),
      modifiedTime: r.modifiedTime,
      parents: [ROOT_ID],
    });
    drive.updateFile.mockResolvedValueOnce({ id: 'r2', trashed: true });
    const out = await executor(pairFile([k1, record('r2', 'b.pdf')])).run([
      action('trash-local', 'a.pdf', { record: k1, local: a, localMd5: md5('A') }),
      action('trash-remote', 'b.pdf', { record: record('r2', 'b.pdf'), remote: r }),
      action('forget', 'c.pdf', { record: record('r3', 'c.pdf') }),
    ]);
    expect(out.map((o) => [o.kind, o.status])).toEqual([
      ['forget', 'done'],
      ['trash-remote', 'done'],
      ['trash-local', 'done'],
    ]);
    expect(await readdir(trashDir)).toEqual(['a.pdf']);
    expect(audit.entries.map((e) => e.op)).toEqual(['sync_trash_remote', 'sync_trash_local']);
    expect(saves.at(-1)?.records).toEqual([]);
  });

  it('uploads a new file into a created sub-folder and records it (U1)', async () => {
    const l = await put('sub/a.pdf', 'hello');
    drive.listFiles.mockResolvedValueOnce({ files: [] });
    drive.createFile.mockResolvedValueOnce({ id: 'F-sub', name: 'sub' }).mockResolvedValueOnce({
      id: 'n1',
      name: 'a.pdf',
      parents: ['F-sub'],
      md5Checksum: md5('hello'),
      size: '5',
      modifiedTime: 't',
    });
    const file = pairFile([], ['sub/a.pdf']);
    const out = await executor(file).run([
      action('upload-new', 'sub/a.pdf', { local: l, localMd5: md5('hello') }),
    ]);
    expect(out[0]).toEqual({ kind: 'upload-new', path: 'sub/a.pdf', status: 'done' });
    expect(drive.createFile.mock.calls[0]?.[0].requestBody).toEqual({
      name: 'sub',
      mimeType: 'application/vnd.google-apps.folder',
      parents: [ROOT_ID],
    });
    expect(drive.createFile.mock.calls[1]?.[0].requestBody).toEqual({
      name: 'a.pdf',
      parents: ['F-sub'],
    });
    expect(file.records[0]).toMatchObject({
      remoteId: 'n1',
      path: 'sub/a.pdf',
      localMd5: md5('hello'),
      remoteParentId: 'F-sub',
    });
    expect(audit.entries.map((e) => [e.op, e.account, e.details])).toEqual([
      ['create_folder', 'emco', { pair: 'docs', parentId: ROOT_ID }],
      ['sync_upload', 'emco', { pair: 'docs', path: 'sub/a.pdf', remoteId: 'n1' }],
    ]);
  });

  it('warns changed-during-upload when Drive reports a different md5', async () => {
    const l = await put('a.pdf', 'hello');
    drive.createFile.mockResolvedValueOnce({ id: 'n1', name: 'a.pdf', md5Checksum: 'other' });
    const file = pairFile([], ['a.pdf']);
    const out = await executor(file).run([
      action('upload-new', 'a.pdf', { local: l, localMd5: md5('hello') }),
    ]);
    expect(out[0]?.warning).toBe('changed-during-upload');
    expect(file.records[0]).toMatchObject({
      localMd5: 'other',
      remoteMd5: 'other',
      localSize: l.size,
    });
  });

  it('adopts its own upload after an ambiguous upload error (duplicate-safe)', async () => {
    const l = await put('a.pdf', 'hello');
    drive.createFile.mockRejectedValueOnce(httpError(500));
    drive.listFiles.mockResolvedValueOnce({
      files: [
        {
          id: 'n1',
          name: 'a.pdf',
          md5Checksum: md5('hello'),
          createdTime: new Date(NOW.getTime() - 60_000).toISOString(),
          parents: [ROOT_ID],
        },
      ],
    });
    const file = pairFile([], ['a.pdf']);
    const out = await executor(file).run([
      action('upload-new', 'a.pdf', { local: l, localMd5: md5('hello') }),
    ]);
    expect(out[0]?.status).toBe('done');
    expect(file.records[0]?.remoteId).toBe('n1');
  });

  it('skips update-remote when Drive changed since planning (no If-Match in Drive)', async () => {
    const l = await put('a.pdf', 'local edit');
    const r = remote('r1', 'a.pdf', 'R');
    drive.getFile.mockResolvedValueOnce({ id: 'r1', md5Checksum: 'newer', modifiedTime: 'later' });
    const out = await executor(pairFile([record('r1', 'a.pdf')])).run([
      action('update-remote', 'a.pdf', {
        record: record('r1', 'a.pdf'),
        local: l,
        localMd5: md5('local edit'),
        remote: r,
      }),
    ]);
    expect(out[0]?.status).toBe('skipped');
    expect(drive.updateFile).not.toHaveBeenCalled();
  });

  it('updates the Drive file in place (B2)', async () => {
    const l = await put('a.pdf', 'local edit');
    const r = remote('r1', 'a.pdf', 'R');
    drive.getFile.mockResolvedValueOnce({
      id: 'r1',
      md5Checksum: r.md5,
      modifiedTime: r.modifiedTime,
    });
    drive.updateFile.mockResolvedValueOnce({
      id: 'r1',
      name: 'a.pdf',
      md5Checksum: md5('local edit'),
      modifiedTime: 'new',
    });
    const file = pairFile([record('r1', 'a.pdf')]);
    await executor(file).run([
      action('update-remote', 'a.pdf', {
        record: record('r1', 'a.pdf'),
        local: l,
        localMd5: md5('local edit'),
        remote: r,
      }),
    ]);
    expect(drive.updateFile.mock.calls[0]?.[0]).toMatchObject({ fileId: 'r1' });
    expect(file.records[0]).toMatchObject({
      localMd5: md5('local edit'),
      remoteMd5: md5('local edit'),
      remoteModifiedTime: 'new',
    });
  });

  it('downloads new files exclusively and reports collisions', async () => {
    serve('R');
    const file = pairFile();
    const r = remote('n1', 'in/new.pdf', 'R');
    await put('taken.pdf', 'mine');
    const out = await executor(file).run([
      action('download-new', 'in/new.pdf', { remote: r, selection: { add: ['in/new.pdf'] } }),
      action('download-new', 'taken.pdf', {
        remote: remote('n2', 'taken.pdf', 'R'),
        selection: { add: ['taken.pdf'] },
      }),
    ]);
    expect(out.map((o) => o.status)).toEqual(['done', 'collision']);
    expect(await readFile(path.join(dir, 'in', 'new.pdf'), 'utf8')).toBe('R');
    expect(await readFile(path.join(dir, 'taken.pdf'), 'utf8')).toBe('mine');
    expect(file.pair.selection).toEqual(['in/new.pdf']);
    expect(file.records.map((r2) => r2.remoteId)).toEqual(['n1']);
  });

  it('skips download-replace when the local file changed after the scan', async () => {
    const l = await put('a.pdf', 'old');
    await writeFile(path.join(dir, 'a.pdf'), 'edited after scan');
    serve('R');
    const out = await executor(pairFile([record('r1', 'a.pdf')])).run([
      action('download-replace', 'a.pdf', {
        record: record('r1', 'a.pdf'),
        local: l,
        remote: remote('r1', 'a.pdf', 'R'),
      }),
    ]);
    expect(out[0]?.status).toBe('skipped');
    expect(await readFile(path.join(dir, 'a.pdf'), 'utf8')).toBe('edited after scan');
  });

  it('moves a file to its new key, then downloads the newer content (B7)', async () => {
    const l = await put('a.pdf', 'old');
    serve('new');
    const k = record('r1', 'a.pdf', { localMd5: md5('old') });
    const file = pairFile([k]);
    const r = remote('r1', 'sub/b.pdf', 'new', { parentId: 'F', name: 'b.pdf' });
    await executor(file).run([
      action('move-local', 'sub/b.pdf', {
        record: k,
        local: l,
        localMd5: md5('old'),
        remote: r,
        thenDownload: true,
        selection: { remove: ['a.pdf'], add: ['sub/b.pdf'] },
      }),
    ]);
    expect(await readdir(dir)).toEqual(['sub']);
    expect(await readFile(path.join(dir, 'sub', 'b.pdf'), 'utf8')).toBe('new');
    expect(file.pair.selection).toEqual(['sub/b.pdf']);
    expect(file.records[0]).toMatchObject({
      path: 'sub/b.pdf',
      localMd5: md5('new'),
      remoteMd5: md5('new'),
      remoteParentId: 'F',
    });
    expect(saves).toHaveLength(2);
    expect(saves[0]?.records[0]).toMatchObject({ path: 'sub/b.pdf', remoteMd5: k.remoteMd5 });
  });

  it('places the conflict copy before uploading L (spec §6.9)', async () => {
    const l = await put('a.pdf', 'local edit');
    const r = remote('r1', 'a.pdf', 'remote edit');
    serve('remote edit');
    drive.getFile.mockResolvedValueOnce({
      id: 'r1',
      md5Checksum: r.md5,
      modifiedTime: r.modifiedTime,
    });
    drive.updateFile.mockResolvedValueOnce({
      id: 'r1',
      name: 'a.pdf',
      md5Checksum: md5('local edit'),
      modifiedTime: 'new',
    });
    const file = pairFile([record('r1', 'a.pdf')]);
    const out = await executor(file).run([
      action('conflict', 'a.pdf', {
        record: record('r1', 'a.pdf'),
        local: l,
        localMd5: md5('local edit'),
        remote: r,
        updateRemote: true,
      }),
    ]);
    const copy = conflictName('a.pdf', NOW, 0);
    expect(copy).toBe('a (Drive conflict 2026-11-03 10.15).pdf');
    expect(out[0]).toMatchObject({ status: 'done', conflictCopy: copy });
    expect(await readFile(path.join(dir, copy), 'utf8')).toBe('remote edit');
    expect(drive.downloadMedia.mock.invocationCallOrder[0]).toBeLessThan(
      drive.updateFile.mock.invocationCallOrder[0] ?? 0,
    );
    expect(file.records[0]).toMatchObject({
      localMd5: md5('local edit'),
      remoteMd5: md5('local edit'),
    });
    expect(file.pair.selection).toEqual(['a.pdf']);
  });

  it('numbers conflict copies and skips the upload when the copy fails', async () => {
    expect(conflictName('a.pdf', NOW, 1)).toBe('a (Drive conflict 2026-11-03 10.15) 2.pdf');
    expect(conflictName('README', NOW, 0)).toBe('README (Drive conflict 2026-11-03 10.15)');
    const l = await put('a.pdf', 'local edit');
    serve('something else');
    const out = await executor(pairFile([record('r1', 'a.pdf')])).run([
      action('conflict', 'a.pdf', {
        record: record('r1', 'a.pdf'),
        local: l,
        localMd5: md5('local edit'),
        remote: remote('r1', 'a.pdf', 'remote edit'),
        updateRemote: true,
      }),
    ]);
    expect(out[0]?.status).toBe('failed');
    expect(drive.updateFile).not.toHaveBeenCalled();
    expect(await readdir(dir)).toEqual(['a.pdf']);
  });

  it('skips trash-remote when Drive changed and trash-local when L changed', async () => {
    const l = await put('a.pdf', 'edited');
    drive.getFile.mockResolvedValueOnce({ id: 'r2', md5Checksum: 'newer', modifiedTime: 'later' });
    const out = await executor(pairFile([record('r1', 'a.pdf'), record('r2', 'b.pdf')])).run([
      action('trash-local', 'a.pdf', {
        record: record('r1', 'a.pdf'),
        local: l,
        localMd5: md5('original'),
      }),
      action('trash-remote', 'b.pdf', {
        record: record('r2', 'b.pdf'),
        remote: remote('r2', 'b.pdf', 'B'),
      }),
    ]);
    expect(out.map((o) => o.status)).toEqual(['skipped', 'skipped']);
    expect(await readdir(trashDir)).toEqual([]);
    expect(saves).toEqual([]);
  });

  it('isolates failures and aborts on run-ending errors', async () => {
    const a = await put('a.pdf', 'A');
    const b = await put('b.pdf', 'B');
    drive.createFile.mockRejectedValueOnce(httpError(400, 'badRequest'));
    drive.listFiles.mockResolvedValueOnce({ files: [] });
    drive.createFile.mockRejectedValueOnce(httpError(403, 'storageQuotaExceeded'));
    const out = await executor(pairFile([], ['a.pdf', 'b.pdf'])).run([
      action('upload-new', 'a.pdf', { local: a, localMd5: md5('A') }),
      action('upload-new', 'b.pdf', { local: b, localMd5: md5('B') }),
      action('download-new', 'c.pdf', { remote: remote('n3', 'c.pdf', 'C') }),
    ]);
    expect(out.map((o) => [o.path, o.status])).toEqual([
      ['a.pdf', 'failed'],
      ['b.pdf', 'failed'],
      ['c.pdf', 'not-run'],
    ]);
    expect(out[1]?.message).toBe(new QuotaExceededError('emco').message);
  });

  it('persists after every success, so a crash keeps completed work', async () => {
    serve('R');
    const file = pairFile();
    await executor(file).run([
      action('download-new', 'a.pdf', {
        remote: remote('n1', 'a.pdf', 'R'),
        selection: { add: ['a.pdf'] },
      }),
      action('download-new', 'b.pdf', {
        remote: remote('n2', 'b.pdf', 'R'),
        selection: { add: ['b.pdf'] },
      }),
    ]);
    expect(saves.map((s) => s.records.map((r) => r.remoteId))).toEqual([['n1'], ['n1', 'n2']]);
    expect(saves[0]?.pair.selection).toEqual(['a.pdf']);
  });

  it('applies untrack selection changes (key → excluded)', async () => {
    const k = record('r1', 'a.pdf');
    const file = pairFile([k]);
    await executor(file).run([
      action('untrack', 'a.pdf', {
        record: k,
        selection: { remove: ['a.pdf'], exclude: ['a.pdf'] },
      }),
    ]);
    expect(file.records).toEqual([]);
    expect(file.pair.selection).toEqual([]);
    expect(file.pair.excluded).toEqual(['a.pdf']);
  });
});

describe('Executor (review regressions)', () => {
  it('skips trash-remote when the local file is back or the Drive file moved', async () => {
    await put('back.pdf', 'restored from Trash');
    const r = remote('r2', 'moved.pdf', 'M');
    drive.getFile.mockResolvedValueOnce({
      id: 'r2',
      md5Checksum: r.md5,
      modifiedTime: r.modifiedTime,
      parents: ['ELSEWHERE'],
    });
    const out = await executor(pairFile([record('r1', 'back.pdf'), record('r2', 'moved.pdf')])).run(
      [
        action('trash-remote', 'back.pdf', {
          record: record('r1', 'back.pdf'),
          remote: remote('r1', 'back.pdf', 'B'),
        }),
        action('trash-remote', 'moved.pdf', { record: record('r2', 'moved.pdf'), remote: r }),
      ],
    );
    expect(out.map((o) => o.status)).toEqual(['skipped', 'skipped']);
    expect(drive.updateFile).not.toHaveBeenCalled();
  });

  it('pages through the parent folder listing when ensuring a folder', async () => {
    const l = await put('sub/a.pdf', 'hello');
    drive.listFiles
      .mockResolvedValueOnce({ files: [{ id: 'X', name: 'other' }], nextPageToken: 'p2' })
      .mockResolvedValueOnce({ files: [{ id: 'F-sub', name: 'sub' }] });
    drive.createFile.mockResolvedValueOnce({
      id: 'n1',
      name: 'a.pdf',
      parents: ['F-sub'],
      md5Checksum: md5('hello'),
    });
    await executor(pairFile([], ['sub/a.pdf'])).run([
      action('upload-new', 'sub/a.pdf', { local: l, localMd5: md5('hello') }),
    ]);
    expect(drive.listFiles.mock.calls[1]?.[0].pageToken).toBe('p2');
    expect(drive.createFile).toHaveBeenCalledTimes(1);
    expect(drive.createFile.mock.calls[0]?.[0].requestBody).toEqual({
      name: 'a.pdf',
      parents: ['F-sub'],
    });
  });

  it('reuses a Drive folder whose name differs only in case (case-insensitive volume)', async () => {
    const l = await put('docs/a.pdf', 'hello');
    drive.listFiles.mockResolvedValueOnce({ files: [{ id: 'F-Docs', name: 'Docs' }] });
    drive.createFile.mockResolvedValueOnce({
      id: 'n1',
      name: 'a.pdf',
      parents: ['F-Docs'],
      md5Checksum: md5('hello'),
    });
    await executor(pairFile([], ['docs/a.pdf'])).run([
      action('upload-new', 'docs/a.pdf', { local: l, localMd5: md5('hello') }),
    ]);
    expect(drive.createFile).toHaveBeenCalledTimes(1);
    expect(drive.createFile.mock.calls[0]?.[0].requestBody).toEqual({
      name: 'a.pdf',
      parents: ['F-Docs'],
    });
  });
});
```

- [ ] **Step 2: Run and see it fail** — `npx vitest run src/sync/__tests__/executor.test.ts` → FAIL: `../executor.js` cannot be resolved.

- [ ] **Step 3: Implement.**

`src/sync/executor.ts`:

```ts
import { lstat } from 'node:fs/promises';
import path from 'node:path';
import type { AuditOp, AuditSink } from '../audit/audit-log.js';
import type { OperationRunner } from '../core/operation.js';
import type { DriveFile } from '../drive/drive-adapter.js';
import { AppError, ValidationError, hasErrorCode } from '../errors.js';
import { GOOGLE_MIME } from '../files/export-formats.js';
import { escapeQueryValue } from '../files/query.js';
import type { Logger } from '../logger.js';
import { CollisionError, TargetChangedError, isAbortError } from './errors.js';
import { md5File } from './local-scanner.js';
import { absInside, baseName, foldKey, parentKey, prepareParent } from './paths.js';
import { SYNC_LIST_FIELDS } from './remote-scanner.js';
import {
  downloadReplace,
  moveLocal,
  placeExclusive,
  updateContent,
  uploadNew,
  type StatExpect,
} from './transfer.js';
import { trashLocal, type ExecFn } from './trash.js';
import {
  SYNC_FILE_FIELDS,
  type Action,
  type ActionKind,
  type ActionOutcome,
  type LocalEntry,
  type PairFile,
  type RemoteEntry,
  type SelectionChange,
  type SyncRecord,
} from './types.js';

/** Spec §7 order; state-only actions first. */
export const STAGES: ActionKind[][] = [
  ['adopt', 'forget', 'untrack', 'refresh'],
  ['upload-new', 'update-remote'],
  ['move-local'],
  ['download-new', 'download-replace'],
  ['conflict'],
  ['trash-remote'],
  ['trash-local'],
];

const DUPLICATE_WINDOW_MS = 10 * 60 * 1000;
const MAX_CONFLICT_NAMES = 100;

export interface ExecutorDeps {
  ops: OperationRunner;
  audit: AuditSink;
  logger: Logger;
  clock: () => Date;
  save: (file: PairFile) => Promise<void>;
  /** Runs /usr/bin/trash (tests pass a fake). */
  trashExec: ExecFn;
}

interface RemoteFields {
  id: string;
  name: string;
  parentId: string;
  md5: string | null;
  size: number | null;
  modifiedTime: string;
}

interface LocalFields {
  name: string;
  md5: string;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
}

function fromEntry(e: RemoteEntry): RemoteFields {
  return {
    id: e.id,
    name: e.name,
    parentId: e.parentId,
    md5: e.md5,
    size: e.size,
    modifiedTime: e.modifiedTime,
  };
}

function fromDrive(f: DriveFile, fallbackParent: string): RemoteFields {
  return {
    id: f.id ?? '',
    name: f.name ?? '',
    parentId: f.parents?.[0] ?? fallbackParent,
    md5: f.md5Checksum ?? null,
    size: f.size ? Number(f.size) : null,
    modifiedTime: f.modifiedTime ?? '',
  };
}

function statOf(e: LocalEntry): StatExpect {
  return { size: e.size, mtimeMs: e.mtimeMs, ctimeMs: e.ctimeMs };
}

function makeRecord(key: string, local: LocalFields, remote: RemoteFields): SyncRecord {
  return {
    remoteId: remote.id,
    path: key,
    localName: local.name,
    remoteName: remote.name,
    remoteParentId: remote.parentId,
    localMd5: local.md5,
    localSize: local.size,
    localMtimeMs: local.mtimeMs,
    localCtimeMs: local.ctimeMs,
    remoteMd5: remote.md5,
    remoteSize: remote.size,
    remoteModifiedTime: remote.modifiedTime,
    native: null,
    remoteOnly: false,
    restorePending: false,
    remoteTrashed: false,
  };
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/** `<stem> (Drive conflict YYYY-MM-DD HH.mm)<ext>`, then ` 2`, ` 3`… (spec §6.9, local time). */
export function conflictName(base: string, at: Date, attempt: number): string {
  const dot = base.lastIndexOf('.');
  const stem = dot > 0 ? base.slice(0, dot) : base;
  const ext = dot > 0 ? base.slice(dot) : '';
  const stamp = `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}.${pad(at.getMinutes())}`;
  return `${stem} (Drive conflict ${stamp})${attempt === 0 ? '' : ` ${attempt + 1}`}${ext}`;
}

function applySelection(file: PairFile, change: SelectionChange): void {
  const pair = file.pair;
  const without = (list: string[], keys: string[]): string[] => {
    const folds = new Set(keys.map(foldKey));
    return list.filter((k) => !folds.has(foldKey(k)));
  };
  if (change.remove) pair.selection = without(pair.selection, change.remove);
  if (change.exclude) {
    pair.selection = without(pair.selection, change.exclude);
    pair.excluded = [...without(pair.excluded, change.exclude), ...change.exclude];
  }
  if (change.add) {
    pair.excluded = without(pair.excluded, change.add);
    pair.selection = [...without(pair.selection, change.add), ...change.add];
  }
}

function putRecord(file: PairFile, record: SyncRecord, replaces?: string): void {
  file.records = file.records.filter(
    (r) => r.remoteId !== record.remoteId && r.remoteId !== replaces,
  );
  file.records.push(record);
}

function dropRecord(file: PairFile, remoteId: string): void {
  file.records = file.records.filter((r) => r.remoteId !== remoteId);
}

function messageOf(err: unknown): string {
  if (err instanceof AppError) return err.message;
  return err instanceof Error ? err.message : String(err);
}

/** Executes a plan in spec §7 order, persisting the pair file after every success. */
export class Executor {
  private readonly folderIds = new Map<string, string>();
  private readonly folderErrors = new Map<string, string>();

  constructor(
    private readonly deps: ExecutorDeps,
    private readonly file: PairFile,
    folders: ReadonlyMap<string, string>,
  ) {
    for (const [id, key] of folders) this.folderIds.set(key, id);
  }

  private get pair(): PairFile['pair'] {
    return this.file.pair;
  }

  async run(actions: readonly Action[]): Promise<ActionOutcome[]> {
    const outcomes: ActionOutcome[] = [];
    let aborted = false;
    await this.ensureFolders(actions.filter((a) => a.kind === 'upload-new'));
    for (const stage of STAGES) {
      for (const action of actions.filter((a) => stage.includes(a.kind))) {
        const base = { kind: action.kind, path: action.key };
        if (aborted) {
          outcomes.push({ ...base, status: 'not-run' });
          continue;
        }
        try {
          outcomes.push({ ...base, status: 'done', ...(await this.execute(action)) });
        } catch (err) {
          if (err instanceof TargetChangedError) {
            outcomes.push({ ...base, status: 'skipped', message: err.message });
          } else if (err instanceof CollisionError) {
            outcomes.push({ ...base, status: 'collision', message: err.message });
          } else {
            if (!(err instanceof AppError)) {
              this.deps.logger.error('Sync action failed', {
                kind: action.kind,
                path: action.key,
                error: err,
              });
            }
            outcomes.push({ ...base, status: 'failed', message: messageOf(err) });
            if (isAbortError(err)) aborted = true;
          }
        }
      }
    }
    return outcomes;
  }

  private async execute(action: Action): Promise<Partial<ActionOutcome>> {
    switch (action.kind) {
      case 'adopt':
        return this.adopt(action);
      case 'refresh':
        return this.refresh(action);
      case 'forget':
      case 'untrack':
        return this.forget(action);
      case 'upload-new':
        return this.upload(action);
      case 'update-remote':
        return this.updateRemote(action);
      case 'move-local':
        return this.move(action);
      case 'download-new':
        return this.downloadNew(action);
      case 'download-replace':
        return this.downloadReplace(action);
      case 'conflict':
        return this.conflict(action);
      case 'trash-remote':
        return this.trashRemote(action);
      case 'trash-local':
        return this.trashLocalFile(action);
    }
  }

  private async commit(action: Action, mutate: () => void): Promise<void> {
    mutate();
    applySelection(this.file, action.selection);
    await this.deps.save(this.file);
  }

  private async audit(op: AuditOp, action: Action, remoteId: string): Promise<void> {
    try {
      await this.deps.audit.record({
        account: this.pair.account,
        op,
        fileId: remoteId,
        name: baseName(action.key),
        details: { pair: this.pair.name, path: action.key, remoteId },
      });
    } catch (err) {
      this.deps.logger.warn('Audit log write failed', { op, error: err });
    }
  }

  private need<T>(value: T | null | undefined, what: string): T {
    if (value === null || value === undefined)
      throw new ValidationError(`Internal: ${what} missing for sync action`);
    return value;
  }

  private localFields(entry: LocalEntry, md5: string): LocalFields {
    return {
      name: entry.name,
      md5,
      size: entry.size,
      mtimeMs: entry.mtimeMs,
      ctimeMs: entry.ctimeMs,
    };
  }

  private async statFields(name: string, md5: string): Promise<LocalFields> {
    const info = await lstat(absInside(this.pair.localDir, name));
    return { name, md5, size: info.size, mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs };
  }

  private readRemote(id: string): Promise<DriveFile> {
    return this.deps.ops.exec(this.pair.account, 'idempotent', id, (ctx) =>
      ctx.drive.getFile(id, SYNC_FILE_FIELDS),
    );
  }

  /** Re-reads R and throws TargetChangedError unless it still matches the plan (spec §7). */
  private async verifyRemote(planned: RemoteEntry): Promise<DriveFile> {
    const current = await this.readRemote(planned.id);
    if (
      current.trashed ||
      (current.md5Checksum ?? null) !== planned.md5 ||
      (current.modifiedTime ?? '') !== planned.modifiedTime
    ) {
      throw new TargetChangedError(`${planned.key} changed in Drive since planning`);
    }
    return current;
  }

  // ---- remote folders -------------------------------------------------------------

  private async ensureFolders(uploads: readonly Action[]): Promise<void> {
    const dirs = [...new Set(uploads.map((a) => parentKey(a.key)))].sort(
      (a, b) => a.split('/').length - b.split('/').length || (a < b ? -1 : 1),
    );
    for (const dir of dirs) {
      try {
        await this.folderFor(dir);
      } catch (err) {
        if (isAbortError(err)) throw err;
        this.folderErrors.set(dir, messageOf(err));
      }
    }
  }

  private async folderFor(dir: string): Promise<string> {
    const known =
      this.folderIds.get(dir) ??
      (this.pair.caseInsensitive
        ? [...this.folderIds].find(([key]) => foldKey(key) === foldKey(dir))?.[1]
        : undefined);
    if (known) return known;
    const failed = this.folderErrors.get(dir);
    if (failed) throw new ValidationError(failed);
    const parentId = await this.folderFor(parentKey(dir));
    const id = await this.ensureRemoteFolder(parentId, baseName(dir));
    this.folderIds.set(dir, id);
    return id;
  }

  /** Reuses exactly one non-trashed same-name folder; several → refuse (spec §4). */
  private async ensureRemoteFolder(parentId: string, name: string): Promise<string> {
    const q = `'${escapeQueryValue(parentId)}' in parents and trashed = false and mimeType = '${GOOGLE_MIME.folder}'`;
    const folders: DriveFile[] = [];
    let pageToken: string | undefined;
    do {
      const page = await this.deps.ops.exec(this.pair.account, 'idempotent', parentId, (ctx) =>
        ctx.drive.listFiles({
          q,
          pageSize: 1000,
          ...(pageToken ? { pageToken } : {}),
          fields: 'nextPageToken, files(id, name)',
        }),
      );
      folders.push(...(page.files ?? []));
      pageToken = page.nextPageToken ?? undefined;
    } while (pageToken);
    const same = folders.filter((f) =>
      this.pair.caseInsensitive
        ? foldKey(f.name ?? '') === foldKey(name)
        : (f.name ?? '').normalize('NFC') === name.normalize('NFC'),
    );
    if (same.length > 1)
      throw new ValidationError(
        `Several Drive folders named "${name}"; resolve the duplicate first`,
      );
    const existing = same[0]?.id;
    if (existing) return existing;
    const created = await this.deps.ops.exec(this.pair.account, 'create', parentId, (ctx) =>
      ctx.drive.createFile({
        requestBody: { name, mimeType: GOOGLE_MIME.folder, parents: [parentId] },
        fields: 'id, name',
      }),
    );
    const id = this.need(created.id, 'folder id');
    try {
      await this.deps.audit.record({
        account: this.pair.account,
        op: 'create_folder',
        fileId: id,
        name,
        details: { pair: this.pair.name, parentId },
      });
    } catch (err) {
      this.deps.logger.warn('Audit log write failed', { op: 'create_folder', error: err });
    }
    return id;
  }

  // ---- state-only -------------------------------------------------------------------

  private async adopt(action: Action): Promise<Partial<ActionOutcome>> {
    const local = this.need(action.local, 'local');
    const remote = this.need(action.remote, 'remote');
    const md5 = this.need(action.localMd5, 'local md5');
    await this.commit(action, () =>
      putRecord(
        this.file,
        makeRecord(action.key, this.localFields(local, md5), fromEntry(remote)),
        action.rebaseFrom,
      ),
    );
    return {};
  }

  private async refresh(action: Action): Promise<Partial<ActionOutcome>> {
    const local = this.need(action.local, 'local');
    const remote = this.need(action.remote, 'remote');
    const md5 = this.need(action.localMd5, 'local md5');
    await this.commit(action, () =>
      putRecord(this.file, makeRecord(action.key, this.localFields(local, md5), fromEntry(remote))),
    );
    return {};
  }

  private async forget(action: Action): Promise<Partial<ActionOutcome>> {
    const record = this.need(action.record, 'record');
    await this.commit(action, () => dropRecord(this.file, record.remoteId));
    return {};
  }

  // ---- uploads ----------------------------------------------------------------------

  private async upload(action: Action): Promise<Partial<ActionOutcome>> {
    const local = this.need(action.local, 'local');
    const planned = this.need(action.localMd5, 'local md5');
    const parentId = await this.folderFor(parentKey(action.key));
    const abs = absInside(this.pair.localDir, local.name);
    const name = baseName(action.key);
    let uploaded: DriveFile;
    try {
      uploaded = await this.deps.ops.exec(this.pair.account, 'create', parentId, (ctx) =>
        uploadNew(ctx.drive, { abs, name, parentId }),
      );
    } catch (err) {
      if (isAbortError(err)) throw err;
      const adopted = await this.findDuplicateUpload(parentId, name, planned);
      if (!adopted) throw err;
      uploaded = adopted;
    }
    const remote = fromDrive(uploaded, parentId);
    const warning =
      remote.md5 !== null && remote.md5 !== planned ? 'changed-during-upload' : undefined;
    await this.commit(action, () =>
      putRecord(
        this.file,
        makeRecord(action.key, this.localFields(local, remote.md5 ?? planned), remote),
        action.rebaseFrom,
      ),
    );
    await this.audit('sync_upload', action, remote.id);
    return warning ? { warning } : {};
  }

  /** After an upload error: a same-name, same-md5 file created within 10 minutes is ours (spec §7). */
  private async findDuplicateUpload(
    parentId: string,
    name: string,
    md5: string,
  ): Promise<DriveFile | null> {
    const q = `'${escapeQueryValue(parentId)}' in parents and trashed = false and name = '${escapeQueryValue(name)}'`;
    try {
      const list = await this.deps.ops.exec(this.pair.account, 'idempotent', parentId, (ctx) =>
        ctx.drive.listFiles({ q, pageSize: 100, fields: SYNC_LIST_FIELDS }),
      );
      const now = this.deps.clock().getTime();
      return (
        (list.files ?? []).find(
          (f) =>
            f.md5Checksum === md5 &&
            f.name === name &&
            Math.abs(now - Date.parse(f.createdTime ?? '')) <= DUPLICATE_WINDOW_MS,
        ) ?? null
      );
    } catch (err) {
      if (isAbortError(err)) throw err;
      return null;
    }
  }

  private async updateRemote(action: Action): Promise<Partial<ActionOutcome>> {
    const local = this.need(action.local, 'local');
    const planned = this.need(action.localMd5, 'local md5');
    const remote = this.need(action.remote, 'remote');
    await this.verifyRemote(remote);
    const abs = absInside(this.pair.localDir, local.name);
    const updated = await this.deps.ops.exec(this.pair.account, 'mutate', remote.id, (ctx) =>
      updateContent(ctx.drive, { fileId: remote.id, abs }),
    );
    const fields = fromDrive(updated, remote.parentId);
    const warning =
      fields.md5 !== null && fields.md5 !== planned ? 'changed-during-upload' : undefined;
    await this.commit(action, () =>
      putRecord(
        this.file,
        makeRecord(action.key, this.localFields(local, fields.md5 ?? planned), fields),
      ),
    );
    await this.audit('sync_update', action, remote.id);
    return warning ? { warning } : {};
  }

  // ---- local writes -----------------------------------------------------------------

  private async move(action: Action): Promise<Partial<ActionOutcome>> {
    const record = this.need(action.record, 'record');
    const local = this.need(action.local, 'local');
    const remote = this.need(action.remote, 'remote');
    const from = absInside(this.pair.localDir, local.name);
    const to = action.inPlace
      ? absInside(this.pair.localDir, action.key)
      : await prepareParent(this.pair.localDir, action.key);
    await moveLocal(from, to, { inPlace: action.inPlace ?? false, expect: statOf(local) });
    const moved = await this.statFields(action.key, record.localMd5);
    // Persist the move with the old remote content so a failed follow-up download is retried (B3).
    await this.commit(action, () =>
      putRecord(this.file, {
        ...record,
        path: action.key,
        localName: moved.name,
        localSize: moved.size,
        localMtimeMs: moved.mtimeMs,
        localCtimeMs: moved.ctimeMs,
        remoteName: remote.name,
        remoteParentId: remote.parentId,
      }),
    );
    await this.audit('sync_move_local', action, remote.id);
    if (!action.thenDownload) return {};
    const expect = { size: moved.size, mtimeMs: moved.mtimeMs, ctimeMs: moved.ctimeMs };
    const written = await this.deps.ops.exec(this.pair.account, 'idempotent', remote.id, (ctx) =>
      downloadReplace(to, () => ctx.drive.downloadMedia(remote.id), {
        expect,
        expectedMd5: remote.md5,
      }),
    );
    const after = await this.statFields(action.key, written.md5);
    putRecord(this.file, makeRecord(action.key, after, fromEntry(remote)));
    await this.deps.save(this.file);
    await this.audit('sync_download', action, remote.id);
    return {};
  }

  private async downloadNew(action: Action): Promise<Partial<ActionOutcome>> {
    const remote = this.need(action.remote, 'remote');
    const abs = await prepareParent(this.pair.localDir, action.key);
    const written = await this.deps.ops.exec(this.pair.account, 'idempotent', remote.id, (ctx) =>
      placeExclusive(
        path.dirname(abs),
        () => path.basename(abs),
        () => ctx.drive.downloadMedia(remote.id),
        {
          expectedMd5: remote.md5,
        },
      ),
    );
    const local = await this.statFields(action.key, written.md5);
    await this.commit(action, () =>
      putRecord(this.file, makeRecord(action.key, local, fromEntry(remote))),
    );
    await this.audit('sync_download', action, remote.id);
    return {};
  }

  private async downloadReplace(action: Action): Promise<Partial<ActionOutcome>> {
    const local = this.need(action.local, 'local');
    const remote = this.need(action.remote, 'remote');
    const abs = absInside(this.pair.localDir, local.name);
    const written = await this.deps.ops.exec(this.pair.account, 'idempotent', remote.id, (ctx) =>
      downloadReplace(abs, () => ctx.drive.downloadMedia(remote.id), {
        expect: statOf(local),
        expectedMd5: remote.md5,
      }),
    );
    const after = await this.statFields(local.name, written.md5);
    await this.commit(action, () =>
      putRecord(this.file, makeRecord(action.key, after, fromEntry(remote))),
    );
    await this.audit('sync_download', action, remote.id);
    return {};
  }

  /** Spec §6.9: conflict copy first (verified, fsynced), only then upload L over R. */
  private async conflict(action: Action): Promise<Partial<ActionOutcome>> {
    const local = this.need(action.local, 'local');
    const remote = this.need(action.remote, 'remote');
    const planned = this.need(action.localMd5, 'local md5');
    const abs = absInside(this.pair.localDir, local.name);
    const at = this.deps.clock();
    const base = path.basename(abs);
    const copy = await this.deps.ops.exec(this.pair.account, 'idempotent', remote.id, (ctx) =>
      placeExclusive(
        path.dirname(abs),
        (i) => conflictName(base, at, i),
        () => ctx.drive.downloadMedia(remote.id),
        {
          expectedMd5: remote.md5,
          maxAttempts: MAX_CONFLICT_NAMES,
        },
      ),
    );
    const conflictCopy = path.relative(this.pair.localDir, copy.path).split(path.sep).join('/');
    await this.audit('sync_conflict', action, remote.id);
    if (!action.updateRemote) {
      const record = this.need(action.record, 'record');
      await this.commit(action, () =>
        putRecord(this.file, {
          ...record,
          remoteMd5: remote.md5,
          remoteSize: remote.size,
          remoteModifiedTime: remote.modifiedTime,
          remoteName: remote.name,
          remoteParentId: remote.parentId,
        }),
      );
      return { conflictCopy };
    }
    await this.verifyRemote(remote);
    const updated = await this.deps.ops.exec(this.pair.account, 'mutate', remote.id, (ctx) =>
      updateContent(ctx.drive, { fileId: remote.id, abs }),
    );
    const fields = fromDrive(updated, remote.parentId);
    await this.commit(action, () =>
      putRecord(
        this.file,
        makeRecord(action.key, this.localFields(local, fields.md5 ?? planned), fields),
      ),
    );
    await this.audit('sync_update', action, remote.id);
    return {
      conflictCopy,
      ...(fields.md5 !== null && fields.md5 !== planned
        ? { warning: 'changed-during-upload' }
        : {}),
    };
  }

  // ---- deletions --------------------------------------------------------------------

  private async trashRemote(action: Action): Promise<Partial<ActionOutcome>> {
    const record = this.need(action.record, 'record');
    const remote = this.need(action.remote, 'remote');
    // The local deletion must still hold: the file may be back (restored from the Trash).
    const back = await lstat(absInside(this.pair.localDir, record.localName)).catch(
      (err: unknown) => {
        if (hasErrorCode(err, 'ENOENT')) return null;
        throw err;
      },
    );
    if (back) throw new TargetChangedError(`${action.key} exists locally again`);
    const current = await this.readRemote(remote.id);
    if (!current.trashed) {
      if (
        (current.md5Checksum ?? null) !== remote.md5 ||
        (current.modifiedTime ?? '') !== remote.modifiedTime ||
        (current.parents?.[0] ?? '') !== remote.parentId
      ) {
        throw new TargetChangedError(`${action.key} changed or moved in Drive since planning`);
      }
      await this.deps.ops.exec(this.pair.account, 'idempotent', remote.id, (ctx) =>
        ctx.drive.updateFile({
          fileId: remote.id,
          requestBody: { trashed: true },
          fields: 'id, trashed',
        }),
      );
    }
    await this.commit(action, () => dropRecord(this.file, record.remoteId));
    await this.audit('sync_trash_remote', action, remote.id);
    return {};
  }

  private async trashLocalFile(action: Action): Promise<Partial<ActionOutcome>> {
    const record = this.need(action.record, 'record');
    const local = this.need(action.local, 'local');
    const abs = absInside(this.pair.localDir, local.name);
    let md5: string;
    try {
      md5 = await md5File(abs);
    } catch (err) {
      if (hasErrorCode(err, 'ENOENT'))
        throw new TargetChangedError(`${action.key} is already gone`);
      throw err;
    }
    if (md5 !== action.localMd5)
      throw new TargetChangedError(`${action.key} changed locally since planning`);
    await trashLocal(abs, this.deps.trashExec);
    await this.commit(action, () => dropRecord(this.file, record.remoteId));
    await this.audit('sync_trash_local', action, record.remoteId);
    return {};
  }
}
```

- [ ] **Step 4: Run and see it pass** — `npx vitest run src/sync/__tests__/executor.test.ts` → PASS.

- [ ] **Step 5: Quality gate** — `npx prettier --write src/sync` then `npm run check` → typecheck, eslint (0 warnings), prettier and all tests green.

- [ ] **Step 6: Commit** —

```bash
git add src/sync
git commit -m "feat(sync): executor with spec order, re-verification and per-action persistence" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

## Chunk 8: SyncService — pairs, scan, select

### Task 13: SyncService: pairs, root checks, scan and select

**Files:**
- Create: `src/sync/sync-service.ts`, `src/sync/__tests__/memory-drive.ts`
- Test: `src/sync/__tests__/sync-service.pairs.test.ts`

`memory-drive.ts` is a small in-memory Drive behind the `FakeDrive` interface (understands the `in parents`, `trashed = false`, `name =` and `mimeType =` clauses sync uses; md5 computed from content; a `my-drive` root without parents). The `run` lifecycle is added in Task 15.

`src/sync/__tests__/memory-drive.ts`:

```ts
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import type { DriveFile } from '../../drive/drive-adapter.js';
import { GOOGLE_MIME } from '../../files/export-formats.js';
import { createFakeDrive, httpError, type FakeDrive } from '../../files/__tests__/fakes.js';

export interface MemFile {
  id: string;
  name: string;
  mimeType: string;
  parents: string[];
  content: Buffer;
  trashed: boolean;
  createdTime: string;
  modifiedTime: string;
  canEdit: boolean;
  canTrash: boolean;
}

export interface MemoryDrive {
  drive: FakeDrive;
  files: Map<string, MemFile>;
  addFolder(id: string, name: string, parent: string): MemFile;
  addFile(
    id: string,
    name: string,
    parent: string,
    content: string,
    extra?: Partial<MemFile>,
  ): MemFile;
  childrenOf(parent: string): MemFile[];
}

function unescape(value: string): string {
  return value.replace(/\\'/g, "'").replace(/\\\\/g, '\\');
}

async function readAll(body: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of body) chunks.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(chunks);
}

/** A tiny in-memory Drive behind the FakeDrive interface (queries used by sync only). */
export function memoryDrive(rootId = 'ROOT'): MemoryDrive {
  const files = new Map<string, MemFile>();
  let tick = 0;
  let seq = 0;
  const stamp = (): string => new Date(Date.UTC(2026, 10, 3, 9, 0, tick++)).toISOString();
  const toDrive = (f: MemFile): DriveFile => {
    const isFolder = f.mimeType === GOOGLE_MIME.folder;
    return {
      id: f.id,
      name: f.name,
      mimeType: f.mimeType,
      parents: f.parents,
      trashed: f.trashed,
      createdTime: f.createdTime,
      modifiedTime: f.modifiedTime,
      ...(isFolder
        ? {}
        : {
            md5Checksum: createHash('md5').update(f.content).digest('hex'),
            size: String(f.content.length),
          }),
      capabilities: { canEdit: f.canEdit, canTrash: f.canTrash, canAddChildren: isFolder },
    };
  };
  const add = (
    f: Omit<MemFile, 'createdTime' | 'modifiedTime' | 'trashed' | 'canEdit' | 'canTrash'> &
      Partial<MemFile>,
  ): MemFile => {
    const now = stamp();
    const file: MemFile = {
      trashed: false,
      canEdit: true,
      canTrash: true,
      createdTime: now,
      modifiedTime: now,
      ...f,
    };
    files.set(file.id, file);
    return file;
  };
  const drive = createFakeDrive();
  drive.getFile.mockImplementation(async (id) => {
    const f = files.get(id);
    if (!f) throw httpError(404, 'notFound');
    return toDrive(f);
  });
  drive.listFiles.mockImplementation(async ({ q }) => {
    const parent = /'((?:\\'|[^'])+)' in parents/.exec(q)?.[1];
    const name = /name = '((?:\\'|[^'])*)'/.exec(q)?.[1];
    const mime = /mimeType = '([^']+)'/.exec(q)?.[1];
    const list = [...files.values()].filter(
      (f) =>
        (parent === undefined || f.parents.includes(unescape(parent))) &&
        (!q.includes('trashed = false') || !f.trashed) &&
        (name === undefined || f.name === unescape(name)) &&
        (mime === undefined || f.mimeType === mime),
    );
    return { files: list.map(toDrive) };
  });
  drive.createFile.mockImplementation(async ({ requestBody, media }) => {
    const created = add({
      id: `n${++seq}`,
      name: requestBody.name ?? '',
      mimeType: requestBody.mimeType ?? media?.mimeType ?? 'application/octet-stream',
      parents: requestBody.parents ?? [rootId],
      content: media ? await readAll(media.body) : Buffer.alloc(0),
    });
    return toDrive(created);
  });
  drive.updateFile.mockImplementation(async ({ fileId, requestBody, media }) => {
    const f = files.get(fileId);
    if (!f) throw httpError(404, 'notFound');
    if (requestBody?.trashed !== undefined && requestBody.trashed !== null)
      f.trashed = requestBody.trashed;
    if (requestBody?.name) f.name = requestBody.name;
    if (media) {
      f.content = await readAll(media.body);
      f.modifiedTime = stamp();
    }
    return toDrive(f);
  });
  drive.downloadMedia.mockImplementation(async (id) => {
    const f = files.get(id);
    if (!f) throw httpError(404, 'notFound');
    return Readable.from([f.content]);
  });
  add({
    id: rootId,
    name: 'Sync root',
    mimeType: GOOGLE_MIME.folder,
    parents: ['my-drive'],
    content: Buffer.alloc(0),
  });
  return {
    drive,
    files,
    addFolder: (id, name, parent) =>
      add({ id, name, mimeType: GOOGLE_MIME.folder, parents: [parent], content: Buffer.alloc(0) }),
    addFile: (id, name, parent, content, extra = {}) =>
      add({
        id,
        name,
        mimeType: 'application/pdf',
        parents: [parent],
        content: Buffer.from(content),
        ...extra,
      }),
    childrenOf: (parent) =>
      [...files.values()].filter((f) => f.parents.includes(parent) && !f.trashed),
  };
}
```

- [ ] **Step 1: Write the failing tests.**

`src/sync/__tests__/sync-service.pairs.test.ts`:

```ts
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ValidationError } from '../../errors.js';
import { createAudit, createRunner, noSleep, silentLogger } from '../../files/__tests__/fakes.js';
import { PairStore, markerName, probeCaseInsensitive } from '../pair-store.js';
import { SyncService } from '../sync-service.js';
import { refuseTrash } from './fixtures.js';
import { memoryDrive, type MemoryDrive } from './memory-drive.js';

let tmp: string;
let local: string;
let mem: MemoryDrive;
let store: PairStore;
let audit: ReturnType<typeof createAudit>;
let sync: SyncService;

beforeEach(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), 'sync-svc-'));
  local = path.join(tmp, 'Local');
  await mkdir(local);
  mem = memoryDrive('ROOT');
  store = new PairStore({ dir: path.join(tmp, 'config', 'sync'), logger: silentLogger() });
  audit = createAudit();
  sync = new SyncService({
    runner: createRunner(mem.drive),
    audit,
    retry: noSleep,
    logger: silentLogger(),
    store,
    trashExec: refuseTrash,
    clock: () => new Date('2026-11-03T12:00:00.000Z'),
  });
});
afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

async function createDocs(): Promise<void> {
  await sync.createPair({ name: 'docs', localDir: local, remoteFolderId: 'ROOT' });
}

describe('createPair', () => {
  it('binds an existing Drive folder, writes the marker and probes case sensitivity', async () => {
    const summary = await sync.createPair({
      name: 'docs',
      localDir: local,
      remoteFolderId: 'ROOT',
    });
    const file = await store.load('docs');
    expect(summary).toMatchObject({
      name: 'docs',
      account: 'emco',
      remoteFolderId: 'ROOT',
      lastAppliedRunAt: null,
    });
    expect(summary.localDir).toBe(file.pair.localDir);
    expect((await readFile(path.join(local, markerName('docs')), 'utf8')).trim()).toBe(
      file.pair.id,
    );
    expect(file.pair.caseInsensitive).toBe(await probeCaseInsensitive(local, 'docs'));
    expect(file.pair.googleExport).toEqual({
      document: 'docx',
      spreadsheet: 'xlsx',
      presentation: 'pptx',
      drawing: 'pdf',
    });
  });

  it('creates a new Drive folder by name and audits it', async () => {
    mem.addFolder('P', 'Parent', 'my-drive');
    const summary = await sync.createPair({
      name: 'docs',
      localDir: local,
      remoteFolderName: 'Backup',
      remoteParentId: 'P',
    });
    const created = mem.files.get(summary.remoteFolderId);
    expect(created).toMatchObject({ name: 'Backup', parents: ['P'] });
    expect(audit.entries[0]).toMatchObject({ op: 'create_folder', fileId: summary.remoteFolderId });
  });

  it('validates the name, the remote arguments and the local folder', async () => {
    await expect(
      sync.createPair({ name: 'Bad Name', localDir: local, remoteFolderId: 'ROOT' }),
    ).rejects.toThrow('Invalid pair name');
    await expect(sync.createPair({ name: 'docs', localDir: local })).rejects.toThrow('exactly one');
    await expect(
      sync.createPair({
        name: 'docs',
        localDir: local,
        remoteFolderId: 'ROOT',
        remoteFolderName: 'x',
      }),
    ).rejects.toThrow('exactly one');
    await expect(
      sync.createPair({ name: 'docs', localDir: 'rel', remoteFolderId: 'ROOT' }),
    ).rejects.toThrow('absolute');
    await expect(
      sync.createPair({ name: 'docs', localDir: path.join(tmp, 'nope'), remoteFolderId: 'ROOT' }),
    ).rejects.toThrow('does not exist');
  });

  it('rejects a Drive file that is not a usable folder and removes the marker again', async () => {
    mem.addFile('F', 'a.pdf', 'ROOT', 'x');
    await expect(
      sync.createPair({ name: 'docs', localDir: local, remoteFolderId: 'F' }),
    ).rejects.toThrow('is not a folder');
    expect(await readdir(local)).toEqual([]);
    expect(await store.exists('docs')).toBe(false);
  });

  it('rejects overlapping pairs', async () => {
    await createDocs();
    await mkdir(path.join(local, 'sub'));
    mem.addFolder('R2', 'Other', 'my-drive');
    await expect(
      sync.createPair({ name: 'sub', localDir: path.join(local, 'sub'), remoteFolderId: 'R2' }),
    ).rejects.toThrow('overlaps');
    const other = path.join(tmp, 'Other');
    await mkdir(other);
    await expect(
      sync.createPair({ name: 'other', localDir: other, remoteFolderId: 'ROOT' }),
    ).rejects.toThrow('already used');
    await expect(
      sync.createPair({ name: 'docs', localDir: other, remoteFolderId: 'R2' }),
    ).rejects.toThrow('already exists');
  });
});

describe('listPairs / removePair / repairMarker', () => {
  it('lists pairs with counts', async () => {
    await createDocs();
    expect(await sync.listPairs()).toEqual([
      expect.objectContaining({
        name: 'docs',
        counts: { selected: 0, tracked: 0, remoteOnly: 0, excluded: 0, baseline: 0 },
      }),
    ]);
  });

  it('removes the pair and its marker but no files', async () => {
    await createDocs();
    await writeFile(path.join(local, 'keep.pdf'), 'x');
    await expect(sync.removePair({ name: 'docs' })).resolves.toMatchObject({
      name: 'docs',
      removed: true,
    });
    expect(await readdir(local)).toEqual(['keep.pdf']);
    expect(await store.exists('docs')).toBe(false);
    expect(mem.files.has('ROOT')).toBe(true);
  });

  it('rewrites the marker only after confirmation', async () => {
    await createDocs();
    await rm(path.join(local, markerName('docs')));
    const declined = await sync.repairMarker('docs', async () => false);
    expect(declined.repaired).toBe(false);
    expect(await readdir(local)).toEqual([]);
    const confirmed = await sync.repairMarker('docs', async (pair) =>
      pair.localDir.endsWith('Local'),
    );
    expect(confirmed.repaired).toBe(true);
    expect((await readFile(path.join(local, markerName('docs')), 'utf8')).trim()).toBe(
      (await store.load('docs')).pair.id,
    );
  });
});

describe('select', () => {
  beforeEach(async () => {
    await createDocs();
    await mkdir(path.join(local, 'sub'));
    await writeFile(path.join(local, 'sub', 'Report.pdf'), 'r');
    await writeFile(path.join(local, '.env'), 'secret');
    mem.addFile('n1', 'remote.pdf', 'ROOT', 'remote');
  });

  it('adds local and remote paths, canonicalised and deduped by foldKey', async () => {
    const res = await sync.select({
      name: 'docs',
      add: ['sub/report.pdf', 'sub/Report.pdf', 'remote.pdf'],
    });
    expect(res).toMatchObject({
      added: ['sub/Report.pdf', 'remote.pdf'],
      rejected: [],
      selected: 2,
    });
    expect((await store.load('docs')).pair.selection).toEqual(['sub/Report.pdf', 'remote.pdf']);
  });

  it('rejects ignored, missing and invalid paths', async () => {
    const res = await sync.select({
      name: 'docs',
      add: ['.env', 'missing.pdf', '../x', 'sub/.hidden'],
    });
    expect(res.added).toEqual([]);
    expect(res.rejected.map((r) => [r.path, r.reason])).toEqual([
      ['.env', 'dot-files and temp files are never synced'],
      ['missing.pdf', 'not found locally or in the Drive folder'],
      ['../x', '"../x" is not a clean relative path'],
      ['sub/.hidden', 'dot-files and temp files are never synced'],
    ]);
  });

  it('remove moves the key to excluded and drops the record; add takes it back', async () => {
    await sync.select({ name: 'docs', add: ['remote.pdf'] });
    const file = await store.load('docs');
    file.records.push({
      remoteId: 'n1',
      path: 'remote.pdf',
      localName: 'remote.pdf',
      remoteName: 'remote.pdf',
      remoteParentId: 'ROOT',
      localMd5: 'x',
      localSize: 1,
      localMtimeMs: 1,
      localCtimeMs: 1,
      remoteMd5: 'x',
      remoteSize: 1,
      remoteModifiedTime: 't',
      native: null,
      remoteOnly: false,
      restorePending: false,
      remoteTrashed: false,
    });
    await store.save(file);
    const removed = await sync.select({ name: 'docs', remove: ['remote.pdf'] });
    expect(removed).toMatchObject({
      removed: ['remote.pdf'],
      selected: 0,
      excluded: 1,
      tracked: 0,
    });
    expect(mem.files.get('n1')?.trashed).toBe(false);
    const again = await sync.select({ name: 'docs', add: ['remote.pdf'] });
    expect(again).toMatchObject({ added: ['remote.pdf'], excluded: 0 });
  });

  it('refuses while another writer holds the lock', async () => {
    const release = await store.lock('docs');
    await expect(sync.select({ name: 'docs', add: ['remote.pdf'] })).rejects.toThrow(
      ValidationError,
    );
    await release();
  });
});

describe('scan', () => {
  beforeEach(async () => {
    await createDocs();
    await mkdir(path.join(local, 'notes'));
    await writeFile(
      path.join(local, 'notes', 'ship.md'),
      '# Seafaring\nCargo manifest for the vessel',
    );
    await writeFile(path.join(local, 'manual.pdf'), Buffer.from([0x25, 0x50, 0x44, 0x46, 0]));
    await writeFile(path.join(local, 'picked.txt'), 'already chosen');
    mem.addFile('n1', 'drive-only.pdf', 'ROOT', 'x');
    await sync.select({ name: 'docs', add: ['picked.txt'] });
  });

  it('returns unselected local files with text previews and remote candidates', async () => {
    const res = await sync.scan({ name: 'docs', previewChars: 10 });
    expect(res.entries.map((e) => [e.path, e.mimeType, e.preview])).toEqual([
      ['manual.pdf', 'application/pdf', undefined],
      ['notes/ship.md', 'text/markdown', '# Seafarin'],
    ]);
    expect(res.remoteCandidates).toEqual([
      {
        path: 'drive-only.pdf',
        size: 1,
        modifiedTime: expect.any(String),
        mimeType: 'application/pdf',
      },
    ]);
    expect(res.truncated).toBe(false);
  });

  it('honours onlyUnselected, subdir and limit', async () => {
    const all = await sync.scan({ name: 'docs', onlyUnselected: false, previewChars: 0 });
    expect(all.entries.map((e) => e.path)).toEqual(['manual.pdf', 'notes/ship.md', 'picked.txt']);
    const sub = await sync.scan({ name: 'docs', subdir: 'notes' });
    expect(sub.entries.map((e) => e.path)).toEqual(['notes/ship.md']);
    expect(sub.remoteCandidates).toEqual([]);
    const limited = await sync.scan({ name: 'docs', limit: 1 });
    expect(limited.entries).toHaveLength(1);
    expect(limited.truncated).toBe(true);
  });
});
```

- [ ] **Step 2: Run and see it fail** — `npx vitest run src/sync/__tests__/sync-service.pairs.test.ts` → FAIL: `../sync-service.js` cannot be resolved.

- [ ] **Step 3: Implement.**

`src/sync/sync-service.ts`:

```ts
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { access, open, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { OperationRunner, type OperationDeps } from '../core/operation.js';
import type { DriveFile } from '../drive/drive-adapter.js';
import { AppError, NotFoundError, ValidationError } from '../errors.js';
import { expandHome } from '../files/destination.js';
import { GOOGLE_MIME } from '../files/export-formats.js';
import { uploadMimeType } from '../files/upload-mime.js';
import { logger as defaultLogger, type Logger } from '../logger.js';
import { SyncRootError } from './errors.js';
import { scanLocal } from './local-scanner.js';
import {
  PairStore,
  checkOverlap,
  probeCaseInsensitive,
  readMarker,
  removeMarker,
  writeMarker,
} from './pair-store.js';
import {
  absInside,
  ancestorKeys,
  foldKey,
  isIgnoredName,
  isUnder,
  validateRelPath,
} from './paths.js';
import { SYNC_LIST_FIELDS, SYNC_PAGE_SIZE, childrenQuery, scanRemote } from './remote-scanner.js';
import type { ExecFn } from './trash.js';
import {
  DEFAULT_GOOGLE_EXPORT,
  PAIR_NAME,
  SYNC_FILE_FIELDS,
  type LocalScan,
  type Pair,
  type PairFile,
  type RemoteScan,
} from './types.js';

const TEXT_MIME = /^(text\/|application\/(json|xml|javascript|x-yaml|yaml|x-sh|sql|toml))/;

export interface SyncServiceDeps extends OperationDeps {
  store: PairStore;
  /** Runs /usr/bin/trash (the app passes `defaultExec`; tests pass a fake, never the real Trash). */
  trashExec: ExecFn;
  clock?: () => Date;
}

export interface CreatePairInput {
  name: string;
  localDir: string;
  remoteFolderId?: string;
  remoteFolderName?: string;
  remoteParentId?: string;
  account?: string;
}

export interface PairSummary {
  name: string;
  account: string;
  localDir: string;
  remoteFolderId: string;
  caseInsensitive: boolean;
  counts: {
    selected: number;
    tracked: number;
    remoteOnly: number;
    excluded: number;
    baseline: number;
  };
  createdAt: string;
  lastAppliedRunAt: string | null;
}

export interface ScanInput {
  name: string;
  onlyUnselected?: boolean;
  previewChars?: number;
  limit?: number;
  subdir?: string;
}

export interface ScanEntry {
  path: string;
  size: number;
  modifiedTime: string;
  mimeType: string;
  preview?: string;
}

export interface ScanResult {
  entries: ScanEntry[];
  remoteCandidates: Array<{
    path: string;
    size: number | null;
    modifiedTime: string;
    mimeType: string;
  }>;
  truncated: boolean;
}

export interface SelectInput {
  name: string;
  add?: string[];
  remove?: string[];
}

export interface SelectResult {
  selected: number;
  excluded: number;
  tracked: number;
  added: string[];
  removed: string[];
  rejected: Array<{ path: string; reason: string }>;
}

export function summarize(file: PairFile): PairSummary {
  const { pair, records } = file;
  return {
    name: pair.name,
    account: pair.account,
    localDir: pair.localDir,
    remoteFolderId: pair.remoteFolderId,
    caseInsensitive: pair.caseInsensitive,
    counts: {
      selected: pair.selection.length,
      tracked: records.length,
      remoteOnly: records.filter((r) => r.remoteOnly).length,
      excluded: pair.excluded.length,
      baseline: pair.remoteBaseline.length,
    },
    createdAt: pair.createdAt,
    lastAppliedRunAt: pair.lastAppliedRunAt,
  };
}

/** Why a Drive folder cannot be a pair root, or null (spec §5 step 2). */
export function remoteRootProblem(file: DriveFile): string | null {
  if (file.mimeType !== GOOGLE_MIME.folder) return 'is not a folder';
  if (file.trashed) return 'is in the Drive trash';
  if (file.capabilities?.canAddChildren === false) return 'does not allow adding files';
  return null;
}

async function resolveLocalDir(input: string): Promise<string> {
  const expanded = expandHome(input);
  if (!path.isAbsolute(expanded)) {
    throw new ValidationError(`localDir must be an absolute path (got "${input}")`);
  }
  let real: string;
  try {
    real = await realpath(expanded);
  } catch (err) {
    throw new ValidationError(`${expanded} does not exist`, { cause: err });
  }
  if (!(await stat(real)).isDirectory()) throw new ValidationError(`${real} is not a folder`);
  return real;
}

async function readPreview(abs: string, chars: number): Promise<string | undefined> {
  const handle = await open(abs, 'r');
  try {
    const buf = Buffer.alloc(chars * 4);
    const { bytesRead } = await handle.read(buf, 0, buf.length, 0);
    const bytes = buf.subarray(0, bytesRead);
    if (bytes.includes(0)) return undefined;
    return Array.from(bytes.toString('utf8')).slice(0, chars).join('');
  } finally {
    await handle.close();
  }
}

/** Sub-project 5 Phase A: pairs, AI-assisted selection, dry-run/apply two-way sync. */
export class SyncService {
  private readonly ops: OperationRunner;
  private readonly log: Logger;
  private readonly clock: () => Date;

  constructor(private readonly deps: SyncServiceDeps) {
    this.ops = new OperationRunner(deps);
    this.log = deps.logger ?? defaultLogger;
    this.clock = deps.clock ?? ((): Date => new Date());
  }

  private get store(): PairStore {
    return this.deps.store;
  }

  async createPair(input: CreatePairInput): Promise<PairSummary> {
    if (!PAIR_NAME.test(input.name)) {
      throw new ValidationError(`Invalid pair name "${input.name}" (use a-z, 0-9 and -, max 40)`);
    }
    if (Boolean(input.remoteFolderId) === Boolean(input.remoteFolderName)) {
      throw new ValidationError('Give exactly one of remoteFolderId or remoteFolderName');
    }
    const localDir = await resolveLocalDir(input.localDir);
    return this.store.withLock(input.name, async () => {
      const existing = (await this.store.list()).map((f) => f.pair);
      checkOverlap(existing, {
        name: input.name,
        localDir,
        remoteFolderId: input.remoteFolderId ?? '',
      });
      const id = randomUUID();
      await writeMarker(localDir, input.name, id);
      let remote: { folderId: string; alias: string };
      try {
        remote = await this.resolveRemoteRoot(input);
        checkOverlap(existing, { name: input.name, localDir, remoteFolderId: remote.folderId });
      } catch (err) {
        await removeMarker(localDir, input.name);
        throw err;
      }
      const pair: Pair = {
        name: input.name,
        id,
        account: remote.alias,
        localDir,
        caseInsensitive: await probeCaseInsensitive(localDir, input.name),
        remoteFolderId: remote.folderId,
        googleExport: { ...DEFAULT_GOOGLE_EXPORT },
        selection: [],
        excluded: [],
        remoteBaseline: [],
        baselineFolders: [],
        createdAt: this.clock().toISOString(),
        lastAppliedRunAt: null,
        firstAppliedRunAt: null,
      };
      const file: PairFile = { version: 1, pair, records: [] };
      await this.store.save(file);
      return summarize(file);
    });
  }

  private resolveRemoteRoot(input: CreatePairInput): Promise<{ folderId: string; alias: string }> {
    const folderId = input.remoteFolderId;
    if (folderId) {
      return this.ops.exec(input.account, 'idempotent', folderId, async (ctx) => {
        const root = await ctx.drive.getFile(folderId, SYNC_FILE_FIELDS);
        const problem = remoteRootProblem(root);
        if (problem) throw new ValidationError(`Drive folder ${folderId} ${problem}`);
        return { folderId, alias: ctx.account.alias };
      });
    }
    const parentId = input.remoteParentId ?? 'root';
    return this.ops.exec(input.account, 'create', input.remoteParentId, async (ctx) => {
      const folder = await ctx.drive.createFile({
        requestBody: {
          name: input.remoteFolderName ?? '',
          mimeType: GOOGLE_MIME.folder,
          parents: [parentId],
        },
        fields: 'id, name',
      });
      await this.ops.audit(ctx, 'create_folder', folder, { parentId, pair: input.name });
      return { folderId: folder.id ?? '', alias: ctx.account.alias };
    });
  }

  async listPairs(): Promise<PairSummary[]> {
    return (await this.store.list()).map(summarize);
  }

  async removePair(input: {
    name: string;
  }): Promise<{ name: string; removed: true; note: string }> {
    return this.store.withLock(input.name, async () => {
      const { pair } = await this.store.load(input.name);
      try {
        await removeMarker(pair.localDir, pair.name);
      } catch (err) {
        this.log.warn('Could not remove the sync marker', { name: pair.name, error: err });
      }
      await this.store.remove(pair.name);
      return {
        name: pair.name,
        removed: true,
        note: 'Pair removed; no local or Drive files were touched.',
      };
    });
  }

  /** Rewrites the root marker after `confirm` (spec §9) and re-probes case sensitivity. */
  async repairMarker(
    name: string,
    confirm: (pair: Pair) => Promise<boolean>,
  ): Promise<{ repaired: boolean; localDir: string; caseInsensitive: boolean }> {
    return this.store.withLock(name, async () => {
      const file = await this.store.load(name);
      const { pair } = file;
      const info = await stat(pair.localDir).catch(() => null);
      if (!info?.isDirectory())
        throw new ValidationError(`${pair.localDir} is not an available folder`);
      if (!(await confirm(pair))) {
        return { repaired: false, localDir: pair.localDir, caseInsensitive: pair.caseInsensitive };
      }
      await writeMarker(pair.localDir, pair.name, pair.id);
      pair.caseInsensitive = await probeCaseInsensitive(pair.localDir, pair.name);
      await this.store.save(file);
      return { repaired: true, localDir: pair.localDir, caseInsensitive: pair.caseInsensitive };
    });
  }

  /** Spec §5 step 2: any failure aborts the whole run. */
  private async checkRoots(pair: Pair): Promise<void> {
    const hint = `run: marvin-drive sync repair-marker ${pair.name}`;
    const info = await stat(pair.localDir).catch(() => null);
    if (!info?.isDirectory()) {
      throw new SyncRootError(`${pair.localDir} is not available (unmounted, moved or deleted?)`);
    }
    try {
      await access(pair.localDir, constants.R_OK | constants.X_OK);
    } catch (err) {
      throw new SyncRootError(`${pair.localDir} is not readable`, { cause: err });
    }
    const marker = await readMarker(pair.localDir, pair.name).catch(() => null);
    if (marker !== pair.id) {
      throw new SyncRootError(
        `The marker .marvin-sync-${pair.name} in ${pair.localDir} is missing or belongs to another pair; ${hint}`,
      );
    }
    if ((await probeCaseInsensitive(pair.localDir, pair.name)) !== pair.caseInsensitive) {
      throw new SyncRootError(`Case sensitivity of ${pair.localDir} changed; ${hint}`);
    }
    let root: DriveFile;
    try {
      root = await this.ops.exec(pair.account, 'idempotent', pair.remoteFolderId, (ctx) =>
        ctx.drive.getFile(pair.remoteFolderId, SYNC_FILE_FIELDS),
      );
    } catch (err) {
      if (err instanceof NotFoundError) {
        throw new SyncRootError(`The Drive folder ${pair.remoteFolderId} no longer exists`, {
          cause: err,
        });
      }
      throw err;
    }
    const problem = remoteRootProblem(root);
    if (problem) throw new SyncRootError(`The Drive folder ${pair.remoteFolderId} ${problem}`);
  }

  private async scanBoth(pair: Pair): Promise<{ local: LocalScan; remote: RemoteScan }> {
    const local = await scanLocal(pair.localDir);
    const remote = await scanRemote(pair.remoteFolderId, (folderId, pageToken) =>
      this.ops.exec(pair.account, 'idempotent', folderId, (ctx) =>
        ctx.drive.listFiles({
          q: childrenQuery(folderId),
          pageSize: SYNC_PAGE_SIZE,
          ...(pageToken ? { pageToken } : {}),
          fields: SYNC_LIST_FIELDS,
        }),
      ),
    );
    return { local, remote };
  }

  /** sync_scan: local files (with text previews) and remote candidates for Claude to choose from. */
  async scan(input: ScanInput): Promise<ScanResult> {
    const file = await this.store.load(input.name);
    const { pair } = file;
    await this.checkRoots(pair);
    const subdir = input.subdir ? validateRelPath(input.subdir) : undefined;
    const limit = input.limit ?? 200;
    const previewChars = input.previewChars ?? 300;
    const local = await scanLocal(pair.localDir, subdir ? { subdir } : {});
    const { remote } = await this.scanBoth(pair);
    const selected = new Set(pair.selection.map(foldKey));
    const excluded = new Set(pair.excluded.map(foldKey));
    const tracked = new Set(file.records.map((r) => r.remoteId));
    const onlyUnselected = input.onlyUnselected ?? true;
    const localHits = local.entries.filter(
      (e) => !excluded.has(e.foldKey) && !(onlyUnselected && selected.has(e.foldKey)),
    );
    const remoteHits = remote.entries.filter(
      (r) =>
        !tracked.has(r.id) &&
        !selected.has(r.foldKey) &&
        !excluded.has(r.foldKey) &&
        (subdir === undefined || isUnder(r.key, subdir)),
    );
    const entries: ScanEntry[] = [];
    for (const e of localHits.slice(0, limit)) {
      const mimeType = uploadMimeType(e.name);
      const entry: ScanEntry = {
        path: e.key,
        size: e.size,
        modifiedTime: new Date(e.mtimeMs).toISOString(),
        mimeType,
      };
      if (previewChars > 0 && TEXT_MIME.test(mimeType)) {
        try {
          const preview = await readPreview(absInside(pair.localDir, e.name), previewChars);
          if (preview !== undefined) entry.preview = preview;
        } catch (err) {
          this.log.warn('Preview failed', { path: e.key, error: err });
        }
      }
      entries.push(entry);
    }
    return {
      entries,
      remoteCandidates: remoteHits.slice(0, limit).map((r) => ({
        path: r.key,
        size: r.size,
        modifiedTime: r.modifiedTime,
        mimeType: r.mimeType,
      })),
      truncated: localHits.length > limit || remoteHits.length > limit,
    };
  }

  /** sync_select: add/remove relative paths (spec §8). */
  async select(input: SelectInput): Promise<SelectResult> {
    return this.store.withLock(input.name, async () => {
      const file = await this.store.load(input.name);
      const { pair } = file;
      const result: SelectResult = {
        selected: 0,
        excluded: 0,
        tracked: 0,
        added: [],
        removed: [],
        rejected: [],
      };
      const validated = (raw: string): string | null => {
        try {
          return validateRelPath(raw);
        } catch (err) {
          result.rejected.push({
            path: raw,
            reason: err instanceof AppError ? err.message : 'invalid path',
          });
          return null;
        }
      };
      for (const raw of input.remove ?? []) {
        const key = validated(raw);
        if (key === null) continue;
        const fold = foldKey(key);
        pair.selection = pair.selection.filter((k) => foldKey(k) !== fold);
        file.records = file.records.filter((r) => foldKey(r.path) !== fold);
        if (!pair.excluded.some((k) => foldKey(k) === fold)) pair.excluded.push(key);
        result.removed.push(key);
      }
      if (input.add && input.add.length > 0) {
        await this.checkRoots(pair);
        const { local, remote } = await this.scanBoth(pair);
        const localByFold = new Map(local.entries.map((e) => [e.foldKey, e.key]));
        const remoteByFold = new Map(remote.entries.map((r) => [r.foldKey, r.key]));
        const unknown = [...local.unknownSubtrees, ...remote.unknownSubtrees];
        const blocking = local.blocking.map(foldKey);
        for (const raw of input.add) {
          const key = validated(raw);
          if (key === null) continue;
          const fold = foldKey(key);
          const reject = (reason: string): void => {
            result.rejected.push({ path: raw, reason });
          };
          if (key.split('/').some(isIgnoredName))
            reject('dot-files and temp files are never synced');
          else if (unknown.some((u) => isUnder(key, u)))
            reject('inside a folder that could not be read');
          else if (ancestorKeys(key).some((a) => blocking.includes(foldKey(a))))
            reject('inside a symlinked, special or ignored folder');
          else if (pair.selection.some((k) => foldKey(k) === fold)) continue;
          else {
            const canonical = localByFold.get(fold) ?? remoteByFold.get(fold);
            if (canonical === undefined) reject('not found locally or in the Drive folder');
            else {
              pair.excluded = pair.excluded.filter((k) => foldKey(k) !== fold);
              pair.selection.push(canonical);
              result.added.push(canonical);
            }
          }
        }
      }
      await this.store.save(file);
      return {
        ...result,
        selected: pair.selection.length,
        excluded: pair.excluded.length,
        tracked: file.records.length,
      };
    });
  }
}
```

- [ ] **Step 4: Run and see it pass** — `npx vitest run src/sync/__tests__/sync-service.pairs.test.ts` → PASS.

- [ ] **Step 5: Quality gate** — `npx prettier --write src/sync` then `npm run check` → typecheck, eslint (0 warnings), prettier and all tests green.

- [ ] **Step 6: Commit** —

```bash
git add src/sync
git commit -m "feat(sync): sync service with pairs, root checks, scan and select" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

## Chunk 9: Report, run lifecycle and MCP tools

### Task 14: Run report

**Files:**
- Create: `src/sync/report.ts`
- Test: `src/sync/__tests__/report.test.ts`

- [ ] **Step 1: Write the failing tests.**

`src/sync/__tests__/report.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { buildReport } from '../report.js';
import type { Action, Plan } from '../types.js';

function action(kind: Action['kind'], key: string): Action {
  return {
    kind,
    rule: 'x',
    key,
    record: null,
    local: null,
    localMd5: null,
    remote: null,
    selection: {},
  };
}

const PLAN: Plan = {
  planId: 'p1',
  actions: [action('upload-new', 'a.pdf'), action('refresh', 'r.pdf'), action('conflict', 'c.pdf')],
  notes: [
    {
      code: 'unknown-state',
      path: 'u.pdf',
      rule: 'unknown',
      message: 'local folder could not be read',
    },
    { code: 'ambiguous', path: 'x.pdf', rule: 'ambiguous' },
    { code: 'ambiguous', path: 'x.pdf', rule: 'ambiguous' },
    { code: 'collision', path: 'k.pdf', rule: 'U7' },
    { code: 'remote-readonly', path: 'ro.pdf', rule: 'B2', message: 'no edit permission in Drive' },
  ],
  candidates: {
    local: [{ path: 'l.pdf', size: 1, modifiedTime: 't' }],
    remote: [],
    truncated: false,
  },
  brake: { tripped: false, trashRemote: 0, trashLocal: 0, tracked: 0 },
  baseline: { files: [], folders: [] },
};

describe('buildReport', () => {
  it('lists planned actions (without refreshes) and classifies notes on a dry run', () => {
    expect(buildReport('docs', PLAN, { dryRun: true })).toEqual({
      pair: 'docs',
      dryRun: true,
      planId: 'p1',
      aborted: null,
      actions: { 'upload-new': ['a.pdf'], conflict: ['c.pdf'] },
      conflicts: [{ path: 'c.pdf' }],
      collisions: ['k.pdf'],
      ambiguous: ['x.pdf'],
      unknown: [{ path: 'u.pdf', reason: 'local folder could not be read' }],
      warnings: [
        { path: 'ro.pdf', code: 'remote-readonly', message: 'no edit permission in Drive' },
      ],
      failures: [],
      notRun: [],
      candidates: PLAN.candidates,
    });
  });

  it('reports executed outcomes', () => {
    const report = buildReport('docs', PLAN, {
      dryRun: false,
      outcomes: [
        { kind: 'upload-new', path: 'a.pdf', status: 'done', warning: 'changed-during-upload' },
        { kind: 'refresh', path: 'r.pdf', status: 'done' },
        {
          kind: 'conflict',
          path: 'c.pdf',
          status: 'done',
          conflictCopy: 'c (Drive conflict 2026-11-03 10.15).pdf',
        },
        { kind: 'download-replace', path: 'd.pdf', status: 'skipped', message: 'changed' },
        { kind: 'download-new', path: 'e.pdf', status: 'collision', message: 'exists' },
        { kind: 'update-remote', path: 'f.pdf', status: 'failed', message: 'boom' },
        { kind: 'trash-local', path: 'g.pdf', status: 'not-run' },
      ],
    });
    expect(report.actions).toEqual({ 'upload-new': ['a.pdf'], conflict: ['c.pdf'] });
    expect(report.conflicts).toEqual([
      { path: 'c.pdf', conflictCopy: 'c (Drive conflict 2026-11-03 10.15).pdf' },
    ]);
    expect(report.warnings).toEqual([
      { path: 'ro.pdf', code: 'remote-readonly', message: 'no edit permission in Drive' },
      { path: 'a.pdf', code: 'changed-during-upload' },
      { path: 'd.pdf', code: 'skipped-changed', message: 'changed' },
    ]);
    expect(report.collisions).toEqual(['k.pdf', 'e.pdf']);
    expect(report.failures).toEqual([{ path: 'f.pdf', kind: 'update-remote', message: 'boom' }]);
    expect(report.notRun).toEqual(['g.pdf']);
  });

  it('carries an abort reason', () => {
    const aborted = { reason: 'mass-delete' as const, message: 'too many' };
    expect(buildReport('docs', PLAN, { dryRun: true, aborted }).aborted).toEqual(aborted);
  });
});
```

- [ ] **Step 2: Run and see it fail** — `npx vitest run src/sync/__tests__/report.test.ts` → FAIL: `../report.js` cannot be resolved.

- [ ] **Step 3: Implement.**

`src/sync/report.ts`:

```ts
import type { ActionOutcome, Note, NoteCode, Plan, SyncReport } from './types.js';

const WARNING_CODES: ReadonlySet<NoteCode> = new Set([
  'conflict-rename',
  'moved-out',
  'moved-into-excluded',
  'remote-unavailable',
  'remote-readonly',
  'cannot-trash',
  'missing',
  'native-skipped',
  'unrepresentable',
  'weak-compare',
]);

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function warningOf(n: Note): { path: string; code: string; message?: string } {
  return { path: n.path, code: n.code, ...(n.message ? { message: n.message } : {}) };
}

export interface ReportOptions {
  dryRun: boolean;
  aborted?: SyncReport['aborted'];
  outcomes?: readonly ActionOutcome[];
}

/** Turns a plan (dry run / aborted) or executed outcomes into the sync_run report (spec §8). */
export function buildReport(pairName: string, plan: Plan, opts: ReportOptions): SyncReport {
  const notes = plan.notes;
  const report: SyncReport = {
    pair: pairName,
    dryRun: opts.dryRun,
    planId: plan.planId,
    aborted: opts.aborted ?? null,
    actions: {},
    conflicts: [],
    collisions: unique(notes.filter((n) => n.code === 'collision').map((n) => n.path)),
    ambiguous: unique(notes.filter((n) => n.code === 'ambiguous').map((n) => n.path)),
    unknown: notes
      .filter((n) => n.code === 'unknown-state')
      .map((n) => ({ path: n.path, ...(n.message ? { reason: n.message } : {}) })),
    warnings: notes.filter((n) => WARNING_CODES.has(n.code)).map(warningOf),
    failures: [],
    notRun: [],
    candidates: plan.candidates,
  };
  const add = (kind: keyof SyncReport['actions'], path: string): void => {
    (report.actions[kind] ??= []).push(path);
  };
  if (!opts.outcomes) {
    for (const a of plan.actions) {
      if (a.kind === 'refresh') continue;
      add(a.kind, a.key);
      if (a.kind === 'conflict') report.conflicts.push({ path: a.key });
    }
    return report;
  }
  for (const o of opts.outcomes) {
    if (o.status === 'done') {
      if (o.kind !== 'refresh') add(o.kind, o.path);
      if (o.kind === 'conflict') {
        report.conflicts.push({
          path: o.path,
          ...(o.conflictCopy ? { conflictCopy: o.conflictCopy } : {}),
        });
      }
      if (o.warning) report.warnings.push({ path: o.path, code: o.warning });
    } else if (o.status === 'skipped') {
      report.warnings.push({
        path: o.path,
        code: 'skipped-changed',
        ...(o.message ? { message: o.message } : {}),
      });
    } else if (o.status === 'collision') {
      report.collisions.push(o.path);
    } else if (o.status === 'failed') {
      report.failures.push({ path: o.path, kind: o.kind, message: o.message ?? 'failed' });
    } else {
      report.notRun.push(o.path);
    }
  }
  return report;
}
```

- [ ] **Step 4: Run and see it pass** — `npx vitest run src/sync/__tests__/report.test.ts` → PASS.

- [ ] **Step 5: Quality gate** — `npx prettier --write src/sync` then `npm run check` → typecheck, eslint (0 warnings), prettier and all tests green.

- [ ] **Step 6: Commit** —

```bash
git add src/sync
git commit -m "feat(sync): sync_run report from plans and outcomes" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 15: SyncService.run — dry run, planId, brake, execution, baseline

**Files:**
- Modify: `src/sync/sync-service.ts`
- Test: `src/sync/__tests__/sync-service.run.test.ts`

Spec §5: lock → scan-start timestamp → root checks → scan → (apply: stale part cleanup) → on-disk `lstat` of record keys without an exact scan match → hash → probe → plan → dry run returns the report / apply re-plans, checks `planId`, the brake, executes, then stamps `lastAppliedRunAt` with the **scan start** time (and on the first applied run `firstAppliedRunAt`, `remoteBaseline`, `baselineFolders`).

- [ ] **Step 1: Write the failing tests.**

`src/sync/__tests__/sync-service.run.test.ts`:

```ts
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createAudit, createRunner, noSleep, silentLogger } from '../../files/__tests__/fakes.js';
import { SyncRootError } from '../errors.js';
import { PairStore, markerName } from '../pair-store.js';
import { SyncService } from '../sync-service.js';
import { memoryDrive, type MemoryDrive } from './memory-drive.js';

let tmp: string;
let local: string;
let trashDir: string;
let mem: MemoryDrive;
let store: PairStore;
let sync: SyncService;
let now: Date;

beforeEach(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), 'sync-run-'));
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
    trashExec: async (_bin, args) => {
      const target = args[1] ?? '';
      await rename(target, path.join(trashDir, path.basename(target)));
    },
  });
  await sync.createPair({ name: 'docs', localDir: local, remoteFolderId: 'ROOT' });
});
afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

const at = (...parts: string[]): string => path.join(local, ...parts);

async function apply(extra: { allowMassDelete?: boolean } = {}) {
  const dry = await sync.run({ name: 'docs' });
  return sync.run({ name: 'docs', apply: true, planId: dry.planId, ...extra });
}

describe('root checks', () => {
  it('aborts when the marker is missing, with the repair hint', async () => {
    await rm(at(markerName('docs')));
    await expect(sync.run({ name: 'docs' })).rejects.toThrow(/repair-marker docs/);
    await expect(sync.run({ name: 'docs' })).rejects.toBeInstanceOf(SyncRootError);
  });

  it('aborts when the local folder is gone or the Drive folder is trashed', async () => {
    mem.files.get('ROOT')!.trashed = true;
    await expect(sync.run({ name: 'docs' })).rejects.toThrow('is in the Drive trash');
    await rm(local, { recursive: true });
    await expect(sync.run({ name: 'docs' })).rejects.toThrow('is not available');
  });

  it('aborts when the case sensitivity probe changed', async () => {
    const file = await store.load('docs');
    file.pair.caseInsensitive = !file.pair.caseInsensitive;
    await store.save(file);
    await expect(sync.run({ name: 'docs' })).rejects.toThrow('Case sensitivity');
  });
});

describe('run', () => {
  it('dry run is the default and writes nothing', async () => {
    await writeFile(at('a.pdf'), 'A');
    await sync.select({ name: 'docs', add: ['a.pdf'] });
    const before = await readFile(path.join(store.dir, 'docs.json'), 'utf8');
    const report = await sync.run({ name: 'docs' });
    expect(report).toMatchObject({
      dryRun: true,
      aborted: null,
      actions: { 'upload-new': ['a.pdf'] },
    });
    expect(await readFile(path.join(store.dir, 'docs.json'), 'utf8')).toBe(before);
    expect(mem.childrenOf('ROOT')).toEqual([]);
  });

  it('applies, records the baseline and keeps pre-existing Drive files as candidates', async () => {
    mem.addFile('old', 'old.pdf', 'ROOT', 'pre-existing');
    await writeFile(at('a.pdf'), 'A');
    await sync.select({ name: 'docs', add: ['a.pdf'] });
    const first = await apply();
    expect(first).toMatchObject({
      dryRun: false,
      actions: { 'upload-new': ['a.pdf'] },
      failures: [],
    });
    expect(first.candidates.remote.map((c) => c.path)).toEqual(['old.pdf']);
    const file = await store.load('docs');
    expect(file.pair).toMatchObject({
      firstAppliedRunAt: now.toISOString(),
      lastAppliedRunAt: now.toISOString(),
      remoteBaseline: ['old'],
    });
    expect(file.records.map((r) => r.path)).toEqual(['a.pdf']);

    now = new Date('2026-11-03T13:00:00.000Z');
    mem.addFile('new', 'new.pdf', 'ROOT', 'added later');
    const second = await apply();
    expect(second.actions).toEqual({ 'download-new': ['new.pdf'] });
    expect(second.candidates.remote.map((c) => c.path)).toEqual(['old.pdf']);
    expect(await readFile(at('new.pdf'), 'utf8')).toBe('added later');
    expect((await store.load('docs')).pair.selection).toEqual(['a.pdf', 'new.pdf']);
  });

  it('returns the new plan without applying when planId no longer matches', async () => {
    await writeFile(at('a.pdf'), 'A');
    await sync.select({ name: 'docs', add: ['a.pdf'] });
    const dry = await sync.run({ name: 'docs' });
    await writeFile(at('a.pdf'), 'A edited');
    const res = await sync.run({ name: 'docs', apply: true, planId: dry.planId });
    expect(res.aborted?.reason).toBe('plan-changed');
    expect(res.planId).not.toBe(dry.planId);
    expect(mem.childrenOf('ROOT')).toEqual([]);
  });

  it('brakes mass deletion unless allowed', async () => {
    for (const n of ['a', 'b', 'c']) await writeFile(at(`${n}.pdf`), n);
    await sync.select({ name: 'docs', add: ['a.pdf', 'b.pdf', 'c.pdf'] });
    await apply();
    for (const n of ['a', 'b', 'c']) await rm(at(`${n}.pdf`));
    const braked = await apply();
    expect(braked.aborted).toMatchObject({ reason: 'mass-delete' });
    expect(mem.childrenOf('ROOT')).toHaveLength(3);
    const allowed = await apply({ allowMassDelete: true });
    expect(allowed.actions['trash-remote']).toEqual(['a.pdf', 'b.pdf', 'c.pdf']);
    expect(mem.childrenOf('ROOT')).toEqual([]);
  });

  it('propagates edits both ways, conflicts, deletions and remote renames', async () => {
    for (const n of ['edit-local', 'edit-remote', 'both', 'del-local', 'del-remote', 'moved']) {
      await writeFile(at(`${n}.txt`), `${n} v1`);
    }
    await sync.select({
      name: 'docs',
      add: [
        'edit-local.txt',
        'edit-remote.txt',
        'both.txt',
        'del-local.txt',
        'del-remote.txt',
        'moved.txt',
      ],
    });
    await apply();
    const idOf = async (p: string): Promise<string> =>
      (await store.load('docs')).records.find((r) => r.path === p)?.remoteId ?? '';
    const setRemote = async (p: string, content: string): Promise<void> => {
      const f = mem.files.get(await idOf(p))!;
      f.content = Buffer.from(content);
      f.modifiedTime = '2026-11-03T14:00:00.000Z';
    };
    await writeFile(at('edit-local.txt'), 'local v2');
    await setRemote('edit-remote.txt', 'remote v2');
    await writeFile(at('both.txt'), 'both local');
    await setRemote('both.txt', 'both remote');
    await rm(at('del-local.txt'));
    mem.files.get(await idOf('del-remote.txt'))!.trashed = true;
    mem.addFolder('SUB', 'sub', 'ROOT');
    const moved = mem.files.get(await idOf('moved.txt'))!;
    moved.parents = ['SUB'];
    moved.name = 'renamed.txt';

    now = new Date('2026-11-03T15:30:00');
    const report = await apply();
    expect(report.failures).toEqual([]);
    expect(report.actions).toEqual({
      'update-remote': ['edit-local.txt'],
      'move-local': ['sub/renamed.txt'],
      'download-replace': ['edit-remote.txt'],
      conflict: ['both.txt'],
      'trash-remote': ['del-local.txt'],
      'trash-local': ['del-remote.txt'],
    });
    expect(report.conflicts).toEqual([
      { path: 'both.txt', conflictCopy: 'both (Drive conflict 2026-11-03 15.30).txt' },
    ]);
    expect(await readFile(at('both (Drive conflict 2026-11-03 15.30).txt'), 'utf8')).toBe(
      'both remote',
    );
    expect(mem.files.get(await idOf('both.txt'))?.content.toString()).toBe('both local');
    expect(await readFile(at('edit-remote.txt'), 'utf8')).toBe('remote v2');
    expect(mem.files.get(await idOf('edit-local.txt'))?.content.toString()).toBe('local v2');
    expect(await readFile(at('sub', 'renamed.txt'), 'utf8')).toBe('moved v1');
    expect(await readdir(trashDir)).toEqual(['del-remote.txt']);
    const after = await sync.run({ name: 'docs' });
    expect(after.actions).toEqual({});
  });

  it('deletes stale temp files on applied runs only', async () => {
    const part = at('.abc.marvin-part');
    await writeFile(part, 'partial');
    const old = new Date(now.getTime() - 2 * 60 * 60 * 1000);
    await utimes(part, old, old);
    await sync.run({ name: 'docs' });
    expect(await readdir(local)).toContain('.abc.marvin-part');
    await apply();
    expect(await readdir(local)).not.toContain('.abc.marvin-part');
  });
});

describe('run (review regressions)', () => {
  it('a folder moved to another disk and replaced by a symlink never trashes Drive files', async () => {
    await mkdir(at('a'));
    await writeFile(at('a', 'x.pdf'), 'X');
    await sync.select({ name: 'docs', add: ['a/x.pdf'] });
    await apply();
    const external = path.join(tmp, 'External');
    await rename(at('a'), external);
    await symlink(external, at('a'));
    const reachable = await apply();
    expect(reachable.actions).toEqual({});
    expect(reachable.unknown.map((u) => u.path)).toEqual(['a/x.pdf']);
    await rm(external, { recursive: true }); // disk unmounted: dangling symlink
    const dangling = await apply();
    expect(dangling.actions).toEqual({});
    expect(dangling.unknown.map((u) => u.path)).toEqual(['a/x.pdf']);
    expect(mem.childrenOf('ROOT').map((f) => f.name)).toEqual(['a']);
    expect(mem.childrenOf(mem.childrenOf('ROOT')[0]?.id ?? '').map((f) => f.name)).toEqual([
      'x.pdf',
    ]);
  });

  it('uploads into the existing Drive folder whose name differs only in case', async () => {
    const ci = (await store.load('docs')).pair.caseInsensitive;
    mem.addFolder('F-Docs', 'Docs', 'ROOT');
    await mkdir(at('docs'));
    await writeFile(at('docs', 'a.pdf'), 'A');
    await sync.select({ name: 'docs', add: ['docs/a.pdf'] });
    const first = await apply();
    if (!ci) {
      expect(first.ambiguous).toEqual(['docs/a.pdf']);
      return;
    }
    expect(first.actions).toEqual({ 'upload-new': ['Docs/a.pdf'] });
    expect(mem.childrenOf('ROOT').map((f) => f.name)).toEqual(['Docs']);
    expect(mem.childrenOf('F-Docs').map((f) => f.name)).toEqual(['a.pdf']);
    const second = await apply();
    expect(second).toMatchObject({ actions: {}, unknown: [], ambiguous: [] });
  });

  it('stamps lastAppliedRunAt with the scan start time', async () => {
    const stamps: Date[] = [];
    const ticking = new SyncService({
      runner: createRunner(mem.drive),
      audit: createAudit(),
      retry: noSleep,
      logger: silentLogger(),
      store,
      trashExec: async () => undefined,
      clock: () => {
        const t = new Date(Date.UTC(2026, 10, 3, 12, 0, stamps.length));
        stamps.push(t);
        return t;
      },
    });
    await writeFile(at('a.pdf'), 'A');
    await ticking.select({ name: 'docs', add: ['a.pdf'] });
    const before = stamps.length;
    await ticking.run({ name: 'docs', apply: true });
    const pair = (await store.load('docs')).pair;
    expect(pair.lastAppliedRunAt).toBe(stamps[before]?.toISOString());
  });
});
```

- [ ] **Step 2: Run and see it fail** — `npx vitest run src/sync/__tests__/sync-service.run.test.ts` → FAIL: `sync.run is not a function` in every test.

- [ ] **Step 3: Implement** in `src/sync/sync-service.ts`.

Imports — change/add:

```ts
import { access, open, realpath, rm, stat } from 'node:fs/promises';
import { Executor } from './executor.js';
import { hashLocal, probeOnDisk, scanLocal } from './local-scanner.js';
import { plan as makePlan } from './planner.js';
import { probeRecords } from './remote-probe.js';
import { buildReport } from './report.js';
import { hashTargets } from './resolve.js';
```

add `toKey,` to the `./paths.js` import list, and add `type Plan,` and `type SyncReport,` to the `./types.js` import list.

After the imports (next to `TEXT_MIME`):

```ts
const STALE_PART_MS = 60 * 60 * 1000;
```

After `SelectResult`:

```ts
export interface RunInput {
  name: string;
  apply?: boolean;
  planId?: string;
  allowMassDelete?: boolean;
}
```

Append these methods at the end of the `SyncService` class (after `select`):

```ts
  /** Spec §5 steps 3–5: scan, hash, probe, plan. */
  private async buildPlan(
    file: PairFile,
    apply: boolean,
  ): Promise<{ plan: Plan; remote: RemoteScan }> {
    const { pair, records } = file;
    const { local, remote } = await this.scanBoth(pair);
    if (apply) await this.removeStaleParts(pair, local);
    // §6.1: keys without an exact scan match may still exist on disk (through a symlinked
    // parent, or under a spelling the volume folds onto a scanned file) — ask the volume.
    const onDisk = await probeOnDisk(
      pair.localDir,
      onDiskProbeKeys({ pair, records, local, remote }),
    );
    const base = { pair, records, local, remote, probes: new Map(), onDisk };
    const { md5s, failed } = await hashLocal(pair.localDir, hashTargets(base));
    for (const name of failed) local.unknownSubtrees.push(toKey(name));
    const seen = new Set([...remote.entries.map((e) => e.id), ...remote.ignored.map((i) => i.id)]);
    const missing = records.map((r) => r.remoteId).filter((id) => !seen.has(id));
    const probes = await probeRecords(missing, remote, (id, fields) =>
      this.ops.exec(pair.account, 'idempotent', id, (ctx) => ctx.drive.getFile(id, fields)),
    );
    return { plan: makePlan({ ...base, probes, md5s }), remote };
  }

  private async removeStaleParts(pair: Pair, local: LocalScan): Promise<void> {
    const now = this.clock().getTime();
    for (const part of local.partFiles) {
      if (now - part.mtimeMs <= STALE_PART_MS) continue;
      try {
        await rm(absInside(pair.localDir, part.name), { force: true });
      } catch (err) {
        this.log.warn('Could not remove a stale temp file', { name: part.name, error: err });
      }
    }
  }

  /** sync_run: dry run by default; apply re-plans and can be bound to a dry run's planId. */
  async run(input: RunInput): Promise<SyncReport> {
    const apply = input.apply ?? false;
    return this.store.withLock(input.name, async () => {
      // lastAppliedRunAt is the scan start: files changed during the run stay "recent" (U8).
      const startedAt = this.clock().toISOString();
      const file = await this.store.load(input.name);
      await this.checkRoots(file.pair);
      const { plan, remote } = await this.buildPlan(file, apply);
      const name = file.pair.name;
      if (!apply) return buildReport(name, plan, { dryRun: true });
      if (input.planId !== undefined && input.planId !== plan.planId) {
        return buildReport(name, plan, {
          dryRun: true,
          aborted: {
            reason: 'plan-changed',
            message:
              'Files changed since the dry run; nothing was applied. Review this new plan and apply it with its planId.',
          },
        });
      }
      if (plan.brake.tripped && !input.allowMassDelete) {
        const { trashRemote, trashLocal, tracked } = plan.brake;
        return buildReport(name, plan, {
          dryRun: true,
          aborted: {
            reason: 'mass-delete',
            message: `Would move ${trashRemote} Drive file(s) and ${trashLocal} local file(s) to the trash out of ${tracked} tracked; nothing was applied. Re-run with allowMassDelete if this is intended.`,
          },
        });
      }
      const executor = new Executor(
        {
          ops: this.ops,
          audit: this.deps.audit,
          logger: this.log,
          clock: this.clock,
          save: (f): Promise<void> => this.store.save(f),
          trashExec: this.deps.trashExec,
        },
        file,
        remote.folders,
      );
      const outcomes = await executor.run(plan.actions);
      file.pair.lastAppliedRunAt = startedAt;
      if (file.pair.firstAppliedRunAt === null) {
        file.pair.firstAppliedRunAt = startedAt;
        file.pair.remoteBaseline = plan.baseline.files;
        file.pair.baselineFolders = plan.baseline.folders;
      }
      await this.store.save(file);
      return buildReport(name, plan, { dryRun: false, outcomes });
    });
  }
```

- [ ] **Step 4: Run and see it pass** — `npx vitest run src/sync` → PASS (the full-cycle test exercises update-remote, move-local, download-replace, conflict, trash-remote and trash-local in one applied run, then a clean dry run).

- [ ] **Step 5: Quality gate** — `npx prettier --write src/sync` then `npm run check` → typecheck, eslint (0 warnings), prettier and all tests green.

- [ ] **Step 6: Commit** —

```bash
git add src/sync
git commit -m "feat(sync): dry-run/apply runs with planId binding, brake and baseline" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 16: MCP sync tools, app wiring (31 tools)

**Files:**
- Create: `src/mcp/sync-tools.ts`
- Modify: `src/mcp/server.ts`, `src/app.ts`, `src/cli/main.ts` (serve only), `src/mcp/__tests__/server.test.ts`, `src/mcp/__tests__/content-tools.test.ts`
- Test: `src/mcp/__tests__/sync-tools.test.ts`

- [ ] **Step 1: Write the failing tests.**

`src/mcp/__tests__/sync-tools.test.ts`:

```ts
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DocsService } from '../../content/docs-service.js';
import { SheetsService } from '../../content/sheets-service.js';
import { SlidesService } from '../../content/slides-service.js';
import { FileService } from '../../files/file-service.js';
import { createAudit, createRunner, noSleep, silentLogger } from '../../files/__tests__/fakes.js';
import { PairStore } from '../../sync/pair-store.js';
import { SyncService } from '../../sync/sync-service.js';
import { refuseTrash } from '../../sync/__tests__/fixtures.js';
import { memoryDrive, type MemoryDrive } from '../../sync/__tests__/memory-drive.js';
import { createMcpServer } from '../server.js';

let tmp: string;
let local: string;
let mem: MemoryDrive;
let client: Client;

function textOf(result: unknown): string {
  return (result as { content: Array<{ text?: string }> }).content[0]?.text ?? '';
}

async function call(
  name: string,
  args: Record<string, unknown>,
): Promise<{ isError: boolean; data: unknown; text: string }> {
  const res = await client.callTool({ name, arguments: args });
  const text = textOf(res);
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    data = null;
  }
  return { isError: res.isError === true, data, text };
}

beforeEach(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), 'sync-mcp-'));
  local = path.join(tmp, 'Local');
  await mkdir(local);
  mem = memoryDrive('ROOT');
  const deps = {
    runner: createRunner(mem.drive),
    audit: createAudit(),
    retry: noSleep,
    logger: silentLogger(),
  };
  const server = createMcpServer({
    files: new FileService({ ...deps, downloadsDir: path.join(tmp, 'dl') }),
    docs: new DocsService(deps),
    sheets: new SheetsService(deps),
    slides: new SlidesService(deps),
    sync: new SyncService({
      ...deps,
      store: new PairStore({ dir: path.join(tmp, 'sync'), logger: silentLogger() }),
      trashExec: refuseTrash,
    }),
    auth: { status: async () => [] },
    version: '0.0.0-test',
    logger: silentLogger(),
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(clientTransport);
});
afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe('sync MCP tools', () => {
  it('describe the conversational flow and the dry-run default', async () => {
    const { tools } = await client.listTools();
    const byName = new Map(tools.map((t) => [t.name, t.description ?? '']));
    expect(byName.get('sync_scan')).toContain('confirm it with them, then call sync_select');
    expect(byName.get('sync_run')).toContain('DRY RUN BY DEFAULT');
    expect(byName.get('sync_run')).toContain('apply without planId is rejected');
    expect(byName.has('sync_release')).toBe(false);
  });

  it('runs create → scan → select → dry run → apply with planId', async () => {
    await writeFile(path.join(local, 'voyage.txt'), 'Seafaring log');
    const created = await call('sync_create_pair', {
      name: 'docs',
      localDir: local,
      remoteFolderId: 'ROOT',
    });
    expect(created.isError).toBe(false);
    const scan = await call('sync_scan', { name: 'docs' });
    expect(scan.data).toMatchObject({
      entries: [{ path: 'voyage.txt', preview: 'Seafaring log' }],
    });
    const sel = await call('sync_select', { name: 'docs', add: ['voyage.txt'] });
    expect(sel.data).toMatchObject({ added: ['voyage.txt'], selected: 1 });
    const dry = await call('sync_run', { name: 'docs' });
    expect(dry.data).toMatchObject({ dryRun: true, actions: { 'upload-new': ['voyage.txt'] } });
    expect(mem.childrenOf('ROOT')).toEqual([]);
    const planId = (dry.data as { planId: string }).planId;
    const applied = await call('sync_run', { name: 'docs', apply: true, planId });
    expect(applied.data).toMatchObject({ dryRun: false, failures: [] });
    expect(mem.childrenOf('ROOT').map((f) => f.name)).toEqual(['voyage.txt']);
    const pairs = await call('sync_list_pairs', {});
    expect(pairs.data).toMatchObject([{ name: 'docs', counts: { selected: 1, tracked: 1 } }]);
    const removed = await call('sync_remove_pair', { name: 'docs' });
    expect(removed.data).toMatchObject({ removed: true });
  });

  it('refuses apply without the planId of a dry run', async () => {
    await call('sync_create_pair', { name: 'docs', localDir: local, remoteFolderId: 'ROOT' });
    const res = await call('sync_run', { name: 'docs', apply: true });
    expect(res).toMatchObject({ isError: true });
    expect(res.text).toContain('needs the planId');
  });

  it('returns readable tool errors', async () => {
    const bad = await call('sync_run', { name: 'Bad Name' });
    expect(bad.isError).toBe(true);
    const missing = await call('sync_run', { name: 'nope' });
    expect(missing).toMatchObject({
      isError: true,
      text: 'No sync pair named "nope". List pairs with sync_list_pairs.',
    });
  });
});
```

`src/mcp/__tests__/server.test.ts` — add imports

```ts
import { PairStore } from '../../sync/pair-store.js';
import { SyncService } from '../../sync/sync-service.js';
import { refuseTrash } from '../../sync/__tests__/fixtures.js';
```

change `contentServices` to return `Pick<McpDeps, 'docs' | 'sheets' | 'slides' | 'sync'>` and add to its returned object:

```ts
    sync: new SyncService({
      ...deps,
      store: new PairStore({ dir: '/tmp/unused-sync' }),
      trashExec: refuseTrash,
    }),
```

(constructing a `PairStore` touches no files), rename the count test to `'exposes the 31 tools from all specs'` and change `toHaveLength(25)` → `toHaveLength(31)`.

`src/mcp/__tests__/content-tools.test.ts` — the same three imports, and in the `createMcpServer({...})` call after `slides` the same `sync: new SyncService({ ... })` entry.

- [ ] **Step 2: Run and see it fail** — `npx vitest run src/mcp` → FAIL: no `sync_*` tool is registered yet (`sync-tools.test.ts`: the `sync_scan`/`sync_run` descriptions are undefined and the tool calls error), and `server.test.ts` counts 25 tools instead of 31.

- [ ] **Step 3: Implement.**

`src/mcp/sync-tools.ts`:

```ts
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { ValidationError } from '../errors.js';
import type { Logger } from '../logger.js';
import type { SyncService } from '../sync/sync-service.js';
import { PAIR_NAME } from '../sync/types.js';
import { account, respond } from './shared.js';

export const SYNC_TOOL_NAMES = [
  'sync_create_pair',
  'sync_list_pairs',
  'sync_scan',
  'sync_select',
  'sync_run',
  'sync_remove_pair',
] as const;

const name = z.string().regex(PAIR_NAME).describe('Sync pair name (a-z, 0-9 and -, max 40)');
const relPaths = z
  .array(z.string().min(1))
  .min(1)
  .max(1000)
  .describe('Paths relative to the pair folder, with "/" separators');

export function registerSyncTools(server: McpServer, sync: SyncService, log: Logger): void {
  server.registerTool(
    'sync_create_pair',
    {
      description:
        'Create a selective two-way sync pair between a local folder and a Drive folder (synced on demand, never automatically). Pass remoteFolderId of an existing Drive folder, or remoteFolderName (+ optional remoteParentId) to create a new one. Writes a hidden marker file .marvin-sync-<name> into localDir. Next step: sync_scan.',
      inputSchema: {
        name,
        localDir: z
          .string()
          .min(1)
          .describe('Absolute path of an existing local folder (~ allowed)'),
        remoteFolderId: z.string().min(1).optional(),
        remoteFolderName: z
          .string()
          .min(1)
          .optional()
          .describe('Creates a new Drive folder with this name'),
        remoteParentId: z
          .string()
          .min(1)
          .optional()
          .describe('Parent for remoteFolderName (default: My Drive)'),
        account,
      },
    },
    async (args) => respond(log, () => sync.createPair(args)),
  );

  server.registerTool(
    'sync_list_pairs',
    {
      description:
        'List sync pairs with their folders, account, counts (selected, tracked, remote-only, excluded, baseline) and the last applied run.',
      inputSchema: {},
    },
    async () => respond(log, () => sync.listPairs()),
  );

  server.registerTool(
    'sync_scan',
    {
      description:
        'Step 1 of choosing what to sync: lists the local files of a pair (path, size, modifiedTime, mimeType, and a short preview for text files) plus remoteCandidates (Drive files not yet synced). Changes nothing. Open PDFs/Office files with your own file-reading tool when the name and preview are not enough, propose a selection to the user (e.g. "the seafaring files"), confirm it with them, then call sync_select.',
      inputSchema: {
        name,
        onlyUnselected: z
          .boolean()
          .optional()
          .describe('Default true: hide already selected files'),
        previewChars: z
          .number()
          .int()
          .min(0)
          .max(2000)
          .optional()
          .describe('Default 300; 0 disables previews'),
        limit: z.number().int().min(1).max(1000).optional().describe('Default 200 per list'),
        subdir: z.string().min(1).optional().describe('Only this sub-folder (relative path)'),
      },
    },
    async (args) => respond(log, () => sync.scan(args)),
  );

  server.registerTool(
    'sync_select',
    {
      description:
        'Step 2, after the user confirmed: add paths to the pair selection (local files or Drive remoteCandidates; deduped by case/Unicode form) or remove them. remove stops syncing a path and puts it on the excluded list — no file is touched on either side. Rejected paths come back with reasons. Next step: sync_run (dry run).',
      inputSchema: { name, add: relPaths.optional(), remove: relPaths.optional() },
    },
    async (args) => respond(log, () => sync.select(args)),
  );

  server.registerTool(
    'sync_run',
    {
      description:
        'Step 3: plan or apply a sync. DRY RUN BY DEFAULT (apply omitted/false): returns the plan — actions by kind, conflicts, collisions, ambiguous/unknown items, warnings, candidates — and a planId; nothing is written. Show it to the user; after they agree call again with apply: true AND that planId (apply without planId is rejected). If anything changed meanwhile nothing is applied and the new plan is returned. Deletions go to the Drive trash or the macOS Trash, never permanent; conflicts keep both copies. Set allowMassDelete only after the user explicitly confirmed a large deletion.',
      inputSchema: {
        name,
        apply: z.boolean().optional().describe('Default false (dry run)'),
        planId: z
          .string()
          .min(1)
          .optional()
          .describe('planId of the dry run the user approved; required with apply: true'),
        allowMassDelete: z.boolean().optional(),
      },
    },
    async (args) =>
      respond(log, async () => {
        if (args.apply === true && args.planId === undefined) {
          throw new ValidationError(
            'apply: true needs the planId of the dry run the user approved; run sync_run without apply first.',
          );
        }
        return sync.run(args);
      }),
  );

  server.registerTool(
    'sync_remove_pair',
    {
      description:
        'Remove a sync pair: deletes its saved state and the marker file. No local or Drive files are touched.',
      inputSchema: { name },
    },
    async (args) => respond(log, () => sync.removePair(args)),
  );
}
```

`src/mcp/server.ts`:

```ts
import type { SyncService } from '../sync/sync-service.js';
import { SYNC_TOOL_NAMES, registerSyncTools } from './sync-tools.js';

export const TOOL_NAMES = [
  ...DRIVE_TOOL_NAMES,
  ...DOCS_TOOL_NAMES,
  ...SHEETS_TOOL_NAMES,
  ...SLIDES_TOOL_NAMES,
  ...SYNC_TOOL_NAMES,
] as const;
```

add `sync: SyncService;` to `McpDeps` (after `slides`), and in `createMcpServer` after `registerSlidesTools(...)`:

```ts
  registerSyncTools(server, deps.sync, log);
```

`src/app.ts` — import `PairStore` (`./sync/pair-store.js`), `SyncService` (`./sync/sync-service.js`) and `defaultExec` (`./sync/trash.js`), add `sync: SyncService;` to `App`, and end `buildApp` with:

```ts
  const sync = new SyncService({
    runner,
    audit,
    store: new PairStore({ dir: paths.syncDir }),
    trashExec: defaultExec,
  });
  return { paths, auth, files, docs, sheets, slides, sync };
```

`src/cli/main.ts` — in the `serve` action add `sync: app.sync,` to the `createMcpServer({...})` call (after `slides: app.slides,`); `McpDeps` now requires it.

- [ ] **Step 4: Run and see it pass** — `npx vitest run src/mcp` → PASS.

- [ ] **Step 5: Quality gate** — `npx prettier --write src` then `npm run check` → green; `npm run build` succeeds.

- [ ] **Step 6: Smoke-test the real binary over stdio** (lists tools, no Google calls; temp config dir):

```bash
MARVIN_DRIVE_CONFIG_DIR="$(mktemp -d)" node --input-type=module -e "
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
const c = new Client({ name: 'smoke', version: '0' });
await c.connect(new StdioClientTransport({ command: 'node', args: ['dist/cli/main.js', 'serve'], env: { ...process.env } }));
const { tools } = await c.listTools();
console.log(tools.length, tools.map((t) => t.name).filter((n) => n.startsWith('sync_')).join(' '));
await c.close();
"
```

Expected: `31 sync_create_pair sync_list_pairs sync_scan sync_select sync_run sync_remove_pair`

- [ ] **Step 7: Commit** —

```bash
git add src/mcp src/app.ts src/cli/main.ts
git commit -m "feat(mcp): six sync tools (31 total), wired into the app" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

## Chunk 10: CLI, live E2E and documentation

### Task 17: CLI `sync list | run | repair-marker`

**Files:**
- Create: `src/cli/sync-format.ts`, `src/cli/sync-commands.ts`
- Modify: `src/cli/main.ts`
- Test: `src/cli/__tests__/sync-commands.test.ts`

The commands are registered by a function with injected dependencies (service factory, output, confirm, exit code) so tests drive them through commander without a terminal.

- [ ] **Step 1: Write the failing tests.**

`src/cli/__tests__/sync-commands.test.ts`:

```ts
import { Command } from 'commander';
import { describe, expect, it, vi } from 'vitest';
import type { PairSummary } from '../../sync/sync-service.js';
import type { Pair, SyncReport } from '../../sync/types.js';
import { makePair } from '../../sync/__tests__/fixtures.js';
import { registerSyncCommands, type SyncCliDeps } from '../sync-commands.js';
import { formatReport } from '../sync-format.js';

const REPORT: SyncReport = {
  pair: 'docs',
  dryRun: false,
  planId: 'abcdef0123456789',
  aborted: null,
  actions: { 'upload-new': ['a.pdf'] },
  conflicts: [{ path: 'b.pdf', conflictCopy: 'b (Drive conflict 2026-11-03 10.15).pdf' }],
  collisions: [],
  ambiguous: [],
  unknown: [{ path: 'locked/c.pdf', reason: 'local folder could not be read' }],
  warnings: [],
  failures: [],
  notRun: [],
  candidates: { local: [], remote: [], truncated: false },
};

const SUMMARY: PairSummary = {
  name: 'docs',
  account: 'emco',
  localDir: '/Users/x/Docs',
  remoteFolderId: 'F1',
  caseInsensitive: true,
  counts: { selected: 2, tracked: 1, remoteOnly: 0, excluded: 0, baseline: 3 },
  createdAt: '2026-11-03T00:00:00.000Z',
  lastAppliedRunAt: null,
};

function setup(report: SyncReport = REPORT, answer = true) {
  const lines: string[] = [];
  const service = {
    listPairs: vi.fn(async () => [SUMMARY]),
    run: vi.fn(async () => report),
    repairMarker: vi.fn(async (_name: string, confirm: (pair: Pair) => Promise<boolean>) => {
      const repaired = await confirm(makePair({ localDir: '/Users/x/Docs' }));
      return { repaired, localDir: '/Users/x/Docs', caseInsensitive: true };
    }),
  };
  const deps: SyncCliDeps = {
    sync: () => service,
    out: (line) => lines.push(line),
    confirm: vi.fn(async () => answer),
    setExitCode: vi.fn(),
  };
  const program = new Command().exitOverride();
  registerSyncCommands(program, deps);
  const run = (...args: string[]) => program.parseAsync(['node', 'marvin-drive', 'sync', ...args]);
  return { lines, service, deps, run };
}

describe('sync CLI', () => {
  it('lists pairs', async () => {
    const { lines, run } = setup();
    await run('list');
    expect(lines[0]).toContain('docs');
    expect(lines[0]).toContain('/Users/x/Docs ⇄ F1 (emco)');
    expect(lines[0]).toContain('baseline 3');
  });

  it('runs a dry run by default and applies with flags', async () => {
    const { service, run, deps } = setup();
    await run('run', 'docs');
    expect(service.run).toHaveBeenLastCalledWith({
      name: 'docs',
      apply: false,
      allowMassDelete: false,
    });
    await run('run', 'docs', '--apply', '--allow-mass-delete');
    expect(service.run).toHaveBeenLastCalledWith({
      name: 'docs',
      apply: true,
      allowMassDelete: true,
    });
    await run('run', 'docs', '--apply', '--plan-id', 'abc');
    expect(service.run).toHaveBeenLastCalledWith({
      name: 'docs',
      apply: true,
      allowMassDelete: false,
      planId: 'abc',
    });
    expect(deps.setExitCode).not.toHaveBeenCalled();
  });

  it('exits 1 when the run aborted or something failed', async () => {
    const aborted = { ...REPORT, aborted: { reason: 'mass-delete' as const, message: 'too many' } };
    const a = setup(aborted);
    await a.run('run', 'docs', '--apply');
    expect(a.deps.setExitCode).toHaveBeenCalledWith(1);
    const failed = {
      ...REPORT,
      failures: [{ path: 'a.pdf', kind: 'upload-new' as const, message: 'x' }],
    };
    const f = setup(failed);
    await f.run('run', 'docs', '--apply');
    expect(f.deps.setExitCode).toHaveBeenCalledWith(1);
  });

  it('repair-marker asks for confirmation', async () => {
    const yes = setup(REPORT, true);
    await yes.run('repair-marker', 'docs');
    expect(yes.deps.confirm).toHaveBeenCalledWith(expect.stringContaining('/Users/x/Docs'));
    expect(yes.lines).toEqual(['Marker rewritten in /Users/x/Docs (case-insensitive: true).']);
    const no = setup(REPORT, false);
    await no.run('repair-marker', 'docs');
    expect(no.lines).toEqual(['Nothing changed.']);
  });
});

describe('formatReport', () => {
  it('renders actions, conflicts and unknown items', () => {
    expect(formatReport(REPORT)).toBe(
      [
        'docs — applied (planId abcdef012345)',
        'Done:',
        '  upload-new (1): a.pdf',
        'Conflicts:',
        '  b.pdf → Drive version kept as b (Drive conflict 2026-11-03 10.15).pdf',
        'Unknown state (no action):',
        '  locked/c.pdf — local folder could not be read',
      ].join('\n'),
    );
  });

  it('says when there is nothing to do', () => {
    const empty: SyncReport = { ...REPORT, dryRun: true, actions: {}, conflicts: [], unknown: [] };
    expect(formatReport(empty)).toBe('docs — dry run (planId abcdef012345)\nNothing to do.');
  });
});
```

- [ ] **Step 2: Run and see it fail** — `npx vitest run src/cli` → FAIL: `../sync-commands.js` cannot be resolved.

- [ ] **Step 3: Implement.**

`src/cli/sync-format.ts`:

```ts
import type { PairSummary } from '../sync/sync-service.js';
import type { SyncReport } from '../sync/types.js';

export function formatPairs(pairs: readonly PairSummary[]): string {
  if (pairs.length === 0) return 'No sync pairs. Create one with the sync_create_pair tool.';
  return pairs
    .map((p) => {
      const c = p.counts;
      const last = p.lastAppliedRunAt ?? 'never';
      return `${p.name.padEnd(20)} ${p.localDir} ⇄ ${p.remoteFolderId} (${p.account})\n  selected ${c.selected} · tracked ${c.tracked} · excluded ${c.excluded} · baseline ${c.baseline} · last applied ${last}`;
    })
    .join('\n');
}

function section(title: string, lines: string[]): string[] {
  return lines.length === 0 ? [] : [`${title}:`, ...lines.map((l) => `  ${l}`)];
}

export function formatReport(r: SyncReport): string {
  const lines = [
    `${r.pair} — ${r.dryRun ? 'dry run' : 'applied'} (planId ${r.planId.slice(0, 12)})`,
  ];
  if (r.aborted) lines.push(`ABORTED (${r.aborted.reason}): ${r.aborted.message}`);
  const actions = Object.entries(r.actions).map(
    ([kind, paths]) => `${kind} (${paths.length}): ${paths.join(', ')}`,
  );
  lines.push(...section(r.dryRun ? 'Planned' : 'Done', actions));
  lines.push(
    ...section(
      'Conflicts',
      r.conflicts.map((c) =>
        c.conflictCopy ? `${c.path} → Drive version kept as ${c.conflictCopy}` : c.path,
      ),
    ),
  );
  lines.push(...section('Collisions (nothing written)', r.collisions));
  lines.push(...section('Ambiguous (no action)', r.ambiguous));
  lines.push(
    ...section(
      'Unknown state (no action)',
      r.unknown.map((u) => (u.reason ? `${u.path} — ${u.reason}` : u.path)),
    ),
  );
  lines.push(
    ...section(
      'Warnings',
      r.warnings.map((w) => `${w.path}: ${w.code}${w.message ? ` — ${w.message}` : ''}`),
    ),
  );
  lines.push(
    ...section(
      'Failures',
      r.failures.map((f) => `${f.path} [${f.kind}]: ${f.message}`),
    ),
  );
  lines.push(...section('Not run', r.notRun));
  const { local, remote, truncated } = r.candidates;
  if (local.length + remote.length > 0) {
    lines.push(
      `Candidates: ${local.length} local, ${remote.length} in Drive${truncated ? ' (truncated)' : ''} — choose with sync_scan / sync_select`,
    );
  }
  if (lines.length === 1) lines.push('Nothing to do.');
  return lines.join('\n');
}

/** Exit code 1 if anything failed or the run aborted (spec §9). */
export function reportFailed(r: SyncReport): boolean {
  return r.aborted !== null || r.failures.length > 0 || r.notRun.length > 0;
}
```

`src/cli/sync-commands.ts`:

```ts
import type { Command } from 'commander';
import type { SyncService } from '../sync/sync-service.js';
import { formatPairs, formatReport, reportFailed } from './sync-format.js';

export interface SyncCliDeps {
  sync: () => Pick<SyncService, 'listPairs' | 'run' | 'repairMarker'>;
  out: (line: string) => void;
  /** Asks a yes/no question on the terminal; injectable for tests. */
  confirm: (question: string) => Promise<boolean>;
  setExitCode: (code: number) => void;
}

/** `marvin-drive sync list | run | repair-marker` (spec §9, Phase A). */
export function registerSyncCommands(program: Command, deps: SyncCliDeps): void {
  const sync = program
    .command('sync')
    .description('Selective two-way sync between local and Drive folders');

  sync
    .command('list')
    .description('List sync pairs')
    .action(async () => {
      deps.out(formatPairs(await deps.sync().listPairs()));
    });

  sync
    .command('run')
    .description('Plan a sync (dry run) or apply it with --apply')
    .argument('<name>', 'pair name')
    .option('--apply', 'apply the plan (default: dry run)')
    .option('--allow-mass-delete', 'allow more deletions than the safety brake permits')
    .option('--plan-id <id>', 'apply only if the plan still matches this dry-run planId')
    .action(
      async (
        name: string,
        opts: { apply?: boolean; allowMassDelete?: boolean; planId?: string },
      ) => {
        const report = await deps.sync().run({
          name,
          apply: opts.apply ?? false,
          allowMassDelete: opts.allowMassDelete ?? false,
          ...(opts.planId ? { planId: opts.planId } : {}),
        });
        deps.out(formatReport(report));
        if (reportFailed(report)) deps.setExitCode(1);
      },
    );

  sync
    .command('repair-marker')
    .description('Rewrite the .marvin-sync-<name> marker after confirming the local folder')
    .argument('<name>', 'pair name')
    .action(async (name: string) => {
      const res = await deps
        .sync()
        .repairMarker(name, (pair) =>
          deps.confirm(
            `Pair "${pair.name}" syncs ${pair.localDir}. Is this the same folder as before (not a different disk or copy)? Rewrite its marker? [y/N] `,
          ),
        );
      deps.out(
        res.repaired
          ? `Marker rewritten in ${res.localDir} (case-insensitive: ${res.caseInsensitive}).`
          : 'Nothing changed.',
      );
    });
}
```

`src/cli/main.ts` — add imports

```ts
import { createInterface } from 'node:readline/promises';
import { registerSyncCommands } from './sync-commands.js';
```

(the `node:` import first, `./sync-commands.js` after `./format.js`), add after `out`:

```ts
async function confirm(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return /^y(es)?$/i.test((await rl.question(question)).trim());
  } finally {
    rl.close();
  }
}
```

and register the commands just before `program.parseAsync()`:

```ts
registerSyncCommands(program, {
  sync: () => buildApp().sync,
  out,
  confirm,
  setExitCode: (code) => {
    process.exitCode = code;
  },
});
```

- [ ] **Step 4: Run and see it pass** — `npx vitest run src/cli` → PASS.

- [ ] **Step 5: Quality gate** — `npx prettier --write src/cli` then `npm run check` → green; `npm run build` then `node dist/cli/main.js sync --help` lists `list`, `run [options] <name>`, `repair-marker <name>`.

- [ ] **Step 6: Commit** —

```bash
git add src/cli
git commit -m "feat(cli): sync list, run and repair-marker commands" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 18: Live E2E (spec §11 Phase A)

**Files:** Create `tests/e2e/sync.e2e.test.ts`.

Guarded by `MARVIN_E2E_ACCOUNT` (skipped otherwise). It uses a temp local dir and a temp Drive folder; in `finally` it lists the folder **including trashed children** and deletes each child permanently, then the folder (so nothing it trashed is left in the Drive trash). It builds its own `FileService` and `SyncService` on `app.auth` with a temp pair store and a **temp audit file** (no entry reaches the real `audit.jsonl`), and **redirects local trash**: `SyncService` gets a `trashExec` that `rename`s the path into a temp `trash/` dir instead of running `/usr/bin/trash`, so the user's real macOS Trash is never filled (the real `/usr/bin/trash -s` invocation is covered by the stubbed unit test in Task 11). Drive-side edits go through `DriveAdapter.updateFile` with `media` — the live check of the Task 2 adapter change.

- [ ] **Step 1: Write the test.**

`tests/e2e/sync.e2e.test.ts`:

```ts
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { FileAuditLog } from '../../src/audit/audit-log.js';
import { DriveClientFactory } from '../../src/drive/client-factory.js';
import { FileService } from '../../src/files/file-service.js';
import { PairStore } from '../../src/sync/pair-store.js';
import { SyncService } from '../../src/sync/sync-service.js';
import type { ExecFn } from '../../src/sync/trash.js';

const account = process.env.MARVIN_E2E_ACCOUNT;

describe.runIf(account)('Sync E2E (live)', () => {
  it('scan → select → dry run → apply → edits, conflict, deletions, rename, adoption', async () => {
    const app = buildApp();
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'marvin-sync-e2e-'));
    const local = path.join(tmp, 'local');
    const trashDir = path.join(tmp, 'trash');
    await mkdir(local);
    await mkdir(trashDir);
    // Local "Trash" is redirected into the temp dir: the user's real macOS Trash is never touched.
    const trashExec: ExecFn = async (_bin, args) => {
      const target = args[1] ?? '';
      await rename(target, path.join(trashDir, path.basename(target)));
    };
    // Every audit entry of this test (sync and plain file operations) goes to a temp file.
    const runner = new DriveClientFactory(app.auth);
    const audit = new FileAuditLog(path.join(tmp, 'audit.jsonl'));
    const files = new FileService({ runner, audit, downloadsDir: path.join(tmp, 'downloads') });
    const sync = new SyncService({
      runner,
      audit,
      store: new PairStore({ dir: path.join(tmp, 'sync') }),
      trashExec,
    });
    const at = (name: string): string => path.join(local, name);
    const setRemote = (fileId: string, text: string): Promise<unknown> =>
      runner.run(account, (ctx) =>
        ctx.drive.updateFile({
          fileId,
          media: { mimeType: 'text/plain', body: Readable.from([Buffer.from(text)]) },
          fields: 'id',
        }),
      );
    const root = await files.createFolder({ account, name: `marvin-sync-e2e-${Date.now()}` });
    try {
      const pre = path.join(tmp, 'pre.txt');
      await writeFile(pre, 'already in Drive');
      await files.upload({ account, localPath: pre, parentId: root.id });
      const names = ['edit-local', 'edit-remote', 'both', 'del-local', 'del-remote', 'moved'].map(
        (n) => `${n}.txt`,
      );
      for (const n of names) await writeFile(at(n), `${n.slice(0, -4)} v1`);
      await sync.createPair({ name: 'e2e', localDir: local, remoteFolderId: root.id, account });

      // scan → select → dry run → apply with planId
      const scan = await sync.scan({ name: 'e2e' });
      expect(scan.entries.map((e) => e.path).sort()).toEqual([...names].sort());
      expect(scan.entries.find((e) => e.path === 'both.txt')?.preview).toBe('both v1');
      expect(scan.remoteCandidates.map((c) => c.path)).toEqual(['pre.txt']);
      await sync.select({ name: 'e2e', add: names });
      const dry = await sync.run({ name: 'e2e' });
      expect(dry.actions['upload-new']).toHaveLength(6);
      const first = await sync.run({ name: 'e2e', apply: true, planId: dry.planId });
      expect(first.failures).toEqual([]);
      expect(first.actions['upload-new']).toHaveLength(6);

      // run 2: the pre-existing Drive file stays a candidate, nothing to do
      const second = await sync.run({ name: 'e2e' });
      expect(second.actions).toEqual({});
      expect(second.candidates.remote.map((c) => c.path)).toEqual(['pre.txt']);

      // edit both sides, conflict, delete on each side, rename within the folder
      const listed = await files.list({ account, folderId: root.id, pageSize: 200 });
      const id = (name: string): string => listed.files.find((f) => f.name === name)?.id ?? '';
      await writeFile(at('edit-local.txt'), 'local v2');
      await setRemote(id('edit-remote.txt'), 'remote v2');
      await writeFile(at('both.txt'), 'both local');
      await setRemote(id('both.txt'), 'both remote');
      await rm(at('del-local.txt'));
      await files.delete({ account, fileId: id('del-remote.txt') });
      await files.rename({ account, fileId: id('moved.txt'), newName: 'renamed.txt' });

      const third = await sync.run({ name: 'e2e', apply: true });
      expect(third.failures).toEqual([]);
      expect(third.actions).toEqual({
        'update-remote': ['edit-local.txt'],
        'move-local': ['renamed.txt'],
        'download-replace': ['edit-remote.txt'],
        conflict: ['both.txt'],
        'trash-remote': ['del-local.txt'],
        'trash-local': ['del-remote.txt'],
      });
      const copy = third.conflicts[0]?.conflictCopy ?? '';
      expect(copy).toMatch(/^both \(Drive conflict \d{4}-\d{2}-\d{2} \d{2}\.\d{2}\)\.txt$/);
      expect(await readFile(at(copy), 'utf8')).toBe('both remote');
      expect(await readFile(at('edit-remote.txt'), 'utf8')).toBe('remote v2');
      expect(await readFile(at('renamed.txt'), 'utf8')).toBe('moved v1');
      expect(await readdir(trashDir)).toEqual(['del-remote.txt']);

      // a Drive file added after the first applied run is adopted
      const late = path.join(tmp, 'late.txt');
      await writeFile(late, 'added after the first run');
      await files.upload({ account, localPath: late, parentId: root.id });
      const fourth = await sync.run({ name: 'e2e', apply: true });
      expect(fourth.actions).toEqual({ 'download-new': ['late.txt'] });
      expect(await readFile(at('late.txt'), 'utf8')).toBe('added after the first run');

      const final = await sync.run({ name: 'e2e' });
      expect(final.actions).toEqual({});
      expect(final.candidates.remote.map((c) => c.path)).toEqual(['pre.txt']);
      await sync.removePair({ name: 'e2e' });
    } finally {
      // Purge every child (including the ones this test trashed in Drive), then the folder.
      const children = await files.list({
        account,
        folderId: root.id,
        includeTrashed: true,
        pageSize: 200,
      });
      for (const child of children.files) {
        await files.delete({ account, fileId: child.id, permanent: true }).catch(() => undefined);
      }
      await files.delete({ account, fileId: root.id, permanent: true });
      await rm(tmp, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Verify it is skipped without an account** — `npx vitest run --config vitest.e2e.config.ts tests/e2e/sync.e2e.test.ts` → `1 skipped`; `npm run check` → green.

- [ ] **Step 3: Run live** — `npm run build && MARVIN_E2E_ACCOUNT=emco npm run test:e2e` → all three E2E files PASS.
  If an assertion fails because Google's real behaviour differs from an assumption (e.g. md5/`modifiedTime` not yet updated right after an edit, or a rename changing `modifiedTime`), **investigate with the real response first** (log the plan/report), then fix the **sync code** if it is wrong, or the **test expectation** if Google's behaviour is legitimate — note the finding in the commit message. Do not weaken assertions without understanding why.

- [ ] **Step 4: Commit** —

```bash
git add tests/e2e
git commit -m "test(e2e): live selective sync round trip" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 19: Documentation and version 0.3.0

**Files:** `README.md`, `docs/FEATURES.md`, `docs/CHANGELOG.md`, `package.json`, `package-lock.json`, `src/version.ts`.

- [ ] **Step 1: README.**
  - Intro sentence becomes: `Local MCP server + CLI that lets Claude Code manage files in one or more Google Drive accounts, read and edit Google Docs, Sheets and Slides, and keep a chosen set of local files in two-way sync with a Drive folder, through your own Google OAuth client.`
  - `## CLI` table — add rows:

```markdown
| `marvin-drive sync list`                                  | Sync pairs with counts and last applied run                         |
| `marvin-drive sync run <name> [--apply] [--allow-mass-delete]` | Dry run (default) or apply a sync; exit code 1 on failure/abort |
| `marvin-drive sync repair-marker <name>`                  | Rewrite the folder marker after confirming the local folder         |
```

  - After the `### Slides` table (before `### Editing safely`) add:

```markdown
### Sync (selective two-way, on demand)

| Tool               | Purpose                                                                                                         |
| ------------------ | --------------------------------------------------------------------------------------------------------------- |
| `sync_create_pair` | Pair a local folder with an existing or new Drive folder; writes a hidden `.marvin-sync-<name>` marker            |
| `sync_list_pairs`  | Pairs with selected / tracked / excluded / baseline counts and the last applied run                              |
| `sync_scan`        | Local files (with short text previews) and Drive-only candidates, so Claude can propose a selection             |
| `sync_select`      | Add or remove relative paths; removing excludes the path and touches no file                                    |
| `sync_run`         | Dry run by default (plan + `planId`); `apply: true` with the approved `planId` executes it                      |
| `sync_remove_pair` | Forget a pair and remove its marker; no files are touched                                                        |

Typical conversation: "sync the seafaring files in Downloads to my Drive folder *Denizcilik*" → Claude creates the pair, runs `sync_scan`, opens unclear files with its own reader, proposes a list, asks you to confirm, calls `sync_select`, shows the `sync_run` dry run, and applies it with the `planId` once you agree.

### Syncing safely

- Only selected files sync. Drive files that already existed at the first applied run stay **candidates** until you select them; Drive files added later are downloaded and selected automatically (unless a local file of the same name exists — then it is reported as a collision).
- Changes are detected three-way (local, Drive, last sync) by MD5. Edits on both sides become a **conflict**: the Drive version is saved next to yours as `<name> (Drive conflict YYYY-MM-DD HH.mm).<ext>`, then your version is uploaded (Drive keeps the old revision).
- Deletions are propagated but never permanent: Drive files go to the Drive trash, local files to the macOS Trash via `/usr/bin/trash` (volumes without a Trash, e.g. some SMB/FAT disks, cannot delete — the action fails). A safety brake stops runs that would delete more than max(10, 20 %) of tracked files, or every tracked file of one side.
- A local file is only ever overwritten when it is the tracked file itself and unchanged since the scan; every new local file is created exclusively (never replaces anything). Anything the planner cannot classify — unreadable folders, duplicate names, case-only clashes on case-sensitive disks — is reported and left alone.
- Each run checks that the local folder still has its marker (catches unmounted or replaced disks) and that the Drive folder still exists; if the marker is missing, run `marvin-drive sync repair-marker <name>`.
- Google Docs/Sheets/Slides inside a synced Drive folder are reported as `native-skipped` in this version. Hashing a file that iCloud has evicted makes macOS download it first (slow but correct).
```

  - `## Files` table — add rows:

```markdown
| `~/.config/google-handler/sync/<name>.json`   | Sync pair state (selection, records) |
| `<local folder>/.marvin-sync-<name>`          | Sync folder marker (pair id)         |
```

  - `## Development` — change the E2E comment to `# live Drive tests (temp Drive folder + temp local dir; sync uses a temp trash)`.
  - Run `npx prettier --write README.md` (re-aligns the tables).

- [ ] **Step 2: FEATURES** — in `docs/FEATURES.md` add before `## Later`:

```markdown
### 5. Selective sync — Phase A (spec: `docs/superpowers/specs/2026-11-03-selective-sync-design.md`)
- ✅ Pairs: create (existing or new Drive folder), list, remove; root marker + case-sensitivity probe; overlap check
- ✅ AI-assisted selection: `sync_scan` (previews, remote candidates) → `sync_select` (add/remove/exclude)
- ✅ Pure three-way planner (B1–B14, U0–U8), ambiguity/unknown-state protection, mass-delete brake, stable `planId`
- ✅ Executor: spec order, re-verification, exclusive local writes, conflict copies, Drive/macOS trash, per-action persistence, audit
- ✅ MCP tools `sync_create_pair`, `sync_list_pairs`, `sync_scan`, `sync_select`, `sync_run`, `sync_remove_pair`; CLI `sync list/run/repair-marker`
- ⬜ Phase B: Google-native exports, release ("move to Drive"), `sync_release`
```

  and in `## Later` replace `- ⬜ 5. Sync (local ↔ Drive)` with `- ⬜ Sync watch mode (continuous sync)`.

- [ ] **Step 3: CHANGELOG** — add above `## 0.2.0`:

```markdown
## 0.3.0 — 2026-11-03

### Added
- Selective two-way sync between a local folder and a Drive folder (Phase A, binary files): six MCP tools (`sync_create_pair`, `sync_list_pairs`, `sync_scan`, `sync_select`, `sync_run`, `sync_remove_pair`) and CLI `marvin-drive sync list | run | repair-marker`.
- Claude-assisted file selection with text previews and Drive-side candidates.
- Dry run by default; apply bound to the approved `planId`; conflicts keep both versions; deletions go to the Drive trash or macOS Trash; mass-delete brake; root-marker and case-sensitivity checks.
- `DriveAdapter.updateFile` accepts new media (content update of the same file id).
```

- [ ] **Step 4: Version** — `"version": "0.3.0"` in `package.json`, then `npm install --package-lock-only` (updates the root entry of `package-lock.json`), and `export const VERSION = '0.3.0';` in `src/version.ts`.

- [ ] **Step 5: Verify** — `npx prettier --write README.md docs/FEATURES.md docs/CHANGELOG.md` then `npm run check` → green; `npm run build` → OK; `node dist/cli/main.js --version` → `0.3.0`.

- [ ] **Step 6: Commit** —

```bash
git add -A
git commit -m "docs: selective sync (phase A) tools, changelog 0.3.0" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
