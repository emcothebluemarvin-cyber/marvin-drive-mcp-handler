# OneDrive sub-project 2: selective two-way sync — design

Status: approved in brainstorming on 2026-11-11; revision 2 after spec review round 1.
Builds on: sync spec `2026-11-02-selective-sync-design.md` (Phase A), addendum
`2026-11-07-sync-phase-b-addendum.md` (Phase B), OneDrive files spec `2026-11-08-onedrive-files-design.md`
(sub-project 1).

## 1. Goal and scope

The existing `sync_*` tools and `sync` CLI commands work for Microsoft accounts (personal OneDrive)
with the same behaviour as for Google accounts: everything of Phase A and Phase B except the
Google-native export path.

In scope:

- Selective two-way sync with the same planner rules (tracked, untracked, remote-only tables
  A/B/U/O/R), `sync_scan` → `sync_select` → dry run → apply with `planId`
- Remote-only files and `sync_release` ("move to OneDrive, free the local copy"), restore by
  re-download (`restorePending`)
- Local-deletion confirmation (`confirmRemoteTrash`, `pendingConfirmation`)
- Local trash for local deletions (unchanged)
- Remote-deletion evidence for OneDrive through the Graph `delta` feed (§4.1)
- A new guard for all providers: refuse pairs inside a cloud desktop client's folder (§6)

Out of scope: work/school accounts are supported by the code but not live-tested in this
sub-project (no work account signed in); sync between Google and OneDrive; files shared with the
user (`remoteItem`), SharePoint/Teams libraries; watch mode; Office content editing.

User decisions (2026-11-11): full parity with Google sync; refuse pairs inside OneDrive / Google
Drive desktop folders; a OneDrive file counts as deleted only with `delta` evidence, otherwise
report only; continue with the two personal accounts (`ms-personal`, and `ms-work`, which is a
second personal account despite its alias).

## 2. Architecture

The sync engine calls Drive today through `env.ops.exec(account, kind, target, (ctx) =>
ctx.drive.*)`, reads Drive's `DriveFile` shape (`md5Checksum`, `parents`, `trashed`,
`capabilities`, folder/shortcut MIME types) and builds Drive query strings. All of that moves
behind one port; the engine sees only provider-neutral types.

```
sync-service ─▶ planner / executor / release / scan-select / pair-admin / remote-probe
                         │
                         ▼
                   SyncRemote (port, src/sync/remote/sync-remote.ts)
                    │                         │
        GoogleSyncRemote                OneDriveSyncRemote
   (DriveAdapter via OperationRunner)   (GraphClient of sub-project 1)
```

### 2.1 Types and port

