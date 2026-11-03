# Marvin Drive — Selective Two-Way Sync Design (Sub-project 5)

- **Date:** 2026-11-03
- **Status:** Approved in brainstorming; spec review approved (round 4)
- **Scope:** Sub-project 5 of 5 — on-demand, selective, two-way sync between a local folder and a Drive folder, with AI-assisted file selection and an optional "move to Drive" (release local copies) step
- **Builds on:** MVP spec (`2026-11-03-drive-mcp-mvp-design.md`) and content spec (`2026-11-03-content-processing-design.md`)
- **Delivery:** one spec, two implementation plans — **Phase A** (binary-file sync, AI selection, run) and **Phase B** (Google-native exports, release). §12 lists the split.

## 1. Goal

Keep a chosen set of files in a local folder and a Drive folder in sync in both directions, where the set is chosen with Claude's help ("the seafaring files in Downloads → this Drive folder"), and optionally remove the local copies once they are safely in Drive.

**Overriding principle:** when in doubt, do nothing destructive. Any state the planner cannot classify with certainty becomes "report, no action". Nothing is ever deleted permanently, and no local file is ever overwritten except the tracked file's own path after re-verification.

## 2. Decisions

| Topic | Decision |
|---|---|
| Direction | Two-way |
| Trigger | On demand only (`sync_run` / `marvin-drive sync run`). `sync watch` is a later roadmap item |
| Selection | Explicit per-pair selection of local relative paths plus an `excluded` set. Only selected files sync; other local files are invisible except as candidates/collisions |
| Remote files present at the first applied run | Recorded in `remoteBaseline`; always reported as candidates, never auto-downloaded. Selecting one downloads it |
| Remote files appearing later | Adopted automatically (downloaded + selected) unless excluded or colliding |
| Who selects | Claude in Claude Code, via `sync_scan`. A future GUI plugs a Claude-API classifier into the same selection boundary (out of scope) |
| Identity | Records keyed by Drive `fileId`; local paths matched by NFC key, with case-/normalization-fold lookup |
| Change detection | Three-way: current local, current remote, last-synced record. MD5 (local hash vs `md5Checksum`); Google-native uses `modifiedTime` |
| Conflicts | Keep both; reported |
| Deletions | Propagated, never permanent: Drive trash / macOS Trash via `/usr/bin/trash -s` |
| Google-native files | Pull-only read-only exports (Phase B) |
| Release ("move to Drive") | On request after an applied run; verified; to macOS Trash; released files become remote-only (Phase B) |
| Safety | Dry run by default; apply re-plans and can be bound to the dry run's `planId`; root identity checks; unknown-subtree protection; mass-delete brake; exclusive local writes; re-verification before every destructive or overwriting action; per-pair lock for every writer |
| New dependencies | None (`/usr/bin/trash` ships with macOS 15+) |

## 3. Data model

**Pair file** `~/.config/google-handler/sync/<name>.json` = `{ version: 1, pair, records }`; atomic write (temp + `rename`), file 0600, dir 0700.

```
pair {
  name,                       // unique, [a-z0-9-]{1,40}
  id,                         // random UUID
  account,                    // alias
  localDir,                   // absolute realpath at creation
  caseInsensitive: boolean,   // probed read-only: lstat the case-flipped marker name; a mismatch at run time aborts ("run marvin-drive sync repair-marker")
  remoteFolderId,
  googleExport: { document: 'docx', spreadsheet: 'xlsx', presentation: 'pptx', drawing: 'pdf' },  // Phase B; validated per type with resolveExport
  selection: string[],        // NFC relative POSIX paths
  excluded: string[],         // NFC relative paths; ignored on both sides
  remoteBaseline: string[],   // fileIds of all untracked remote files seen at the first applied run
  baselineFolders: string[],  // remote folder ids that were unknown subtrees at the first applied run
  createdAt, lastAppliedRunAt: string | null, firstAppliedRunAt: string | null
}
record {                      // one per tracked Drive file, keyed by remoteId
  remoteId, path,             // path = NFC relative key (== a selection entry)
  localName,                  // on-disk relative path last seen (may differ in case/normalization)
  remoteName, remoteParentId,
  localMd5, localSize, localMtimeMs, localCtimeMs,
  remoteMd5: string | null, remoteSize: number | null, remoteModifiedTime,
  native: null | { mimeType, exportFormat },        // Phase B
  remoteOnly: boolean, restorePending: boolean, remoteTrashed: boolean   // Phase B
}
```

