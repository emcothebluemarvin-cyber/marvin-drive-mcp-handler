import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { SlidesPresentation } from '../../drive/slides-adapter.js';
import { SLIDE_FIELDS, findElement, shapeText, slidesOutline } from '../slides-text.js';

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
        '- group g:',
        '  - element c1',
        '  - element c2',
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

describe('slides text refinements', () => {
  const tx = (c: string): { textElements: Array<{ textRun: { content: string } }> } => ({
    textElements: [{ textRun: { content: c } }],
  });
  const one = (el: object): SlidesPresentation => ({
    slides: [{ objectId: 's', pageElements: [el] }],
  });

  it('renders grouped children indented and finds them', () => {
    const p = one({
      objectId: 'g',
      elementGroup: {
        children: [
          { objectId: 'c1', shape: { shapeType: 'TEXT_BOX', text: tx('Hi\n') } },
          {
            objectId: 'c2',
            elementGroup: { children: [{ objectId: 'c3', shape: { text: tx('Deep\n') } }] },
          },
        ],
      },
    });
    expect(slidesOutline(p)).toBe(
      [
        '## Slide 1 · id=s',
        '- group g:',
        '  - shape c1 (TEXT_BOX): "Hi"',
        '  - group c2:',
        '    - shape c3 (SHAPE): "Deep"',
      ].join('\n'),
    );
    expect(findElement(p, 'c1')?.slideId).toBe('s');
    expect(findElement(p, 'c3')?.element.objectId).toBe('c3');
  });

  it('reads autoText content', () => {
    const el = {
      objectId: 'n',
      shape: {
        placeholder: { type: 'SLIDE_NUMBER' },
        text: { textElements: [{ autoText: { content: '3' } }] },
      },
    };
    expect(slidesOutline(one(el))).toContain('- shape n (SLIDE_NUMBER): "3"');
    expect(SLIDE_FIELDS).toContain('autoText(content)');
  });

  it('makes table cells single-line, escaped and capped', () => {
    const p = one({
      objectId: 'tb',
      table: {
        rows: 1,
        columns: 2,
        tableRows: [
          { tableCells: [{ text: tx('a|b\nc\n') }, { text: tx(`${'x'.repeat(150)}\n`) }] },
        ],
      },
    });
    expect(slidesOutline(p)).toContain(`- table tb 1x2: | a\\|b ⏎ c | ${'x'.repeat(100)}… |`);
  });

  it('does not split a surrogate pair at the 300 char cap', () => {
    const p = one({
      objectId: 'e',
      shape: { shapeType: 'TEXT_BOX', text: tx(`${'a'.repeat(299)}😀tail\n`) },
    });
    const out = slidesOutline(p);
    expect(out).toContain(`"${'a'.repeat(299)}…"`);
  });
});
