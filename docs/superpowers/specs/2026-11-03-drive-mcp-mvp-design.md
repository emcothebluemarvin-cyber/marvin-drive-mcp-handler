# Marvin Drive MCP Handler — MVP Design

- **Date:** 2026-11-03
- **Status:** Approved in brainstorming; spec review approved (round 3)
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
| `drive/client-factory` | Returns an authorized `drive_v3.Drive` per account; caches per account keyed by refresh token (see §8 "Long-running server") | auth-service |
| `files/file-service` | Operations in §6; export mapping, pagination, error mapping, retry | client-factory, audit |
| `audit` | Append-only JSONL: `{ ts, account, op, fileId, name?, details }`. `details` per op — upload: `{ localPath, parentId, size, converted }`; create_folder: `{ parentId }`; move: `{ oldParents, newParentId }`; rename: `{ oldName, newName }`; copy: `{ sourceId, parentId }`; delete: `{ permanent }`; restore: `{}` | config |
| `cli` | `auth add/login/list/remove/default`, `serve` | auth-service, mcp |
| `mcp` | Tool registration, zod schemas, error → MCP error text | file-service, auth-service |

## 6. MCP tools

All tools accept `account?: string`. If omitted, the default account is used; if no default and >1 account, return an error listing accounts.

General rules:
- Every Drive API call sets `supportsAllDrives: true` (and `includeItemsFromAllDrives: true` on list/search) so items shared from Shared Drives resolve, even though Shared Drive management is out of scope.
- Errors are returned as tool results with `isError: true` and a text message — never as JSON-RPC protocol errors.
- Standard file fields (`FILE_FIELDS`): `id, name, mimeType, size, createdTime, modifiedTime, parents, owners(emailAddress,displayName), webViewLink, trashed, shortcutDetails`. `drive_list`/`drive_search` return `id, name, mimeType, size, modifiedTime, parents`.

| Tool | Input | Behavior |
|---|---|---|
| `drive_list_accounts` | `verify?` (default false) | Aliases, emails, default, token status. `verify=false`: `ok` if a refresh token exists and no `ReauthRequiredError` was observed in this process, else `reauth_required`. `verify=true`: performs a live token refresh per account for an accurate status |
| `drive_list` | `folderId?` (default `root`), `pageSize?` (default 50, max 200), `pageToken?`, `includeTrashed?` (default false) | Query `'<folderId>' in parents` (`folderId` escaped like search values) (+ `and trashed = false` unless `includeTrashed`); returns items + `nextPageToken` |
| `drive_search` | `query?`, `mimeType?`, `modifiedAfter?` (ISO date), `rawQuery?`, `pageSize?` (default 50, max 200), `pageToken?` | At least one of `query`/`mimeType`/`modifiedAfter`/`rawQuery` required. Clauses AND-ed: `query` → `(name contains 'q' or fullText contains 'q')`; `mimeType` → `mimeType = 'm'`; `modifiedAfter` → `modifiedTime > 'iso'`; `rawQuery` → `(raw)` verbatim. String values escaped: `\` → `\\` first, then `'` → `\'`. `trashed = false` is appended unless `rawQuery` matches `/\btrashed\b/i` |
| `drive_get_metadata` | `fileId` | `FILE_FIELDS` |
| `drive_download` | `fileId`, `destPath?`, `exportFormat?` | See "Download rules" below. Returns absolute path, size, source mimeType, export format used |
| `drive_upload` | `localPath`, `parentId?` (default root), `name?` (default basename), `convertToGoogle?` (default false) | MIME type from file extension (`mime-types`), fallback `application/octet-stream`. `convertToGoogle` mapping: doc/docx/odt/rtf/txt/html/md → Doc; xls/xlsx/ods/csv/tsv → Sheet; ppt/pptx/odp → Slides; other types with `convertToGoogle=true` → `ValidationError`. Multipart for ≤ 5 MB, resumable above. Missing/unreadable/directory `localPath` → `ValidationError` |
| `drive_create_folder` | `name`, `parentId?` (default root) | mimeType `application/vnd.google-apps.folder`; returns folder metadata |
| `drive_move` | `fileId`, `newParentId` | 1) `files.get fields=parents`; 2) `files.update addParents=newParentId, removeParents=<all old parents except newParentId>`. No-op if already only in `newParentId` |
| `drive_rename` | `fileId`, `newName` | `files.update { name }` |
| `drive_copy` | `fileId`, `parentId?`, `name?` | `files.copy`; folders → `ValidationError` (Drive cannot copy folders) |
| `drive_delete` | `fileId`, `permanent?` (default false) | false → `files.update { trashed: true }`; true → fetch `name` first (for audit), then `files.delete` |
| `drive_restore` | `fileId` | `files.update { trashed: false }` |

