# Marvin Drive — Local Trash on Windows and Linux

- **Date:** 2026-11-05
- **Status:** Approved in brainstorming; spec review round 3
- **Scope:** Sync deletions of local files (`trash-local`, and later Phase B release) work on Windows and Linux as well as macOS
- **Builds on:** selective sync spec (`2026-11-03-selective-sync-design.md`) §7 "Local trash"; cross-platform work in FEATURES §6

## 1. Goal

When sync deletes a local file, the file goes to the operating system's trash, so the user can restore it with the normal desktop tools. Today this works only on macOS (`/usr/bin/trash -s`). On Windows and Linux `trash-local` always fails, which leaves the file in place.

**Overriding principle (unchanged, sync spec §1):** a local file is never deleted permanently. If the file cannot be moved to a trash with certainty, the action fails and the file stays where it is.

## 2. Decisions

| Topic | Decision |
|---|---|
| Mechanism on Windows and Linux | Our own code puts the file into the OS trash folder of the same volume and writes the trash metadata file. The file is moved with one `rename` after the target name is reserved and checked free (§4); it is never copied, unlinked or deleted |
| Why not the OS tools | Windows `SHFileOperation`/`IFileOperation`/`Microsoft.VisualBasic` silently delete permanently when the volume has no Recycle Bin, when the Recycle Bin is disabled, or when the file is larger than the bin's size limit. Linux `gio trash` is usually missing on headless servers, which is a main target |
| No trash available | Fail with `LocalTrashError`; the file stays. No fallback folder, no permanent delete (user decision 2026-11-05) |
| Retention | Once the file is in the trash, the OS's own trash policy applies (user empties it, desktop auto-purge, Windows purging the oldest items when the bin is over its size). This is the same as deleting the file in Explorer/Files; we do not read or enforce trash size settings |
| macOS | Unchanged: `/usr/bin/trash -s <path>` through `execFile` |
| What is trashed | Regular files only (sync only trashes files). Anything else is a `ValidationError` before touching the disk. A file with several hard links: only this name is moved, which is correct |
| New dependencies | None |

## 3. Interface

```ts
// src/sync/trash.ts
export interface LocalTrash {
  /** Moves one regular file at an absolute path to the OS trash. Never deletes, never overwrites. */
  trash(absPath: string): Promise<void>;
}
export type ExecFn = (file: string, args: readonly string[]) => Promise<{ stdout: string }>;
export const defaultExec: ExecFn;              // execFile, no shell; stays exported
export class MacTrash implements LocalTrash { constructor(exec?: ExecFn) }
export function createLocalTrash(platform?: NodeJS.Platform): LocalTrash;

// src/sync/trash-xdg.ts
export interface XdgTrashDeps {
  env?: NodeJS.ProcessEnv;    // default process.env (XDG_DATA_HOME)
  homedir?: string;           // default os.homedir()
  uid?: number;               // default process.getuid()
  now?: () => Date;
  fs?: TrashFs;               // default node:fs/promises subset (below)
}
export class XdgTrash implements LocalTrash { constructor(deps?: XdgTrashDeps) }

// src/sync/trash-windows.ts
export interface WindowsTrashDeps {
  exec?: ExecFn;                          // runs whoami
  binDir?: (root: string) => Promise<string>; // default: `${root}$Recycle.Bin\${sid}`; tests point it at a temp dir
  now?: () => Date;
  random?: () => string;                  // 6 chars A–Z0–9; default uses crypto.randomInt
  fs?: TrashFs;
  realpath?: (p: string) => Promise<string>; // default fs.realpath.native
}
export class WindowsTrash implements LocalTrash { constructor(deps?: WindowsTrashDeps) }
export function encodeRecycleRecord(r: { path: string; size: bigint; deletedAt: Date }): Buffer;

// TrashFs = { lstat, stat, mkdir, open, unlink, rename, realpath } with the node:fs/promises signatures
// (unlink is used only to remove our own metadata file on failure)
```

`ExecFn` now resolves to `{ stdout }`. Existing fakes that return `undefined` (e.g. `sync-service.run.test.ts`) are not adapted: the sync tests stop faking `ExecFn` and fake `LocalTrash` instead; only `MacTrash` and `WindowsTrash` tests use `ExecFn`.