```ts
type HashKind = 'md5' | 'quickXor';
interface ContentHash { kind: HashKind; value: string }

type RemoteUnsupported = 'native-unsupported' | 'shortcut' | 'onenote' | 'special' | 'shared';

interface RemoteItem {
  id: string;
  name: string;
  /** First parent; null for the drive root. */
  parentId: string | null;
  kind: 'file' | 'folder' | 'unsupported';
  unsupported?: RemoteUnsupported;
  mimeType: string;
  size: number | null;
  /** Google: modifiedTime. OneDrive: item lastModifiedDateTime (renames and moves bump it). */
  modifiedTime: string;
  createdTime: string;
  hash: ContentHash | null;
  /** OneDrive eTag, sent as If-Match; null on Google. */
  version: string | null;
  /** Google trashed flag; always false on OneDrive (deleted items are 404). */
  trashed: boolean;
  canEdit: boolean;
  canTrash: boolean;
  canAddChildren: boolean;
  /** Google-native file that exports (today's RemoteKind 'native'); null elsewhere. */
  native: NativeInfo | null;
}

interface SyncRemote {
  readonly provider: 'google' | 'microsoft';
  /** The hash kind this remote reports for files; local digests of this kind are computed. */
  readonly hashKind: HashKind;
  /** Default pair root when the caller gives none ('root' on both). */
  readonly rootId: string;
  /** null when the item does not exist or cannot be read (404/403); other errors throw. */
  get(id: string, signal?: AbortSignal): Promise<RemoteItem | null>;
  listChildren(folderId: string, pageToken: string | undefined, signal?: AbortSignal):
    Promise<{ items: RemoteItem[]; next?: string }>;
  /** All children whose name folds to `name`'s fold key; the engine decides what to do. */
  findChildren(parentId: string, name: string, kind?: 'folder'): Promise<RemoteItem[]>;
  createFolder(parentId: string, name: string): Promise<RemoteItem>;
  /** Fails with NameConflictError when the name is taken (OneDrive conflictBehavior=fail). */
  uploadNew(parentId: string, name: string, localPath: string): Promise<RemoteItem>;
  /** OneDrive: If-Match item.version; 412 → TargetChangedError. Google: today's update. */
  replaceContent(item: RemoteItem, localPath: string): Promise<RemoteItem>;
  /** Streams content; verification is the caller's (§3.3). */
  download(id: string, signal?: AbortSignal): Promise<Readable>;
  /** Google only; OneDrive throws ValidationError. */
  exportNative(id: string, mimeType: string): Promise<Readable>;
  /** Google: trashed=true. OneDrive: DELETE with If-Match item.version (recycle bin). */
  trash(item: RemoteItem): Promise<void>;
  /** OneDrive only (§4.1); Google returns null and never calls the feed. */
  deletionFeed(): DeletionFeed | null;
}

interface DeletionFeed {
  /** Cursor for "from now on", without enumerating: GET items/{root}/delta?token=latest. */
  start(folderId: string): Promise<string>;
  /** Ids reported with the `deleted` facet since `cursor`, and the next cursor.
   *  Expired cursor (410 resyncRequired) → { expired: true }. */
  read(cursor: string): Promise<{ deletedIds: string[]; cursor: string } | { expired: true }>;
}
```

The port owns transport, retries and error mapping; the engine keeps every decision and every
audit record. `findChildren` lists the parent's children (paged) and filters by fold key, the
same comparison `ensureRemoteFolder` and `findDuplicateUpload` make today. There is no path
lookup, so no name is ever URL-encoded into a path.

`remote-scanner.ts` keeps the breadth-first walk and key building, but consumes `RemoteItem`.
Folder detection uses `kind === 'folder'`, ignored entries use `unsupported`, and Drive query
strings and MIME checks move into `GoogleSyncRemote`. `RemoteIgnoreReason`
(`types.ts`) becomes `RemoteUnsupported | 'unrepresentable' | 'ignored-name'`, and the report
renders each new reason (§4.2).

### 2.2 Implementations

- **`google-remote.ts`**: the current `ctx.drive.*` calls, query strings, `SYNC_FILE_FIELDS`,
  folder/shortcut MIME checks and `classifyRemote` move here. Behaviour is unchanged: `get`
  returns null on 404/403 exactly where `remote-probe.ts` maps those to `unavailable` today,
  `version` is null, `replaceContent` keeps re-verify-then-update, `trash` sets `trashed=true`.
  A test pins the issued Drive calls (fields, queries) against today's.
- **`onedrive-remote.ts`**: built on `GraphClient`.
  - `listChildren`: `GET items/{id}/children?$select=…&$top=200`, paging through
    `@odata.nextLink` with sub-project 1's host and shape check.
  - `uploadNew`: up to 4 MiB a simple `PUT items/{parent}:/{name}:/content` with
    `@microsoft.graph.conflictBehavior=fail`. Above that, an upload session with the same
    behaviour. Names go into the path through sub-project 1's `childPath` (which checks the name).
  - `replaceContent`: `PUT items/{id}/content` or an upload session, each with
    `If-Match: <version>`.
  - `trash`: `DELETE items/{id}` with `If-Match`.
  - `exportNative` throws.
  - Errors use sub-project 1's `graph-errors.ts` mapping (§5).
- **`quickxor.ts`**: an incremental QuickXorHash (`update(chunk)`, `digest()` → base64). It uses
  a 160-bit state, shifts by 11 bits per byte, and XORs the 64-bit little-endian length into the
  last 8 bytes. Pure function, no dependency.
- `SyncService` picks the remote from the pair's account (`isMicrosoft(account)`). The
  `assertSupportedAccount` refusal is removed for sync only; content and watch keep it.

