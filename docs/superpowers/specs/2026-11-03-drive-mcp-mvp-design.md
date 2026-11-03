# Marvin Drive MCP Handler — MVP Design

- **Date:** 2026-11-03
- **Status:** Approved in brainstorming, pending spec review
- **Scope:** Sub-projects 1–3 of 5 (Core + File management + MCP server)

## 1. Goal

Let Claude Code operate on one or more Google Drive accounts (first: `emcothebluemarvin@gmail.com`) through a local MCP server that uses our own Google OAuth client, independent of the claude.ai Drive connector.

## 2. Roadmap context

| # | Sub-project | In this spec |
|---|---|---|
| 1 | Core: multi-account OAuth, token storage, Drive client | ✅ |
| 2 | File management: list / search / download / upload / move / rename / copy / delete / restore | ✅ |
| 3 | MCP server exposing #2 as tools | ✅ |
| 4 | Content processing (Docs/Sheets/PDF analysis) | ❌ later spec |
| 5 | Sync (local folder ↔ Drive) | ❌ later spec |

## 3. Decisions

| Topic | Decision |
|---|---|
| Language / runtime | TypeScript (strict), Node.js 22 LTS |
| Libraries | `@modelcontextprotocol/sdk`, `googleapis`, `zod`; Keychain access via a maintained native binding (e.g. `@napi-rs/keyring`), chosen at plan time |
| MCP transport | stdio (Claude Code spawns `marvin-drive serve`) |
| Architecture | Layered (single user, no DB, one integration) |
| Accounts | Multi-account from day one; each tool takes an optional `account` (alias or email) |
| Permissions | All operations allowed without confirmation (user choice). Safety defaults: delete → trash unless `permanent: true`; every mutating call written to an audit log |
| OAuth scope | `https://www.googleapis.com/auth/drive` + `openid email` |
| OAuth app state | **Testing** mode. Refresh tokens expire after 7 days → app must handle `invalid_grant` with a clear re-login message. Move to production after MVP (GitHub Pages homepage + privacy policy) |

## 4. File locations

| Path | Content | Permissions |
|---|---|---|
| `~/.config/google-handler/client_secret.json` | OAuth Desktop client (Google "installed" JSON format) | `600`, dir `700` |
| `~/.config/google-handler/accounts.json` | `{ default, accounts: [{ alias, email, addedAt }] }` — no secrets | `600` |
| `~/.config/google-handler/audit.jsonl` | One JSON line per mutating operation | `600` |
| macOS Keychain, service `marvin-drive`, account = email | Refresh token | Keychain-managed |
| `~/Downloads/marvin-drive/` | Default download destination | — |

Config directory overridable via `MARVIN_DRIVE_CONFIG_DIR` (used by tests).

## 5. Architecture

```
CLI (marvin-drive)      MCP Server (stdio)        ← thin entry points: validate (zod) + delegate
        └──────────┬──────────┘
                   ▼
              FileService                         ← all business logic
                   ▼
           DriveClientFactory ──▶ AuditLog
                   ▼
              AuthService ──▶ TokenStore (Keychain | InMemory)
                   ▼
                 Config
```

| Module | Responsibility | Depends on |
|---|---|---|
| `config` | Resolve paths, load/validate `client_secret.json`, read/write `accounts.json` | — |
| `auth/token-store` | `TokenStore` interface: `get/set/delete(email)`. Implementations: `KeychainTokenStore`, `InMemoryTokenStore` | — |
| `auth/auth-service` | Loopback + PKCE login, token refresh, `invalid_grant` → `ReauthRequiredError`, account resolution (alias/email/default) | config, token-store |
| `drive/client-factory` | Returns an authorized `drive_v3.Drive` per account; caches per process | auth-service |
| `files/file-service` | Operations in §6; export mapping, pagination, error mapping, retry | client-factory, audit |
| `audit` | Append-only JSONL: `{ ts, account, op, fileId, name?, details }` | config |
| `cli` | `auth add/login/list/remove/default`, `serve` | auth-service, mcp |
| `mcp` | Tool registration, zod schemas, error → MCP error text | file-service, auth-service |

## 6. MCP tools

All tools accept `account?: string`. If omitted, the default account is used; if no default and >1 account, return an error listing accounts.

