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

### 5. Selective sync — Phase A (spec: `docs/superpowers/specs/2026-11-03-selective-sync-design.md`)
- ✅ Pairs: create (existing or new Drive folder), list, remove; root marker + case-sensitivity probe; overlap check
- ✅ AI-assisted selection: `sync_scan` (previews, remote candidates) → `sync_select` (add/remove/exclude)
- ✅ Pure three-way planner (B1–B14, U0–U8), ambiguity/unknown-state protection, mass-delete brake, stable `planId`
- ✅ Executor: spec order, re-verification, exclusive local writes, conflict copies, Drive/macOS trash, per-action persistence, audit
- ✅ MCP tools `sync_create_pair`, `sync_list_pairs`, `sync_scan`, `sync_select`, `sync_run`, `sync_remove_pair`; CLI `sync list/run/repair-marker`
- ⬜ Phase B: Google-native exports, release ("move to Drive"), `sync_release`

## Later
- ⬜ Sync watch mode (continuous sync)
- ⬜ GUI with Claude-API file classification for sync selection (plugs into `sync_select`; terminal use keeps Claude Code as the selector)
- ⬜ Resumable upload for large files
- ⬜ OAuth app → production (GitHub Pages homepage + privacy policy)
