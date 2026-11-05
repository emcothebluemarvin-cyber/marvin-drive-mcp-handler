# Marvin Drive — Local Trash on Windows and Linux

- **Date:** 2026-11-05
- **Status:** Approved in brainstorming; awaiting spec review
- **Scope:** Sync deletions of local files (`trash-local`, and later Phase B release) work on Windows and Linux as well as macOS
- **Builds on:** selective sync spec (`2026-11-03-selective-sync-design.md`) §7 "Local trash"; cross-platform work in FEATURES §6

## 1. Goal

When sync deletes a local file, the file goes to the operating system's trash, so the user can restore it with the normal desktop tools. Today this works only on macOS (`/usr/bin/trash -s`). On Windows and Linux `trash-local` always fails, which leaves the file in place.

**Overriding principle (unchanged, sync spec §1):** a local file is never deleted permanently. If the file cannot be moved to a trash with certainty, the action fails and the file stays where it is.

## 2. Decisions

| Topic | Decision |
|---|---|
| Mechanism on Windows and Linux | Our own code moves the file with `rename` inside the same volume into the OS trash folder and writes the trash metadata file. A `rename` cannot destroy data: it either moves the file or fails |
| Why not the OS tools | Windows `SHFileOperation`/`IFileOperation`/`Microsoft.VisualBasic` silently delete permanently when the volume has no Recycle Bin, when the Recycle Bin is disabled, or when the file is larger than the bin's size limit. Linux `gio trash` is usually missing on headless servers, which is a main target |
| No trash available | Fail with `LocalTrashError`; the file stays. No fallback folder, no permanent delete (user decision 2026-11-05) |
| macOS | Unchanged: `/usr/bin/trash -s <path>` through `execFile` |
| What is trashed | Regular files only (sync only trashes files). Anything else is a `ValidationError` before touching the disk |
| New dependencies | None |

## 3. Interface

```ts
// src/sync/trash.ts
export interface LocalTrash {
  /** Moves one regular file at an absolute path to the OS trash. Never deletes. */
  trash(absPath: string): Promise<void>;
}
export function createLocalTrash(platform: NodeJS.Platform = process.platform): LocalTrash;
```

- `createLocalTrash` returns `MacTrash` on `darwin`, `WindowsTrash` on `win32`, `XdgTrash` on every other platform.
- `SyncService` and `Executor` deps change from `trashExec: ExecFn` to `trash: LocalTrash`. `app.ts` passes `createLocalTrash()`. Tests pass fakes (`refuseTrash` becomes a `LocalTrash` that throws). The e2e test passes a `LocalTrash` that moves the file into its temp dir, as it does today.
- Shared checks in every implementation, before any disk write: the path is absolute (else `ValidationError`), and `lstat` says it is a regular file (else `ValidationError`; `ENOENT` is rethrown unchanged so the executor reports "already gone").
- Every failure after these checks is wrapped in `LocalTrashError` with the OS error as `cause` and a message that names the path and the reason (e.g. "no Recycle Bin on this drive", "file is on a different filesystem than any usable trash").

**Files:**

```
src/sync/trash.ts           LocalTrash, createLocalTrash, MacTrash (moved from today's trashLocal)
src/sync/trash-xdg.ts       XdgTrash + trashinfo formatting
src/sync/trash-windows.ts   WindowsTrash + $I record encoding + SID lookup
```

## 4. Linux and other Unix: XDG trash

Follows the freedesktop.org Trash specification 1.0.

### 4.1 Choosing the trash directory

Let `dev` = `stat(file).dev`.

1. **Home trash** `H` = `$XDG_DATA_HOME/Trash`, or `~/.local/share/Trash` when `XDG_DATA_HOME` is unset or not absolute. Use `H` if the nearest existing directory among `H`, its parents, up to `~` has `st_dev === dev`. Missing `H`, `H/files`, `H/info` are created with mode 0700.
2. Otherwise find the **top directory** `T` of the file's mount: walk up from the file's directory while the parent's `st_dev === dev`; `T` is the last directory on the same device.
3. **Admin trash** `T/.Trash/$uid`: use it only if `T/.Trash` exists, `lstat` says it is a directory (not a symlink), and it has the sticky bit. Create `$uid`, `files`, `info` (0700) if missing.
4. **User trash** `T/.Trash-$uid`: create it and its `files`, `info` (0700) if missing.
5. If none of these can be created or used → `LocalTrashError`.

The trash directory must be on the file's device; we check that before writing and the `rename` enforces it again (`EXDEV` → `LocalTrashError`).

### 4.2 Moving the file

1. Pick a name: the file's basename `b`, then `stem.2.ext`, `stem.3.ext`, … (`stem`/`ext` split at the last dot that is not the first character), up to 1000 tries.
2. **Reserve** the name by creating `info/<name>.trashinfo` with flag `wx` (O_CREAT | O_EXCL). `EEXIST` → next name. Also skip a name whose `files/<name>` already exists (orphan from another tool), because `rename` would replace it.
3. Write the info file, `fsync`, close:
   ```
   [Trash Info]
   Path=<path>
   DeletionDate=YYYY-MM-DDThh:mm:ss
   ```
   `Path` is absolute for the home trash and relative to `T` for top-directory trashes. Each path byte outside `A–Z a–z 0–9 - _ . ~ /` is percent-encoded (UTF-8 bytes). `DeletionDate` is local time without zone, as the spec requires.