**Root identity marker:** `sync_create_pair` writes `<localDir>/.marvin-sync-<name>` containing `pair.id`. (Dot-files are ignored by sync.) Moving the folder elsewhere = remove and recreate the pair (records re-adopt by md5, §6.5 U2).

**Keys:** `key` = NFC relative path. `foldKey` = NFC + Unicode case-fold. Remote names containing `/` or NUL, or a segment longer than 255 UTF-8 bytes, are `unrepresentable` (skipped, reported).

## 4. Architecture

```
src/sync/
  types.ts           Pair, SyncRecord, LocalEntry, RemoteEntry, Probe, Action, Plan, SyncReport
  pair-store.ts      atomic load/save, list, delete, lock (all writers), overlap check, marker file
  paths.ts           key/foldKey, validation (no "..", no absolute), containment via realpath
  local-scanner.ts   → { entries: LocalEntry[], unknownSubtrees: string[] }; LocalEntry { key, foldKey, name, size, mtimeMs, ctimeMs }; md5 on demand
  remote-scanner.ts  → { entries: RemoteEntry[], folders: Map<id, key>, unknownSubtrees: string[] }
  remote-probe.ts    files.get for records missing from the scan
  planner.ts         PURE: (pair, records, local, remote, probes, md5s, now) → Plan
  executor.ts        ordered execution, re-verification, persistence after each success
  transfer.ts        downloadReplace, placeExclusive (link + EEXIST, as writeUnique), uploadNew, updateContent
  trash.ts           execFile('/usr/bin/trash', ['-s', absPath]) one path per call; never unlink
  sync-service.ts    createPair, listPairs, scan, select, run, release, removePair
src/mcp/sync-tools.ts (7 tools, §8) · src/cli/main.ts (§9)
```

Changes to existing code: `DriveAdapter.updateFile` gains optional `media` (same `fileId`; Drive keeps a revision — binary revisions are pruned after 30 days / 100 revisions unless `keepForever`). Sync uses its own field list `SYNC_FILE_FIELDS = 'id, name, mimeType, md5Checksum, size, modifiedTime, createdTime, parents, trashed, capabilities(canEdit, canTrash, canAddChildren)'` (`SUMMARY_FIELDS` unchanged). `ensureRemoteFolder(parentId, name)` reuses exactly one non-trashed same-name folder; several → that subtree is `unknown`. `FileService.download` (never overwrites) is not used by sync. New `AuditOp`s (§10). `SyncService` wired in `buildApp` with the shared runner and audit sink.

**Unknown subtrees:** local — directories that cannot be read (`EACCES`, `EPERM`), entries that vanish or error during the scan; remote — ambiguous duplicate folders, folders whose listing failed. Every record, selection key or candidate under an unknown subtree gets **`unknown-state` (report, no action)**.

## 5. Run lifecycle

1. **Lock** (§10).
2. **Root checks — abort the whole run if any fails** (marker problems tell the user to run `marvin-drive sync repair-marker <name>`): `localDir` exists, is a readable directory, and contains `.marvin-sync-<name>` with `pair.id` (catches unmounted/replaced volumes); remote root exists, is a folder, not trashed, `canAddChildren`.
3. **Scan** both sides (hash only when size/mtime/ctime differ from the record; hash every selected file not yet recorded).
4. **Probe** every record whose `remoteId` was not in the remote scan (§6.2).
5. **Plan** (pure). `planId` = SHA-256 over the canonical list of `(kind, remoteId|key, md5s)` — no generated names or timestamps.
6. **Dry run** returns the plan; nothing is written (no timestamps updated). **Apply** re-scans and re-plans; if `planId` was passed and differs → abort and return the new plan.
7. **Brake** (§6.8), **execute** (§7), then set `lastAppliedRunAt`; on the first applied run also set `firstAppliedRunAt` and `remoteBaseline` = ids of **every** untracked remote file seen in this run, whatever its classification (candidate, native-skipped, ambiguous, unrepresentable, ignored), plus `baselineFolders` = ids of remote folders that were unknown subtrees. Files later first seen under a folder in `baselineFolders` (or one of its descendants) are treated as baseline candidates (U5), never adopted.