### 2.3 Files touched

New: `src/sync/remote/{sync-remote,google-remote,onedrive-remote,quickxor,remote-names}.ts`,
`src/sync/cloud-folders.ts`.

Changed, every place that touches Drive shapes today:
- `remote-scanner.ts`: the query, MIME checks, `md5Checksum`, `capabilities`
- `remote-probe.ts`: the `parents` walk, MIME checks, `classifyRemote`, the 404 mapping (§4.1).
  `FileGetter` becomes `SyncRemote.get`.
- `remote-kinds.ts`: moves under `google-remote.ts`
- `remote-folders.ts`: `ensureRemoteFolder`
- `scan-select.ts`
- `executor.ts`: `readRemote`, `findDuplicateUpload`, trash-remote, the upload checks
- `transfer.ts`: `uploadNew`, `updateContent`, `writeTemp` verification
- `exec-records.ts`: `fromDrive` becomes `fromRemote`
- `exec-export.ts`
- `release.ts`: `verifyLocal`, `releaseProblem`, its re-read
- `pair-admin.ts`: `remoteRootProblem`, folder creation
- `content-compare.ts`: `remoteChanged`, `remoteUnchangedSince` (now on `RemoteItem`),
  `localMatchesRemote`
- `planner.ts`: the planId input uses `hash`
- `plan-shared.ts`, `plan-remote-only.ts`, `plan-tracked.ts`, `plan-untracked.ts`: md5
  comparisons go through `content-compare`
- `local-scanner.ts`: digests (§3.1)
- `types.ts`, `pair-store.ts` (schema v2), `paths.ts` (`isRepresentable` per provider)
- `sync-service.ts`, `app.ts`, the MCP/CLI account checks

## 3. Content comparison

### 3.1 Local digests

- `hashLocal` (`local-scanner.ts`) computes, in one read, md5 plus the digest of the remote's
  `hashKind` when that kind is not md5. `PlanInput.md5s: Map<name, string>` becomes
  `digests: Map<name, LocalDigests>` with `LocalDigests = { md5: string; remote: ContentHash }`
  (`remote` equals `{ kind: 'md5', value: md5 }` on Google).
- `Action` carries `localDigests` next to today's `localMd5`. The executor's re-hash before an
  upload, and release's `verifyLocal`/`releaseProblem` re-hash, compute both digests through one
  `hashFileDigests(path, kind)` helper. `md5File` alone is no longer used where a remote hash is
  compared.
- `SyncRecord.localMd5` stays the **local md5, always**. It is never filled from a remote value.
  `exec-records.localFields` takes the local digests: where it uses `remote.md5 ?? planned`
  today, it uses `planned.md5`. The remote hash is only used for the check in §3.2.

### 3.2 Comparisons (`content-compare.ts`, the only place)

- `sameContent(local: LocalDigests, remote: ContentHash | null): boolean | null`. It returns
  null when `remote` is null or of another kind; otherwise it compares
  `local.remote.value === remote.value`.
- `localMatchesRemote` (U2/B4 adopt, B11 re-upload adopt, release) is true only when
  `sameContent` is true. Null means "not the same", never a weak fallback. A file without a
  remote hash is therefore never adopted by content, and release refuses it with "OneDrive
  reports no hash for this file; it cannot be released safely".
