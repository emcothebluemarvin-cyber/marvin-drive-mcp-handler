import type { SlidesRequest } from '../drive/slides-adapter.js';
import { ValidationError } from '../errors.js';
import {
  ContentService,
  requestKinds,
  type ContentFileRef,
  type Guard,
} from './content-service.js';
import { SLIDE_FIELDS, elementKind, findElement, shapeText, slidesOutline } from './slides-text.js';
import { DEFAULT_MAX_CHARS, sliceText, type TextSlice } from './truncate.js';

export interface SlidesReadInput extends ContentFileRef {
  maxChars?: number;
  offset?: number;
}

export interface SlidesReadResult extends TextSlice {
  fileId: string;
  name: string;
  revisionId: string;
  slideCount: number;
}

export interface SlidesReplaceInput extends ContentFileRef {
  find: string;
  replace: string;
  matchCase?: boolean;
  slideIds?: string[];
  requiredRevisionId?: string;
}

export interface SlidesSetTextInput extends ContentFileRef {
  objectId: string;
  text: string;
  requiredRevisionId?: string;
}

export interface SlidesBatchInput extends ContentFileRef {
  requests: Array<Record<string, unknown>>;
  requiredRevisionId: string;
}

const ARTICLE: Record<string, string> = { image: 'an image' };

export class SlidesService extends ContentService {
  protected readonly api = 'slides' as const;

  async read(input: SlidesReadInput): Promise<SlidesReadResult> {
    const file = await this.resolve(input.account, input.fileId);
    return this.run(input.account, file, 'idempotent', async (ctx) => {
      const p = await ctx.slides.getPresentation(file.id, SLIDE_FIELDS);
      return {
        fileId: file.id,
        name: file.name,
        revisionId: p.revisionId ?? '',
        slideCount: p.slides?.length ?? 0,
        ...sliceText(slidesOutline(p), input.offset ?? 0, input.maxChars ?? DEFAULT_MAX_CHARS),
      };
    });
  }

  async replaceText(
    input: SlidesReplaceInput,
  ): Promise<{ occurrencesChanged: number; revisionId: string | null }> {
    const file = await this.resolve(input.account, input.fileId);
    const matchCase = input.matchCase ?? true;
    return this.run(input.account, file, 'mutate', async (ctx) => {
      const res = await ctx.slides.batchUpdate(
        file.id,
        [
          {
            replaceAllText: {
              containsText: { text: input.find, matchCase },
              replaceText: input.replace,
              ...(input.slideIds && input.slideIds.length > 0
                ? { pageObjectIds: input.slideIds }
                : {}),
            },
          },
        ],
        input.requiredRevisionId,
      );
      const occurrencesChanged = res.replies?.[0]?.replaceAllText?.occurrencesChanged ?? 0;
      const guarded: Guard = input.requiredRevisionId ? 'caller' : false;
      await this.ops.audit(ctx, 'slides_replace_text', file, {
        occurrencesChanged,
        matchCase,
        guarded,
      });
      return { occurrencesChanged, revisionId: res.writeControl?.requiredRevisionId ?? null };
    });
  }

  async setText(
    input: SlidesSetTextInput,
  ): Promise<{ objectId: string; revisionId: string | null }> {
    const file = await this.resolve(input.account, input.fileId);
    const p = await this.run(input.account, file, 'idempotent', (ctx) =>
      ctx.slides.getPresentation(file.id, SLIDE_FIELDS),
    );
    const found = findElement(p, input.objectId);
    if (!found) {
      throw new ValidationError(
        `No page element "${input.objectId}" in "${file.name}"; run slides_read to list objectIds.`,
      );
    }
    const shape = found.element.shape;
    if (!shape) {
      const kind = elementKind(found.element);
      throw new ValidationError(
        `"${input.objectId}" is ${ARTICLE[kind] ?? `a ${kind}`}, not a text shape; use slides_batch_update.`,
      );
    }
    const requests: SlidesRequest[] = [];
    // Slides rejects deleteText on a shape without text.
    if (shapeText(shape.text).length > 0) {
      requests.push({ deleteText: { objectId: input.objectId, textRange: { type: 'ALL' } } });
    }
    if (input.text.length > 0) {
      requests.push({
        insertText: { objectId: input.objectId, insertionIndex: 0, text: input.text },
      });
    }
    if (requests.length === 0)
      return { objectId: input.objectId, revisionId: p.revisionId ?? null };

    const revision = input.requiredRevisionId ?? p.revisionId ?? undefined;
    const guarded: Guard = input.requiredRevisionId ? 'caller' : p.revisionId ? 'implicit' : false;
    return this.run(input.account, file, 'mutate', async (ctx) => {
      const res = await ctx.slides.batchUpdate(file.id, requests, revision);
      await this.ops.audit(ctx, 'slides_set_text', file, {
        objectId: input.objectId,
        chars: input.text.length,
        guarded,
      });
      return { objectId: input.objectId, revisionId: res.writeControl?.requiredRevisionId ?? null };
    });
  }

  async batchUpdate(
    input: SlidesBatchInput,
  ): Promise<{ replies: unknown[]; revisionId: string | null }> {
    const file = await this.resolve(input.account, input.fileId);
    return this.run(input.account, file, 'mutate', async (ctx) => {
      const res = await ctx.slides.batchUpdate(
        file.id,
        input.requests as SlidesRequest[],
        input.requiredRevisionId,
      );
      await this.ops.audit(ctx, 'slides_batch_update', file, {
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