## 6. Planner

The planner classifies every **tracked record** (§6.3) and every **untracked key** (§6.5). Each item is resolved through the steps below in order; the first matching step decides.

### 6.1 Resolving L for a key

1. Exact key match in the local scan → L.
2. Else, **only if `pair.caseInsensitive`**, a local entry with the same `foldKey` → L, flagged `renamed-case` (record `localName` updated; no remote rename). On a case-sensitive volume a fold-only match → `ambiguous`.
3. Else, if the key lies under a local unknown subtree → `unknown-state`.
4. Else, if something exists at the key on disk but is not a regular file (symlink, directory, socket…) → `unknown-state`.
5. Else L = absent.

L state: **unchanged** (md5 = `K.localMd5`), **changed**, or **absent**.

### 6.2 Resolving R for a record

From the scan by `remoteId`: **present-same** (same key) or **present-moved** (different key inside the pair). If not in the scan, probe: `trashed` → **trashed**; parents resolve to a scanned folder or into an unknown subtree → **unknown-state** if unknown, else **present-moved**; parents outside the pair → **moved-out**; 404/403 → **unavailable**. R content: **unchanged** / **changed** (md5, or size+modifiedTime with warning `weak-compare` when md5 is null; native: `modifiedTime`).

### 6.3 Tracked records — dispatch

Order: (a) record or its key under an unknown subtree → `unknown-state`. (b) key involved in an `ambiguous` collision → `ambiguous`. (c) `K.remoteOnly` → §6.7 (for native records too). (d) `K.native` → §6.6. (e) otherwise → §6.4.

All tables below are **first-match-wins in the order listed**. Selection/`excluded` updates attached to an action are applied only after that action succeeds. A tracked file whose new key (B7–B9, N6, O4) is in `excluded` → `untrack` with report `moved-into-excluded`.

### 6.4 Binary tracked records

| # | R | L | Action |
|---|---|---|---|
| B1 | present-same, unchanged | unchanged | none |
| B2 | present-same, unchanged | changed | `update-remote` (needs `canEdit`, else `remote-readonly` report) |
| B3 | present-same, changed | unchanged | `download-replace` |
| B4 | present-same, changed | changed | equal md5 → `adopt`; else `conflict` (§6.9; if `!canEdit`: conflict copy only + `remote-readonly`) |
| B5 | present-same, unchanged | absent | `trash-remote` (needs `canTrash`, else `cannot-trash` report, record kept) |
| B6 | present-same, changed | absent | `download-new` at the key (recreate; change beats deletion) |
| B7 | present-moved | unchanged | `move-local` to the new key (exclusive); then `download-replace` if R changed. Selection: old key → new key. If old and new keys share a `foldKey` on a case-insensitive volume (remote case-only rename) → plain `rename` in place, persisting `localName` and the selection key in the same step |
| B8 | present-moved | changed | `download-new` at the new key; L stays at the old key untouched; old key → `excluded`; new key → selection; report `conflict-rename` |
| B9 | present-moved | absent | `download-new` at the new key; old key → new key in selection (remote rename counts as a change) |
| B10 | trashed | unchanged | `trash-local` |
| B11 | trashed | changed | `upload-new` at the key (record rebased to the new id) |
| B12 | trashed | absent | `forget` (drop record; key removed from selection) |
| B13 | moved-out | any | `untrack`: drop record, key → `excluded`, keep L; report `moved-out` |
| B14 | unavailable | any | report `remote-unavailable` every run; no action (clear with `sync_select remove`) |

### 6.5 Untracked keys (no record)

Candidate keys = selection keys without a record ∪ untracked remote files (by `foldKey`) ∪ unselected local files.

