# Marvin Drive — Content Processing Design (Sub-project 4)

- **Date:** 2026-11-03
- **Status:** Approved in brainstorming; awaiting spec review
- **Scope:** Sub-project 4 of 5 — read and edit Google Docs, Sheets and Slides in place
- **Builds on:** `2026-11-03-drive-mcp-mvp-design.md` (sub-projects 1–3)

## 1. Goal

Let Claude read Google Docs, Sheets and Slides as structured content and edit them in place (no download/re-upload round trip), through new MCP tools on the existing `marvin-drive` server.

## 2. Decisions

| Topic | Decision |
|---|---|
| Use case | Read + targeted in-place edits (chosen over read-only, Sheets-only, template filling) |
| File types | Docs, Sheets, Slides. PDF is out of scope: `drive_download` + the client's own PDF reading already covers it |
| Tool style | **Hybrid:** purpose-built tools with small validated schemas for everyday work, plus one explicitly "advanced" raw `*_batch_update` tool per API |
| Concurrency | Docs and Slides edits accept `requiredRevisionId` (Google `writeControl`); mandatory on `docs_batch_update` / `slides_batch_update`. Sheets has no equivalent — documented, not emulated |
| OAuth scope | Unchanged. The existing `https://www.googleapis.com/auth/drive` scope is accepted by the Docs, Sheets and Slides APIs; no re-consent |
| Libraries | No new dependencies; `googleapis` already ships `docs_v1`, `sheets_v4`, `slides_v1` |
| Docs → Markdown | Drive export to `text/markdown` (Google's converter, verified live in the demo) — no hand-written Markdown converter |
| Audit | Every edit is logged with counts only; document content is never written to the audit log |

## 3. Architecture

```
src/drive/
  client-factory.ts     DriveContext gains docs/sheets/slides adapters built from the same OAuth2 client
  drive-adapter.ts      (unchanged)
  docs-adapter.ts       thin wrapper: get(documentId, fields), batchUpdate(documentId, requests, writeControl)
  sheets-adapter.ts     thin wrapper: get(spreadsheetId, fields), values.get/update/append, batchUpdate
  slides-adapter.ts     thin wrapper: get(presentationId, fields), batchUpdate(presentationId, requests, writeControl)
src/core/
  operation.ts          OperationRunner: exec(account, retryClass, target, fn) + audit(); extracted from FileService
  google-file.ts        resolveGoogleFile(ctx, fileId, expectedMime): shortcut resolution + type check
src/content/
  docs-service.ts       read (markdown | structure), replaceText, insertText, batchUpdate
  docs-structure.ts     Docs JSON → indexed outline (pure function)
  sheets-service.ts     info, readRange, writeRange, appendRows, batchUpdate
  slides-service.ts     read, replaceText, setText, batchUpdate
  slides-text.ts        Slides JSON → per-slide element/text summary (pure function)
  truncate.ts           shared maxChars / offset slicing
src/mcp/
  server.ts             composition of tool groups (keeps respond(), shared zod fields)
  drive-tools.ts        the 12 existing tools, moved verbatim
  docs-tools.ts · sheets-tools.ts · slides-tools.ts
```

**Targeted refactors (in service of this work):**
- `FileService.exec` / `recordAudit` move to `OperationRunner`; `FileService` and the three content services all take it as a dependency. Behaviour of the 12 existing tools is unchanged and their tests must pass untouched apart from construction.
- `server.ts` is split by tool group so it doesn't grow to 25 tool registrations in one file.
- `DriveRunner`'s adapter factory changes from `makeAdapter(client) → DriveAdapter` to `makeAdapters(client) → { drive, docs, sheets, slides }`. Adapters are created lazily per cached context.

**Shared pre-flight (`resolveGoogleFile`):** every content tool first calls Drive `files.get(fileId, 'id, name, mimeType, shortcutDetails')`. A shortcut resolves to its target. If the target's MIME type is not the expected Google type, it throws `ValidationError` naming the right tool family, e.g. *"`<name>` is a Google Sheets file; use the sheets_* tools."* The resolved `{ id, name }` feeds the audit log and error messages.

## 4. MCP tools (13 new, 25 total)

Every tool takes the optional `account` (alias or email), like the MVP tools. `fileId` accepts a Drive file ID or a shortcut to one.

### 4.1 Docs

| Tool | Input | Output |
|---|---|---|
| `docs_read` | `fileId`, `format?: 'markdown' \| 'structure'` (default `markdown`), `maxChars?` (default 50 000, max 200 000), `offset?` (default 0) | `{ fileId, name, revisionId, format, content, totalChars, offset, truncated, nextOffset? }` |
| `docs_replace_text` | `fileId`, `find` (min 1), `replace`, `matchCase?` (default true), `requiredRevisionId?` | `{ occurrencesChanged, revisionId }` |
| `docs_insert_text` | `fileId`, `text` (min 1), `position`: `{ at: 'end' }` \| `{ at: 'afterHeading', heading: string }` \| `{ at: 'index', index: int ≥ 1 }`, `requiredRevisionId?` | `{ insertedAt, revisionId }` |
| `docs_batch_update` ⚠ | `fileId`, `requests` (array of objects, 1–200), `requiredRevisionId` (**required**) | `{ replies, revisionId }` |

- **`markdown`:** `documents.get(fields: 'revisionId')` is called **before** the Drive `text/markdown` export, so the returned `revisionId` is never newer than the content. A guarded edit against a doc that changed in between is rejected — the safe direction.
- **`structure`:** `documents.get` (body only); `docs-structure.ts` emits one line per structural element as text, e.g. `[1-24] HEADING_1 "marvin-drive — Proje Genel Bakışı"`, `[24-140] NORMAL_TEXT "Claude Code'un …"`, `[140-610] TABLE 8x2`, with table cell text indented beneath. This is the input Claude needs to compute indexes for `docs_batch_update`. Paragraph text in the outline is capped at 200 chars per element.
- **Truncation:** `content` is sliced by `offset`/`maxChars` on character boundaries; `truncated` and `nextOffset` tell the caller how to continue.
- **`afterHeading`:** finds the first paragraph whose named style is a heading (`TITLE`, `SUBTITLE`, `HEADING_1`–`HEADING_6`) and whose trimmed text equals `heading` (case-sensitive). Inserts at that paragraph's `endIndex`, so the text starts on the line after the heading. The inserted text is prefixed with nothing and should end with `\n` if the caller wants a separate paragraph; the tool description says so. No match → `ValidationError` listing up to 20 available headings.
- **`end`:** inserts at `body.content[last].endIndex - 1` (before the final newline Docs requires).
- **`index`:** passed through; out-of-range errors come back as Google's 400 message.
- `insertText` is plain text; formatting is done via `docs_batch_update`.

### 4.2 Sheets

| Tool | Input | Output |
|---|---|---|
| `sheets_info` | `fileId` | `{ fileId, name, locale, timeZone, sheets: [{ sheetId, title, index, rowCount, columnCount, hidden }] }` |
| `sheets_read_range` | `fileId`, `range` (A1, e.g. `Modüller!A1:F9` or `Modüller`), `render?: 'formatted' \| 'unformatted' \| 'formula'` (default `formatted`), `maxCells?` (default 5 000, max 50 000) | `{ range, values: unknown[][], rowCount, truncated }` |
| `sheets_write_range` | `fileId`, `range`, `values: (string \| number \| boolean \| null)[][]` (1–10 000 cells), `input?: 'user_entered' \| 'raw'` (default `user_entered`) | `{ updatedRange, updatedRows, updatedColumns, updatedCells }` |
| `sheets_append_rows` | `fileId`, `range` (table anchor, usually a tab name), `values` (same limits), `input?` | `{ updatedRange, updatedRows, updatedCells }` |
| `sheets_batch_update` ⚠ | `fileId`, `requests` (1–200) | `{ replies }` |

- `render` maps to `FORMATTED_VALUE` / `UNFORMATTED_VALUE` / `FORMULA`. Truncation drops whole trailing rows once `maxCells` is exceeded.
- `null` in `values` writes an empty cell. `user_entered` means formulas and locale number parsing apply.
- `append_rows` uses `insertDataOption: INSERT_ROWS`.
- **No revision guard exists in the Sheets API.** `sheets_batch_update`'s description states this and tells the caller to target sheets by `sheetId` from `sheets_info`, not by position.

### 4.3 Slides

| Tool | Input | Output |
|---|---|---|
| `slides_read` | `fileId`, `maxChars?` (default 50 000, max 200 000), `offset?` | `{ fileId, name, revisionId, slideCount, content, totalChars, offset, truncated, nextOffset? }` |
| `slides_replace_text` | `fileId`, `find` (min 1), `replace`, `matchCase?` (default true), `slideIds?: string[]`, `requiredRevisionId?` | `{ occurrencesChanged, revisionId }` |
| `slides_set_text` | `fileId`, `objectId`, `text`, `requiredRevisionId?` | `{ objectId, revisionId }` |
| `slides_batch_update` ⚠ | `fileId`, `requests` (1–200), `requiredRevisionId` (**required**) | `{ replies, revisionId }` |

- **`slides_read` content** (from `slides-text.ts`), one block per slide:
  ```
  ## Slide 2 · id=p2 · layout=BLANK
  - shape g1a2b3 (TITLE): "MVP tamamlandı ve canlı doğrulandı"
  - shape g4c5d6 (TEXT_BOX): "12"
  - table g7e8f9 3x2: | a | b | / | c | d | …
  - image g0a1b2
  Notes: "…"
  ```
  Shapes without text are listed (`(empty)`) so their `objectId` is still usable.
- **`slides_set_text`:** reads the page element first. Not found → `NotFoundError` for the `objectId`. Not a shape with a text body (table, image, line) → `ValidationError` suggesting `slides_batch_update`. Requests sent: `deleteText { type: ALL }` only when the shape currently has text (Slides rejects deleting from an empty shape), then `insertText` at index 0 when `text` is non-empty. Both in one `batchUpdate`, under `requiredRevisionId` when given.
- `slides_replace_text` uses `replaceAllText` with `pageObjectIds` when `slideIds` is given.

### 4.4 Advanced tools

`*_batch_update` descriptions start with "ADVANCED:" and say: prefer the purpose-built tools; requests are sent verbatim to the Google API; read first and pass the `revisionId` (Docs/Slides). The `requests` schema is `z.array(z.record(z.string(), z.unknown())).min(1).max(200)` — Google validates the content and its 400 message is surfaced verbatim.

### 4.5 Revision chaining

Docs and Slides `batchUpdate` responses carry `writeControl.requiredRevisionId`; every Docs/Slides edit tool returns it as `revisionId`, so consecutive edits can stay guarded without re-reading.

## 5. Error handling

Additions to `mapDriveError` (renamed `mapGoogleError`; same function, now also used for Docs/Sheets/Slides):

| Error | Trigger | Message to MCP client |
|---|---|---|
| `ConflictError` (new) | HTTP 400 whose message mentions the required revision ID (Docs/Slides `writeControl` mismatch) | "`<name>` changed since it was read; re-read it with `docs_read` / `slides_read` and retry with the new revisionId." |
| `ApiDisabledError` (new) | HTTP 403 with reason `accessNotConfigured` or `SERVICE_DISABLED` | "The Google `<Docs/Sheets/Slides>` API is not enabled for this OAuth project. Enable it in Cloud Console → APIs & Services, then retry." |
| `ValidationError` | Wrong file type (pre-flight), unknown heading, non-text element for `slides_set_text`, zod failures | Specific message as described in §4 |
| `DriveApiError` | Other 400s from content APIs (bad A1 range, invalid batch request) | Google's message, scrubbed and capped (cap raised from 200 to 500 chars for 400s, since these messages are the actionable part) |
| Existing | 404, 403 permission, 429, reauth | Unchanged MVP behaviour |

The exact wording Google uses for a revision mismatch is confirmed by the E2E test (§7), which deliberately triggers one; the matcher is a unit-tested pure function.

**Retry classes** (`RetryClass` gains `mutate`):
- Reads (`docs_read`, `sheets_info`, `sheets_read_range`, `slides_read`, pre-flight `files.get`): `idempotent` — retry on rate limit and 5xx.
- Edits (all write tools): `mutate` — retry on rate limit only. A 5xx surfaces immediately with the hint *"The change may have been applied anyway; re-read the file before retrying."* (Re-running `replace "a" → "aa"` or an append would corrupt content.)

## 6. Audit

`OperationRunner.audit` writes one JSONL entry per successful edit, with `op` = the full tool name (e.g. `docs_replace_text`) and:

| Tool | `details` |
|---|---|
| `docs_replace_text`, `slides_replace_text` | `{ occurrencesChanged, matchCase, guarded }` |
| `docs_insert_text` | `{ position: 'end' \| 'afterHeading' \| 'index', insertedAt, chars, guarded }` |
| `slides_set_text` | `{ objectId, chars, guarded }` |
| `sheets_write_range`, `sheets_append_rows` | `{ updatedRange, updatedCells, input }` |
| `*_batch_update` | `{ requestCount, requestKinds: string[] (first key of each request, deduped), guarded }` |

`guarded` = whether `requiredRevisionId` was supplied. `find`/`replace`/`text`/`values`/request bodies are never logged. Reads are not audited (consistent with the MVP).

## 7. Testing

- **Unit — services (Vitest, fake adapters extending `fakes.ts`):** pre-flight type check + shortcut resolution; `afterHeading` / `end` / `index` index computation; revisionId ordering (`documents.get` before export); truncation boundaries and `nextOffset`; `slides_set_text` request building (empty vs non-empty shape, non-text element, missing objectId); Sheets `render`/`input` mapping and `maxCells` row truncation; retry class per tool (`mutate` never retries 5xx); audit details contain no content.
- **Unit — pure functions:** `docs-structure.ts` and `slides-text.ts` against JSON fixtures captured from the demo Doc and Slides deck (`src/content/__tests__/fixtures/`), golden-string assertions; revision-mismatch matcher; `mapGoogleError` additions.
- **Refactor safety:** the existing 205 tests pass with only construction changes after `OperationRunner` is extracted, before any new tool is added.
- **MCP integration:** in-memory transport; tool list now 25, schema validation (e.g. `docs_batch_update` without `requiredRevisionId` is rejected), happy paths, `isError` texts for `ConflictError` and `ApiDisabledError`.
- **E2E (opt-in, `MARVIN_E2E_ACCOUNT`):** in a temp folder: upload a `.md` → Doc, `.xlsx` → Sheet, `.pptx` → Slides (convertToGoogle); exercise all 13 tools; trigger a revision conflict by editing twice with the same stale `revisionId` and assert `ConflictError`; permanently delete the folder contents.

Quality gates as in the MVP: `tsc --noEmit`, ESLint + Prettier, Vitest — green before each step proceeds.

## 8. Documentation

README tool table (25 tools, grouped), `docs/FEATURES.md` (sub-project 4 ✅ items), `docs/CHANGELOG.md`.

## 9. Out of scope

- PDF text extraction; Drawings, Forms, Apps Script.
- Formatting helpers (bold, styles, colours) beyond what `*_batch_update` offers.
- Creating new blank Docs/Sheets/Slides via their APIs (`drive_upload` with `convertToGoogle` already covers creation).
- Comments and suggestions (Drive comments API).
- Sync (sub-project 5), resumable upload, OAuth production publishing.
