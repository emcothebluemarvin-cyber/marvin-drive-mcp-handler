import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { beforeEach, describe, expect, it } from 'vitest';
import { DocsService } from '../../content/docs-service.js';
import { SheetsService } from '../../content/sheets-service.js';
import { SlidesService } from '../../content/slides-service.js';
import { PairStore } from '../../sync/pair-store.js';
import { SyncService } from '../../sync/sync-service.js';
import { refuseTrash } from '../../sync/__tests__/fixtures.js';
import { FileService } from '../../files/file-service.js';
import { GOOGLE_MIME } from '../../files/export-formats.js';
import {
  createAudit,
  createFakeDocs,
  createFakeDrive,
  createFakeSheets,
  createFakeSlides,
  createRunner,
  httpError,
  noSleep,
  silentLogger,
  stubFile,
  type FakeDocs,
  type FakeDrive,
  type FakeSheets,
} from '../../files/__tests__/fakes.js';
import { createMcpServer } from '../server.js';

let drive: FakeDrive;
let docs: FakeDocs;
let sheets: FakeSheets;
let client: Client;

function textOf(result: unknown): string {
  return (result as { content: Array<{ text?: string }> }).content[0]?.text ?? '';
}

beforeEach(async () => {
  drive = createFakeDrive();
  docs = createFakeDocs();
  sheets = createFakeSheets();
  const deps = {
    runner: createRunner(drive, { docs, sheets, slides: createFakeSlides() }),
    audit: createAudit(),
    retry: noSleep,
    logger: silentLogger(),
  };
  const server = createMcpServer({
    files: new FileService({ ...deps, downloadsDir: '/tmp/unused' }),
    docs: new DocsService(deps),
    sheets: new SheetsService(deps),
    slides: new SlidesService(deps),
    sync: new SyncService({
      ...deps,
      store: new PairStore({ dir: '/tmp/unused-sync' }),
      trashExec: refuseTrash,
    }),
    auth: { status: async () => [] },
    version: '0.0.0-test',
    logger: silentLogger(),
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(clientTransport);
});

describe('content MCP tools', () => {
  it('describes tools accurately and marks required fields', async () => {
    const { tools } = await client.listTools();
    const tool = (name: string): (typeof tools)[number] => {
      const t = tools.find((x) => x.name === name);
      if (!t) throw new Error(`missing tool ${name}`);
      return t;
    };
    for (const name of ['docs_batch_update', 'sheets_batch_update', 'slides_batch_update']) {
      expect(tool(name).description).toMatch(/^ADVANCED:/);
    }
    expect(tool('docs_batch_update').inputSchema.required).toContain('requiredRevisionId');
    expect(tool('slides_batch_update').inputSchema.required).toContain('requiredRevisionId');
    expect(tool('docs_replace_text').inputSchema.required).not.toContain('requiredRevisionId');
    expect(tool('slides_set_text').inputSchema.required).not.toContain('requiredRevisionId');
    expect(tool('slides_set_text').description).toContain('inside groups');
  });

  it('requires requiredRevisionId for docs_batch_update', async () => {
    const res = await client.callTool({
      name: 'docs_batch_update',
      arguments: { fileId: 'd1', requests: [{ insertText: {} }] },
    });
    expect(res.isError).toBe(true);
    expect(docs.batchUpdate).not.toHaveBeenCalled();
  });

  it('runs docs_insert_text with a discriminated position', async () => {
    stubFile(drive, 'd1', GOOGLE_MIME.document, 'Plan');
    docs.batchUpdate.mockResolvedValueOnce({ writeControl: { requiredRevisionId: 'r2' } });
    const res = await client.callTool({
      name: 'docs_insert_text',
      arguments: { fileId: 'd1', text: 'x', position: { at: 'index', index: 3 } },
    });
    expect(res.isError).toBeFalsy();
    expect(JSON.parse(textOf(res))).toEqual({ insertedAt: 3, revisionId: 'r2' });
  });

  it('reports revision conflicts as a readable tool error', async () => {
    stubFile(drive, 'd1', GOOGLE_MIME.document, 'Plan');
    docs.batchUpdate.mockRejectedValueOnce(
      httpError(
        400,
        'badRequest',
        "The required revision ID 'r1' does not match the latest revision.",
      ),
    );
    const res = await client.callTool({
      name: 'docs_replace_text',
      arguments: { fileId: 'd1', find: 'a', replace: 'b', requiredRevisionId: 'r1' },
    });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain('"Plan" changed since it was read');
  });

  it('reports a disabled API', async () => {
    stubFile(drive, 's1', GOOGLE_MIME.spreadsheet, 'Budget');
    sheets.getSpreadsheet.mockRejectedValueOnce(
      httpError(
        403,
        'accessNotConfigured',
        'Google Sheets API has not been used in project 1 before or it is disabled.',
      ),
    );
    const res = await client.callTool({ name: 'sheets_info', arguments: { fileId: 's1' } });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain('The Google Sheets API is not enabled');
  });

  it('accepts null cells in sheets_write_range', async () => {
    stubFile(drive, 's1', GOOGLE_MIME.spreadsheet, 'Budget');
    sheets.updateValues.mockResolvedValueOnce({
      updatedRange: 'A!A1:B1',
      updatedRows: 1,
      updatedColumns: 2,
      updatedCells: 2,
    });
    const res = await client.callTool({
      name: 'sheets_write_range',
      arguments: { fileId: 's1', range: 'A!A1:B1', values: [[1, null]] },
    });
    expect(res.isError).toBeFalsy();
    expect(sheets.updateValues).toHaveBeenCalledWith('s1', 'A!A1:B1', [[1, '']], 'USER_ENTERED');
  });
});
