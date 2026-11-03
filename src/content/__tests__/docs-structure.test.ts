import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { DocsDocument } from '../../drive/docs-adapter.js';
import { bodyEndIndex, docOutline, headings } from '../docs-structure.js';

const demo = JSON.parse(
  readFileSync(new URL('./fixtures/demo-doc.json', import.meta.url), 'utf8'),
) as DocsDocument;

describe('docOutline', () => {
  it('renders indexed lines for the demo document', () => {
    const lines = docOutline(demo).split('\n');
    expect(lines[0]).toBe('[0-1] SECTION_BREAK');
    expect(lines[1]).toBe('[1-35] HEADING_1 "marvin-drive — Proje Genel Bakışı"');
    expect(lines).toContain('[162-168] HEADING_2 "Durum"');
    expect(lines).toContain('[403-867] TABLE 8x2');
    expect(lines).toContain('  (0,0) [406-413] NORMAL_TEXT "Katman"');
    expect(lines.at(-1)).toMatch(/^\[1927-2042\] NORMAL_TEXT "Bu belge/);
  });

  it('caps long paragraph text at 200 chars', () => {
    const long = 'x'.repeat(250);
    const doc: DocsDocument = {
      body: {
        content: [
          {
            startIndex: 1,
            endIndex: 252,
            paragraph: { elements: [{ textRun: { content: `${long}\n` } }] },
          },
        ],
      },
    };
    expect(docOutline(doc)).toBe(`[1-252] NORMAL_TEXT "${'x'.repeat(200)}…"`);
  });
});

describe('headings / bodyEndIndex', () => {
  it('lists top-level headings with ranges and finds the body end', () => {
    const hs = headings(demo);
    expect(hs[0]).toEqual({
      text: 'marvin-drive — Proje Genel Bakışı',
      startIndex: 1,
      endIndex: 35,
    });
    expect(hs.map((h) => h.text)).toContain('Durum');
    expect(bodyEndIndex(demo)).toBe(2042);
  });

  it('ignores headings inside tables', () => {
    const doc: DocsDocument = {
      body: {
        content: [
          {
            startIndex: 1,
            endIndex: 20,
            table: {
              rows: 1,
              columns: 1,
              tableRows: [
                {
                  tableCells: [
                    {
                      content: [
                        {
                          startIndex: 3,
                          endIndex: 8,
                          paragraph: {
                            paragraphStyle: { namedStyleType: 'HEADING_1' },
                            elements: [{ textRun: { content: 'Cell\n' } }],
                          },
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          },
        ],
      },
    };
    expect(headings(doc)).toEqual([]);
  });

  it('never returns an end index that would make the insert index 0', () => {
    expect(bodyEndIndex({})).toBe(2);
    expect(bodyEndIndex({ body: { content: [{ endIndex: 1, sectionBreak: {} }] } })).toBe(2);
  });
});
