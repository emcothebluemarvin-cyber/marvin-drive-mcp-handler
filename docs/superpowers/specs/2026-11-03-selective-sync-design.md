# Marvin Drive — Selective Two-Way Sync Design (Sub-project 5)

- **Date:** 2026-11-03
- **Status:** Approved in brainstorming; awaiting spec review
- **Scope:** Sub-project 5 of 5 — on-demand, selective, two-way sync between a local folder and a Drive folder, with AI-assisted file selection and an optional "move to Drive" (release local copies) step
- **Builds on:** MVP spec (`2026-11-03-drive-mcp-mvp-design.md`) and content spec (`2026-11-03-content-processing-design.md`)

## 1. Goal

Keep a chosen set of files in a local folder and a Drive folder in sync in both directions, where the set is chosen with Claude's help ("the seafaring files in Downloads → this Drive folder"), and optionally remove the local copies once they are safely in Drive.

## 2. Decisions

| Topic | Decision |
|---|---|
| Direction | Two-way |
| Trigger | On demand only (`sync_run` / `marvin-drive sync run`). No daemon; `sync watch` is a later roadmap item |
| Selection | Explicit per-pair list of relative paths. Only selected files sync; everything else in the local folder is invisible to sync |
| Who selects | Claude in Claude Code, using a scan tool (metadata + short text preview). No API key, no extra cost. A future GUI would plug a Claude-API classifier into the same selection boundary (out of scope) |
| Change detection | Three-way comparison: current local, current remote, last-synced record (approach A). Content equality by MD5 (local hash vs Drive `md5Checksum`), never by timestamps |
| Conflicts | Keep both: remote version downloaded next to the local one with a conflict suffix, local version uploaded; reported |
| Deletions | Propagated, never permanent: Drive → trash; local → macOS Trash (`~/.Trash`) |
| Google-native files | Pull-only read-only copies exported in the pair's format; local edits to them are never uploaded (reported) |
| Release ("move to Drive") | After an applied run, files verified in Drive can be removed locally (to macOS Trash) on request; they become *remote-only* and are not re-downloaded |
| Safety defaults | `sync_run` and `sync_release` are dry runs unless `apply: true`; mass-delete brake; per-pair lock |
| New dependencies | None |

## 3. Concepts

