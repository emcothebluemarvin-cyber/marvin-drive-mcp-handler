# OneDrive sub-project 2: selective two-way sync — design

Status: approved in brainstorming on 2026-11-11, pending spec review.
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
- A new guard for all providers: refuse pairs inside a cloud desktop client's folder (§6)

Out of scope: work/school accounts are supported by the code but not live-tested in this
sub-project (no work account signed in); sync between Google and OneDrive; files shared with the
user (`remoteItem`), SharePoint/Teams libraries; watch mode; Office content editing.

User decisions (2026-11-11): full parity with Google sync; refuse pairs inside OneDrive / Google
Drive desktop folders; continue with the two personal accounts (`ms-personal`, and `ms-work`,
which is a second personal account despite its alias).

## 2. Architecture

The sync engine calls Drive today through `env.ops.exec(account, kind, target, (ctx) =>
ctx.drive.*)` with Drive query strings (`'x' in parents and trashed = false`) in
`remote-folders.ts`, `scan-select.ts`, `executor.ts`, `transfer.ts`, `pair-admin.ts`,
`release.ts` and `exec-export.ts`. These calls move behind one port.

```
sync-service ─▶ planner / executor / release / scan-select / pair-admin
                         │
                         ▼
                   SyncRemote (port, src/sync/remote/sync-remote.ts)
                    │                         │
        GoogleSyncRemote                OneDriveSyncRemote
   (DriveAdapter via OperationRunner)   (GraphClient of sub-project 1)
```

### 2.1 `SyncRemote`

```ts
interface RemoteItem {
  id: string;
  name: string;
  parentId: string | null;
  kind: 'file' | 'folder' | 'unsupported';
  unsupportedReason?: 'native-unsupported' | 'onenote' | 'special';
  mimeType: string;
  size: number | null;
  modifiedTime: string;
  createdTime: string;
  hash: ContentHash | null;
  /** OneDrive: eTag for If-Match; Google: null. */
  version: string | null;
  trashed: boolean;
  canEdit: boolean;
  canTrash: boolean;
  canAddChildren: boolean;
  /** Google-native file that exports (RemoteKind 'native'); null elsewhere. */
  native: NativeInfo | null;
}

type ContentHash = { kind: 'md5' | 'quickXor'; value: string };

interface SyncRemote {
  readonly provider: 'google' | 'microsoft';
  /** Local hash kinds this remote compares against (Google: md5; OneDrive: md5 + quickXor). */
  readonly hashKind: ContentHash['kind'];
  get(id: string): Promise<RemoteItem | null>; // null: gone (404)
  listChildren(folderId: string, pageToken?: string): Promise<{ items: RemoteItem[]; next?: string }>;
  findChildren(parentId: string, name: string, kind?: 'folder'): Promise<RemoteItem[]>;
  createFolder(parentId: string, name: string): Promise<RemoteItem>;
  uploadNew(parentId: string, name: string, localPath: string): Promise<RemoteItem>;
  replaceContent(item: RemoteItem, localPath: string): Promise<RemoteItem>;
  download(id: string): Promise<Readable>;
  exportNative(id: string, mimeType: string): Promise<Readable>; // Google only; OneDrive throws
  trash(id: string): Promise<void>;
}
```

The port owns retries, error mapping and audit-neutral transport; the engine keeps all audit
records and all decisions. `findChildren` replaces the name queries in `executor.ts` (line ~330)
and `remote-folders.ts` (`ensureRemoteFolder`); comparisons by fold key stay in the engine.

### 2.2 Implementations

- **`google-remote.ts`**: the current `ctx.drive.*` calls and query strings moved verbatim,
  `SYNC_FILE_FIELDS`, `classifyRemote` for native kinds. Behaviour is unchanged; `version` is null
  and `replaceContent` keeps today's re-verify-then-update.
- **`onedrive-remote.ts`**: built on `GraphClient`. `listChildren`: `GET items/{id}/children`
  with `$select` and `$top=200`, paging through `@odata.nextLink` (host check of sub-project 1).
  `findChildren`: `GET items/{parent}:/{name}` plus a children scan when the drive is
  case-insensitive (OneDrive always is). `uploadNew`: simple `PUT` up to 4 MiB, upload session
  above, both with `@microsoft.graph.conflictBehavior=fail`. `replaceContent`: `PUT
  items/{id}/content` or an upload session with `If-Match: <version>`. `trash`: `DELETE
  items/{id}` (to the recycle bin). `exportNative` throws `ValidationError`.
