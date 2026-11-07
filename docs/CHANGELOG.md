# Changelog

## Unreleased

### Added
- Sync Phase B: Google Docs/Sheets/Slides/Drawings sync as read-only exports (rules N1–N9), with per-pair `googleExport` formats (validated at `sync_create_pair`), the 10 MB `exportLinks` fallback and `native-too-large` reporting.
- `sync_release` / `marvin-drive sync release`: keep files in Drive only; local copies go to the OS trash after re-verification; `sync_select add` restores them (rules O0–O8). Locally deleted files can be released by name (R0). Applied runs list `releasable` files.
- `sync_run` `confirmRemoteTrash` / `--confirm-remote-trash` and the report field `pendingConfirmation`.
- CLI: `sync list` shows the remote-only count; applied run reports print a releasable hint.
- Two-step login without a waiting terminal: `auth add|login --print-url` prints the Google URL and exits; `--redirect-url '<url>'` finishes it within 10 minutes (works from Claude Code's `!` prompt).
- MIT license; the repository is public.
- File token store for hosts without an OS credential store (headless Linux servers): `MARVIN_DRIVE_TOKEN_STORE=file` keeps refresh tokens in `~/.config/google-handler/tokens.json` (`0600`, directory `0700`).
- `auth add --no-browser` / `auth login <alias> --no-browser`: sign in from a server by pasting the redirect URL; the loopback callback (SSH tunnel) keeps working in parallel. No-browser logins wait up to 10 minutes.
- Sync deletions of local files work on Windows (Recycle Bin) and Linux/other Unix (freedesktop.org trash), without new dependencies. The file is moved with one rename after its trash record is reserved; when no trash can be used with certainty the action fails and the file stays.

### Changed
- Sync: deleting a tracked file locally no longer trashes its Drive copy automatically; it waits in `pendingConfirmation` until confirmed (`confirm-needs-mass-delete` warns when the confirmed run would also need `allowMassDelete`).
- Sync: Google files are no longer reported `native-skipped`; unsupported Google types are reported `native-unsupported`. Pair files gain `nativeBaselineDone` (old files load as `false`): the first applied run after the upgrade baselines existing Google files as candidates instead of exporting them.
- `sync_scan` reads the local folder once instead of twice.
- Sync skips and reports Drive names Windows cannot store (reserved device names, `< > : " \ | ? *`, trailing dot or space) when running on Windows; `sync_select` paths are validated the same way.
- Saves that replace an existing file (accounts, tokens, sync pairs, markers, sync downloads) retry briefly on Windows when the target is locked (`EPERM`/`EACCES`/`EBUSY`).
- Directory fsync is skipped on Windows.
- CI also runs on Windows; macOS on manual dispatch.

### Fixed
- `package-lock.json` records the MIT license, so `npm install` no longer rewrites it.
- Sync: a local file that vanished while being moved to the trash is reported as "already gone" instead of an unclassified failure.
- Windows: a `drive_download` destination ending in `\` is treated as a folder (it used to become a file of that name); `~\` expands to the home folder.
- Windows: symlink tests no longer fail for ordinary users (directory links use junctions; file-symlink tests are skipped without Developer Mode).
- Windows: a tracked path whose parent folder had been replaced by a file was probed as absent (Windows reports `ENOENT`, not `ENOTDIR`), so sync could treat it as locally deleted; it is now reported as unknown, as on macOS/Linux.
- OS credential store failures now raise a clear `CONFIG_ERROR` that points to the file store instead of a raw keyring error.

## 0.3.0 — 2026-11-03

### Added
- Selective two-way sync between a local folder and a Drive folder (Phase A, binary files): six MCP tools (`sync_create_pair`, `sync_list_pairs`, `sync_scan`, `sync_select`, `sync_run`, `sync_remove_pair`) and CLI `marvin-drive sync list | run | repair-marker`.
- Claude-assisted file selection with text previews and Drive-side candidates.
- Dry run by default; apply bound to the approved `planId`; conflicts keep both versions; deletions go to the Drive trash or macOS Trash; mass-delete brake; root-marker and case-sensitivity checks.
- `DriveAdapter.updateFile` accepts new media (content update of the same file id).

## 0.2.0 — 2026-11-03

### Added
- Content processing: 13 tools to read and edit Google Docs, Sheets and Slides in place (`docs_*`, `sheets_*`, `slides_*`), including advanced `*_batch_update` passthroughs.
- Revision-guarded edits for Docs and Slides with clear conflict errors; implicit guards for read-then-write tools.
- Clear errors when a Google API is not enabled for the OAuth project.

### Fixed
- `drive_upload` / `drive_copy` no longer report Drive's placeholder size for freshly created Google files.

## 0.1.0 — 2026-11-03

### Added
- Multi-account Google OAuth (loopback + PKCE) with Keychain token storage and automatic recovery after re-login.
- File operations: list, search, metadata, download/export, upload, create folder, move, rename, copy, delete (trash/permanent), restore.
- MCP server with 12 tools; `marvin-drive` CLI for account management.
- JSONL audit log for all mutating operations.