- **Pair:** `{ name, account (alias), localDir (absolute), remoteFolderId, googleExport, selection, createdAt }`.
  - `name`: unique, `[a-z0-9-]{1,40}`.
  - `googleExport`: the export format for Google-native files — one of `docx|xlsx|pptx` (default: type's native Office format), or `md`, `pdf`, `csv` where valid for the type (reuses `resolveExport` / `EXPORT_FORMATS` from the MVP).
  - `selection`: set of POSIX relative paths (`"reports/ship.pdf"`), normalized, no `..`, no leading `/`.
- **Record (last-synced state), per selected path:**
  `{ path, remoteId, localMd5, remoteMd5 | null, localSize, localMtimeMs, remoteModifiedTime, googleNative: boolean, exportFormat?: string, remoteOnly: boolean }`.
  - `remoteMd5` is null for Google-native files (Drive has no checksum); for them change detection uses `remoteModifiedTime`.
  - `remoteOnly` marks released files (§6).
- **Storage:** `~/.config/google-handler/sync/<name>.json` holds `{ version: 1, pair, records }`; `<name>.lock` is the run lock. Writes are atomic (write temp file + `rename`), mode 0600, directory 0700.

## 4. Architecture

```
src/sync/
  types.ts           Pair, SyncRecord, LocalEntry, RemoteEntry, Action, SyncReport
  pair-store.ts      load/save pairs+records atomically; list; delete; lock acquire/release
  paths.ts           normalize/validate relative paths; containment + symlink checks
  local-scanner.ts   walk localDir → LocalEntry {path, size, mtimeMs}; md5 on demand (cached via record size+mtime)
  remote-scanner.ts  walk remote folder recursively → RemoteEntry {path, id, md5, modifiedTime, mimeType, trashed}
  planner.ts         PURE: (pair, records, local, remote, now) → Action[]  (+ candidates, warnings)
  executor.ts        apply Action[] via FileService/adapters; persist record after each success
  trash.ts           move a local file to ~/.Trash with a unique name
  sync-service.ts    createPair, listPairs, scan, select, run, release, removePair
src/mcp/sync-tools.ts   7 MCP tools (§7)
src/cli/main.ts          `sync list | run | release` commands (§8)
```

- `planner.ts` has no I/O and is the unit most heavily tested.
- `executor.ts` reuses `FileService` for uploads/downloads/trash so retry, error mapping, audit and Drive conventions are shared. `DriveAdapter.updateFile` gains optional `media` (content update keeping the same `fileId`, so Drive keeps version history); `FileService` gains `updateContent({ fileId, localPath })` (kind `mutate`: no 5xx retry).
- `SyncService` is wired in `buildApp` with the same runner and audit sink as the other services.

## 5. Planning rules

Inputs per path in `selection ∪ (remote paths not in records and not ignored)`:
L = current local entry (or absent), R = current remote entry (or absent/trashed), K = record (or absent). "Changed" means: local — md5 differs from `K.localMd5`; remote — `md5Checksum` differs from `K.remoteMd5` (Google-native: `modifiedTime` differs from `K.remoteModifiedTime`). MD5 of a local file is computed only when size or mtime differs from the record (otherwise reuse `K.localMd5`).

| # | Situation | Action |
|---|---|---|
| 1 | K absent, L present (selected), R absent | `upload` (create in remote folder at the same relative path; create subfolders as needed) |
| 2 | K absent, R present, L absent | `download` and add path to selection (remote folder content belongs to the pair) |
| 3 | K absent, L and R present | Same md5 → `adopt` (record only). Different → `conflict` |
| 4 | Only L changed | `update-remote` (same `fileId`) |
| 5 | Only R changed | `download` (to `<file>.marvin-part`, then atomic rename) |
| 6 | Both changed, same md5 | `adopt` |
| 7 | Both changed, different md5 | `conflict` |
| 8 | L absent, R unchanged | `trash-remote` |
| 9 | R absent/trashed, L unchanged | `trash-local` |
| 10 | L absent, R changed | `download` (recreate locally; change wins over deletion) |
| 11 | R absent/trashed, L changed | `upload` (recreate remotely as a new file) |
| 12 | L and R both absent | `forget` (drop record) |
| 13 | Neither changed | nothing |
| 14 | Google-native R | Never upload. New/changed R → `export-download` in `googleExport` format to `<path>.<ext>` (record keeps the Drive name and the local exported path). Local copy changed (md5 ≠ record) → `warn` "read-only copy edited; use docs_*/sheets_*/slides_*", no upload; next remote change → `conflict`-style keep-both (local edited copy renamed with the conflict suffix, fresh export downloaded) |
| 15 | `K.remoteOnly` | Local absence is expected: no `trash-remote`. R changed → update record only. R absent → `forget`. Path re-added via `sync_select` → clears `remoteOnly`, then rule 5/2 downloads it |

**Conflict action (`conflict`):** download R to `<stem> (Drive conflict YYYY-MM-DD HH.mm)<ext>` in the same local directory (local time, collision-safe with ` 2`, ` 3`…), then `update-remote` with L. The conflict copy is **not** added to the selection; the report lists both paths. Google-native: see rule 14.

**Remote naming:** remote file name = local basename; remote subfolder chain = local relative directories (created with `drive_create_folder` semantics, reused when a folder of that name already exists under the parent). Two remote files with the same name in one folder (Drive allows it) → the extra ones are reported as `ambiguous` and skipped.

**Ignored:** local entries that are not regular files (symlinks, sockets, directories as leaves), names starting with `.` (e.g. `.DS_Store`), `*.marvin-part`, and anything outside `localDir` after `realpath`. Remote: shortcuts, folders as leaves, files already trashed when K is absent.

**Candidates (AI selection aid):** every dry run also returns `newLocalCandidates`: local files not in the selection whose mtime is newer than the pair's last run (or all unselected files on first run), capped at 200 entries. They are never synced unless selected.

**Mass-delete brake:** if `trash-remote` + `trash-local` actions exceed `max(10, 20% of selection)`, `run` with `apply` fails with a `ValidationError` listing the counts unless `allowMassDelete: true`.

**Rename** is treated as delete + new (rules 8 + 1); acceptable for an on-demand tool and reported as such.

## 6. Release ("move to Drive")

- `release(pair, paths | 'all', apply)` considers selected, non-Google-native, non-`remoteOnly` paths that are in sync (L md5 = K.localMd5 = remote md5 now). Google-native exported copies are releasable without checksum comparison (they are derived copies), provided the remote file still exists.
- Immediately before each removal it re-hashes L and re-reads R (`md5Checksum`); any mismatch → skip with reason `changed` / `missing-remote`.
- Removal moves the file to macOS Trash (`trash.ts`); the record is set `remoteOnly: true`; empty local subdirectories left behind are removed (only directories that the pair created and that are now empty).
- After an applied `run`, the report includes `releasable` (count + paths) so Claude can ask "Yerel kopyaları silmek ister misiniz? Hepsi / bazıları / hayır".

## 7. MCP tools

| Tool | Input | Output |
|---|---|---|
| `sync_create_pair` | `name`, `localDir` (absolute, `~` allowed, must exist), `remoteFolderId` **or** `remoteFolderName` (+ optional `remoteParentId`, created if given by name), `account?`, `googleExport?` | the pair |
| `sync_list_pairs` | — | pairs with selection count, remote-only count, lastRunAt |
| `sync_scan` | `name`, `onlyUnselected?` (default true), `previewChars?` (default 300, max 2000), `limit?` (default 200, max 1000), `subdir?` | `{ entries: [{ path, size, modifiedTime, mimeType, preview? }], truncated }` — preview only for text-like files (`text/*`, `.md`, `.csv`, `.json`); tool description tells Claude to open PDFs/Office files with its own file-reading tool when content matters |
| `sync_select` | `name`, `add?: string[]`, `remove?: string[]` | new selection size, rejected paths with reasons. `remove` stops syncing only; it never deletes and drops the record |
| `sync_run` | `name`, `apply?` (default false), `allowMassDelete?` | `SyncReport`: planned/applied actions grouped by kind, conflicts, warnings, failures, `newLocalCandidates`, `releasable` (applied runs) |
| `sync_release` | `name`, `paths?: string[]` or `all?: true`, `apply?` (default false) | released / would-release paths, skipped with reasons |
| `sync_remove_pair` | `name` | confirmation; files untouched |

Tool descriptions state the dry-run default and the intended conversational flow (scan → propose → confirm → select → dry run → confirm → apply → offer release).

## 8. CLI

`marvin-drive sync list` · `marvin-drive sync run <name> [--apply] [--allow-mass-delete]` · `marvin-drive sync release <name> [--all | <paths…>] [--apply]`. Output is a human-readable summary of the `SyncReport` on stdout; exit code 1 if any action failed.

## 9. Execution, errors, audit

- **Lock:** `run` and `release` take `<name>.lock` (O_EXCL, contains pid + timestamp). A lock older than 1 hour whose pid is not alive is broken with a warning; otherwise a second run fails with `ValidationError("sync already running for <name>")`.
- **Order:** folder creations → uploads/updates → downloads/exports → conflicts → trash actions (deletions last, so a failure earlier never leaves data only in the trash).
- **Per-action isolation:** an action failure is recorded in `failures` with the mapped error message; its record is not updated (retried next run); the run continues. `ReauthRequiredError`, `QuotaExceededError`, `RateLimitError` (after retries) and `ApiDisabledError` abort the run (remaining actions reported as `not-run`).
- **Record persistence:** after every successful action the record file is rewritten atomically, so an interrupted run resumes correctly.
- **Retry:** reads `idempotent`; uploads `create`; content updates and trash `mutate` (no 5xx retry; hint to re-run).
- **Containment:** every local path is resolved with `realpath` and must stay inside `realpath(localDir)`; symlinked entries are ignored; downloads never overwrite a file that changed since planning (re-stat before rename; if changed → conflict on next run, reported).
- **Audit:** one JSONL entry per applied action — new `AuditOp` values `sync_upload`, `sync_update`, `sync_download`, `sync_conflict`, `sync_trash_remote`, `sync_trash_local`, `sync_release`; details `{ pair, path, remoteId }`. No file content.

## 10. Testing

- **Planner (pure):** one test per rule in §5 (1–15), conflict naming and collision suffixes, ignored entries, candidates, mass-delete threshold boundaries, remote-only behaviour, Google-native rules.
- **pair-store / paths / trash:** atomic write, 0600 mode, lock acquire/stale-break, path normalization and traversal rejection, symlink rejection, Trash naming collisions (temp HOME).
- **Scanners:** temp directories; fake Drive pages with nested folders, shortcuts, duplicates, trashed files.
- **Executor:** fake FileService/adapters; ordering; per-action failure isolation; abort-class errors; record persisted after each success (simulate crash mid-run and resume).
- **Service + MCP + CLI:** dry-run default, `apply`, release verification (md5 mismatch skip), tool schemas.
- **E2E (opt-in, live):** temp local folder + temp Drive folder: create pair → scan → select subset → run (dry, apply) → edit both sides → conflict → delete on each side → Google Doc in remote folder exported → release → run again (no re-download) → cleanup (permanent delete of the Drive temp folder, rm local temp; nothing left in Trash from the test except files it moved, which it restores/deletes).

## 11. Out of scope

- Continuous sync (`sync watch`), Drive Changes API, scheduled runs.
- GUI and Claude-API-based automatic classification (future: plugs into `sync_select`).
- Rule-based selection (globs, tags), rename detection, partial/byte-range transfer, resumable uploads (separate roadmap item), shared drives as pair targets, Windows/Linux trash.
