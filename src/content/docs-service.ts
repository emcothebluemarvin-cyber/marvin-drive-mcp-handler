import type { Readable } from 'node:stream';
import { ContentService, type ContentFileRef } from './content-service.js';
import { DOC_FIELDS, docOutline } from './docs-structure.js';
import { DEFAULT_MAX_CHARS, sliceText, type TextSlice } from './truncate.js';

export type DocsReadFormat = 'markdown' | 'structure';

export interface DocsReadInput extends ContentFileRef {
  format?: DocsReadFormat;
  maxChars?: number;
  offset?: number;
}

export interface DocsReadResult extends TextSlice {
  fileId: string;
  name: string;
  revisionId: string;
  format: DocsReadFormat;
}

async function readAll(stream: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream)
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
  return Buffer.concat(chunks).toString('utf8');
}

export class DocsService extends ContentService {
  protected readonly api = 'docs' as const;

  async read(input: DocsReadInput): Promise<DocsReadResult> {
    const file = await this.resolve(input.account, input.fileId);
    const format = input.format ?? 'markdown';
    return this.run(input.account, file, 'idempotent', async (ctx) => {
      let revisionId: string;
      let text: string;
      if (format === 'markdown') {
        // Revision first: it is never newer than the exported content (spec §4.1).
        revisionId = (await ctx.docs.getDocument(file.id, 'revisionId')).revisionId ?? '';
        text = await readAll(await ctx.drive.exportMedia(file.id, 'text/markdown'));
      } else {
        const doc = await ctx.docs.getDocument(file.id, DOC_FIELDS);
        revisionId = doc.revisionId ?? '';
        text = docOutline(doc);
      }
      return {
        fileId: file.id,
        name: file.name,
        revisionId,
        format,
        ...sliceText(text, input.offset ?? 0, input.maxChars ?? DEFAULT_MAX_CHARS),
      };
    });
  }
}
