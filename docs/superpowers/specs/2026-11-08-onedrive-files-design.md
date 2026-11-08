# OneDrive sub-project 1: sign-in and file operations

Status: design approved by the user (2026-11-08), revised after spec review rounds 1 to 3. Branch
`feat/onedrive` (on top of `feat/drive-watch`).

## 1. Goal

A Microsoft account can be registered next to Google accounts, and the existing `drive_*` MCP
tools work on that account's own OneDrive. The account decides the provider; the tool names do
not change.

OneDrive is split into four sub-projects, each with its own spec and plan. This spec covers only
the first.

| # | Sub-project                      | State     |
| - | -------------------------------- | --------- |
| 1 | Sign-in and file operations      | this spec |
| 2 | Sync on OneDrive                 | later     |
| 3 | Change watching (Graph `delta`)  | later     |
| 4 | Office content editing           | later     |

Out of scope here: files shared with the user, SharePoint and Teams libraries (later updates),
sync, watch, `docs_*` / `sheets_*` / `slides_*` on OneDrive, a remote HTTP MCP transport.

## 2. Decisions (approved)

| Topic            | Decision                                                                                     |
| ---------------- | -------------------------------------------------------------------------------------------- |
| Account types    | Personal and work/school (`common` authority).                                               |
| Tool surface     | Same `drive_*` tools; the account's provider routes the call.                                |
| Reach            | The user's own drive only (`/me/drive`); `remoteItem` entries are never returned.            |
| Name conflicts   | `drive_upload`: fail, then the server asks the user Overwrite / Cancel. Other tools: error.  |
| Permanent delete | Not offered on OneDrive.                                                                     |
| Dependencies     | None new: `fetch` for Graph and OAuth, no MSAL (its token cache conflicts with `TokenStore`). |

## 3. Architecture

```
drive_* tools
     │
FileRouter ── resolves the account, picks the provider
   ├── FileService (Google, unchanged behaviour)
   └── OneDriveFileService ── GraphClient ── MicrosoftAuth

auth CLI, drive_list_accounts
     │
AuthService ── dispatches on the account's provider
   ├── Google flow (unchanged behaviour)
   └── MicrosoftAuth

docs_* / sheets_* / slides_* / sync_* / drive_watch ── Microsoft account → ProviderNotSupportedError (§3.3)
```

| Unit                                    | Responsibility                                                                    | Depends on                       |
| --------------------------------------- | --------------------------------------------------------------------------------- | -------------------------------- |
| `src/files/file-provider.ts`            | `FileProvider` interface and neutral input/result types                           | nothing                          |
| `src/files/file-router.ts`              | Implements `FileProvider`; picks the provider from the account record             | `AccountRegistry`, providers     |
| `src/files/file-service.ts`             | Google implementation; implements `FileProvider`                                  | as today                         |
| `src/files/local-paths.ts`              | `resolveUploadPath`, extracted from `FileService.upload`; shared by both providers | `destination.ts`                 |
| `src/onedrive/graph-client.ts`          | Authenticated JSON/stream requests, paging check, upload session, copy monitor    | `fetch`, `MicrosoftAuth`         |
| `src/onedrive/graph-retry.ts`           | Graph retry rules (§7.2)                                                          | nothing                          |
| `src/onedrive/onedrive-file-service.ts` | The 11 file operations on Graph, audit records                                    | `GraphClient`, `AuditSink`, `downloadsDir`, `destination.ts`, `local-paths.ts` |
| `src/onedrive/map-item.ts`              | Graph `driveItem` → `FileSummary` / `OneDriveMetadata`                            | nothing                          |
| `src/onedrive/graph-errors.ts`          | Graph error → `AppError` subclasses                                               | `src/errors.ts`                  |
| `src/auth/microsoft-auth.ts`            | Microsoft PKCE login, token refresh, status, local removal (§3.4)                 | the dependency list in §3.4      |
| `src/auth/loopback.ts`                  | `listen`, `waitForCallback`, `waitForPaste`, `parsePasted`, `parseRedirectUrl`, `sendPage`, `withDeadline`, extracted from `login-flow.ts`; provider-neutral, no `googleapis` | callback page |
| `src/mcp/confirm-replace.ts`            | The elicitation dialog behind the `ConfirmReplace` callback                       | MCP `Server`                     |

