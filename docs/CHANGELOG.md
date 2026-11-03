# Changelog

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
