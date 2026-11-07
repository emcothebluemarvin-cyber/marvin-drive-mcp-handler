# Marvin Drive MCP Handler

Local MCP server + CLI that lets Claude Code manage files in one or more Google Drive accounts, read and edit Google Docs, Sheets and Slides, and keep a chosen set of local files in two-way sync with a Drive folder, through your own Google OAuth client.

## Requirements

- Node.js ≥ 22.12; tokens go to the OS credential store (macOS Keychain, Windows Credential Manager, Linux Secret Service) or, with `MARVIN_DRIVE_TOKEN_STORE=file`, to a `0600` file (see [Headless servers](#headless-servers)). The live end-to-end tests (Drive, content, sync) pass on macOS and Ubuntu; Windows is covered by the CI unit and integration tests
- A Google Cloud project with **Google Drive API** enabled (plus **Google Docs API**, **Google Sheets API** and **Google Slides API** for the content tools; the server reports a clear error if one is not enabled) and an OAuth client of type **Desktop app**
- While the OAuth app is in **Testing** mode: every account must be listed under _Google Auth Platform → Audience → Test users_, and logins expire after 7 days (re-run `auth login`)

## Setup

```bash
npm install
npm run build
mkdir -p ~/.config/google-handler && chmod 700 ~/.config/google-handler
# Save the Desktop client JSON as ~/.config/google-handler/client_secret.json (chmod 600)
npm link            # puts `marvin-drive` on PATH (optional; otherwise use `node dist/cli/main.js`)
marvin-drive auth add --alias <name>   # e.g. work; default: the part of the email before @
```

Error messages refer to `marvin-drive …`; without `npm link`, run the same command as `node dist/cli/main.js …`.

## Register with Claude Code

```bash
claude mcp add marvin-drive --scope user -- node "$PWD/dist/cli/main.js" serve
```

After changing code, run `npm run build` again — Claude Code runs the compiled `dist/` output.

### Headless servers

Headless Linux hosts usually have no Secret Service (D-Bus keyring), so keep tokens in a file instead:

```bash
export MARVIN_DRIVE_TOKEN_STORE=file      # tokens in ~/.config/google-handler/tokens.json (0600)
marvin-drive auth add --alias <name> --no-browser
claude mcp add marvin-drive --scope user -e MARVIN_DRIVE_TOKEN_STORE=file -- node "$PWD/dist/cli/main.js" serve
```

Sign in without a browser on the server: `marvin-drive auth add --no-browser` (or `auth login <alias> --no-browser`) prints the Google URL. Open it on any device, sign in, and paste the URL Google redirects to (`http://127.0.0.1:<PORT>/?state=…&code=…`) back into the terminal. That page failing to load is expected. The loopback listener stays up as well, so an SSH tunnel (`ssh -N -L <PORT>:127.0.0.1:<PORT> user@server`) also works; whichever arrives first wins. A no-browser login waits up to 10 minutes.

**Two-step login** (no waiting terminal, e.g. from Claude Code's `!` prompt or a script):

```bash
marvin-drive auth add --alias <name> --print-url                 # prints the Google URL and exits
marvin-drive auth add --alias <name> --redirect-url '<the URL>'  # within 10 minutes
```

`auth login <alias> --print-url` / `--redirect-url` work the same way. Step 1 keeps the PKCE verifier in `~/.config/google-handler/pending-logins.json` (`0600`) until step 2 uses it once or it expires; step 2 must name the same command and alias. Quote the URL (it contains `&`). It lands in your shell history, but its code works only once and only together with that stored verifier.

The file store protects tokens only with file permissions: use it only on hosts where your user account is trusted.

### Windows

Tested on Windows 11 (Node 24, ordinary user account) with the MCP tools and a live sync; CI runs on `windows-latest`.

```powershell
npm install; npm run build
claude mcp add marvin-drive --scope user -- node "$PWD\dist\cli\main.js" serve
```

- Paths: `C:\...` and `C:/...` both work; a `drive_download` destination ending in `\` or `/` is a folder (created if missing). In Git Bash, MSYS rewrites arguments that start with `\\` (UNC paths), so run the CLI with `MSYS_NO_PATHCONV=1` or from PowerShell.
- Tokens are kept in Windows Credential Manager (service `marvin-drive`); the config folder is `%USERPROFILE%\.config\google-handler`. `chmod` has no effect on Windows, so these files are protected only by your user profile's ACLs.
- Sync skips Drive files Windows cannot store (`CON`, `NUL.txt`, `COM1`, names with `< > : " \ | ? *` or ending in a dot or space) and lists them under `unrepresentable` in the plan, so rename them in Drive to sync them.
- Updating: Windows cannot delete the keyring module (`keyring.win32-x64-msvc.node`) while the MCP server has it loaded, so `npm ci` fails with `EPERM` and leaves `node_modules` half removed. Disconnect marvin-drive in `/mcp` (or close Claude Code) before `git pull; npm ci; npm run build`, then reconnect. If it already failed, `npm install` restores the missing packages without touching the locked file.
- Saves that replace a file retry for about 1.5 s when the target is briefly locked (antivirus, indexer, an open editor).
- Sync deletions go to the Recycle Bin of the file's drive (`<drive>:\$Recycle.Bin\<your SID>`). That folder exists once you have deleted anything on that drive in Explorer; until then, and on network drives, the deletion fails safely and the file stays. Marvin writes the Recycle Bin's `$I` record itself (the format Windows 10+ uses, not officially documented), so Explorer shows the file with its original location and _Restore_ puts it back.

## CLI

| Command                                                                                                  | Purpose                                                                                                     |
| -------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `marvin-drive auth add [--alias a] [--no-browser\|--print-url\|--redirect-url u]`                        | Browser login, register account (first = default)                                                           |
| `marvin-drive auth login <alias> [--no-browser\|--print-url\|--redirect-url u]`                          | Re-login an expired account                                                                                 |
| `marvin-drive auth list [--verify]`                                                                      | Accounts and token status                                                                                   |
| `marvin-drive auth remove <alias>`                                                                       | Remove account, delete + revoke token                                                                       |
| `marvin-drive auth default <alias>`                                                                      | Set the default account                                                                                     |
| `marvin-drive serve`                                                                                     | MCP server on stdio                                                                                         |
| `marvin-drive sync list`                                                                                 | Sync pairs with counts and last applied run                                                                 |
| `marvin-drive sync run <name> [--apply] [--plan-id <id>] [--allow-mass-delete] [--confirm-remote-trash]` | Dry run (default) or apply a sync; exit code 1 on failure/abort; `--confirm-remote-trash` needs `--plan-id` |
| `marvin-drive sync release <name> [--all \| <paths…>] [--apply]`                                         | Keep files in Drive only: local copies go to the system trash (dry run by default)                          |
| `marvin-drive sync repair-marker <name>`                                                                 | Rewrite the folder marker after confirming the local folder                                                 |
| `marvin-drive watch add\|remove <fileId> [--account a]`                                                  | Watch a file or folder (folders recursively) for changes by others / stop watching                          |
| `marvin-drive watch list [--account a]`                                                                  | Watched files and folders                                                                                   |
| `marvin-drive watch delivery [hook\|channel]`                                                            | Show or set how changes reach Claude Code (default `hook`)                                                  |
| `marvin-drive changes [--all] [--own] [--json] [--hook]`                                                 | Changes in watched files (unread by default, marks them read); `--hook` is the `UserPromptSubmit` hook      |

## MCP tools

34 tools. All except `drive_list_accounts` and `drive_changes` (which cover every account) accept an optional `account` (alias or email).

| Tool                                                              | Purpose                                                                                                   |
| ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `drive_list_accounts`                                             | Accounts, default, token status (`verify` for a live check)                                               |
| `drive_list`                                                      | Folder contents (default root), paginated                                                                 |
| `drive_search`                                                    | Name/full-text search, mimeType, modifiedAfter, raw Drive query                                           |
| `drive_get_metadata`                                              | Owners, parents, size, link, trashed                                                                      |
| `drive_download`                                                  | Download / export (Docs→docx, Sheets→xlsx, Slides→pptx; `md`, `pdf`, `csv`… on request). Never overwrites |
| `drive_upload`                                                    | Upload a local file, optionally converting to Google format                                               |
| `drive_create_folder`, `drive_move`, `drive_rename`, `drive_copy` | Organize files                                                                                            |
| `drive_delete`                                                    | Trash by default; `permanent: true` deletes forever                                                       |
| `drive_restore`                                                   | Restore from trash                                                                                        |

### Docs

| Tool                | Purpose                                                                                                     |
| ------------------- | ----------------------------------------------------------------------------------------------------------- |
| `docs_read`         | Read a Doc as Markdown, or as an indexed structure outline; returns `revisionId`; paged                     |
| `docs_replace_text` | Replace every occurrence of a string                                                                        |
| `docs_insert_text`  | Insert text at the end, as new paragraph(s) directly under a heading (also above tables), or at a raw index |
| `docs_batch_update` | Advanced: raw Docs API requests (formatting, tables, deletions); requires `requiredRevisionId`              |

### Sheets

| Tool                  | Purpose                                                                                     |
| --------------------- | ------------------------------------------------------------------------------------------- |
| `sheets_info`         | Tabs (sheetId, title, size, hidden, sheetType), locale and time zone                        |
| `sheets_read_range`   | Read cell values (formatted, unformatted or formulas); truncates whole rows beyond maxCells |
| `sheets_write_range`  | Overwrite a range with values (`null` clears a cell)                                        |
| `sheets_append_rows`  | Append rows after the last row of a table                                                   |
| `sheets_batch_update` | Advanced: raw Sheets API requests (tabs, formatting, sorting); no concurrency guard         |

### Slides

| Tool                  | Purpose                                                                                                        |
| --------------------- | -------------------------------------------------------------------------------------------------------------- |
| `slides_read`         | Per slide: element ids, text (including shapes in groups), tables, speaker notes; returns `revisionId`         |
| `slides_replace_text` | Replace every occurrence across the deck or only on given slides                                               |
| `slides_set_text`     | Replace the whole text of one shape, including shapes inside groups (speaker notes need `slides_batch_update`) |
| `slides_batch_update` | Advanced: raw Slides API requests (create slides/shapes, styling); requires `requiredRevisionId`               |

### Sync (selective two-way, on demand)

| Tool               | Purpose                                                                                                                                                                                  |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sync_create_pair` | Pair a local folder with an existing or new Drive folder; writes a hidden `.marvin-sync-<name>` marker; `googleExport` picks the local format of Google Docs/Sheets/Slides/Drawings      |
| `sync_list_pairs`  | Pairs with selected / tracked / remote-only / excluded / baseline counts and the last applied run                                                                                        |
| `sync_scan`        | Local files (with short text previews) and Drive-only candidates, so Claude can propose a selection                                                                                      |
| `sync_select`      | Add or remove relative paths; removing excludes the path and touches no file                                                                                                             |
| `sync_run`         | Dry run by default (plan + `planId`); `apply: true` with the approved `planId` executes it; locally deleted files wait in `pendingConfirmation` until you confirm (`confirmRemoteTrash`) |
| `sync_release`     | "Move to Drive": remove local copies (to the system trash) of files that are in sync; they stay in Drive and selected; `sync_select add` restores them                                   |
| `sync_remove_pair` | Forget a pair and remove its marker; no files are touched                                                                                                                                |

Typical conversation: "sync the seafaring files in Downloads to my Drive folder _Denizcilik_" → Claude creates the pair, runs `sync_scan`, opens unclear files with its own reader, proposes a list, asks you to confirm, calls `sync_select`, shows the `sync_run` dry run, and applies it with the `planId` once you agree.

### Syncing safely

- Only selected files sync. Drive files that already existed at the first applied run stay **candidates** until you select them; Drive files added later are downloaded and selected automatically (unless a local file of the same name exists — then it is reported as a collision).
- Changes are detected three-way (local, Drive, last sync) by MD5. Edits on both sides become a **conflict**: the Drive version is saved next to yours as `<name> (Drive conflict YYYY-MM-DD HH.mm).<ext>`, then your version is uploaded (Drive keeps the old revision).
- Deletions are propagated but never permanent: Drive files go to the Drive trash, local files to the system trash: the macOS Trash via `/usr/bin/trash`, the Windows Recycle Bin, or the freedesktop.org trash on Linux (`~/.local/share/Trash`, or `.Trash-<uid>` at the top of another disk), restorable from Files/Dolphin/`gio trash --restore`. If no trash can be used with certainty — network drives, Linux FAT/exFAT USB disks, some SMB volumes — the action fails and the file stays; nothing is ever deleted permanently. A safety brake stops runs that would delete more than max(10, 20 %) of tracked files, or every tracked file of one side.
- A local file is only ever overwritten when it is the tracked file itself and unchanged since the scan; every new local file is created exclusively (never replaces anything). Anything the planner cannot classify — unreadable folders, duplicate names, case-only clashes on case-sensitive disks — is reported and left alone.
- Each run checks that the local folder still has its marker (catches unmounted or replaced disks) and that the Drive folder still exists; if the marker is missing, run `marvin-drive sync repair-marker <name>`.
- Hashing a file that iCloud has evicted makes macOS download it first (slow but correct).
- **Google Docs, Sheets, Slides and Drawings** sync one way, as read-only exports (default `.docx`, `.xlsx`, `.pptx`, `.pdf`; set `googleExport` when creating the pair, e.g. `{ "document": "pdf", "spreadsheet": "csv" }`). A changed Drive original is exported again; local edits are never uploaded — they are reported, and if the original also changed your copy is kept as `<name> (local edit YYYY-MM-DD HH.mm).<ext>`. Forms, Sites and Apps Script files are listed as `native-unsupported`. Exports over Drive's 10 MB limit use the export link; if that fails too they are reported `native-too-large`.
- **Deleting a synced file locally does not delete it in Drive by itself.** The run lists it under `pendingConfirmation`; Claude asks whether to delete the Drive copy too (`confirmRemoteTrash` with the dry run's `planId`, Drive trash for 30 days) or to keep it in Drive only (`sync_release`). From the terminal: `marvin-drive sync run <name> --apply --plan-id <id> --confirm-remote-trash`, or `marvin-drive sync release <name> <path> --apply`.
- **Upgrading from 0.3:** on the first applied run after the upgrade, Google files already in a synced Drive folder are listed as candidates (not exported); select the ones you want. Google files added later are exported automatically.

#### Move to Drive

After an applied run Claude can offer to free disk space: `sync_release` (or `marvin-drive sync release <name> --all`) re-checks every file, moves the local copy to the system trash and keeps the Drive file; released files are never downloaded again unless you `sync_select add` them. A file you already deleted locally can be released by name, so it stays in Drive. Where no system trash can be used (Windows network drives, a drive without a Recycle Bin), release cannot move the local copy: the dry run lists such files under `skipped`. To keep one in Drive only there, delete the local copy yourself, then release it by name.

### Watch

| Tool            | Purpose                                                                                                                                  |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `drive_watch`   | `add` / `remove` / `list` watched files and folders (folders recursively; max 200 per account)                                           |
| `drive_changes` | Who changed what and when in watched files: diffs (Docs/Slides lines, Sheets cells) and new comments; unread by default, marks them read |

### Editing safely

Read tools return a `revisionId`. Docs and Slides edits accept `requiredRevisionId` and fail with a re-read hint if the file changed in the meantime; read-then-write tools (`docs_insert_text` at `end`/`afterHeading`, and `slides_set_text`) apply this guard implicitly using their own read, while `docs_insert_text` at an explicit `index` is guarded only when you pass `requiredRevisionId`. The advanced `docs_batch_update` and `slides_batch_update` tools require it. The Sheets API has no such guard, so address tabs by `sheetId` from `sheets_info`, never by position.

The advanced `*_batch_update` tools run raw API requests with the account's own permissions, and some requests (for example charts linked to another spreadsheet, or images inserted by URL) read from other sources.

## Watching files

Ask Claude to "watch the budget sheet" (or run `marvin-drive watch add <fileId>`). While a Claude Code session is open, the MCP server checks the Drive Changes API every `MARVIN_WATCH_POLL_SECONDS` (default 30, between 15 and 3600; with several sessions open only one polls). When someone **else** edits a watched file, renames, moves or trashes it, Claude is told who changed what and when — once the file has been quiet for 2 minutes (at most 10 minutes after the first change), as one summary with a diff (`+`/`-` lines for Docs and Slides, `Sheet1!B4: "120" → "135"` for Sheets). New comments are included when the file also changed; comment-only changes are not detected yet (pending a live check). Claude only informs you; it never acts on a change by itself. `drive_changes` (or `marvin-drive changes`) shows the full stored details.

Choose one delivery mode per machine (`marvin-drive watch delivery hook|channel`):

- **`hook` (default, no flags needed):** add a `UserPromptSubmit` hook to `~/.claude/settings.json`; new changes are added to the context of your next prompt:

  ```json
  {
    "hooks": {
      "UserPromptSubmit": [
        {
          "hooks": [
            {
              "type": "command",
              "command": "node /path/to/google-handler/dist/cli/main.js changes --hook"
            }
          ]
        }
      ]
    }
  }
  ```

  The hook reads only local files (no network), prints at most 9 000 characters (the rest as a count), prints nothing when nothing is unread or in `channel` mode, and always exits 0, so it never blocks a prompt.

- **`channel` (Claude Code research preview):** run `marvin-drive watch delivery channel`, then start Claude Code with `claude --dangerously-load-development-channels server:marvin-drive`. Changes are pushed into the open session as they are found; a session that starts later gets one "N Drive changes while you were away" summary. Caveats of the preview: channels need a claude.ai login or a Console API key; on Team/Enterprise plans an admin must enable `channelsEnabled`; if your client negotiates the newer protocol and pushes do not arrive, try `MCP_PROTOCOL_NEGOTIATION=legacy`. Without the flag Claude Code silently drops the pushes — the changes stay unread for `drive_changes`.

Good to know:

- **Your own edits are not notified** (they are stored; `drive_changes { "includeOwn": true }` shows them). Drive only reports the _last_ editor, so a foreign edit followed by your own edit between two checks looks like your own edit.
- Removals, moves out of a watched folder, trashing and renames may be attributed to someone else or to "someone": Drive reports the file's last editor, not who performed the action.
- Files moved into a watched folder stay silent until they are edited (a move does not change the modification time). Large files are reported as "changed (too large to compare)" (text over 1 MB, sheets over 20 000 cells).
- A file inside two watched folders is tracked through the folder that covered it when it was last seen. Removing that folder's watch can stop tracking the file although the other folder still covers it; its next change is then reported as first seen, without a diff.
- **Safety:** notification text is written by other people. Names, diffs and comments are sanitized (control characters removed, `<`/`>` replaced, long lines cut) and marked untrusted, and the server instructions tell Claude to report them, never to follow instructions inside them.
- **Privacy:** snapshots of watched files (plain text, cell values) and the change inbox are stored locally in `~/.config/google-handler/watch/` (`0600`); nothing leaves your machine except the Google API calls. Remove a watch to delete its snapshots.
- The hook runs in Claude Code's environment: if you use a custom `MARVIN_DRIVE_CONFIG_DIR`, set it there too (for example in the hook command), or the hook reads the default folder.
- To change the poll interval, pass it to the server when registering it: `claude mcp add marvin-drive --scope user -e MARVIN_WATCH_POLL_SECONDS=60 -- node "$PWD/dist/cli/main.js" serve`.
- If a session expires, one "watch paused" notice appears; run `marvin-drive auth login <alias>` and watching resumes.

## Files

| Path                                          | Content                              |
| --------------------------------------------- | ------------------------------------ |
| `~/.config/google-handler/client_secret.json` | OAuth client (never commit)          |
| `~/.config/google-handler/accounts.json`      | Aliases and emails (no secrets)      |
| `~/.config/google-handler/audit.jsonl`        | Every mutating operation             |
| `~/.config/google-handler/sync/<name>.json`   | Sync pair state (selection, records) |
| `~/.config/google-handler/watch/`             | Watch list, snapshots, change inbox  |
| `<local folder>/.marvin-sync-<name>`          | Sync folder marker (pair id)         |
| Keychain service `marvin-drive`               | Refresh tokens (default)             |
| `~/.config/google-handler/tokens.json`        | Refresh tokens (`…TOKEN_STORE=file`) |
| `~/Downloads/marvin-drive/`                   | Default download folder              |

## Development

```bash
npm run check                                   # typecheck, lint, format, unit + integration tests
MARVIN_KEYCHAIN_TEST=1 npx vitest run src/auth  # real Keychain round-trip
MARVIN_E2E_ACCOUNT=<alias> npm run test:e2e     # live Drive tests (temp Drive folder + temp local dir; sync uses a temp trash)
MARVIN_E2E_ACCOUNT=<alias> MARVIN_E2E_EDITOR=<alias2> npm run test:e2e  # also the live watch test (second registered account edits)
```

## License

[MIT](LICENSE). Bring your own Google OAuth client; none is shipped with the code.