- `createLocalTrash` returns `MacTrash` on `darwin`, `WindowsTrash` on `win32`, `XdgTrash` on every other platform.
- **Callers:** `SyncService` and `Executor` deps change from `trashExec: ExecFn` to `trash: LocalTrash`; `app.ts` passes `createLocalTrash()`. `refuseTrash` in `fixtures.ts` becomes a `LocalTrash` that throws; executor tests and the e2e test pass a `LocalTrash` whose `trash(abs)` moves the file into their temp dir (today they read `args[1]` of the fake exec).
- **Executor change:** `trashLocalFile` wraps `this.deps.trash.trash(abs)` and maps `ENOENT` to `TargetChangedError("<key> is already gone")`, the same mapping it already uses for the md5 read.
- **Shared checks** in every implementation, before any write: the path is absolute (else `ValidationError`), `lstat` says it is a regular file (else `ValidationError`; `ENOENT` is rethrown unchanged).
- Every later failure is wrapped in `LocalTrashError` with the OS error as `cause` and a message that names the path and the reason (e.g. "no Recycle Bin on drive D:", "no usable trash on this filesystem").

## 4. Moving the file (both platforms)

`placeInTrash(file, target)`, called after the metadata file has reserved the name (§5.2, §6.2):

1. `lstat(target)` must give `ENOENT`; if `target` exists → `EEXIST` to the caller, which picks another name.
2. `rename(file, target)`. Atomic; keeps the file's data, inode and attributes (Windows read-only stays).
   - `ENOENT` (source vanished after the shared check) → rethrown after the caller removed its metadata, so the executor reports "already gone".
   - `EXDEV` (another volume than we determined, e.g. a volume mounted into a folder) → `LocalTrashError`.
   - Windows `EPERM`/`EBUSY` → `LocalTrashError` "file is in use by another program".
3. POSIX: `fsync` the trash `files` directory and the source directory (skipped on win32, where directories cannot be opened for fsync).

**Why `rename` and not `link` + `unlink`:** `unlink(file)` removes whatever is at that name. If an editor saves the file again between the check and the `unlink`, the new content would be lost for good. `rename` moves whatever is at the name into the trash, so a racing save still ends up recoverable there. `rename` also works on filesystems without hard links (FAT/exFAT), and needs no inode comparison or rollback.

**Residual risk (accepted):** `rename` replaces an existing `target`. Between step 1 and step 2 another process would have to create exactly `target`:

- XDG: the trash is validated as owned by the user and not writable by others (§5.1), and the name is already reserved by our `.trashinfo` (compliant trash tools reserve the same way and pick another name).
- Windows: the name has a random 6-character suffix (`crypto.randomInt`), it is reserved by our `$I`, and `$Recycle.Bin\<SID>` is ACL-restricted to the user on NTFS (no ACLs on FAT/exFAT; the random suffix still applies).

Only a non-compliant process of the same user writing that exact name in that window could cause a replacement, and what it replaces is an item in the trash, never the user's live file.

## 5. Linux and other Unix: XDG trash

Follows the freedesktop.org Trash specification 1.0.

### 5.1 Choosing the trash directory

Let `F` = `realpath(dirname(file))/basename(file)` (resolves a symlinked `localDir`), `dev` = `lstat(F).dev`.

1. **Home trash** `H` = `$XDG_DATA_HOME/Trash`, or `$HOME/.local/share/Trash` when `XDG_DATA_HOME` is unset or not absolute. Create `H`, `H/files`, `H/info` (0700, recursive) if missing, then check `stat(H).dev === dev`. If the device differs, `H` is not used (directories we just created stay; they are empty and harmless).
2. Otherwise find the **top directory** `T`: walk up from `dirname(F)` while the parent's `st_dev === dev`; `T` is the last directory on the same device.
3. **Admin trash** `T/.Trash/$uid`: only if `T/.Trash` exists, is a directory (not a symlink, by `lstat`) and has the sticky bit. Create `$uid`, `files`, `info` (0700) if missing.
4. Else **user trash** `T/.Trash-$uid`: create it and `files`, `info` (0700) if missing.
5. **Validation of the chosen trash** (home, admin or user): `lstat` the trash dir, `files` and `info`. Each must be a real directory (not a symlink), owned by `uid`, with no group or other write bit, and on `dev`. A trash that fails this is not used: for 3 move on to 4; for 4 fail; for the home trash `H` (same device but unsafe, e.g. `H/files` is a symlink or group-writable) fail with "home trash is not safe: <reason>", without falling back to a top-directory trash. This stops another user who pre-created `.Trash-$uid` or `.Trash/$uid` (or a symlink) from receiving the file. On FAT/exFAT/NTFS-3g mounts owner and mode come from mount options (often `umask=000` or another uid), so the validation rejects them and `trash-local` fails safely on such disks.
6. Nothing usable → `LocalTrashError` ("no usable trash on this filesystem").