- `SyncService` picks the remote from the pair's account (`isMicrosoft(account)`); the
  `assertSupportedAccount` refusal is removed for sync only (content and watch keep it).

### 2.3 Files touched

New: `src/sync/remote/{sync-remote,google-remote,onedrive-remote,quickxor}.ts`,
`src/sync/cloud-folders.ts` (§6). Changed: the seven call-site files above, `content-compare.ts`,
`types.ts`, `pair-store.ts` (schema migration), `local-scanner.ts` (second hash),
`sync-service.ts`, `app.ts`, MCP/CLI account checks. `executor.ts` (569 lines) loses its Drive
calls, which is the targeted split the Phase A review asked for.

## 3. Content comparison

### 3.1 Hashes

- `SyncRecord.remoteMd5: string | null` becomes `remoteHash: ContentHash | null`;
  `RemoteEntry.md5` becomes `hash`.
- Pair files (`pair-store.ts`, zod schema): on read, a record with `remoteMd5` maps to
  `{ kind: 'md5', value }` (null stays null); records are written in the new shape. A pair file
  version field is bumped; an older binary refuses the new version with a clear message instead
  of misreading it.
- Local side: md5 stays the local identity hash (`localMd5`, used for local-change detection).
  For pairs whose remote `hashKind` is `quickXor`, the scanner also computes QuickXorHash in the
  same read pass (one stream, two digests) and keeps it on the `LocalEntry` only, not in records.
- `quickxor.ts`: Microsoft's published QuickXorHash (160-bit, shift 11 per byte, XOR of the
  length into the last 64 bits, base64 output). Pure function, no dependency; unit tests use
  Microsoft's reference vectors and a live cross-check (§8).
- `content-compare.ts`: hashes are compared only when both kinds match; otherwise, or when either
  is null, the existing size + modifiedTime comparison with `weak: true` applies.
  `localMatchesRemote` compares the local digest of the remote's kind.

### 3.2 Re-verification and preconditions

- The executor's re-read before every write (`remoteUnchangedSince`) compares hash and
  modifiedTime as today, using `hash` instead of `md5Checksum`.
- OneDrive replaces additionally send `If-Match` with the eTag from that re-read; 412 maps to
  `TargetChangedError` ("changed on OneDrive since the scan") and the action is skipped, not
  retried. The race window that Google still has is closed on OneDrive.
- New files on OneDrive use `conflictBehavior=fail`; a 409 maps to `TargetChangedError`
  ("a file with this name appeared on OneDrive"), the action is skipped and the next scan sees it.

## 4. OneDrive-specific rules

### 4.1 Deleted items

- `get` returning 404 is the probe state `trashed`: the planner applies its Drive-trash rules.
  OneDrive cannot tell recycle bin from permanent deletion through Graph on personal drives; both
  mean "deleted remotely".
- Sync never deletes permanently on OneDrive: `trash` is `DELETE`, which moves to the recycle bin.
- `restorePending` keeps meaning "download the remote copy again"; sync never restores from a
  recycle bin, so the business-account restore limit of sub-project 1 does not apply.

### 4.2 Items that are not synced

Reported as `ignored` with a reason, never downloaded, never trashed:

| Item | Detection | Reason text |
|---|---|---|
| OneNote notebook | `package` facet | "OneNote notebook, cannot be synced" |
| Personal Vault and other items without `file`/`folder` | neither facet | "special item, cannot be synced" |
| Shared with the user | `remoteItem` facet | "shared item, out of scope" |

A tracked record whose remote becomes such an item resolves to `unknown` with that reason, the
same path Google uses for `native-unsupported`.

### 4.3 Names

OneDrive name rules of sub-project 1 (forbidden characters `" * : < > ? / \ |`, reserved names
such as `.lock`, `CON`, `desktop.ini`, names starting with `~$` or containing `_vti_`, trailing
dot or space, length limits) decide `isRepresentable` for OneDrive pairs; local files that break
them are reported `unrepresentable` as today. OneDrive is case-insensitive, so the engine's fold
logic treats the remote side as case-insensitive regardless of the local volume.