New error classes live in `src/errors.ts`. No runtime `googleapis` import under `src/onedrive` or in
`src/auth/microsoft-auth.ts` (boundary test, as for `src/sync`).

### 3.1 `FileProvider`

Methods, with today's inputs: `list`, `search`, `getMetadata`, `createFolder`, `move`, `rename`,
`copy`, `delete`, `restore`, `upload`, `download`. The MCP drive tools depend on this interface
instead of `FileService`. Sync, content and watch keep their current Google dependencies.

- `getMetadata` returns `FileMetadata = DriveFile | OneDriveMetadata`. The Google response is
  unchanged. `OneDriveMetadata` is `FileSummary` plus optional `createdTime`, `webViewLink`,
  `trashed`, `owners`.
- `upload(input, options?: { confirmReplace?: ConfirmReplace })` returns
  `FileSummary | UploadCancelled`.

```ts
type ReplaceAnswer = 'overwrite' | 'cancel' | 'no_answer';
type ConfirmReplace = (existing: ExistingFile) => Promise<ReplaceAnswer>;
interface ExistingFile { id: string; name: string; size?: number; modifiedTime?: string; modifiedBy?: string }
interface UploadCancelled { cancelled: true; reason: 'user' | 'no_answer'; existing: ExistingFile }
```

`FileService.upload` ignores `confirmReplace`; Google allows duplicate names.

`FileRouter` resolves `account` and passes the input on with `account` set to the record's alias, so
a provider never sees an ambiguous reference. `OneDriveFileService` receives
`clients: (alias: string) => Promise<GraphClient>`, built at the composition root from the registry
and `MicrosoftAuth.accessToken`.

### 3.2 Accounts

- `AccountRecord` gains optional `provider: 'google' | 'microsoft'` (absent means `google`) and
  optional `accountId`, set for Microsoft to `<tid>.<oid>`. Both are added to `registrySchema`,
  which otherwise strips unknown keys. No migration.
- A Microsoft account's identity is `accountId`, since one address can be both a personal and a work
  account. The `email` field is its display address: the ID token's `email`, else
  `preferred_username`. If `tid` or `oid` is missing, or neither address contains `@`, login fails
  with a clear message and nothing is stored. A relogin compares `accountId`, not the address.
- Uniqueness: Google per email (as today), Microsoft per `accountId`; aliases stay globally unique.
  A generated alias that collides fails with a message asking for `--alias`; nothing is stored.
- `tokenKey(record)` is the only way to derive a token store key: the email for Google (unchanged),
  `microsoft:<accountId>` for Microsoft. `reauthNeeded` is keyed by it too.
- An email reference has two rules. On Google-only surfaces (`DriveClientFactory`, the watch
  provider, `SyncEnv`) it resolves to the Google account, so watch's internal email references keep
  their meaning. Where both providers are valid (`FileRouter`, `relogin`, `removeAccount`,
  `setDefault`, the two-step relogin methods), an email matching more than one account raises
  `ValidationError` listing the aliases. Accounts are then chosen by alias. Google-only users never
  see this error, since Google emails are unique.
- `drive_list_accounts` and `auth list` show the provider.

The ID token comes straight from the token endpoint over TLS, in the same exchange that presented
the PKCE verifier, so its signature is not verified (OIDC Core §3.1.3.7); it only labels the account.

### 3.3 Google-only paths

A Microsoft account must never reach Google code. There are three checks, each raising
`ProviderNotSupportedError` (naming the account and saying the feature is not on OneDrive yet):

1. `DriveClientFactory.context()`, before `readRefreshToken`: all content, sync and watch API calls.
2. The Google watch provider's `resolveAccount`: `drive_watch list` and `remove` touch only the
   store and never reach check 1. Without this, a Microsoft alias could act on a Google watch.
