import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { SlidesPresentation } from '../../drive/slides-adapter.js';
import { findElement, shapeText, slidesOutline } from '../slides-text.js';

const demo = JSON.parse(
  readFileSync(new URL('./fixtures/demo-slides.json', import.meta.url), 'utf8'),
) as SlidesPresentation;

describe('slidesOutline', () => {
  it('lists every slide and element of the demo deck', () => {
    const out = slidesOutline(demo);
    const lines = out.split('\n');
    expect(lines[0]).toBe('## Slide 1 · id=p1');
    expect(lines[1]).toBe('- shape p1_i2 (TEXT_BOX): "marvin-drive"');
    expect(lines[2]).toBe('- shape p1_i3 (RECTANGLE): (empty)');
    expect(out.match(/^## Slide /gm)).toHaveLength(6);
    expect(out).not.toContain('Notes:');
  });

  it('renders tables, images, placeholders and notes', () => {
    const p: SlidesPresentation = {
      slides: [
        {
          objectId: 's1',
          pageElements: [
            {
              objectId: 't',
              shape: {
                shapeType: 'TEXT_BOX',
                placeholder: { type: 'TITLE' },
                text: { textElements: [{ textRun: { content: 'Hi\n' } }] },
              },
            },
            {
              objectId: 'tb',
              table: {
                rows: 1,
                columns: 2,
                tableRows: [
                  {
                    tableCells: [{ text: { textElements: [{ textRun: { content: 'a\n' } }] } }, {}],
                  },
                ],
              },
            },
            { objectId: 'img', image: {} },
            { objectId: 'g', elementGroup: { children: [{ objectId: 'c1' }, { objectId: 'c2' }] } },
          ],
          slideProperties: {
            notesPage: {
              notesProperties: { speakerNotesObjectId: 'n' },
              pageElements: [
                {
                  objectId: 'n',
                  shape: { text: { textElements: [{ textRun: { content: 'Say hi\n' } }] } },
                },
              ],
            },
          },
        },
      ],
    };
    expect(slidesOutline(p)).toBe(
      [
        '## Slide 1 · id=s1',
        '- shape t (TITLE): "Hi"',
        '- table tb 1x2: | a |  |',
        '- image img',
        '- group g: c1, c2',
        'Notes: "Say hi"',
      ].join('\n'),
    );
  });
});

describe('findElement / shapeText', () => {
  it('finds top-level elements and reads their text', () => {
    const found = findElement(demo, 'p1_i2');
    expect(found?.slideId).toBe('p1');
    expect(shapeText(found?.element.shape?.text)).toBe('marvin-drive');
    expect(findElement(demo, 'nope')).toBeUndefined();
  });
});