**Download rules (`drive_download`):**
1. Fetch metadata. Shortcuts → resolve to `shortcutDetails.targetId` and download the target.
2. Folders, Forms, Sites, Maps, and other non-exportable `application/vnd.google-apps.*` types → `UnsupportedTypeError` naming the type.
3. Binary files → `files.get alt=media`, streamed to disk.
4. Google-native → `files.export`. Defaults: Docs→`docx`, Sheets→`xlsx`, Slides→`pptx`, Drawings→`png`. Allowed `exportFormat` per type — Docs: `docx, pdf, md, txt, odt, html`; Sheets: `xlsx, pdf, csv` (first sheet only), `ods`; Slides: `pptx, pdf, txt, odp`; Drawings: `png, pdf, svg, jpg`. Disallowed combo → `ValidationError` listing allowed formats. `exportFormat` on a binary file → `ValidationError`.
5. Export size limit (10 MB, Drive reason `exportSizeLimitExceeded`): retry once by GET-ing the file's `exportLinks[<mime>]` with the account's bearer token; if that fails → `ExportTooLargeError` suggesting `pdf` or opening `webViewLink`.
6. Destination: if `destPath` is omitted → `~/Downloads/marvin-drive/<name>`. If `destPath` is an existing directory or ends with `/` → `<destPath>/<name>`. Otherwise `destPath` is the full file path, used as-is. `<name>` is the **sanitized** Drive name plus the export extension when exporting and the name doesn't already end with it.
   - **Sanitization (Drive names are untrusted):** replace `/`, `\`, NUL and other control characters with `_`; strip leading dots and surrounding whitespace; names that become empty, `.` or `..` → `file-<fileId>`. The 255-byte limit is applied to the **final** name (after export extension and collision suffix), truncating the base and preserving extension + suffix.
   - **Containment check:** when `<name>` is joined to a directory, `path.resolve(target)` must stay inside `path.resolve(dir)`; otherwise → `ValidationError`. A caller-supplied full-file `destPath` is used as given (it's the caller's explicit choice), but is resolved to an absolute path. Missing parent directories are created. If the target exists, append ` (1)`, ` (2)`, … before the extension; never overwrite.
7. Resolve the final (non-colliding) target first, then create `<target>.part` with flag `wx` (fails if it exists → pick the next collision suffix); rename to `<target>` on success, delete the partial file on failure.

**Audit:** All mutating tools (`upload`, `create_folder`, `move`, `rename`, `copy`, `delete`, `restore`) append an audit entry after success. If the audit write fails, log a warning to stderr and still return success (the Drive operation already happened).

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

Prerequisites (checked before opening the browser):
- `client_secret.json` missing or invalid → exit with a message naming the expected path and the required format (Google "installed" Desktop client JSON).
- Printed hint: while the OAuth app is in Testing mode, the account must be listed under *Audience → Test users*, otherwise Google rejects the login.

Steps:
1. Start HTTP server on `127.0.0.1:<random port>`.
2. Open browser to Google auth URL with `code_challenge` (S256), random `state`, `access_type=offline`, `prompt=consent`, scopes from §3, redirect `http://127.0.0.1:<port>`. For `auth login <alias>`, also pass `login_hint=<email>`. The URL is printed too, in case the browser doesn't open.
3. On callback: verify `state` (mismatch → reject), handle `error=access_denied`, exchange code (+ `code_verifier`) for tokens.
4. Verify the `id_token` with `OAuth2Client.verifyIdToken` (audience = our client_id) and read `email` (`email_verified` must be true).
5. Account checks:
   - `auth add`: email already registered → error ("already registered as `<alias>`; use `auth login`"); alias taken → error.
   - `auth login <alias>`: email must equal the registered email for that alias; mismatch → error, nothing stored.
   - No refresh token returned → error (should not happen with `prompt=consent`).
6. Store refresh token in TokenStore; upsert `accounts.json` (first account becomes default).
7. Respond with a minimal "you can close this tab" page; shut server down. Timeout 120 s → error.

Runtime: access tokens kept in memory only; refreshed by the `googleapis` OAuth2 client; if Google returns a new refresh token it is persisted. `invalid_grant` → `ReauthRequiredError(alias)`.

