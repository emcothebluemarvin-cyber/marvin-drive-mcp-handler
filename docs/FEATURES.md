# Features

Status: ⬜ planned · 🟨 in progress · ✅ done

## MVP (spec: `docs/superpowers/specs/2026-11-03-drive-mcp-mvp-design.md`)

### 1. Core
- ✅ Config loading (`client_secret.json`, `accounts.json`)
- ✅ Keychain token store (+ in-memory for tests)
- ✅ OAuth loopback + PKCE login, multi-account
- ✅ Token refresh, `invalid_grant` → re-login message
- ✅ Audit log (JSONL)

### 2. File management
- ✅ list, search, get metadata
- ✅ download (+ Google-native export)
- ✅ upload (streaming multipart; resumable deferred)
- ✅ create folder, move, rename, copy
- ✅ delete (trash default / permanent), restore

### 3. MCP server
- ✅ stdio server, 12 tools, zod schemas
- ✅ CLI: `auth add/login/list/remove/default`, `serve`
- ✅ Claude Code registration docs

### 4. Content processing (spec: `docs/superpowers/specs/2026-11-03-content-processing-design.md`)
- ✅ Docs read / replace / insert / batch
- ✅ Sheets info / read / write / append / batch
- ✅ Slides read / replace / set text / batch
- ✅ Revision guards + conflict errors
- ✅ Disabled-API errors

### 5. Selective sync (spec: `docs/superpowers/specs/2026-11-03-selective-sync-design.md`, Phase B addendum `2026-11-07-sync-phase-b-addendum.md`)
- ✅ Pairs: create (existing or new Drive folder), list, remove; root marker + case-sensitivity probe; overlap check
- ✅ AI-assisted selection: `sync_scan` (previews, remote candidates) → `sync_select` (add/remove/exclude)
- ✅ Pure three-way planner (B1–B14, U0–U8), ambiguity/unknown-state protection, mass-delete brake, stable `planId`
- ✅ Executor: spec order, re-verification, exclusive local writes, conflict copies, Drive/OS trash, per-action persistence, audit
- ✅ MCP tools `sync_create_pair`, `sync_list_pairs`, `sync_scan`, `sync_select`, `sync_run`, `sync_release`, `sync_remove_pair`; CLI `sync list/run/release/repair-marker`
- ✅ Phase B: Google-native exports (N1–N9, `googleExport`, upgrade baseline), release / "move to Drive" (`sync_release`, O0–O8, R0, `releasable`)
- ✅ Confirmation before a local deletion trashes the Drive copy (`confirmRemoteTrash`, `pendingConfirmation`)
- ✅ Provider boundary for a later OneDrive provider: `remote-kinds`, `content-compare`, no runtime `googleapis` under `src/sync`

### 6. Cross-platform (desktop: macOS, Windows, Linux; mobile needs a separate remote MCP)
- ✅ File token store (`MARVIN_DRIVE_TOKEN_STORE=file`) for headless Linux / servers; keychain error hint
- ✅ `auth add --no-browser`: paste the redirect URL instead of an SSH tunnel
- ✅ Windows hardening: reserved/invalid sync names skipped + reported, `rename` retry on `EPERM`, README section
- ✅ GitHub Actions matrix: `ubuntu-latest` (Node 22, 24) + `windows-latest` (Node 24) on every PR; `macos-latest` on manual dispatch (hosted macOS runners kept timing out in the capacity queue)
- ✅ Local trash for sync deletions on Windows (Recycle Bin, `$I` record) and Linux/Unix (freedesktop.org trash); fails safely when no trash is usable (spec `2026-11-05-local-trash-design.md`)
- ⬜ Manual check on a real Windows machine: trashed file shows in the Recycle Bin and *Restore* works

### 7. Drive watch (spec: `docs/superpowers/specs/2026-11-07-drive-watch-design.md`)
- ✅ `drive_watch` add/remove/list (files and recursive folders, 200 per account), CLI `watch add|remove|list|delivery`
- ✅ Drive Changes API poll inside the MCP server: local tick, one poller per machine (lease + heartbeat), gap / paused / backoff handling
- ✅ Relevance rules (no-op drop, own edits stored not notified), 120 s / 600 s coalescing, Docs/Slides line diffs, Sheets cell diffs, new comments
- ✅ Shared inbox with read state; delivery by `UserPromptSubmit` hook (`changes --hook`) or Claude Code channel push
- ✅ Third-party text sanitized and marked untrusted; server instructions forbid acting on it
- ✅ Provider seam (`ChangeFeed`, `ContentSnapshotter`) for a later OneDrive provider; no runtime `googleapis` outside `src/watch/google`
- ⬜ Live E2E with two accounts (`MARVIN_E2E_EDITOR`): written, not run live yet
- ⬜ Comment-only changes polled separately if Drive does not report them (decided by the live E2E, plan Task 33)

## Later
- ⬜ Remote (HTTP) MCP server for claude.ai connectors / mobile (Drive + content tools; no local sync)
- ⬜ Sync watch mode (continuous sync)
- ⬜ GUI with Claude-API file classification for sync selection (plugs into `sync_select`; terminal use keeps Claude Code as the selector)
- ⬜ Resumable upload for large files
- ⬜ OAuth app → production (GitHub Pages homepage + privacy policy)
