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

## Later
- ⬜ 4. Content processing (Docs/Sheets/PDF)
- ⬜ 5. Sync (local ↔ Drive)
- ⬜ Resumable upload for large files
- ⬜ OAuth app → production (GitHub Pages homepage + privacy policy)
