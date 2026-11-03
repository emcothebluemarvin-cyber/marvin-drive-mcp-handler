# Marvin Drive MCP Handler

Local MCP server + CLI that lets Claude Code manage files in one or more Google Drive accounts, and read and edit Google Docs, Sheets and Slides, through your own Google OAuth client.

## Requirements

- macOS (tokens are stored in the login Keychain), Node.js ≥ 22.12
- A Google Cloud project with **Google Drive API** enabled (plus **Google Docs API**, **Google Sheets API** and **Google Slides API** for the content tools; the server reports a clear error if one is not enabled) and an OAuth client of type **Desktop app**
- While the OAuth app is in **Testing** mode: every account must be listed under _Google Auth Platform → Audience → Test users_, and logins expire after 7 days (re-run `auth login`)

## Setup

```bash
npm install
npm run build
mkdir -p ~/.config/google-handler && chmod 700 ~/.config/google-handler
# Save the Desktop client JSON as ~/.config/google-handler/client_secret.json (chmod 600)
npm link            # puts `marvin-drive` on PATH (optional; otherwise use `node dist/cli/main.js`)
marvin-drive auth add --alias emco
```

Error messages refer to `marvin-drive …`; without `npm link`, run the same command as `node dist/cli/main.js …`.

## Register with Claude Code

```bash
claude mcp add marvin-drive --scope user -- node "$PWD/dist/cli/main.js" serve
```

After changing code, run `npm run build` again — Claude Code runs the compiled `dist/` output.

## CLI

| Command                             | Purpose                                           |
| ----------------------------------- | ------------------------------------------------- |
| `marvin-drive auth add [--alias a]` | Browser login, register account (first = default) |
| `marvin-drive auth login <alias>`   | Re-login an expired account                       |
| `marvin-drive auth list [--verify]` | Accounts and token status                         |
| `marvin-drive auth remove <alias>`  | Remove account, delete + revoke token             |
| `marvin-drive auth default <alias>` | Set the default account                           |
| `marvin-drive serve`                | MCP server on stdio                               |

## MCP tools

All tools accept an optional `account` (alias or email).

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

### Editing safely

Read tools return a `revisionId`. Docs and Slides edits accept `requiredRevisionId` and fail with a re-read hint if the file changed in the meantime; read-then-write tools (`docs_insert_text` at `end`/`afterHeading`, and `slides_set_text`) apply this guard implicitly using their own read, while `docs_insert_text` at an explicit `index` is guarded only when you pass `requiredRevisionId`. The advanced `docs_batch_update` and `slides_batch_update` tools require it. The Sheets API has no such guard, so address tabs by `sheetId` from `sheets_info`, never by position.

The advanced `*_batch_update` tools run raw API requests with the account's own permissions, and some requests (for example charts linked to another spreadsheet, or images inserted by URL) read from other sources.

## Files

| Path                                          | Content                         |
| --------------------------------------------- | ------------------------------- |
| `~/.config/google-handler/client_secret.json` | OAuth client (never commit)     |
| `~/.config/google-handler/accounts.json`      | Aliases and emails (no secrets) |
| `~/.config/google-handler/audit.jsonl`        | Every mutating operation        |
| Keychain service `marvin-drive`               | Refresh tokens                  |
| `~/Downloads/marvin-drive/`                   | Default download folder         |

## Development

```bash
npm run check                                   # typecheck, lint, format, unit + integration tests
MARVIN_KEYCHAIN_TEST=1 npx vitest run src/auth  # real Keychain round-trip
MARVIN_E2E_ACCOUNT=emco npm run test:e2e        # live Drive test (creates and deletes a temp folder)
```
