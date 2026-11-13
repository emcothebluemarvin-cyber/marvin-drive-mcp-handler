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
- ✅ Comment-only changes: the two-account live E2E showed Drive reports them through the Changes API and they pass the no-op rule, so no separate comment polling is needed (plan Task 33 skipped)

### 8. OneDrive sign-in and file operations (spec: `docs/superpowers/specs/2026-11-08-onedrive-files-design.md`)
- ✅ Microsoft PKCE login (`auth add --provider microsoft`), personal and work/school accounts, two-step login, token rotation
- ✅ `FileRouter` picks Google or OneDrive from the account; the `drive_*` tools are unchanged
- ✅ GraphClient: token only to graph.microsoft.com, retry rules, resumable upload sessions, copy monitor
- ✅ `drive_upload` name conflicts ask Overwrite / Cancel through MCP elicitation; rename, move and copy conflicts are errors
- ✅ Microsoft accounts are rejected on the Google-only tools (content, watch); sync supports them since sub-project 2 (section 9)
- ✅ Live E2E (`MARVIN_E2E_MS_PERSONAL`, `MARVIN_E2E_MS_WORK`), 2026-11-11: personal passed on two personal accounts. Work/school: not live-tested (no work account signed in yet)
- ✅ Overwrite / Cancel dialog in Claude Code, 2026-11-11: Overwrite answered after about 5 min succeeded with the new content; Cancel returned `cancelled: true`, reason `user`, file unchanged
- Search: new items on personal OneDrive stayed out of the search index for over 30 minutes; the E2E checks search with an item that existed before the run

Spec §10 results:

| §10 point | Personal | Work |
|---|---|---|
| Entra accepts any port for a registered `http://localhost` | confirmed | not live-tested |
| `PATCH` rename and move return 409 on a name conflict | not live-tested (the §5.1 preflight stops first) | not live-tested |
| `copy` without a conflict parameter fails on a name conflict | confirmed | not live-tested |
| `PUT` of an empty file honours `conflictBehavior=fail` | not live-tested (needs a hand-made race) | not live-tested |
| `If-Match` is honoured on `createUploadSession` and on `PUT items/{id}/content` | confirmed | not live-tested |
| `@odata.nextLink` has one of the two path shapes of §7.1 | confirmed | not live-tested |
| A work account in another tenant can consent to an unverified app | n/a | not live-tested |
| `elicitInput` works on the protocol revision Claude Code negotiates | confirmed | n/a (same client) |

### 9. OneDrive selective sync (spec: `docs/superpowers/specs/2026-11-11-onedrive-sync-design.md`)
- ✅ `SyncRemote` port with Google and OneDrive implementations; the engine has no Drive or Graph shapes
- ✅ QuickXorHash digests, pair file v2 (`remoteHash`, deletion cursor and evidence) with v1 migration
- ✅ Deletions only with root `delta` evidence; `remote-unavailable` without it; `deletion-history-unavailable` for an expired or unusable cursor
- ✅ `If-Match` on replace and delete; 409 / 412 / 423 skipped, 507 stops the run
- ✅ OneDrive name rules (`remote-name-invalid`, 255 units per name, 400 per path), ignored OneNote / special / shared items, provider words in reports
- ✅ Cloud desktop folder guard for both providers (create, repair-marker, list warning, runs refused)
- ✅ Live OneDrive sync E2E (`tests/e2e/onedrive-sync.e2e.test.ts`, `MARVIN_E2E_MS_PERSONAL`, optional `MARVIN_E2E_MS_SECOND`): passed 2026-11-11 on two personal accounts; Google sync E2E re-run and passed on the same build
- ⬜ Work/school accounts: supported by the code, not live-tested
- Known limitation: the pair file does not store the provider (it follows the account alias)

## Later
- ⬜ OneDrive: change watching (Graph `delta`), Office content editing, files shared with the user, SharePoint and Teams libraries
- ⬜ Remote (HTTP) MCP server for claude.ai connectors / mobile (Drive + content tools; no local sync)
- ⬜ Sync watch mode (continuous sync)
- ⬜ GUI with Claude-API file classification for sync selection (plugs into `sync_select`; terminal use keeps Claude Code as the selector)
- ⬜ Resumable upload for large files
- ⬜ OAuth app → production (GitHub Pages homepage + privacy policy)
