# Marvin Drive — Selective Two-Way Sync Design (Sub-project 5)

- **Date:** 2026-11-03
- **Status:** Approved in brainstorming; spec review round 1 issues addressed (v2)
- **Scope:** Sub-project 5 of 5 — on-demand, selective, two-way sync between a local folder and a Drive folder, with AI-assisted file selection and an optional "move to Drive" (release local copies) step
- **Builds on:** MVP spec (`2026-11-03-drive-mcp-mvp-design.md`) and content spec (`2026-11-03-content-processing-design.md`)
- **Delivery:** one spec, two implementation plans — **Phase A** (core binary-file sync, AI selection, run) and **Phase B** (Google-native exports, release, CLI release, E2E extension). §12 lists the split.

## 1. Goal

Keep a chosen set of files in a local folder and a Drive folder in sync in both directions, where the set is chosen with Claude's help ("the seafaring files in Downloads → this Drive folder"), and optionally remove the local copies once they are safely in Drive.

**Overriding principle:** when in doubt, do nothing destructive. Every rule below prefers "report and skip" over any action that could remove or overwrite the only copy of data.

## 2. Decisions

| Topic | Decision |
|---|---|
| Direction | Two-way |
| Trigger | On demand only (`sync_run` / `marvin-drive sync run`). No daemon; `sync watch` is a later roadmap item |
| Selection | Explicit per-pair selection of local relative paths, plus an `excluded` set. Only selected files sync; every other local file is invisible to sync |
| Remote-new files | Files already in the Drive folder at the pair's first applied run are **candidates** (reported, not downloaded). Files that appear in the Drive folder **after** the first applied run are adopted automatically (downloaded and selected) unless excluded |
| Who selects | Claude in Claude Code, via a scan tool. No API key. A future GUI plugs a Claude-API classifier into the same selection boundary (out of scope) |
| Identity | Records are keyed by Drive `fileId` (stable across renames/moves); local paths are compared using an NFC-normalized key |
| Change detection | Three-way: current local, current remote, last-synced record. Content equality by MD5 (local hash vs Drive `md5Checksum`) |
| Conflicts | Keep both: remote version saved locally with a conflict suffix, local version uploaded; reported |
| Deletions | Propagated, never permanent: Drive → trash; local → macOS Trash via `/usr/bin/trash` (correct volume, Finder "Put Back" preserved) |
| Google-native files | Pull-only read-only exports (Phase B) |
| Release ("move to Drive") | On request after an applied run; verified, to macOS Trash; released files become *remote-only* (Phase B) |
| Safety | Dry run by default; `apply` re-plans and can be bound to the dry run's `planId`; root-availability checks; mass-delete brake; re-verification before every destructive action; per-pair lock for all writers |
| New dependencies | None (uses `/usr/bin/trash`, present on macOS 15+) |

## 3. Data model

**Pair** (`~/.config/google-handler/sync/<name>.json`, `{ version: 1, pair, records }`, atomic write: temp file + `rename`, file 0600, directory 0700):

```
{
  name,                      // unique, [a-z0-9-]{1,40}
  account,                   // alias
  localDir,                  // absolute realpath at creation
  localDev,                  // st_dev of localDir at creation (volume identity)
  remoteFolderId,
  googleExport: { document: 'docx', spreadsheet: 'xlsx', presentation: 'pptx', drawing: 'pdf' },  // Phase B; per type, validated with resolveExport
  selection: string[],       // NFC relative POSIX paths ("reports/ship.pdf")
  excluded: string[],        // NFC relative paths the user removed; never adopted again
  createdAt, lastRunAt: string | null, firstAppliedRunAt: string | null
}
```

**Record** (one per tracked Drive file, keyed by `remoteId`):

```
{
  remoteId,
  path,                      // NFC relative path (selection key)
  localName,                 // on-disk relative path as last seen (may be NFD); used for I/O
  remoteName,                // Drive name as last seen
  remoteParentId,
  localMd5, localSize, localMtimeMs, localCtimeMs,
  remoteMd5: string | null,  // null for Google-native and for blobs Drive did not checksum
  remoteSize: number | null,
  remoteModifiedTime,
  native: null | { mimeType, exportFormat },   // Phase B
  remoteOnly: boolean        // Phase B (released)
}
```

