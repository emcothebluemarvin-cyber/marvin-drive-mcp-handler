import { beforeEach, describe, expect, it } from 'vitest';
import { ValidationError } from '../../errors.js';
import { GOOGLE_MIME } from '../../files/export-formats.js';
import {
  createAudit,
  createFakeDrive,
  createFakeSlides,
  createRunner,
  noSleep,
  silentLogger,
  stubFile,
  type FakeDrive,
  type FakeSlides,
} from '../../files/__tests__/fakes.js';
import { SlidesService } from '../slides-service.js';
import { SLIDE_FIELDS } from '../slides-text.js';

let drive: FakeDrive;
let slides: FakeSlides;
let audit: ReturnType<typeof createAudit>;
let service: SlidesService;

beforeEach(() => {
  drive = createFakeDrive();
  slides = createFakeSlides();
  audit = createAudit();
  service = new SlidesService({
    runner: createRunner(drive, { slides }),
    audit,
    retry: noSleep,
    logger: silentLogger(),
  });
});

const deck = (): void => stubFile(drive, 'p1', GOOGLE_MIME.presentation, 'Deck');

const PRESENTATION = {
  revisionId: 'rv1',
  slides: [
    {
      objectId: 's1',
      pageElements: [
        {
          objectId: 'full',
          shape: {
            shapeType: 'TEXT_BOX',
            text: { textElements: [{ textRun: { content: 'Old\n' } }] },
          },
        },
        { objectId: 'empty', shape: { shapeType: 'TEXT_BOX' } },
        { objectId: 'pic', image: {} },
      ],
    },
  ],
};

describe('SlidesService', () => {
  it('read returns the outline with revision and slide count', async () => {
    deck();
    slides.getPresentation.mockResolvedValueOnce(PRESENTATION);
    const res = await service.read({ fileId: 'p1' });
    expect(slides.getPresentation).toHaveBeenCalledWith('p1', SLIDE_FIELDS);
    expect(res).toMatchObject({
      fileId: 'p1',
      name: 'Deck',
      revisionId: 'rv1',
      slideCount: 1,
      truncated: false,
    });
    expect(res.content).toContain('- shape full (TEXT_BOX): "Old"');
  });

  it('replaceText scopes to slides and defaults missing counts to 0', async () => {
    deck();
    slides.batchUpdate.mockResolvedValueOnce({
      replies: [{ replaceAllText: {} }],
      writeControl: { requiredRevisionId: 'rv2' },
    });
    await expect(
      service.replaceText({ fileId: 'p1', find: 'a', replace: 'b', slideIds: ['s1'] }),
    ).resolves.toEqual({ occurrencesChanged: 0, revisionId: 'rv2' });
    expect(slides.batchUpdate).toHaveBeenCalledWith(
      'p1',
      [
        {
          replaceAllText: {
            containsText: { text: 'a', matchCase: true },
            replaceText: 'b',
            pageObjectIds: ['s1'],
          },
        },
      ],
      undefined,
    );
    expect(audit.entries[0]).toMatchObject({
      op: 'slides_replace_text',
      details: { occurrencesChanged: 0, guarded: false },
    });
  });

  it('setText replaces existing text under the implicit guard', async () => {
    deck();
    slides.getPresentation.mockResolvedValueOnce(PRESENTATION);
    slides.batchUpdate.mockResolvedValueOnce({ writeControl: { requiredRevisionId: 'rv3' } });
    await expect(service.setText({ fileId: 'p1', objectId: 'full', text: 'New' })).resolves.toEqual(
      {
        objectId: 'full',
        revisionId: 'rv3',
      },
    );
    expect(slides.batchUpdate).toHaveBeenCalledWith(
      'p1',
      [
        { deleteText: { objectId: 'full', textRange: { type: 'ALL' } } },
        { insertText: { objectId: 'full', insertionIndex: 0, text: 'New' } },
      ],
      'rv1',
    );
    expect(audit.entries[0]?.details).toEqual({ objectId: 'full', chars: 3, guarded: 'implicit' });
  });

  it('setText skips deleteText on an empty shape and uses the caller revision', async () => {
    deck();
    slides.getPresentation.mockResolvedValueOnce(PRESENTATION);
    slides.batchUpdate.mockResolvedValueOnce({});
    await service.setText({
      fileId: 'p1',
      objectId: 'empty',
      text: 'Fill',
      requiredRevisionId: 'mine',
    });
    expect(slides.batchUpdate).toHaveBeenCalledWith(
      'p1',
      [{ insertText: { objectId: 'empty', insertionIndex: 0, text: 'Fill' } }],
      'mine',
    );
  });

  it('setText with empty text only clears', async () => {
    deck();
    slides.getPresentation.mockResolvedValueOnce(PRESENTATION);
    slides.batchUpdate.mockResolvedValueOnce({});
    await service.setText({ fileId: 'p1', objectId: 'full', text: '' });
    expect(slides.batchUpdate.mock.calls[0]?.[1]).toEqual([
      { deleteText: { objectId: 'full', textRange: { type: 'ALL' } } },
    ]);
  });

  it('setText on an empty shape with empty text makes no API call', async () => {
    deck();
    slides.getPresentation.mockResolvedValueOnce(PRESENTATION);
    await expect(service.setText({ fileId: 'p1', objectId: 'empty', text: '' })).resolves.toEqual({
      objectId: 'empty',
      revisionId: 'rv1',
    });
    expect(slides.batchUpdate).not.toHaveBeenCalled();
  });

  it('setText rejects unknown ids and non-text elements', async () => {
    deck();
    slides.getPresentation.mockResolvedValueOnce(PRESENTATION);
    await expect(service.setText({ fileId: 'p1', objectId: 'zzz', text: 'x' })).rejects.toThrow(
      'No top-level page element "zzz" in "Deck"; run slides_read to list objectIds.',
    );
    deck();
    slides.getPresentation.mockResolvedValueOnce(PRESENTATION);
    const err = await service
      .setText({ fileId: 'p1', objectId: 'pic', text: 'x' })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ValidationError);
    expect((err as Error).message).toBe(
      '"pic" is an image, not a text shape; use slides_batch_update.',
    );
  });

  it('batchUpdate sends raw requests under the required revision', async () => {
    deck();
    slides.batchUpdate.mockResolvedValueOnce({
      replies: [{}],
      writeControl: { requiredRevisionId: 'rv9' },
    });
    const requests = [{ deleteObject: { objectId: 'pic' } }];
    await expect(
      service.batchUpdate({ fileId: 'p1', requests, requiredRevisionId: 'rv1' }),
    ).resolves.toEqual({
      replies: [{}],
      revisionId: 'rv9',
    });
    expect(audit.entries[0]?.details).toEqual({
      requestCount: 1,
      requestKinds: ['deleteObject'],
      guarded: 'caller',
    });
  });
});