- `remoteChanged(record, entry)`: the hash when both record and entry have one of the same kind,
  else size + modifiedTime with `weak: true` (today's rule).
- `findDuplicateUpload` (after an upload error) matches `size` and `sameContent === true`
  instead of `md5Checksum === md5`.
- The upload results check `changed-during-upload` with `sameContent(planned digests,
  result.hash)`. It warns only when the result is false. Null (no hash returned) is not a
  warning.
- `SyncRecord.remoteMd5: string | null` becomes `remoteHash: ContentHash | null`, and
  `RemoteEntry.md5` becomes `hash`. The planId (`planner.ts`) hashes `hash.kind:hash.value`.

### 3.3 Download verification

`transfer.writeTemp` gets `expected: ContentHash | null` instead of `expectedMd5`. While
streaming, it computes md5 (for `localMd5`) and, when `expected` is quickXor, QuickXorHash too.
It then compares the digest of `expected.kind`. A mismatch keeps today's behaviour: the temp
file is removed and the action fails. Null expected keeps today's behaviour for unhashed files
(size check only).

### 3.4 Re-verification and preconditions

- The executor's re-read before every write (`remoteUnchangedSince`) compares hash and
  modifiedTime as today, on `RemoteItem`.
- OneDrive `replaceContent` and `trash` send `If-Match` with the eTag from that re-read. 412
  maps to `TargetChangedError`: the action is skipped, with "changed on OneDrive since the scan".
  For simple `PUT` and `DELETE`, OneDrive checks the condition when the write happens. For upload
  sessions (files over 4 MiB), it checks only when the session is created, so a remote edit
  during a long upload can still be overwritten. The window is narrower than on Google, but it
  is not closed. The README documents this next to Google's.

## 4. OneDrive-specific rules

### 4.1 Deleted items: `delta` evidence

OneDrive returns 404 for a deleted item. It also returns 404 for items that only became
unreachable (for example, moved into a locked Personal Vault). A 404 alone therefore never
leads to `trashed`.

- `Pair` gains `remoteCursor: string | null` and `remoteDeletedIds: string[]`. Both are null or
  empty on Google pairs, and Google never reads them.
- **Pair creation** (Microsoft): `remoteCursor = feed.start(remoteFolderId)`, which uses
  `?token=latest`, so nothing is enumerated.
- **Every scan** (`sync_scan`, dry run, apply) reads the feed from the stored cursor. The
  evidence set for planning is `remoteDeletedIds ∪ deletedIds`.
- **Applied run, only**: it persists the new cursor and
  `remoteDeletedIds := (remoteDeletedIds ∪ deletedIds) ∩ ids of records still in the pair file
  after the run`. This happens in the same pair-file write as the records. A scan or dry run
  never moves the cursor, so evidence cannot be lost between a dry run and its apply.
- **Probe mapping** (`remote-probe.ts`, by provider):
  - Google: unchanged.
  - OneDrive, `get` returns null and the id is in the evidence set → `trashed` (rules B10/B12
    and the remote-only rules, as for a Drive trash).
  - OneDrive, `get` returns null without evidence → `unavailable` (B14: report only, nothing
    touched).
  - OneDrive, `get` returns an item outside the pair root → `moved-out` (today's walk). This
    also covers items that the feed reports as `deleted` only because they left the folder.
- **Expired cursor** (`{ expired: true }`, HTTP 410): the run warns "OneDrive change history
  expired; deletions since the last run are reported, not applied". It plans with the stored
  `remoteDeletedIds` only. An applied run restarts the cursor with `feed.start`. Records that
  went missing in that gap stay `unavailable` until the user acts.
- The feed only provides evidence. Content changes still come from the folder scan, so the feed
  cannot cause a write by itself.
- Sync never deletes permanently on OneDrive. `restorePending` keeps meaning "download the
  remote copy again"; sync never restores from a recycle bin, so the business-account restore
  limit does not apply.

### 4.2 Items that are not synced

These items are reported as `ignored` with a reason. They are never downloaded and never
trashed.

| Item | Detection | `unsupported` | Report text |
|---|---|---|---|
| OneNote notebook | `package` facet | `onenote` | "OneNote notebook, cannot be synced" |
| Personal Vault and other items without `file`/`folder` | neither facet | `special` | "special item, cannot be synced" |
| Shared with the user | `remoteItem` facet | `shared` | "shared item, out of scope" |

A tracked record whose remote becomes such an item resolves to `unknown` with that text. This is
the same path Google uses for `native-unsupported` (`resolve.ts`).

### 4.3 Names

- `remote-names.ts` (new) holds the per-provider rule `remoteNameProblem(provider, name): string
  | null`.
  - Google: always null, today's behaviour.
  - OneDrive: rejects
    - the characters `" * : < > ? / \ |`
    - a leading or trailing space, and a trailing dot
    - the names `.lock`, `CON`, `PRN`, `AUX`, `NUL`, `COM0`–`COM9`, `LPT0`–`LPT9` (also with an
      extension) and `desktop.ini`
    - names that start with `~$`
    - names that contain `_vti_`
    - names longer than 255 characters
- The planner checks it wherever an action would create a remote name: local-only uploads and
  folder creation (`plan-untracked`), and the remote side of renames and moves, if the engine
  propagates them. A failing name becomes a note `remote-name-invalid` with the rule's text
  ("cannot be uploaded to OneDrive: <reason>"). The file stays local and untouched. A folder
  that fails blocks its subtree, and the subtree is reported once.
- `isRepresentable` (`paths.ts`) keeps checking remote names against the local file system. It
  is unchanged.
- OneDrive names are case-insensitive. For OneDrive pairs, remote fold-collision checks always
  use the fold key, whatever the local volume is.

### 4.4 Pair settings

- `googleExport` is rejected with `ValidationError` on Microsoft accounts.
- `native` is always null on OneDrive, so the native planning paths (`plan-native.ts`,
  `exec-export.ts`) never run.
- `nativeBaselineDone` is true from creation on Microsoft pairs.
- `remoteRootProblem` checks `kind === 'folder'`, `canAddChildren` and `trashed` on
  `RemoteItem`. A null `get` for the root reads "folder not found on OneDrive".

### 4.5 Pair file

`pair-store.ts` moves from `z.literal(1)` to `version: 2`:
- `remoteMd5` becomes `remoteHash`.
- `remoteCursor` and `remoteDeletedIds` are added.

A version-1 file is read and migrated in memory, and written as version 2 on the next save.
Mapping: `remoteMd5: x` → `remoteHash: x === null ? null : { kind: 'md5', value: x }`; the
cursor is null and the set is empty. An older binary refuses version 2 with the existing literal
check. The message is improved to "this pair was saved by a newer marvin-drive; update it".

## 5. Errors

| Graph status | Error (sub-project 1) | Sync handling |
|---|---|---|
| 404 / 403 on `get` | — | `get` returns null; probe per §4.1 |
| 404 elsewhere | `NotFoundError` | per-file failure, re-planned next run |
| 409 on `uploadNew` | `NameConflictError` | the executor runs `findDuplicateUpload` first, as after any upload error. A match adopts our own earlier upload (a lost response on a retry). Otherwise the action is skipped with "a file with this name appeared on OneDrive". |
| 409 on `createFolder` | `NameConflictError` | re-run `findChildren`, then reuse exactly one folder or refuse several (today's `ensureRemoteFolder` rule) |
| 412 | `TargetChangedError` | skip, "changed on OneDrive since the scan" |
| 423 | `FileLockedError` | skip, "open in an Office app on OneDrive; try again later" |
| 401 after refresh | auth error | stop the run, hint `auth login <alias>` |
| 429 / 503 / 5xx | throttled / API error | `GraphClient` retries (Retry-After honoured), then a per-file failure |
| 507 | `OneDriveFullError` | stop the run, report storage full |

A per-file failure does not stop the run, as on Google. Completed actions are committed per file,
so an interrupted run continues next time. A lost upload session restarts once (sub-project 1).
`OperationRunner` kinds (`idempotent`, `create`) map to `GraphClient` retry modes: a create is
never retried blindly, it goes through `findDuplicateUpload` / `findChildren` instead.
Cancellation: the port methods take the engine's `AbortSignal` and pass it to `GraphClient`.

## 6. Cloud desktop folder guard (all providers)

`sync_create_pair` and `sync repair-marker` refuse a `localDir` that is a known cloud client
folder, is inside one, or contains one:

- macOS: `~/Library/CloudStorage/OneDrive-*`, `~/Library/CloudStorage/GoogleDrive-*`,
  `/Volumes/GoogleDrive*` (older Google client), and `~/OneDrive` exactly (older OneDrive client)
- Windows: the folders named by `%OneDrive%`, `%OneDriveConsumer%` and `%OneDriveCommercial%`,
  `%USERPROFILE%\My Drive`, and `<letter>:\My Drive` for a mounted Google Drive
- Linux: none

Paths are compared after `realpath`, case-folded on case-insensitive volumes. The message is
"<path> is synced by the <OneDrive|Google Drive> desktop app; pick a folder outside it so the two
do not sync the same files". Existing pairs inside such a folder are not touched; `sync list` and
`sync_list_pairs` show a warning for them.

## 7. Tools and CLI

There are no new tools. `sync_create_pair`, `sync_scan`, `sync_select`, `sync_run`,
`sync_release`, `sync_list_pairs`, `sync_remove_pair` and the `sync` CLI accept Microsoft
accounts. Tool descriptions mention OneDrive and say that `googleExport` is Google only.

The README gets:
- a OneDrive row in the sync section
- the desktop-folder rule
- the deletion-evidence rule (§4.1)
- the upload-session race note (§3.4)

## 8. Implementation staging (for the plan)

1. **Port with Google only.** Introduce the types, `SyncRemote` and `GoogleSyncRemote`, and move
   every call site. Unit tests move to a fake `SyncRemote`, plus the Drive-call pinning test. Rule
   expectations do not change. The Google live sync E2E must pass at the end of this stage.
2. **Hashes and pair file v2.** `LocalDigests`, `content-compare`, `writeTemp`, `exec-records`
   and release re-hash, and the migration. Still Google only, all green.
3. **OneDrive.** Add `quickxor.ts`, `onedrive-remote.ts`, the deletion feed and its probe mapping,
   `remote-names.ts`, the ignored reasons, settings, error handling and account routing.
4. **Cloud folder guard** and the docs.

## 9. Testing

- A `SyncRemote` contract suite runs against both implementations with fakes (fake Drive
  adapter, fake Graph fetch). It covers paging, `findChildren` folding, `get` → null on 404/403,
  `uploadNew` conflict, `If-Match` on replace and delete, and the 410 feed.
- Rule tests for §4.1:
  - 404 with evidence → B10/B12
  - 404 without evidence → B14, nothing trashed
  - a dry run does not move the cursor
  - evidence survives an apply that skipped the record
  - an expired cursor warns and does not apply deletions
  - moved-out stays moved-out
- §3 tests:
  - U2/B4 adopt by quickXor
  - no adopt or release without a hash
  - `localMd5` is never taken from a remote value
  - a download quickXor mismatch fails the action
  - `changed-during-upload` with a null hash is quiet
- `quickxor.ts`: vectors published by rclone's implementation, empty input, inputs that wrap
  the 160-bit state, chunk-boundary independence. Also a live cross-check against OneDrive's own
  value.
- Pair file: a v1 file loads and saves as v2; the older-binary message.
- `remote-names.ts`: every rule. Cloud folder guard: macOS and Windows path sets, `realpath`
  through a symlink, case folding.
- Live E2E `tests/e2e/onedrive-sync.e2e.test.ts` (`MARVIN_E2E_MS_PERSONAL`; optional
  `MARVIN_E2E_MS_SECOND` repeats the run on the second account):
  - the four Google sync scenarios: first pair and two-way changes; conflict; local-deletion
    confirmation; release then restore
  - a file over 4 MiB
  - a remote edit between scans, by a Graph `PUT` from the test
  - a remote delete that is applied through feed evidence
  - QuickXorHash equal to OneDrive's for an uploaded file
  - a local name with `:` reported as `remote-name-invalid`

  The Google live sync E2E is rerun to show no regression.
- Work/school accounts are recorded as "not live-tested".

## 10. Points the live test must confirm

| Point | If it does not hold |
|---|---|
| `children` returns `file.hashes.quickXorHash` for every file on personal drives | Missing hash → null; such files compare weakly and cannot be released (§3.2); document it |
| `delta?token=latest` on a non-root folder returns a usable cursor on personal drives | Use the root `delta` and filter by ancestry; document the cost |
| A deleted file appears in the folder `delta` with the `deleted` facet | Without evidence, deletions stay report-only (B14); document it |
| `If-Match` on `DELETE` returns 412 on a stale eTag | Re-read immediately before the delete; document the small race |
| `lastModifiedDateTime` changes on every content change | Compare by hash only on OneDrive |
| Office web autosave changes the hash without a user-visible edit | Document that opening a file in Office web can mark it changed |