**Path keys:** comparison key = NFC-normalized relative path. Collision key = NFC + case-folded (macOS APFS default is case- and normalization-insensitive). Drive names containing `/`, NUL, or longer than 255 UTF-8 bytes as a path segment are **not representable** locally → reported as `unrepresentable` and skipped. `:` is allowed (APFS accepts it).

## 4. Architecture

```
src/sync/
  types.ts            Pair, SyncRecord, LocalEntry, RemoteEntry, Action, SyncReport, PlanId
  pair-store.ts       load/save atomically; list; delete; lock (all writers); overlap check
  paths.ts            NFC keys, case-fold collision keys, validation (no "..", no absolute), containment via realpath
  local-scanner.ts    walk localDir → LocalEntry { key, name, size, mtimeMs, ctimeMs, dev, ino }; md5 on demand
  remote-scanner.ts   walk remote folder (files.list per folder) → RemoteEntry { id, key, name, parentId, md5, size, modifiedTime, mimeType, canEdit }
  remote-probe.ts     files.get(remoteId, 'id,name,parents,trashed,mimeType,md5Checksum,size,modifiedTime') for records missing from the scan
  planner.ts          PURE: (pair, records, local, remote, probes, now) → Plan { actions, candidates, warnings, collisions, planId }
  executor.ts         applies actions in a fixed order with re-verification; persists after each success
  transfer.ts         new primitives: downloadReplace (stream → `.marvin-part` → verify → re-stat target → rename), uploadNew, updateContent
  trash.ts            local trash via `/usr/bin/trash` (execFile, no shell); fail the action on error, never unlink
  sync-service.ts     createPair, listPairs, scan, select, run, release, removePair
src/mcp/sync-tools.ts  7 tools (§8)   ·   src/cli/main.ts  sync list | run | release (§9)
```

Changes to existing code:
- `DriveAdapter.updateFile` gains optional `media` (content update keeps the `fileId`; Drive stores a new revision — note: binary revisions are pruned after 30 days / 100 revisions unless `keepForever`).
- Sync uses its own Drive field lists (`SYNC_FILE_FIELDS = 'id, name, mimeType, md5Checksum, size, modifiedTime, parents, trashed, capabilities(canEdit, canAddChildren)'`); `SUMMARY_FIELDS` is not changed.
- Folder find-or-create (`ensureRemoteFolder(parentId, name)`) is new sync logic: reuse exactly one non-trashed folder of that name; if several exist → `ambiguous`, skip the subtree.
- `FileService.download` (`writeUnique`, never overwrites) is **not** used for sync; sync downloads use `transfer.downloadReplace`.
- New `AuditOp`s (§10). `SyncService` is wired in `buildApp` with the shared runner and audit sink.

## 5. Run lifecycle

1. **Lock** the pair (§10).
2. **Root checks — abort the whole run (no actions) if any fails:**
   - `localDir` exists, is a directory, is readable, and its `st_dev` equals `pair.localDev` (unmounted/replaced volume protection).
   - Remote root: `files.get(remoteFolderId)` exists, is a folder, not trashed, `capabilities.canAddChildren` true; otherwise abort with a specific message (`remote-root-missing`, `remote-root-trashed`, `remote-root-readonly`).
3. **Scan** local (selection + candidates only; hashing only when size/mtime/ctime differ from the record) and remote.
4. **Probe** every record whose `remoteId` is absent from the remote scan (§6.3).
5. **Plan** (pure) → `planId` = SHA-256 over the canonical action list.
6. **Dry run** returns the plan. **Apply** re-plans from fresh scans; if the caller passed `planId` and the new plan's id differs, abort with the new plan ("changed since the dry run; review again").
7. **Brake** (§6.6), then **execute** (§7), then set `lastRunAt` (and `firstAppliedRunAt` on the first applied run) and release the lock.

## 6. Planning rules

Notation: K = record, L = local entry for K's path (selected), R = remote entry for `K.remoteId` (from scan or probe). "L changed" = MD5 ≠ `K.localMd5`. "R changed" = `md5Checksum` ≠ `K.remoteMd5`; when either md5 is null (unchecksummed blob) use `size` + `modifiedTime` and add a warning `weak-compare`.