| Tool | Input | Behavior |
|---|---|---|
| `drive_list_accounts` | — | Aliases, emails, default, token status (`ok` / `reauth_required`) |
| `drive_list` | `folderId?` (default `root`), `pageSize?` (default 50, max 200), `pageToken?`, `includeTrashed?` (default false) | Files with id, name, mimeType, size, modifiedTime, parents; returns `nextPageToken` |
| `drive_search` | `query?`, `mimeType?`, `modifiedAfter?` (ISO date), `rawQuery?`, `pageSize?`, `pageToken?` | `query` → `(name contains 'q' or fullText contains 'q')`, values escaped; `rawQuery` passed through verbatim (combined with AND). Excludes trashed unless `rawQuery` says otherwise |
| `drive_get_metadata` | `fileId` | Full metadata incl. owners, webViewLink, trashed |
| `drive_download` | `fileId`, `destPath?`, `exportFormat?` | Binary files: `files.get alt=media`. Google-native: `files.export` — defaults Docs→docx, Sheets→xlsx, Slides→pptx, Drawings→png; allowed overrides `pdf`, `md` (Docs), `csv` (Sheets, first sheet), `txt`. Writes file, returns absolute path + size. Never overwrites silently: appends ` (1)` etc. |
| `drive_upload` | `localPath`, `parentId?`, `name?`, `convertToGoogle?` (default false) | Resumable upload for files > 5 MB; returns new file metadata |
| `drive_create_folder` | `name`, `parentId?` | Returns folder metadata |
| `drive_move` | `fileId`, `newParentId` | Replaces all current parents with `newParentId` |
| `drive_rename` | `fileId`, `newName` | |
| `drive_copy` | `fileId`, `parentId?`, `name?` | |
| `drive_delete` | `fileId`, `permanent?` (default false) | false → `trashed: true`; true → `files.delete` |
| `drive_restore` | `fileId` | `trashed: false` |

All mutating tools (`upload`, `create_folder`, `move`, `rename`, `copy`, `delete`, `restore`) write an audit entry after success.

## 7. CLI

```
marvin-drive auth add [--alias <alias>]   # browser login, register account; first account becomes default
marvin-drive auth login <alias|email>     # re-login an existing account (expired token)
marvin-drive auth list
marvin-drive auth remove <alias|email>    # removes registry entry + Keychain token, revokes token at Google (best effort)
marvin-drive auth default <alias|email>
marvin-drive serve                        # MCP stdio server
```

Alias defaults to the local part of the email. Aliases are unique, `[a-z0-9-]{1,32}`.

## 8. Auth flow

1. Start HTTP server on `127.0.0.1:<random port>`.
2. Open browser to Google auth URL with `code_challenge` (S256), random `state`, `access_type=offline`, `prompt=consent`, scopes from §3, redirect `http://127.0.0.1:<port>`.
3. On callback: verify `state`, exchange code (+ `code_verifier`) for tokens.
4. Read email from `id_token`. If email already registered under another alias → error.
5. Store refresh token in TokenStore; upsert `accounts.json`.
6. Respond with a minimal "you can close this tab" page; shut server down. Timeout 120 s.

Runtime: access tokens kept in memory only; refreshed by `googleapis` OAuth2 client; if Google returns a new refresh token it is persisted. `invalid_grant` → `ReauthRequiredError(alias)`.

## 9. Error handling

| Error | Trigger | Message to MCP client |
|---|---|---|
| `ReauthRequiredError` | `invalid_grant`, missing token | "Session for `<alias>` expired. Run: `marvin-drive auth login <alias>`" |
| `AccountNotFoundError` | Unknown alias / ambiguous default | Lists registered accounts |
| `NotFoundError` | HTTP 404 | "File not found: `<id>`" |
| `PermissionDeniedError` | HTTP 403 (non rate-limit) | "No permission for `<id>`" |
| `RateLimitError` | 429, 403 `rateLimitExceeded`/`userRateLimitExceeded` | Retried 3× with exponential backoff + jitter, then surfaced |
| `ValidationError` | zod failure, bad local path | Field-level message |
| `DriveApiError` | Other 4xx/5xx (5xx retried like rate limit) | Short safe message; details to stderr |

Rules: stdout is reserved for MCP protocol — all logs go to stderr. Tokens, secrets, and auth codes are never logged; logger redacts known keys.

## 10. Testing

- **Unit (Vitest):** FileService with a fake Drive client + `InMemoryTokenStore`; covers query building/escaping, export mapping, pagination, error mapping, retry, delete default, download name collision, account resolution.
- **Integration:** MCP server over SDK in-memory transport; verifies tool list, schemas, happy paths with the fake client, error texts.
- **Auth:** loopback flow with a mocked token endpoint (state mismatch, timeout, duplicate email).
- **E2E (manual, opt-in):** `MARVIN_E2E_ACCOUNT=<alias>` runs create-folder → upload → move → rename → download → delete → restore → permanent delete inside a temp folder, then cleans up. Not run in CI.

Quality gates: `tsc --noEmit` (strict, per global config), ESLint + Prettier, Vitest — all green before each step proceeds.

## 11. Out of scope (MVP)

Sharing/permissions, Shared Drives, revisions, file watching/sync, content analysis, CLI file commands, Windows/Linux credential stores (interface allows adding later).

## 12. Open items for later specs

- Production publishing of the OAuth app (Branding homepage/privacy policy via GitHub Pages).
- Sub-projects 4 (content) and 5 (sync).
