# Marvin Drive MCP Handler

Local MCP server + CLI that lets Claude Code manage files in one or more Google Drive accounts through your own Google OAuth client.

## Requirements

- macOS (tokens are stored in the login Keychain), Node.js ≥ 22.12
- A Google Cloud project with **Google Drive API** enabled and an OAuth client of type **Desktop app**
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