| # | Situation | Action |
|---|---|---|
| U0 | Key in `excluded`, or under an unknown subtree, or ignored (§6.10) | ignored / `unknown-state` |
| U0b | Untracked native R whose export key matches a local entry (Phase B) | `ambiguous-native` (report) |
| U1 | Selected, L present, no untracked R with same `foldKey` | `upload-new` (subfolders via `ensureRemoteFolder`) |
| U2 | Selected, L present, untracked R with same `foldKey` | equal md5 → `adopt`; else `conflict` |
| U3 | Selected, L absent, untracked R present | `download-new` (native: `export-new`, Phase B) |
| U4 | Selected, L absent, no R | report `missing` |
| U5 | Untracked R, key not selected, and (`R.id ∈ remoteBaseline`, or under a `baselineFolders` folder, or `firstAppliedRunAt` null) | `candidate-remote` |
| U6 | Untracked R, key not selected, not in baseline, first applied run done, no local entry with same `foldKey` | `download-new` + add key to selection (native: `export-new`) |
| U7 | Same as U6 but a local entry with same `foldKey` exists | `collision` (report; nothing written) |
| U8 | Unselected L, no untracked R with same `foldKey` | `candidate-local` if mtime > `lastAppliedRunAt` (all on first run); cap 200 |

Duplicate keys on one side (same `foldKey` twice, or two remote files with the same name in one folder) → all involved keys `ambiguous` (report; no action), overriding every rule above.

### 6.6 Google-native tracked records (Phase B)

Native records never produce `upload-new`, `update-remote`, `conflict` uploads or `trash-remote`. The key is the local export path (Drive name + export extension unless already present, via `ensureExtension`). "L edited" = md5 ≠ md5 of the last export.

| # | R | L | Action |
|---|---|---|---|
| N1 | present-same, unmodified | unchanged | none |
| N2 | present-same, unmodified | edited | warning `native-readonly-edited` ("use docs_*/sheets_*/slides_*") |
| N3 | present-same, unmodified | absent | report `native-local-missing` ("it will be re-exported on the next remote change; use sync_select remove or sync_release to stop that") |
| N4 | present-same, modified | unchanged or absent | `export-replace` / `export-new` |
| N5 | present-same, modified | edited | `place-exclusive` L as `<stem> (local edit YYYY-MM-DD HH.mm)<ext>`, then `export-new`; report |
| N6 | present-moved | any | as B7–B9 using exports instead of downloads; never uploads |
| N7 | trashed | unchanged or absent | `trash-local` (if present) / `forget` |
| N8 | trashed | edited | `untrack` (keep L, key → `excluded`); report |
| N9 | moved-out / unavailable | any | as B13 / B14 |
| — | export fails with `ExportTooLargeError` | — | report `native-too-large`; record unchanged |

Untracked native R with L present at the export key → `ambiguous-native` (report).

### 6.7 Remote-only records (Phase B, released files)

| # | Situation | Action |
|---|---|---|
| O0 | `restorePending`, L present with md5 = R md5 (native: = `K.localMd5`) | `adopt`; clear `remoteOnly` and `restorePending` |
| O1 | `restorePending` (set by `sync_select add`), R present-same or present-moved | `download-new` (native: `export-new`) at R's current key (exclusive; collision → report); clear `remoteOnly` and `restorePending` |
| O2 | `restorePending`, R trashed / unavailable | report; keep flags |
| O3 | L absent, R present-same | none (changed R → record refresh) |
| O4 | L absent, R present-moved | record path update; selection old key → new key |
| O5 | R trashed | set `remoteTrashed`; warning every run `remote-only-trashed` ("the only copy is in Drive trash; purged after 30 days") |
| O6 | `remoteTrashed` and R present again | clear `remoteTrashed` |
| O7 | R moved-out / unavailable | as B13 / B14 |
| O8 | L present again (same key, or `foldKey` on a case-insensitive volume) | md5 = R md5 (native: = `K.localMd5`) → clear `remoteOnly` (`adopt`); otherwise `collision` (report; nothing written) |

Remote-only native records are never exported unless `restorePending` (regression test: released Google Doc, remote modified → no export).

### 6.8 Mass-delete brake

Count planned `trash-remote` + `trash-local`. Over threshold → abort with counts unless `allowMassDelete: true`. Threshold: count > max(10, 20% of tracked non-remote-only records), **or** every tracked non-remote-only file of one side would be deleted while ≥ 3 are tracked.

### 6.9 Conflict action

1. `downloadReplace`-style stream of R into `place-exclusive` target `<stem> (Drive conflict YYYY-MM-DD HH.mm)<ext>` (` 2`, ` 3`… on collision), verify md5, `fsync`.
2. Only then `update-remote` with L.
3. Report both paths; the conflict copy is not selected. Step 1 failure → step 2 skipped.