### 6.1 Tracked files (K present, `remoteOnly` false, binary)

| # | L | R (in pair folder) | Action |
|---|---|---|---|
| 1 | unchanged | unchanged | none |
| 2 | changed | unchanged | `update-remote` |
| 3 | unchanged | changed | `download-replace` |
| 4 | changed | changed, same md5 as L | `adopt` (record only; refresh all fields incl. `remoteId`) |
| 5 | changed | changed, different | `conflict` (§6.5) |
| 6 | absent | unchanged | `trash-remote` (re-verified at execution) |
| 7 | absent | changed | `download-replace` (recreate; change beats deletion) |
| 8 | unchanged | trashed | `trash-local` (re-verified at execution) |
| 9 | changed | trashed | `upload-new` (recreate remotely; record rebased to the new id) |
| 10 | absent | trashed | `forget` |
| 11 | any | renamed/moved **within** the pair folder | if L unchanged: `move-local` to the new path (target free, else `collision`); if L changed: `download-replace` at the new path + keep L at the old path, report `conflict-rename` |
| 12 | any | moved **outside** the pair folder | `untrack`: drop from selection and records, keep L, report `moved-out` |
| 13 | any | probe 404 / 403 (deleted permanently or access lost) | no action, report `remote-unavailable`; record kept (re-evaluated next run) |
| 14 | present | present, `canEdit` false | no upload/update/trash-remote; downloads allowed; report `remote-readonly` |
| 15 | selected but L and R and K all absent | — | report `missing` |

Local renames are delete + new (rules 6 + 16), reported as such.

### 6.2 Untracked paths (K absent)

| # | Situation | Action |
|---|---|---|
| 16 | Selected L present, no remote file at that key | `upload-new` (subfolders via `ensureRemoteFolder`) |
| 17 | Selected L present, remote file at that key | same md5 → `adopt`; different → `conflict` |
| 18 | Remote file in pair folder, key not selected, not excluded, `firstAppliedRunAt` null | `candidate-remote` (report only) |
| 19 | Remote file in pair folder, key not selected/excluded, `firstAppliedRunAt` set, no local file at that key | `download-new` + add to selection |
| 20 | Same as 19 but an **unselected** local file exists at that key | `collision` (report; never upload or overwrite the unselected file) |
| 21 | Key in `excluded` | ignored on both sides |
| 22 | Unselected local files | `candidate-local` only if mtime > `lastRunAt` (or all on first run), cap 200 |

### 6.3 Remote probing

For each record whose `remoteId` was not found in the scan: `files.get` (see `remote-probe.ts`). `trashed: true` → treated as "trashed" (rules 8–10). Not trashed and a parent chain inside the pair folder (resolved against the scanned folder set) → rename/move within (rule 11). Not trashed, parent outside → rule 12. 404/403 → rule 13.

### 6.4 Collisions and naming

- Two entries on one side whose collision keys match (e.g. `Report.pdf`/`report.pdf`, or NFC vs NFD forms), or two remote files with the same name in one folder → all involved keys reported as `ambiguous`; no action on them.
- `unrepresentable` remote names (§3) → skipped, reported.
- Ignored entries: local non-regular files (symlinks, sockets, devices), names starting with `.`, `*.marvin-part`, anything whose realpath leaves `localDir`; remote shortcuts, folders as leaves, Google-native files in Phase A (reported `native-skipped`), unsupported native types (Forms, Sites, Apps Script, Jamboard, Maps) in Phase B.

### 6.5 Conflict action

1. Download R to `<stem> (Drive conflict YYYY-MM-DD HH.mm)<ext>` in L's directory (local time; ` 2`, ` 3`… on collision), verify md5, `fsync`.
2. Only after step 1 succeeded: `update-remote` with L (Drive keeps the previous content as a revision).
3. Report both paths. The conflict copy is not selected. If step 1 fails, step 2 is not attempted.

### 6.6 Mass-delete brake

Count planned `trash-remote` + `trash-local`. Abort (`ValidationError` with counts and the root paths) unless `allowMassDelete: true` when: count > max(10, 20% of tracked records), **or** all tracked files of one side would be deleted and the pair tracks ≥ 3 files.

### 6.7 Google-native files (Phase B)