### 5.2 Moving the file

1. Pick a name: the file's basename, then `stem.2.ext`, `stem.3.ext`, … (`stem`/`ext` split at the last dot that is not the first character), up to 1000 tries.
2. **Reserve** the name by creating `info/<name>.trashinfo` with flag `wx` (O_CREAT | O_EXCL). `EEXIST` → next name.
3. Write the info file, `fsync`, close, `fsync` the `info` directory:
   ```
   [Trash Info]
   Path=<path>
   DeletionDate=YYYY-MM-DDThh:mm:ss
   ```
   `Path` is `F` (absolute) for the home trash and `F` relative to `T` for top-directory trashes. Each byte of the UTF-8 path outside `A–Z a–z 0–9 - _ . ~ /` is percent-encoded. `DeletionDate` is local time without zone.
4. `placeInTrash(F, files/<name>)` (§4). `EEXIST` (an orphan `files/<name>` from another tool) → remove our info file and go back to step 1 with the next name.
5. On any other failure: remove the info file (best effort), then rethrow `ENOENT` of the source unchanged, or throw `LocalTrashError`. The original file is untouched.

### 5.3 Not handled

`directorysizes` (only for trashed directories), trash size limits, emptying the trash. File names that are not valid UTF-8 cannot be represented as JS strings; they surface as `ENOENT` or a `ValidationError` and are never moved to a wrong place.

## 6. Windows: Recycle Bin

### 6.1 Where the bin is

