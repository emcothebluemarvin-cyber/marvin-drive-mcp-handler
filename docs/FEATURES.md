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

## Later
- ⬜ 5. Sync (local ↔ Drive)
- ⬜ Resumable upload for large files
- ⬜ OAuth app → production (GitHub Pages homepage + privacy policy)