### 6.10 Ignored entries

- **Local:** names starting with `.` (incl. the marker), `*.marvin-part` (stale ones older than 1 hour are deleted at the start of **applied** runs only), non-regular files (symlinks, sockets, devices, FIFOs), anything whose realpath leaves `localDir`.
- **Remote:** shortcuts, folders as leaves, Google-native files in Phase A (reported `native-skipped`), unsupported native types in Phase B (Forms, Sites, Apps Script, Jamboard, Maps — `resolveExport` would throw `UnsupportedTypeError`; reported `native-unsupported`), `unrepresentable` names.
- Ignored entries never count as "L present" or "R present" for any rule; a tracked key now occupied by an ignored local entry is `unknown-state` (§6.1 step 4).

## 7. Execution

- **Order:** remote folder creation → `upload-new`/`update-remote` → `move-local` → `download-*`/`export-*` → conflicts → `trash-remote` → `trash-local`.
- **Local writes:** every new local file (`download-new`, `export-new`, `move-local`, conflict copies, local-edit renames) uses `placeExclusive` (temp `.marvin-part` + `link` + `EEXIST` → `collision`, never overwrite). Only `download-replace` / `export-replace` of a record's own path overwrite, and only after re-stat shows the target unchanged since the scan (else skip, reported).
- **`move-local` idempotency:** if the target already exists with the same inode as the source (crash between link and unlink), only unlink the source.
- **Re-verification:** `update-remote` re-reads R (skip if changed since planning; no If-Match exists in Drive v3); `trash-remote` re-reads R (skip if changed); `trash-local` re-hashes L (skip if changed); uploads compare the response md5 with the planned md5 (`changed-during-upload` warning, record the response).
- **Duplicate-safe uploads:** after an upload error, look in the parent for a same-name file with the same md5 and `createdTime` within 10 minutes; adopt it instead of failing.
- **Isolation:** failed actions go to `failures` with the mapped message; their records are untouched; the run continues. `ReauthRequiredError`, `QuotaExceededError`, `ApiDisabledError`, `RateLimitError` (after retries) abort; remaining actions `not-run`.
- **Persistence:** the pair file is rewritten atomically after every successful action.
- **Retry kinds:** reads/probes `idempotent`; `upload-new` `create`; `update-remote` `mutate`; Drive trash `idempotent`.
- **Local trash:** `/usr/bin/trash -s <path>`, one path per call, `execFile` (no shell). Non-zero exit → action fails; never `unlink`. Volumes without a trash (some SMB/FAT) always fail `trash-local`/release — documented.
- **iCloud:** hashing an evicted iCloud file makes macOS download it (slow but correct; documented).

## 8. MCP tools

| Tool | Input | Output |
|---|---|---|
| `sync_create_pair` | `name`, `localDir` (absolute, `~` ok, existing), `remoteFolderId` **or** `remoteFolderName` (+ `remoteParentId?`; always creates a new folder), `account?`, `googleExport?` (Phase B) | pair; writes the marker; rejects overlap (same/nested `localDir`, same `remoteFolderId`) |
| `sync_list_pairs` | — | pairs with counts (selected, tracked, remote-only, excluded, baseline) and `lastAppliedRunAt` |
| `sync_scan` | `name`, `onlyUnselected?` (true), `previewChars?` (300, max 2000), `limit?` (200, max 1000), `subdir?` | `{ entries: [{ path, size, modifiedTime, mimeType, preview? }], remoteCandidates: [{ path, size, modifiedTime, mimeType }], truncated }`. Previews only for text-like files; description: open PDFs/Office files with your own file-reading tool, propose a selection, confirm with the user |
| `sync_select` | `name`, `add?`, `remove?` | counts; rejected paths with reasons. `add` is deduped by `foldKey` and rejects keys that are ignored, unrepresentable, under unknown subtrees, or present on neither side. `remove` → key to `excluded`, record dropped, no file touched. `add` → removes from `excluded`; remote candidates become U3; remote-only → `restorePending` (O0/O1) |
| `sync_run` | `name`, `apply?` (false), `planId?`, `allowMassDelete?` | `SyncReport { planId, actions by kind, conflicts, collisions, ambiguous, unknown, warnings, failures, candidates: { local, remote }, releasable? }` |
| `sync_release` (Phase B) | `name`, `paths?` or `all?: true`, `apply?` (false) | released / would-release; skipped with reasons |
| `sync_remove_pair` | `name` | confirmation; removes the marker; files untouched |

