import type { docs_v1 } from 'googleapis';
import type { DocsDocument } from '../drive/docs-adapter.js';

type StructuralElement = docs_v1.Schema$StructuralElement;
type Paragraph = docs_v1.Schema$Paragraph;

/** Field mask for documents.get used by structure reads and index computation. */
const PARAGRAPH_FIELDS = 'paragraph(paragraphStyle(namedStyleType),elements(textRun(content)))';
export const DOC_FIELDS = `documentId,title,revisionId,body(content(startIndex,endIndex,${PARAGRAPH_FIELDS},table(rows,columns,tableRows(tableCells(content(startIndex,endIndex,${PARAGRAPH_FIELDS})))),sectionBreak(sectionStyle(sectionType)),tableOfContents(content(startIndex))))`;

const MAX_TEXT = 200;
const HEADING_STYLES = new Set([
  'TITLE',
  'SUBTITLE',
  'HEADING_1',
  'HEADING_2',
  'HEADING_3',
  'HEADING_4',
  'HEADING_5',
  'HEADING_6',
]);

export interface HeadingRef {
  text: string;
  startIndex: number;
  endIndex: number;
}

export function paragraphText(p: Paragraph): string {
  return (p.elements ?? []).map((e) => e.textRun?.content ?? '').join('');
}

function quote(text: string): string {
  const s = text.replace(/\n$/, '');
  return JSON.stringify(s.length > MAX_TEXT ? `${s.slice(0, MAX_TEXT)}…` : s);
}

function walk(content: StructuralElement[], depth: number, prefix: string, lines: string[]): void {
  const pad = '  '.repeat(depth);
  for (const el of content) {
    const range = `[${el.startIndex ?? 0}-${el.endIndex ?? 0}]`;
    if (el.paragraph) {
      const style = el.paragraph.paragraphStyle?.namedStyleType ?? 'NORMAL_TEXT';
      lines.push(`${pad}${prefix}${range} ${style} ${quote(paragraphText(el.paragraph))}`);
    } else if (el.table) {
      lines.push(`${pad}${prefix}${range} TABLE ${el.table.rows ?? 0}x${el.table.columns ?? 0}`);
      (el.table.tableRows ?? []).forEach((row, r) => {
        (row.tableCells ?? []).forEach((cell, c) => {
          walk(cell.content ?? [], depth + 1, `(${r},${c}) `, lines);
        });
      });
    } else if (el.sectionBreak) {
      lines.push(`${pad}${prefix}${range} SECTION_BREAK`);
    } else if (el.tableOfContents) {
      lines.push(`${pad}${prefix}${range} TABLE_OF_CONTENTS`);
    }
  }
}

/** One line per structural element with its [start-end) index range — input for docs_batch_update. */
export function docOutline(doc: DocsDocument): string {
  const lines: string[] = [];
  walk(doc.body?.content ?? [], 0, '', lines);
  return lines.join('\n');
}

/** Top-level heading paragraphs (headings inside tables are ignored). */
export function headings(doc: DocsDocument): HeadingRef[] {
  const out: HeadingRef[] = [];
  for (const el of doc.body?.content ?? []) {
    const style = el.paragraph?.paragraphStyle?.namedStyleType;
    if (!el.paragraph || !style || !HEADING_STYLES.has(style)) continue;
    out.push({
      text: paragraphText(el.paragraph).trim(),
      startIndex: el.startIndex ?? 0,
      endIndex: el.endIndex ?? 0,
    });
  }
  return out;
}

/** endIndex of the last body element (the body always ends with a paragraph). */
export function bodyEndIndex(doc: DocsDocument): number {
  const content = doc.body?.content ?? [];
  return Math.max(content.at(-1)?.endIndex ?? 2, 2);
}
