# Marvin Drive — Sync Phase B Addendum

- **Date:** 2026-11-07
- **Status:** Approved in brainstorming; spec review approved (round 3, fixes applied)
- **Amends:** `2026-11-03-selective-sync-design.md` (the sync spec). Phase B is built from that spec's §6.6 (Google-native records), §6.7 (remote-only records), §10 (release) and §11 (Phase B tests), **plus the changes below**. Where this addendum and the sync spec disagree, this addendum wins. In particular it overrides the sync spec's §2 "New dependencies: `/usr/bin/trash`" and §13 "non-macOS trash" (local trash now works on all three desktop platforms).
- **Also uses:** `2026-11-05-local-trash-design.md` (`LocalTrash`, `createLocalTrash`).

## 1. Why an addendum

Phase B was designed on 2026-11-03. Since then: local trash works on macOS, Windows and Linux; a planned OneDrive provider means Google-specific code must stay in a few known places; and one safety gap was found — deleting a tracked file locally trashes its Drive copy, which surprises users who only wanted to free disk space.

## 2. Confirmation before a local deletion trashes the Drive copy

**Problem.** Rule B5 (R present-same and unchanged, L absent → `trash-remote`) reads a local deletion as "delete it everywhere". A user who deletes locally to free space loses the Drive copy too (recoverable from Drive trash for 30 days). `sync_release` is the right tool for "keep it in Drive only", but nothing points the user there.

**Change.**

1. **Action reason.** `Action` (types.ts) gains `reason?: 'local-deleted'`; B5's `trash-remote` sets it. B5 is the only `trash-remote` producer today. B5 with `!canTrash` produces the `cannot-trash` note and no action, so it is never pending. `computePlanId` does not include `reason` (the kind, id and md5s already identify the action).
2. **Flag.** `sync_run` gains `confirmRemoteTrash?: boolean` (default `false`); CLI `sync run <name> --confirm-remote-trash`.
3. **Report.** `SyncReport` gains `pendingConfirmation: Array<{ path: string; remoteId: string }>`.
   - Dry run without the flag: B5 actions are listed in `actions['trash-remote']` (what a confirmed apply would do) **and** in `pendingConfirmation`.
   - Dry run with the flag: listed in `actions['trash-remote']` only.
   - Applied run without the flag: B5 actions are not executed and appear only in `pendingConfirmation` — not in `actions`, `failures` or `notRun`. Their records and both sides stay untouched; the next run plans them again. All other actions run normally.
   - Applied run with the flag: executed like any `trash-remote`.
   - CLI: `pendingConfirmation` alone does not make the exit code 1; the human report prints it as its own section.
4. **Wording.** For each pending path the report offers both choices:
   - delete it in Drive too → on a dry run: run again with `confirmRemoteTrash: true` and this dry run's `planId`; on an unconfirmed applied run: do a new dry run, then confirm with its `planId` (§2.7);
   - keep it in Drive only → `sync_release` with those paths (rule R0, §3).
   Confirmation is all-or-nothing per run; to delete some and keep others, release the keepers first, then run with the flag. The `sync_run` tool description tells Claude to ask the user before passing `confirmRemoteTrash`, and to pass it together with the `planId` of the dry run the user saw, so a local deletion made after the user answered is never confirmed unseen.
5. **Not affected:** B10 (`trash-local` after a Drive deletion — the local trash keeps it), `sync_select remove` (touches no file), native records (never `trash-remote`).
6. **Brake.** The pure planner returns two brake results: `brake` (all planned deletions, as today) and `brakeUnconfirmed` (deletions without `reason: 'local-deleted'`). The service checks `brake` when the flag is set, else `brakeUnconfirmed`; `allowMassDelete` still overrides either. A dry run without the flag whose `brake` trips reports a warning `confirm-needs-mass-delete` ("confirming these deletions would also need allowMassDelete"), so the user learns it before confirming.
7. **planId.** The dry-run `planId` stays valid for an apply with `confirmRemoteTrash: true` (the flag does not change the plan). An unconfirmed apply executes the other actions, so the plan after it — and its `planId` — usually differs; the next confirmation needs a fresh dry run.

## 3. Release on every platform, and releasing an already-deleted file

1. **Local trash.** Release (sync spec §10) removes local copies through the injected `LocalTrash` instead of `/usr/bin/trash`. When no trash is usable for a path its release fails with the `LocalTrash` message; the file and record are untouched; the file is never unlinked.
2. **Rule R0 — release of a locally deleted file.** `sync_release` with explicit `paths` also accepts a tracked, non-remote-only record when:
   - L resolves to **absent** through sync spec §6.1 (not unknown-state, not ambiguous, not occupied by a non-regular file, no fold match on a case-insensitive volume), and
   - R is present-same and unchanged (binary: §6.4 B5 situation; native: modifiedTime unchanged — the N3 situation).
   Immediately before setting the flag, re-`lstat` the key (and on a case-insensitive volume its fold) to confirm L is still absent, and re-read R to confirm it is still present-same, unchanged and not trashed; a mismatch skips the path with a reason. R0 sets `remoteOnly` and touches no file; it removes no directories. The next run sees an O3 record instead of B5 (or N3). Reported as `released (already deleted locally)`; a dry-run release (`apply: false`) reports `would release (already deleted locally)`.