## 9. CLI

`marvin-drive sync list` · `marvin-drive sync run <name> [--apply] [--allow-mass-delete]` · `marvin-drive sync repair-marker <name>` (rewrites `.marvin-sync-<name>` after confirming `localDir` interactively; keeps all pair state) · `marvin-drive sync release <name> [--all | <paths…>] [--apply]` (Phase B). Human-readable report; exit code 1 if anything failed or the run aborted.

## 10. Locking, audit, release details

- **Lock:** `<name>.lock` via `O_EXCL` with `{ pid, startedAt }`, taken by every writer (`select`, `run`, `release`, `remove_pair`). Dead pid → broken immediately with a warning; live → `ValidationError("sync is busy for <name>")`.
- **Audit:** one JSONL entry per applied action. New `AuditOp`s: `sync_upload`, `sync_update`, `sync_download`, `sync_move_local`, `sync_conflict`, `sync_trash_remote`, `sync_trash_local`, `sync_release`. Details `{ pair, path, remoteId }`; never content.
- **Release (Phase B):** eligible = tracked, binary or native, not remote-only, L unchanged, R present-same and not trashed; binary additionally `L md5 = K.localMd5 = R md5`. Immediately before each removal re-hash L and re-read R; mismatch → skip with reason. Remove via `trash.ts`; set `remoteOnly`; key stays selected; remove now-empty local directories that contained released files. After an applied run the report lists `releasable` so Claude can ask "Yerel kopyaları silmek ister misiniz? Hepsi / bazıları / hayır".

## 11. Testing

- **Planner (pure):** one test per rule (B1–B14, U0–U8, N1–N9, O1–O8, ambiguous, unknown-state) plus targeted regressions: select-add of a remote-only file never trashes (O1 before B5); baseline candidates never auto-download on later runs (U5); case/NFC cross-side collisions (`Report.pdf` vs `report.pdf`, NFC vs NFD `şartname.pdf`); local case-only rename doesn't trash remote; unknown local subtree never yields `trash-remote`; ambiguous remote folder never yields `untrack`; brake thresholds incl. 100%-of-side with 3 files; `planId` stability across minute boundaries.
- **paths / pair-store / trash / transfer:** normalization, traversal & symlink rejection, atomic writes and modes, marker, lock, overlap, `placeExclusive` never overwrites, `downloadReplace` re-stat abort, `/usr/bin/trash -s` invocation (stubbed) and failure.
- **Scanners / probe:** temp dirs with NFD names and unreadable subdirectories; fake Drive with nested folders, duplicates, shortcuts, trashed, moved-out, 404.
- **Executor:** ordering, re-verification skips, conflict sequencing, duplicate-safe upload adoption, isolation, abort errors, resume after simulated crash.
- **Service / MCP / CLI:** dry-run default and no writes on dry run, `planId` mismatch, root-check aborts, select/exclude/restore semantics.
- **E2E (opt-in, live), Phase A:** temp local + temp Drive folder with one pre-existing remote file → scan → select → dry run → apply with `planId` → (pre-existing file stays a candidate on run 2) → edit both sides → conflict → delete on each side → remote rename within → remote file added after first run is adopted → cleanup. **Phase B:** Google Doc export, release, run does not re-download, select-add restores.

## 12. Phase split

- **Phase A:** §3 (native/remote-only fields present but unused), §4, §5, §6.1–6.5, §6.8, §6.9, §7, §8 except `sync_release`, §9 `list`/`run`, §10 lock+audit, §11 Phase A. Google-native remote files are reported `native-skipped` in Phase A.
- **Phase B:** §6.6, §6.7, release (§10), `sync_release` tool and CLI, `googleExport` validation, Phase B tests and E2E.

## 13. Out of scope

Continuous sync (`sync watch`), Drive Changes API, scheduled runs; GUI and Claude-API classification; rule-based selection; local rename detection beyond case/normalization; resumable uploads (separate roadmap item); shared drives as pair targets; non-macOS trash.
