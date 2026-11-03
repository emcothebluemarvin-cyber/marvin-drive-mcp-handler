# Changelog

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