3. `SyncEnv.assertSupportedAccount(ref)`, called in `createPair` before `writeMarker`, so the user's
   folder is not touched.

`AuthService.authorize` rejects a Microsoft account the same way. Tests cover each path, including
`drive_watch remove` with a shared address.

### 3.4 Auth dispatch

`AuthService` stays the only entry point for the CLI and tools.

```ts
interface ProviderAuth {
  add(alias?: string): Promise<AccountRecord>;
  startAdd(alias?: string): Promise<string>;
  finishAdd(pending: PendingLogin, redirectUrl: string): Promise<AccountRecord>;
  relogin(record: AccountRecord): Promise<AccountRecord>;
  startRelogin(record: AccountRecord): Promise<string>;
  finishRelogin(record: AccountRecord, pending: PendingLogin, redirectUrl: string): Promise<AccountRecord>;
  checkStatus(record: AccountRecord, verify: boolean): Promise<AccountStatus>;
  forget(record: AccountRecord): Promise<void>;
}
```

`AuthService` keeps its Google logic and dispatches to `MicrosoftAuth` (which implements this
interface) before any Google step. `addAccount` and `startAddAccount` take a `provider` argument
and dispatch before `loadCredentials`, so no Google `client_secret` is needed for Microsoft.
`relogin`, `removeAccount` and `status` dispatch on the resolved record.

Finishing a two-step login: `AuthService` takes the pending entry (single use), checks command,
account and provider, and passes the entry to `finishAdd` or `finishRelogin`. Only the entry decides
the provider.

`MicrosoftAuth` owns its own reauth state, keyed by `tokenKey`, and reports it through `checkStatus`.
A successful refresh or relogin clears the mark. `AuthService` does not depend on it for Microsoft
accounts, so there is no cycle.

`MicrosoftAuth` also exposes `accessToken(record, options?: { forceRefresh?: boolean }): Promise<string>`,
the only method `GraphClient` uses; `forceRefresh` bypasses the in-memory cache for the 401 rule of
§7.2. Its dependencies are `AccountRegistry`, `TokenStore`, `PendingLoginStore`, `loopback.ts`,
`fetch`, and the same open-browser, print and paste hooks that `buildApp` gives the Google flow.

`forget` deletes `tokenKey(record)` only; there is no per-token revoke endpoint for this client type,
and the CLI output says so. A test covers `auth remove` of a Microsoft account sharing a Google
address: the Google token stays and is not revoked.

## 4. Sign-in

- Register: `marvin-drive auth add --provider microsoft [--alias a] [--no-browser|--print-url|--redirect-url u]`.
  `--provider` defaults to `google`. `auth login <alias>` reads the provider from the record.
  `TESTING_MODE_HINT` and other Google wording appear only on the Google path.
- `client id`: `<configDir>/microsoft-client.json`, `{ "clientId": "<guid>" }`. Not a secret. A
  missing file raises a `ConfigError` with the registration steps of §9.
- Authorize at `https://login.microsoftonline.com/common/oauth2/v2.0/authorize` with PKCE S256,
  `state`, `prompt=select_account`, scopes `Files.ReadWrite offline_access User.Read openid profile email`.
- Redirect `http://localhost:<port>`. `loopback.ts` binds the port on `127.0.0.1` and, best effort,
  on `::1`, because browsers may resolve `localhost` to either.
- Two-step login reuses `PendingLoginStore`; each entry gains optional `provider` (absent means
  `google`). The step-two entry's provider wins: `--provider` is not needed there, and a flag that
  contradicts the entry is an error. `finishTwoStep` also requires the provider to match, and a
  relogin compares `accountId` for Microsoft.
- After the token exchange the granted scope must contain `Files.ReadWrite`, else fail in the style
  of Google's missing-consent error.
- Refresh is single-flight per account. Each response replaces the stored refresh token. Access
  tokens are cached in memory until 60 s before expiry. `invalid_grant` and `interaction_required`
  re-read the store once (another session may have rotated the token); if that does not help,
  `MicrosoftAuth` sets its own reauth mark (§3.4) and raises `ReauthRequiredError`.

## 5. Tool mapping