**Long-running server (`serve`) and stale state:**
- `accounts.json` is re-read on every tool call when its mtime changed (cheap stat).
- The client cache is keyed by `(email, refreshToken)`. On `invalid_grant`, the server re-reads the token from Keychain once; if it differs (the user ran `auth login` in another shell), it rebuilds the client and retries the call once. Otherwise → `ReauthRequiredError`. So no server restart is needed after re-login.

## 9. Error handling

| Error | Trigger | Message to MCP client |
|---|---|---|
| `ReauthRequiredError` | `invalid_grant`, missing token | "Session for `<alias>` expired. Run: `marvin-drive auth login <alias>`" |
| `AccountNotFoundError` | Unknown alias / ambiguous default | Lists registered accounts |
| `NotFoundError` | HTTP 404 | "File not found: `<id>`" |
| `RateLimitError` | 429, 403 reason `rateLimitExceeded`/`userRateLimitExceeded` | Retried (see retry policy), then surfaced |
| `ExportTooLargeError` | 403 reason `exportSizeLimitExceeded` after `exportLinks` fallback | "Export exceeds Drive's 10 MB limit; try `pdf` or open `<webViewLink>`" |
| `QuotaExceededError` | 403 reason `storageQuotaExceeded` | "Drive storage is full for `<alias>`" |
| `AbusiveFileError` | 403 reason `cannotDownloadAbusiveFile` | "Google flagged this file; download blocked" |
| `PermissionDeniedError` | HTTP 403 with any other reason (e.g. `insufficientFilePermissions`, `forbidden`) | "No permission for `<id>`" |
| `UnsupportedTypeError` | Download of a non-exportable Google type | Names the type |
| `ValidationError` | zod failure, bad local path, invalid format combo | Field-level message |
| `DriveApiError` | Other 4xx/5xx | Short safe message; details to stderr |

403s are classified by `errors[0].reason` from the Drive error body, not by status code alone.

**Retry policy:** exponential backoff with jitter, max 3 retries.
- Idempotent operations (`list`, `search`, `get_metadata`, `download`, `move`, `rename`, `delete`, `restore`, token refresh): retry on rate-limit errors and 5xx.
- Non-idempotent creates (`upload`, `create_folder`, `copy`): retry **only** on rate-limit errors (the request was rejected, not processed). A 5xx is surfaced immediately with a hint to check for a duplicate. MVP does not resume interrupted resumable uploads; a failed upload is surfaced and can be re-run by the caller.
- Retry-after-success guards: a 404 on a retry of `delete permanent` counts as success; `move` re-reads `parents` before each retry and recomputes `removeParents` (no-op if already done).

Rules: stdout is reserved for MCP protocol — all logs go to stderr. Tokens, secrets, and auth codes are never logged; logger redacts known keys.

## 10. Testing

- **Unit (Vitest):** FileService with a fake Drive client + `InMemoryTokenStore`; covers query building/escaping, trashed-clause detection, export format matrix, shortcut resolution, unsupported types, export-size fallback, destination path rules + name collision + `.part` cleanup, filename sanitization + path-traversal containment (e.g. Drive name `../../.zshrc`), retry-after-success guards, upload MIME/convert mapping, move parent computation, pagination, 403 reason mapping, retry policy (idempotent vs create), delete default, audit-failure tolerance, account resolution.
- **Integration:** MCP server over SDK in-memory transport; verifies tool list, schemas, happy paths with the fake client, `isError` results and texts, stale-token recovery (Keychain token swapped mid-session).
- **Auth:** loopback flow with a mocked token endpoint and id_token verifier (state mismatch, `access_denied`, timeout, duplicate email, `auth login` email mismatch, missing `client_secret.json`).
- **E2E (manual, opt-in):** `MARVIN_E2E_ACCOUNT=<alias>` runs create-folder → upload → move → rename → download → delete → restore → permanent delete inside a temp folder, then cleans up. Not run in CI.

Quality gates: `tsc --noEmit` (strict, per global config), ESLint + Prettier, Vitest — all green before each step proceeds.

## 11. Out of scope (MVP)

Sharing/permissions, Shared Drives, revisions, file watching/sync, content analysis, CLI file commands, Windows/Linux credential stores (interface allows adding later).

## 12. Open items for later specs

- Production publishing of the OAuth app (Branding homepage/privacy policy via GitHub Pages).
- Sub-projects 4 (content) and 5 (sync).