The record key is the **local export path** (`Report.docx`); the record also stores `remoteName` and `native.mimeType`. Export path = Drive name with the export extension appended unless already present (reuse `ensureExtension`); if it collides with another key (e.g. a binary `Report.docx` in the same folder) → `ambiguous`.

| # | Situation | Action |
|---|---|---|
| N1 | New native R (adopted per 18/19 rules) | `export-download` with `googleExport[type]` |
| N2 | R `modifiedTime` changed, L unchanged since last export | `export-download` (replace) |
| N3 | R changed, L edited since last export | rename L to the conflict name (§6.5 naming), then `export-download`; report `native-edited-copy` |
| N4 | R unchanged, L edited | warning `native-readonly-edited` ("use docs_*/sheets_*/slides_*"); never upload |
| N5 | L absent, R present | no remote action; re-export on next remote change only; report `native-local-missing` (never `trash-remote`) |
| N6 | R trashed | L unchanged → `trash-local`; L edited → keep L, `untrack`, report |
| N7 | K absent, L present at the export path | `ambiguous-native` (report; user decides by renaming) |

`modifiedTime` also changes on metadata edits, so N2 can cause harmless re-exports.

### 6.8 Release (Phase B)

- Eligible: selected, tracked, `remoteOnly` false, L unchanged, R not trashed and inside the pair folder; binary: L md5 = `K.localMd5` = current R `md5Checksum`; native exports: R exists.
- Immediately before each removal: re-hash L, re-read R (`trashed`, `parents`, `md5Checksum`). Any mismatch → skip with reason.
- Remove via `trash.ts`; set `remoteOnly: true`; the path **stays in `selection`**.
- Remove now-empty local directories that contained released files (never others).
- Remote-only rules: L absent → expected (no `trash-remote`). R changed → record refresh only. R trashed → `forget` with a prominent warning `remote-only-trashed` ("the only copy is in Drive trash and is purged after 30 days"). L present again (restored from Trash or recreated) → clear `remoteOnly`, then rule 17. `sync_select add` of a remote-only path → clear `remoteOnly` and plan `download-replace` (explicit rule R1).
- After an applied run the report lists `releasable` so Claude can ask "Yerel kopyaları silmek ister misiniz? Hepsi / bazıları / hayır".

## 7. Execution

- **Order:** folder creation → uploads/updates → downloads/exports/moves → conflicts → `trash-remote` → `trash-local` (deletions last).
- **Re-verification:** `trash-remote` re-reads R and skips if `md5Checksum`/`modifiedTime` changed; `trash-local` re-hashes L and skips if changed; `download-replace` re-stats the target and aborts that action if size/mtime changed since the scan; uploads compare the response `md5Checksum` with the planned md5 (mismatch → record the response md5, warn `changed-during-upload`).
- **Duplicate-safe uploads:** after an upload error, list the parent for a same-name file with the same md5 created in the last 10 minutes and adopt it instead of reporting failure.
- **Per-action isolation:** a failed action is reported in `failures` with the mapped message; its record is untouched (retried next run); the run continues. `ReauthRequiredError`, `QuotaExceededError`, `ApiDisabledError` and `RateLimitError` (after retries) abort the run; remaining actions are reported as `not-run`.
- **Persistence:** the pair file is rewritten atomically after every successful action.
- **Retry kinds:** reads/probes `idempotent`; `upload-new` `create`; `update-remote` `mutate`; Drive trash `idempotent` (as `FileService.delete`).
- **Local trash:** `/usr/bin/trash <absolute path>` via `execFile` (no shell). Non-zero exit → action fails; never falls back to `unlink`. Moves to the trash of the file's own volume.
- **iCloud:** hashing an evicted iCloud Drive file makes macOS download it; such folders are supported but may be slow (documented).

## 8. MCP tools