`fileId` and `folderId` are opaque; `root` is accepted as a folder. Every ID and name is URL-encoded
into the path; `search` also doubles single quotes for OData. Folders report
`mimeType: 'inode/directory'`; OneNote packages report `application/x-onedrive-package`.

A Google-only parameter given a non-default value raises `ValidationError` ("this option is not
available on OneDrive accounts"); `false` and absent are accepted. Tool descriptions mark these
parameters.

`driveId` and the real root item ID come from `GET /me/drive` and `GET /me/drive/root`, cached per
account for the process lifetime. `root` is replaced by the real ID wherever a request body or a
comparison needs an ID.

| Tool                  | Graph                                     | Differences                                                                 |
| --------------------- | ----------------------------------------- | --------------------------------------------------------------------------- |
| `drive_list`          | `GET items/{id}/children`                 | `includeTrashed` rejected; `remoteItem` entries dropped                     |
| `drive_search`        | `GET root/search(q='…')`                  | `query` is required; `rawQuery`, `mimeType`, `modifiedAfter` rejected; `remoteItem` entries dropped |
| `drive_get_metadata`  | `GET items/{id}`                          | Returns `OneDriveMetadata`                                                  |
| `drive_download`      | `GET items/{id}/content`                  | `exportFormat` rejected; packages rejected; uses `resolveDestination` and `writeUnique`, so it never overwrites locally |
| `drive_upload`        | §6                                        | `convertToGoogle` rejected; path checks from `resolveUploadPath`            |
| `drive_create_folder` | `POST items/{id}/children`, `fail`        | Conflict is an error                                                        |
| `drive_rename`        | Preflight, `PATCH items/{id}` (name)      | §5.1                                                                        |
| `drive_move`          | Preflight, `PATCH` (`parentReference`)    | §5.1; already in the target folder: no-op without audit, as for Google      |
| `drive_copy`          | `POST items/{id}/copy`, monitor           | §5.2; §7.3                                                                  |
| `drive_delete`        | `DELETE items/{id}` (recycle bin)         | `permanent=true` rejected; a 404 after an earlier attempt counts as success |
| `drive_restore`       | `POST items/{id}/restore`                 | Personal drives only; on `driveType: business` an error points to the web recycle bin |

Page size is clamped as today (1 to 200). `nextPageToken` is the Graph `@odata.nextLink`. The audit
operations match Google's, with the account alias.

### 5.1 Rename and move conflicts

Graph documents no conflict option for `PATCH`. Before the request, `items/{parentId}:/{name}` is
read, using the target folder for a move and the item's current parent for a rename (read first).
If it exists and is not the item itself (a case-only rename finds itself), raise
`NameConflictError` and send nothing. Any preflight failure other than 404 also aborts without
sending the `PATCH`. A 409 from Graph maps to `NameConflictError`. See §10.

### 5.2 Copy

`parentReference` carries `driveId` and `id`. With neither `name` nor `parentId` the copy would target
its own name in its own folder, so `ValidationError` asks for a name or a target folder. Folders
may be copied. The tool text stops saying folders cannot be copied, except for Google accounts. No
conflict parameter is sent: `fail` is the default and the parameter is documented as unsupported on
OneDrive Consumer. See §10.

## 6. Upload and name conflicts

A plain `PUT` replaces by default and its reference documents no conflict parameter, so non-empty
files always use an upload session, whose body documents `fail`.

1. Read `items/{parentId}:/{name}`, so a large file does not upload fully before the question. If
   it exists, go to step 2; any failure other than 404 aborts. Otherwise
   `POST items/{parentId}:/{name}:/createUploadSession` with
   `item.@microsoft.graph.conflictBehavior: fail`, then send the fragments; `fail` is the real guard.
   Success ends the flow. A 409 at session creation or on the last fragment enters step 2; the
   session is deleted first. An empty file uses
   `PUT items/{parentId}:/{name}:/content?@microsoft.graph.conflictBehavior=fail` after the same
   read. See §10.
2. Read the existing item: size, modified time, last modifier, eTag. A folder or OneNote package
   raises `NameConflictError`, with no choice offered. A 404 (it vanished) raises
   `TargetChangedError`; nothing is written and the user can retry.
3. If `confirmReplace` is absent, raise `NameConflictError` naming the file. Nothing is written.
4. Call `confirmReplace(existing)`, outside any retry wrapper. `cancel` and `no_answer` return
   `UploadCancelled` with reason `user` or `no_answer` (a successful result, so Claude does not
   retry). Nothing is written.
5. `overwrite` uses `POST items/{id}/createUploadSession` with header `If-Match: <eTag>` and
   `item.@microsoft.graph.conflictBehavior: replace`, and uploads from the start. An empty file uses
   `PUT items/{id}/content` with `If-Match`. A 412 raises `TargetChangedError`, whose message says
   the file changed and asks the user to check it, because a lost final response can look the same.
   The audit record has `replaced: true`.

`src/mcp/confirm-replace.ts` calls `elicitInput` with a one-field form (enum `Overwrite` / `Cancel`),
a message naming the file, its size, modified time and modifier, and a 10 minute timeout. The drive
tool passes `confirmReplace` only when the client declares `elicitation.form`, which the SDK requires.
Decline or dismiss is `cancel`; a timeout or a failed request is `no_answer`. Claude cannot select
Overwrite through a tool parameter: no such parameter exists.

## 7. GraphClient

### 7.1 Authentication and URL safety

- `Authorization` goes only to `https://graph.microsoft.com`. Upload session URLs, copy monitor URLs
  and download redirects are pre-authenticated and get no such header. Download uses
  `redirect: 'manual'` so the token is never forwarded.
- A `pageToken` is accepted only when it is an `https` URL on host `graph.microsoft.com` whose path
  starts with `/v1.0/me/drive/` or `/v1.0/drives/<the account's driveId>/`. Otherwise
  `ValidationError`; no request is sent. A tool parameter therefore cannot send the token to any
  other Graph path.
- Tokens and pre-authenticated URLs never appear in logs, error messages or audit records.

### 7.2 Retry

`withRetry` is not reused: it ignores `Retry-After` and retries 507.

| Response                  | Behaviour                                                                                  |
| ------------------------- | ------------------------------------------------------------------------------------------ |
| 401                       | Refresh once and repeat the request, then `ReauthRequiredError`                            |
| 429                       | A server rejection, so safe for creates too: honour `Retry-After` (capped at 60 s), at most 3 retries, then `GraphThrottledError` |
| 503                       | Idempotent: as for 429. Create: not retried                                                |
| 507                       | Not retried                                                                                |
| Other 5xx, network        | Idempotent: exponential backoff, at most 3 retries. Create: not retried                     |

Error mapping:

| Graph                        | Error                                                         |
| ---------------------------- | ------------------------------------------------------------- |
| 403 `accessDenied`           | Permission error naming the account                           |
| 404 `itemNotFound`           | `NotFoundError`                                               |
| 409 `nameAlreadyExists`      | `NameConflictError`, message asks for another name            |
| 412                          | `TargetChangedError`                                          |
| 423 `resourceLocked`         | "File is locked, probably open in Office"                     |
| 429, 503 after retries       | `GraphThrottledError`: try again later                        |
| 507 `quotaLimitReached`      | "OneDrive storage is full"                                    |
| 400 invalid name             | `ValidationError` with Graph's message                        |
| other                        | Generic `AppError`; Graph's body is logged, not returned      |

### 7.3 Long operations

- Upload session: 10 MiB fragments (a multiple of 320 KiB), sent in order from a stream per
  fragment. A failed fragment reads `nextExpectedRanges` and resumes, at most 5 retries per
  fragment. A 404 on the session restarts the whole upload once. On a final failure the session is
  deleted (best effort).
- Copy: the 202 `Location` URL is polled every 2 s for up to 60 s. On `completed`, the new item is
  read and returned. On `failed` with a name conflict, `NameConflictError`. Past 60 s,
  `CopyStillRunningError` says the copy continues on the server, and the audit record has
  `pending: true`. Once Graph has accepted a copy (202) it is never repeated; only a 429 on the initial
  `POST`, which means the copy was not accepted, is retried under §7.2.

## 8. Testing

- Unit tests with a fake `fetch`: `GraphClient` (auth header rules, `pageToken` check, 401/429,
  session resume and restart, monitor timeout), `graph-retry`, `OneDriveFileService` (each row of §5,
  each path of §5.1, §5.2 and §6), `graph-errors`, `map-item`, `microsoft-auth` (PKCE parameters,
  rotation, single-flight, scope check, re-read on `invalid_grant`, `accountId` identity),
  `FileRouter`, registry (provider default, email resolution, schema keeps the new fields),
  `AuthService` dispatch, each check of §3.3, `auth remove` with a shared address, two-step provider
  match.
- Boundary test: no runtime `googleapis` under `src/onedrive`, in `src/auth/microsoft-auth.ts` or in
  `src/auth/loopback.ts`.
- All existing tests stay green.
- Live E2E `tests/e2e/onedrive.e2e.test.ts`, opt-in with `MARVIN_E2E_MS_PERSONAL` and
  `MARVIN_E2E_MS_WORK`. Each set account runs: create folder, upload empty, small and over 10 MiB,
  list and page, search (polls for index lag), download and compare, rename, move (including to
  root), copy, delete, restore (personal only). Conflict cases assert that the original content or
  the target is unchanged: upload without `confirmReplace`, rename, move, copy, and overwrite with a
  stale eTag. Cleanup sends the test folder to the recycle bin.
- Manual, once: the Overwrite / Cancel dialog in Claude Code, answered after more than 60 s, to confirm
  the tool call is not ended first. Automated tests cover the callback only.
- An account type that cannot be tested live is recorded as "not live-tested" in `docs/FEATURES.md`.

## 9. App registration (user step, documented in the README)

Microsoft Entra admin center → App registrations → New registration:

1. Supported accounts: any organizational directory and personal Microsoft accounts.
2. Redirect: platform "Mobile and desktop applications", `http://localhost`.
3. API permissions (Microsoft Graph, delegated): `Files.ReadWrite`, `offline_access`, `User.Read`,
   `openid`, `profile`, `email`.
4. Save the Application (client) ID in `microsoft-client.json`.

Since June 2024 an app must be registered in a directory (tenant), obtained from a work account,
an Azure subscription or the Microsoft 365 Developer Program.

## 10. Points the live test must confirm

These come from documentation gaps or recollection; each has a defined outcome.

| Point                                                                          | If it does not hold                                                   |
| ------------------------------------------------------------------------------ | --------------------------------------------------------------------- |
| Entra accepts any port for a registered `http://localhost`                     | Fall back to a fixed registered port                                  |
| `PATCH` rename and move return 409 on a name conflict                          | The preflight of §5.1 stays the only guard; document the small race   |
| `copy` without a conflict parameter fails on a name conflict, on both drive types | Add a target-name preflight as in §5.1                             |
| `PUT` of an empty file honours `conflictBehavior=fail`                         | The read in §6 stays the only guard. A file created in that narrow window could be replaced by an empty one; document it |
| `If-Match` is honoured on `createUploadSession` and on `PUT items/{id}/content` | Compare the eTag immediately before the upload; document the small race |
| `@odata.nextLink` has one of the two path shapes of §7.1                       | Add only the observed shape to the check; the host check stays        |
| A work account in another tenant can consent to an unverified app              | Document that its admin must consent; personal and same-tenant accounts are unaffected |
| `elicitInput` of SDK 1.32.2 works on the protocol revision Claude Code negotiates | Adapt `confirm-replace.ts`; the `ConfirmReplace` boundary stays     |

## 11. Documentation

README (accounts, OneDrive differences, registration), `docs/FEATURES.md`, `docs/CHANGELOG.md`. Tool
text becomes provider-neutral: the `fileId` description, `drive_list_accounts` ("Google accounts"),
`drive_copy`, and the trash wording. `RateLimitError` keeps naming Google, as only Google paths raise it.
