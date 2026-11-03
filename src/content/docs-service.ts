import type { Readable } from 'node:stream';
import type { DocsRequest } from '../drive/docs-adapter.js';
import { ValidationError } from '../errors.js';
import {
  ContentService,
  type ContentFileRef,
  type Guard,
  requestKinds,
} from './content-service.js';
import { DOC_FIELDS, bodyEndIndex, docOutline, headings } from './docs-structure.js';
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

export interface DocsReplaceInput extends ContentFileRef {
  find: string;
  replace: string;
  matchCase?: boolean;
  requiredRevisionId?: string;
}

export type InsertPosition =
  { at: 'end' } | { at: 'afterHeading'; heading: string } | { at: 'index'; index: number };

export interface DocsInsertInput extends ContentFileRef {
  text: string;
  position: InsertPosition;
  requiredRevisionId?: string;
}

export interface DocsEditResult {
  revisionId: string | null;
}

interface InsertPlan {
  index: number;
  text: string;
  /** Range to reset to NORMAL_TEXT, when the insert forms its own paragraph after a heading. */
  restyle?: { startIndex: number; endIndex: number };
  revisionId?: string;
}

export interface DocsBatchInput extends ContentFileRef {
  requests: Array<Record<string, unknown>>;
  requiredRevisionId: string;
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

  async replaceText(
    input: DocsReplaceInput,
  ): Promise<DocsEditResult & { occurrencesChanged: number }> {
    const file = await this.resolve(input.account, input.fileId);
    const matchCase = input.matchCase ?? true;
    return this.run(input.account, file, 'mutate', async (ctx) => {
      const res = await ctx.docs.batchUpdate(
        file.id,
        [
          {
            replaceAllText: {
              containsText: { text: input.find, matchCase },
              replaceText: input.replace,
            },
          },
        ],
        input.requiredRevisionId,
      );
      const occurrencesChanged = res.replies?.[0]?.replaceAllText?.occurrencesChanged ?? 0;
      const guarded: Guard = input.requiredRevisionId ? 'caller' : false;
      await this.ops.audit(ctx, 'docs_replace_text', file, {
        occurrencesChanged,
        matchCase,
        guarded,
      });
      return { occurrencesChanged, revisionId: res.writeControl?.requiredRevisionId ?? null };
    });
  }

  async insertText(input: DocsInsertInput): Promise<DocsEditResult & { insertedAt: number }> {
    const file = await this.resolve(input.account, input.fileId);
    const plan = await this.planInsert(input, file);
    const revision = input.requiredRevisionId ?? plan.revisionId;
    const guarded: Guard = input.requiredRevisionId
      ? 'caller'
      : plan.revisionId
        ? 'implicit'
        : false;
    const requests: DocsRequest[] = [
      { insertText: { location: { index: plan.index }, text: plan.text } },
    ];
    if (plan.restyle) {
      requests.push({
        updateParagraphStyle: {
          range: plan.restyle,
          paragraphStyle: { namedStyleType: 'NORMAL_TEXT' },
          fields: 'namedStyleType',
        },
      });
    }
    return this.run(input.account, file, 'mutate', async (ctx) => {
      const res = await ctx.docs.batchUpdate(file.id, requests, revision);
      await this.ops.audit(ctx, 'docs_insert_text', file, {
        position: input.position.at,
        insertedAt: plan.index,
        chars: input.text.length,
        guarded,
      });
      return { insertedAt: plan.index, revisionId: res.writeControl?.requiredRevisionId ?? null };
    });
  }

  private async planInsert(
    input: DocsInsertInput,
    file: { id: string; name: string },
  ): Promise<InsertPlan> {
    const pos = input.position;
    if (pos.at === 'index') return { index: pos.index, text: input.text };

    const doc = await this.run(input.account, file, 'idempotent', (ctx) =>
      ctx.docs.getDocument(file.id, DOC_FIELDS),
    );
    const revisionId = doc.revisionId ?? undefined;
    const end = bodyEndIndex(doc);
    const base = revisionId ? { revisionId } : {};
    if (pos.at === 'end') return { index: end - 1, text: input.text, ...base };

    const all = headings(doc);
    const heading = all.find((h) => h.text === pos.heading);
    if (!heading) {
      const names =
        all
          .slice(0, 20)
          .map((h) => JSON.stringify(h.text))
          .join(', ') || '(none)';
      throw new ValidationError(
        `Heading "${pos.heading}" not found in "${file.name}". Available headings: ${names}`,
      );
    }
    // Insert before the heading's own newline so the text becomes a separate paragraph whatever
    // follows (table, section break, list, end of body), then reset it to NORMAL_TEXT.
    const index = heading.endIndex - 1;
    const body = input.text.endsWith('\n') ? input.text.slice(0, -1) : input.text;
    const text = `\n${body}`;
    return {
      index,
      text,
      restyle: { startIndex: index + 1, endIndex: index + text.length + 1 },
      ...base,
    };
  }

  async batchUpdate(input: DocsBatchInput): Promise<DocsEditResult & { replies: unknown[] }> {
    const file = await this.resolve(input.account, input.fileId);
    return this.run(input.account, file, 'mutate', async (ctx) => {
      const res = await ctx.docs.batchUpdate(
        file.id,
        input.requests as DocsRequest[],
        input.requiredRevisionId,
      );
      await this.ops.audit(ctx, 'docs_batch_update', file, {
        requestCount: input.requests.length,
        requestKinds: requestKinds(input.requests),
        guarded: 'caller',
      });
      return {
        replies: res.replies ?? [],
        revisionId: res.writeControl?.requiredRevisionId ?? null,
      };
    });
  }
}