### 4.4 Pair settings

`googleExport` is rejected with `ValidationError` on Microsoft accounts; native planning
(`plan-native.ts`, `exec-export.ts`) never runs for them because `native` is always null.
`nativeBaselineDone` is set true at pair creation for Microsoft pairs.

## 5. Errors

- Graph errors use the mapping of sub-project 1: 404 → `NotFoundError` / probe `trashed`;
  409 / 412 → `TargetChangedError`; 401 after refresh → `AuthRequiredError` with
  `auth login <alias>`; 429 and 5xx → `GraphClient` retries (Retry-After honoured), then a per-file
  failure. A per-file failure does not stop the run, as on Google.
- An expired session stops the run; completed actions are already committed per file (existing
  journal), so the next run continues.
- Upload sessions: a lost session restarts the upload once (sub-project 1 behaviour).
- The `OperationRunner` classes (`idempotent`, `create`) keep their meaning; OneDrive maps them
  to `GraphClient` retry modes (`create` never blindly retries a create).

## 6. Cloud desktop folder guard (all providers)

`sync_create_pair` and `sync repair-marker` refuse a `localDir` that is inside, or equal to, a
known cloud client folder, and a cloud client folder inside `localDir`:

- macOS: `~/Library/CloudStorage/OneDrive-*`, `~/Library/CloudStorage/GoogleDrive-*`,
  `~/OneDrive*` (older client)
- Windows: `%OneDrive%`, `%OneDriveConsumer%`, `%OneDriveCommercial%`, and
  `My Drive` / `Shared drives` roots of Google Drive for Desktop when found through
  `%USERPROFILE%\My Drive` or a mounted `G:\My Drive`
- Linux: no known client folders; nothing is refused

Paths are compared after `realpath` and case-folded on case-insensitive volumes. Message: "<path> is
synced by the <OneDrive|Google Drive> desktop app; pick a folder outside it so the two do not
sync the same files". Existing pairs inside such a folder are not touched; `sync list` shows a
warning for them.

## 7. Tools and CLI

No new tools. `sync_create_pair`, `sync_scan`, `sync_select`, `sync_run`, `sync_release`,
`sync_list_pairs`, `sync_remove_pair` and the `sync` CLI accept Microsoft accounts. Tool
descriptions mention OneDrive and that `googleExport` is Google only. README: OneDrive row in the
sync section, the desktop-folder rule, the search-lag note does not affect sync (sync lists
folders, it does not search).

## 8. Testing

- `SyncRemote` contract suite run against both implementations with fakes (fake Drive adapter,
  fake Graph fetch): paging, name lookup, conflicts, 404 → null, preconditions.
- Existing sync unit tests (about 700) move to a fake `SyncRemote`; rule expectations do not
  change, only setup code. A test proves the Google remote issues the same Drive calls as before
  (field lists and queries).
- `quickxor.ts`: reference vectors, empty input, inputs across the 160-bit wrap.
- Pair-file migration: old `remoteMd5` records load, round-trip, and an unknown future version is
  refused.
- Cloud folder guard: macOS and Windows path sets, `realpath` through a symlink, case folding.
- Live E2E `tests/e2e/onedrive-sync.e2e.test.ts` (`MARVIN_E2E_MS_PERSONAL`, optional second
  account `MARVIN_E2E_MS_SECOND` for a parallel run): the four Google sync scenarios (first pair
  and two-way changes; conflict; local-deletion confirmation; release then restore) plus a file
  over 4 MiB, an Office file edited remotely between scans (by a Graph `PUT` from the test),
  QuickXorHash equal to OneDrive's for an uploaded file, a OneNote-like `package` reported as
  ignored when present. Live Google sync E2E is rerun to show no regression.
- Work/school accounts: recorded as "not live-tested".

## 9. Open points for the live test

| Point | If it does not hold |
|---|---|
| `children` returns `file.hashes.quickXorHash` for every file on personal drives | Treat a missing hash as null (weak compare) and document it |
| `If-Match` on `PUT items/{id}/content` returns 412 on a stale eTag (confirmed in sub-project 1) | — |
| `lastModifiedDateTime` changes on every content change | Compare hash only for OneDrive |
| Office web autosave changes the hash without a user-visible edit | Document that opening in Office web can mark a file changed |