1. `F` = `realpath.native(path.win32.resolve(absPath))`. This normalises `/` to `\`, resolves junctions and symlinks, and turns a **mapped network drive** (`Z:\…`) or a `subst` drive into its real target (`\\server\share\…` or the underlying drive). `F` is the path written into `$I`.
2. `root` = `path.win32.parse(F).root`; it must match `^[A-Za-z]:\\$`. UNC (`\\server\share\…`) and device paths (`\\?\`, `\\.\`) → `LocalTrashError` ("network and device paths have no local Recycle Bin").
3. The user's SID: run `%SystemRoot%\System32\whoami.exe /user /fo csv /nh` by absolute path (`execFile`, no shell; `SystemRoot` defaults to `C:\Windows`). Parse the single CSV line with quote handling (`"DOMAIN\user, name","S-1-5-21-…"`); the second field must match `^S-1-[0-9]+(-[0-9]+)+$`. Cached per `WindowsTrash` instance. Any failure → `LocalTrashError`.
4. `bin` = `<root>$Recycle.Bin\<SID>`. It must already exist as a directory. We never create it: Windows creates it with special ACLs the first time the user deletes something on that drive. Missing → `LocalTrashError` ("no Recycle Bin on drive D:; delete any file there in Explorer once, or the drive does not support one").

### 6.2 Moving the file

1. Pick a suffix of 6 random characters from `A–Z0–9`, plus the file's extension as it is. Names: `$R<suffix>` (the file), `$I<suffix>` (the record).
2. **Reserve** by creating `bin\$I<suffix>` with flag `wx`. `EEXIST` → new suffix, up to 10 tries.
3. Write the `$I` record (version 2, used since Windows 10), all integers little-endian, then `fsync` and close:

   | Offset | Size | Field |
   |---|---|---|
   | 0 | 8 | version = 2 |
   | 8 | 8 | original file size in bytes |
   | 16 | 8 | deletion time as FILETIME (100 ns intervals since 1601-01-01 UTC) |
   | 24 | 4 | path length in UTF-16 code units, including the terminating NUL |
   | 28 | 2 × length | `F`, UTF-16LE, NUL-terminated |

4. `placeInTrash(F, bin\$R<suffix>)` (§4). The `lstat` check in §4 step 1 exists because Node's `rename` on Windows replaces an existing target (`MOVEFILE_REPLACE_EXISTING`). `EEXIST` → remove our `$I`, new suffix.
5. On any other failure: remove the `$I` file (best effort), then rethrow `ENOENT` of the source unchanged, or throw `LocalTrashError`.

The file size for `$I` comes from `lstat(F, { bigint: true }).size`. If the volume is mounted into a folder without a drive letter, `realpath.native` or the `rename` (`EXDEV`) fails, so the action fails.

### 6.3 Risk and manual check

The `$I` format is not officially documented, but it has been stable since Windows 10 and is widely documented by forensics tools. CI checks the bytes we write; it cannot check what Explorer shows. **Before release, one manual check on a real Windows machine:** a sync `trash-local` shows the file in the Recycle Bin with its original name and location, and "Restore" puts it back. The README states that Windows support depends on this format. Mapped-drive detection (§6.1 step 1) relies on `realpath.native` returning the UNC path, which is also part of this manual check.

## 7. Error handling

| Case | Result |
|---|---|
| Relative path, not a regular file | `ValidationError`, nothing touched |
| File already gone | `ENOENT` → executor `TargetChangedError` "already gone" |
| No usable trash, other filesystem, UNC / mapped network drive, missing `$Recycle.Bin\<SID>`, SID lookup failed, trash dir owned by someone else | `LocalTrashError`, file stays |
| Failure after reservation (incl. `rename` failing: in use, `EXDEV`) | metadata file removed, `LocalTrashError` (or `ENOENT` rethrown if the source vanished), file stays |
| Linux USB disk with FAT/exFAT/NTFS-3g (owner/mode from mount options) | trash validation rejects it → `LocalTrashError`, file stays |
| Windows volume mounted into a folder without a drive letter | `realpath.native` or `EXDEV` → `LocalTrashError`, file stays |
| Cleanup also fails | still `LocalTrashError`; a leftover `.trashinfo`/`$I` without its file loses nothing |
| Crash after the file reached the trash, before the executor commits the record | Next plan sees a local deletion and trashes the Drive copy (Drive trash). Both copies are restorable; nothing is permanent |

## 8. Testing

- **`trash-move.test.ts`** (`placeInTrash`, every platform, temp dirs): moves and keeps content; an existing target gives `EEXIST` and is not replaced; source `ENOENT` is rethrown; injected `rename` → `EXDEV`/`EBUSY` gives `LocalTrashError` and leaves the source. On `windows-latest`: a read-only file keeps its read-only attribute after the move, and a file held open without delete sharing fails with "in use" and stays.
- **`trash-xdg.test.ts`** (POSIX, skipped on win32): temp dir as `XDG_DATA_HOME`; checks `files/`, `info/*.trashinfo` (percent-encoding of spaces, Turkish letters, `%`), name collisions (`a.pdf` → `a.2.pdf`), orphan `files/<name>`, info removed on failure, regular-file and relative-path checks, symlinked parent dir gives the resolved `Path`. Top-directory selection via injected `stat`/`lstat` reporting another `dev` for the home trash: admin trash with and without sticky bit, symlinked `.Trash-$uid`, wrong owner, group-writable → rejected.
- **`trash-windows.test.ts`**: `encodeRecycleRecord` exact bytes with a fixed date and path (every platform). Move logic with injected `binDir`, `realpath` and `random` pointing to a temp dir (every platform). UNC / device / `C:/` normalisation, mapped drive (injected `realpath` returns `\\srv\share\…`) → fail. `whoami` CSV parsing incl. a comma in a quoted user name. On `windows-latest`, one read-only test runs the real `whoami.exe` and checks the SID format.
- **`trash.test.ts`**: `createLocalTrash` per platform; `MacTrash` keeps today's tests.
- **Executor / service / e2e:** switch to `LocalTrash` fakes; executor test for `ENOENT` from `trash()` → "already gone".

## 9. Documentation

- README: remove "Sync deletions do not work yet" for Windows/Linux; describe the trash per OS, what fails safely (network drives, FAT disks without a bin, a drive where the user never deleted anything), and the Windows `$I` note.
- `sync_run` tool description: "the Drive trash or the system Trash / Recycle Bin".
- FEATURES §6: mark the local trash item ✅. CHANGELOG "Unreleased". Sync spec §2 and §7: point to this spec.