3. **`all: true`** releases only eligible present files (sync spec §10); R0 paths need to be named explicitly. They are already listed in `pendingConfirmation`, so Claude can pass them from there. The `releasable` list after an applied run stays as in the sync spec (present files only).

## 4. Keeping Google-specific code in known places

Prepares a later OneDrive provider without designing a provider interface now. The rules cover **Google-native document types and content comparison**; folder and shortcut MIME checks (`GOOGLE_MIME.folder` / `.shortcut`) stay where they are.

1. **`src/sync/remote-kinds.ts`** (new) is the only sync module that knows Google-native MIME types (`isGoogleNative`) or calls `resolveExport`:
   - `classifyRemote(file: DriveFile, prefs: GoogleExportPrefs): { kind: 'binary' } | { kind: 'native'; mimeType; exportFormat; exportMime; extension } | { kind: 'unsupported'; reason: 'native-unsupported' }`.
   - `exportKey(parentKey, remoteName, extension)`: the export's key via `ensureExtension`.
   - Consumers: **remote scanner** (classifies the raw `DriveFile` before building the entry; native entries get `key`/`foldKey` from `exportKey`, so U0b, U7 and duplicate detection compare the export names; unsupported → `ignored` with `native-unsupported`; the Phase A `native-skipped` reason is removed from `RemoteIgnoreReason` and `NoteCode` in types.ts, `WARNING_CODES` in report.ts and the note in planner.ts), **remote probe** (same classification, so a native file found by probe is `present` with its export key instead of today's `unknown('is no longer a regular file')`; this makes N6/N7 reachable), **planner** (dispatch by `entry.native`), **`select`** and **`googleExport` validation** in `createPair`.
   - `RemoteEntry` gains `native: null | { mimeType; exportFormat; exportMime }`. A record whose current R classifies as the other kind (native record, binary R, or binary record, native R) → `unknown-state` with reason `type-changed`, on the scan path and the probe path alike.
   - **Upgrade from Phase A.** Phase A skipped natives and never put them into `remoteBaseline`, so on the first Phase B run every native that appeared after the first applied run would be adopted by U6 and exported at once. To prevent that, `Pair` gains `nativeBaselineDone: boolean` (missing in an old pair file → `false`; new pairs → `false` until their first applied run). While it is `false`, every untracked, **unselected** native R is a U5 `candidate-remote` (this narrows U6 only; a selected native still gets U3 `export-new`, and U0b/U7 keep their meaning). An applied run that reaches execution while it is `false` adds the ids of all untracked natives it saw (deduped) to `remoteBaseline`, adds that run's unknown remote folder ids to `baselineFolders`, and sets it `true` — in the same atomic pair-file save as the sync spec §5 step 7 baseline. A dry run or an aborted apply (`plan-changed`, mass-delete brake) changes nothing. Schema: `nativeBaselineDone: z.boolean().default(false)`; the pair-file `version` stays 1. From then on natives follow U5/U6 like binary files. Documented in CHANGELOG and README.
2. **`src/sync/content-compare.ts`** (new) decides whether content changed, for planner rules and executor re-verification:
   - `remoteChanged(record, entry): { changed; weak }` — binary: md5, else size + `modifiedTime` with `weak`; native: `modifiedTime`. Replaces `remoteState` (resolve.ts) and the native check in plan-tracked.ts.
   - `remoteUnchangedSince(planned: RemoteEntry, current: DriveFile): boolean` — the executor's strict re-verification: binary requires md5 **and** `modifiedTime` equal (as today); native requires `modifiedTime` equal. It replaces only the content comparison in `Executor.verifyRemote` and `trashRemote`; their other checks stay in the executor unchanged (`verifyRemote` rejects `trashed`; `trashRemote` treats already-trashed as success and compares `parents[0]` with the planned parent).
   - `localMatchesRemote(localMd5, record: SyncRecord | null, entry): boolean` — binary: `localMd5 === entry.md5` (record unused, may be null: U2 and B4 adopt); native: `localMd5 === record.localMd5` (export md5; record required — untracked natives with a local file go to U0b, never here). Used by O0, O8, U2/B4 adopt and release eligibility.
   - `needsRefresh` (metadata refresh, not a content decision) stays in plan-tracked.ts.
3. **Exports go through existing `DriveAdapter` methods.** `exportMedia` and the `fetchExportLink` fallback (10 MB limit) already exist. The fallback logic in `FileService.openExport` moves to a shared helper `openExport(drive, file, plan, log)` in `src/files/export-stream.ts`, used by `FileService` and the sync executor. Sync therefore uses the `exportLinks` fallback too; only when that fails too does it report `native-too-large` (sync spec §6.6). `SYNC_FILE_FIELDS` stays as is. Instead `exec-export` re-reads the file with `SYNC_EXPORT_FIELDS` (`SYNC_FILE_FIELDS` + `exportLinks, webViewLink`) immediately before each export; that read doubles as re-verification (`remoteUnchangedSince`; changed or trashed → skip, reported). For N5 the re-read comes **before** moving the local edit aside, so a skipped export leaves L where it is.
4. **No `googleapis` under `src/sync/`.** A unit test fails if any file there imports `googleapis` at runtime. Type-only imports of `DriveFile` (re-exported from `src/drive/drive-adapter.ts`) are allowed.

## 5. File split (first step)

Before any Phase B logic, split the two largest sync files along provider-neutral lines. `sync-service.ts` keeps the same exports for MCP and CLI callers.

| Today | After |
|---|---|
| `executor.ts` (713 lines) | `executor.ts` — ordering, dispatch, persistence, audit, isolation; `exec-records.ts` — `makeRecord`, `fromEntry`, `fromDrive`, `applySelection`, `putRecord`, `dropRecord`, `conflictName`; `remote-folders.ts` — `ensureFolders`, `folderFor`, `ensureRemoteFolder`; Phase B adds `exec-export.ts` (`export-new`, `export-replace`, local-edit copy) |
| `sync-service.ts` (596 lines) | `pair-admin.ts` — create/list/remove pair, repair marker, root checks; `scan-select.ts` — scan, previews, select; `sync-service.ts` — run and the `SyncService` facade; Phase B adds `release.ts` |

Commit 1 is a pure move: all 616 tests pass with at most import changes. Commit 2, separately: `sync_scan` scans the local tree once instead of twice (deferred from Phase A; same output).

## 6. Tests (in addition to sync spec §11 Phase B)

- Planner: one test per N1–N9, O0–O8; B5 action carries `reason: 'local-deleted'`; `brake` vs `brakeUnconfirmed`; native record whose R became binary → `unknown-state`.
- B5 lifecycle: unconfirmed apply leaves B5 pending (record and both sides untouched, only in `pendingConfirmation`) while other actions run; confirmed apply trashes in Drive; a pending B5 whose R then changes becomes B6 (recreate); a pending B5 whose L reappears becomes B1/B2; dry run warns `confirm-needs-mass-delete`; dry-run `planId` accepted by a confirmed apply.
- R0: sets `remoteOnly`, touches no file, next run plans nothing; refused under an unknown local subtree, on a fold-only match, when R changed or is trashed, and when L reappears before the flag is set.
- Release uses the injected `LocalTrash`; a failing trash keeps the file and the record.
- Upgrade: an old pair file without `nativeBaselineDone` loads as `false`; its untracked natives are candidates (not exported) on the first Phase B run and baseline after it; a native added after that run is adopted (U6); a native selected during the upgrade window is exported (U3) on the first Phase B run; a dry run or an aborted apply (brake, `plan-changed`) leaves `nativeBaselineDone` `false`. Binary record whose R became native → `unknown-state` `type-changed`.
- Executor: `remoteUnchangedSince` keeps md5 + `modifiedTime` strictness; `exec-export` re-read skips a changed or trashed file.
- Scanner/probe: native entry keyed by export name; native found only by probe → present-moved (N6); unsupported native → `native-unsupported`.
- `remote-kinds`, `content-compare`, `export-stream` unit tests; the "no runtime `googleapis` import under `src/sync`" test.
- Live E2E (Phase B): Google Doc export → release → next run does not re-export → `select add` restores; local deletion unconfirmed → pending, confirmed → Drive trash; R0 on a deleted file.

## 7. Order of work

1. File split (§5): commit 1 pure move, commit 2 single local scan.
2. `remote-kinds`, `content-compare`, `export-stream`, `RemoteEntry.native`, scanner/probe classification, `googleExport` validation.
3. Native rules N1–N9 and export actions.
4. Remote-only rules O0–O8, `sync_release` (incl. R0), MCP tool and CLI.
5. B5 confirmation (§2).
6. Report wording, README, CHANGELOG, FEATURES; live E2E.

Each step is a local commit; push waits until the GitHub account is restored.

## 8. Implementation notes

- **N5 moves, not copies.** The local edit is moved aside with the exclusive `moveLocal` (sync spec §6.6 N5 said `place-exclusive`). The export stream is opened first, so an export that cannot be obtained leaves the edit at its key; any failure after the move reports the kept name (`conflictCopy`, warning `native-local-edit-kept`).