| Tool | Input | Output |
|---|---|---|
| `sync_create_pair` | `name`, `localDir` (absolute, `~` allowed, existing dir), `remoteFolderId` **or** `remoteFolderName` (+ `remoteParentId?`; **always creates a new folder**), `account?`, `googleExport?` (partial per-type map, Phase B) | pair. Rejects overlapping pairs (same/nested `localDir`, or same `remoteFolderId`) |
| `sync_list_pairs` | — | pairs with counts (selected, tracked, remote-only, excluded) and `lastRunAt` |
| `sync_scan` | `name`, `onlyUnselected?` (default true), `previewChars?` (default 300, max 2000), `limit?` (default 200, max 1000), `subdir?` | `{ entries: [{ path, size, modifiedTime, mimeType, preview? }], truncated }`; previews only for text-like files; description tells Claude to open PDFs/Office files with its own file-reading tool and to confirm the selection with the user |
| `sync_select` | `name`, `add?: string[]`, `remove?: string[]` | new counts; rejected paths with reasons. `remove` → path moves to `excluded`, record dropped, no file touched. `add` of an excluded path removes it from `excluded`; of a remote-only path → rule R1 |
| `sync_run` | `name`, `apply?` (default false), `planId?`, `allowMassDelete?` | `SyncReport`: `planId`, actions by kind, conflicts, collisions/ambiguous, warnings, failures, `candidates.local`, `candidates.remote`, `releasable` (after apply) |
| `sync_release` (Phase B) | `name`, `paths?` or `all?: true`, `apply?` (default false) | released / would-release, skipped with reasons |
| `sync_remove_pair` | `name` | confirmation; files untouched |

## 9. CLI

`marvin-drive sync list` · `marvin-drive sync run <name> [--apply] [--allow-mass-delete]` · `marvin-drive sync release <name> [--all | <paths…>] [--apply]` (Phase B). Human-readable report on stdout; exit code 1 if any action failed or the run aborted.

## 10. Locking, audit, errors

- **Lock:** `<name>.lock` created with `O_EXCL`, content `{ pid, startedAt }`. Taken by **every writer** (`select`, `run`, `release`, `remove_pair`). If the lock's pid is not alive → broken immediately with a warning. Otherwise → `ValidationError("sync is busy for <name>")`.
- **Audit:** one JSONL entry per applied action. New `AuditOp`s: `sync_upload`, `sync_update`, `sync_download`, `sync_move_local`, `sync_conflict`, `sync_trash_remote`, `sync_trash_local`, `sync_release`. Details `{ pair, path, remoteId }`. Never file content.
- **Errors:** new error codes surface through existing `AppError` mapping; root-check aborts and the brake use `ValidationError` with actionable messages.

## 11. Testing

- **Planner (pure):** a test per rule (1–22, N1–N7, R1, release rules), collision keys (case, NFC/NFD Turkish names such as `şartname.pdf`), unrepresentable names, brake thresholds (incl. 100%-of-side with 3 files), `planId` stability.
- **paths / pair-store / trash:** normalization, traversal and symlink rejection, atomic write + modes, lock (dead pid broken, live pid blocks), overlap rejection, `/usr/bin/trash` invocation (stubbed exec) and failure handling.
- **Scanners / probe:** temp dirs (incl. NFD file names written via `Buffer` paths), fake Drive with nested folders, duplicates, shortcuts, trashed, moved-out, 404.
- **Executor / transfer:** ordering, re-verification skips, `.marvin-part` + atomic replace, conflict sequencing (update never before conflict copy), duplicate-safe upload adoption, per-action isolation, abort-class errors, resume after simulated crash.
- **Service, MCP, CLI:** dry-run default, `planId` mismatch abort, root-check aborts, select/exclude semantics.
- **E2E (opt-in, live), Phase A:** temp local + temp Drive folder with a pre-existing remote file (stays a candidate) → scan → select subset → dry run → apply with `planId` → edit both sides → conflict → delete on each side → remote rename within folder → remote file added after first run (adopted) → cleanup. **Phase B** extends with a Google Doc export, release, and a run that must not re-download released files.

## 12. Phase split

- **Phase A:** §3 (without `googleExport`/`native`/`remoteOnly` usage), §4, §5, §6.1–6.6, §7, §8 except `sync_release`, §9 `list`/`run`, §10, §11 Phase A.
- **Phase B:** §6.7, §6.8, `sync_release` tool and CLI, `googleExport` validation, Phase B tests and E2E extension.

## 13. Out of scope

Continuous sync (`sync watch`), Drive Changes API, scheduled runs; GUI and Claude-API classification; rule-based selection (globs, tags); local rename detection; resumable uploads (separate roadmap item); shared drives as pair targets; non-macOS trash.