4. `rename(file, files/<name>)`.
5. If step 4 fails, delete the info file (best effort) and throw `LocalTrashError`. The original file is untouched.

### 4.3 Not handled

`directorysizes` (only for trashed directories), trash size limits (desktop tools manage them), and emptying the trash.

## 5. Windows: Recycle Bin

### 5.1 Where the bin is

1. `root` = `path.win32.parse(absPath).root`. It must match `^[A-Za-z]:\\$`. UNC paths (`\\server\share\…`) and `\\?\` paths → `LocalTrashError` ("network and device paths have no Recycle Bin").
2. The user's SID comes from `whoami /user /fo csv /nh` (`execFile`, no shell). The second CSV field must match `^S-1-[0-9]+(-[0-9]+)+$`. The result is cached per `WindowsTrash` instance. Any failure → `LocalTrashError`.
3. `bin` = `<root>$Recycle.Bin\<SID>`. It must already exist as a directory. We never create it: Windows creates it with special ACLs the first time the user deletes something on that drive. Missing → `LocalTrashError` ("no Recycle Bin on drive X:; delete any file there in Explorer once, or the drive does not support one").

### 5.2 Moving the file

1. Pick a suffix of 6 random characters from `A–Z0–9`, plus the file's extension as it is. Names are `$R<suffix>` (the file) and `$I<suffix>` (the record).
2. **Reserve** by creating `bin\$I<suffix>` with flag `wx`. `EEXIST`, or an existing `bin\$R<suffix>` → new suffix, up to 10 tries.
3. Write the `$I` record (version 2, used since Windows 10), all integers little-endian:

   | Offset | Size | Field |
   |---|---|---|
   | 0 | 8 | version = 2 |
   | 8 | 8 | original file size in bytes |
   | 16 | 8 | deletion time as FILETIME (100 ns intervals since 1601-01-01 UTC) |
   | 24 | 4 | path length in UTF-16 code units, including the terminating NUL |
   | 28 | 2 × length | original absolute path, UTF-16LE, NUL-terminated |

   Then `fsync` and close.
4. `rename(file, bin\$R<suffix>)`. Node's `rename` on Windows replaces an existing target, so step 2's check of `$R<suffix>` is required. A folder mounted from another volume inside the drive gives `EXDEV` → fail.
5. If step 4 fails, delete the `$I` file (best effort) and throw `LocalTrashError`. `EPERM`/`EBUSY` (file open in another program) are reported as "file is in use".

### 5.3 Risk and manual check

The `$I` format is not officially documented, but it has been stable since Windows 10 and is widely documented by forensics tools. CI checks the bytes we write; it cannot check what Explorer shows. **Before release, one manual check on a real Windows machine:** a sync `trash-local` shows the file in the Recycle Bin with its original name and location, and "Restore" puts it back. The README states that Windows support depends on this format.

## 6. Error handling

| Case | Result |
|---|---|
| Relative path, not a regular file | `ValidationError`, nothing touched |
| File already gone | `ENOENT` rethrown (executor: "already gone") |
| No usable trash, different filesystem, UNC path, missing `$Recycle.Bin\<SID>`, SID lookup failed | `LocalTrashError`, file stays |
| Rename fails after reservation | metadata file removed, `LocalTrashError`, file stays |
| Metadata cleanup also fails | still `LocalTrashError`; a leftover `.trashinfo`/`$I` without its file is harmless (desktop tools ignore or clean it) |

## 7. Testing

- **`trash-xdg.test.ts`** (runs on POSIX CI, skipped on win32): temp dir as `XDG_DATA_HOME` and as the file's parent; checks the file moved to `files/`, `info/*.trashinfo` content (percent-encoding of spaces, Turkish letters, `%`), name collisions (`a.pdf` → `a.2.pdf`), orphan `files/<name>`, rename failure removes the info file (injected `rename`), regular-file check. Top-directory selection is tested through an injected `stat` that reports a different `dev` for the home trash.
- **`trash-windows.test.ts`**: `$I` encoding is a pure function, tested on every platform with a fixed date and path (exact bytes). The move logic gets an injected `binDir(root)` pointing to a temp dir and runs on every platform; the UNC/`\\?\`/root-format checks use `path.win32` and run everywhere. SID parsing is tested with sample `whoami` output. On the `windows-latest` runner one read-only test runs the real `whoami` and checks the SID format.
- **`trash.test.ts`**: `createLocalTrash` picks the right class per platform; `MacTrash` keeps today's tests.
- **Executor / service / e2e:** switch to the `LocalTrash` fakes; no behaviour change.

## 8. Documentation

- README: remove "Sync deletions do not work yet" for Windows/Linux; describe the trash per OS, what fails safely, and the Windows `$I` note.
- `sync_run` tool description: "the Drive trash or the system Trash / Recycle Bin".
- FEATURES §6: mark the local trash item ✅. CHANGELOG "Unreleased". Sync spec §2 and §7: point to this spec.
