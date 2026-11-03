import type {
  SlidesPageElement,
  SlidesPresentation,
  SlidesTextContent,
} from '../drive/slides-adapter.js';

const TEXT = 'text(textElements(textRun(content),autoText(content)))';
const SHAPE = `shape(shapeType,placeholder(type),${TEXT})`;
/** Field mask for presentations.get used by slides_read and slides_set_text. */
export const SLIDE_FIELDS = `presentationId,title,revisionId,slides(objectId,pageElements(objectId,${SHAPE},table(rows,columns,tableRows(tableCells(${TEXT}))),image(contentUrl),line(lineType),elementGroup(children(objectId,${SHAPE},elementGroup(children(objectId)))),video(id),sheetsChart(spreadsheetId)),slideProperties(notesPage(notesProperties(speakerNotesObjectId),pageElements(objectId,shape(${TEXT})))))`;

const MAX_TEXT = 300;
const MAX_CELL = 100;

/** Plain text of a shape/cell, without the trailing newline Slides always keeps. */
export function shapeText(text: SlidesTextContent | undefined): string {
  return (text?.textElements ?? [])
    .map((e) => e.textRun?.content ?? e.autoText?.content ?? '')
    .join('')
    .replace(/\n$/, '');
}

/** Cut to at most `max` UTF-16 units without splitting a surrogate pair. */
function clip(s: string, max: number): string {
  if (s.length <= max) return s;
  const last = s.charCodeAt(max - 1);
  const end = last >= 0xd800 && last <= 0xdbff ? max - 1 : max;
  return `${s.slice(0, end)}…`;
}

function quote(s: string): string {
  return JSON.stringify(clip(s, MAX_TEXT));
}

function cellText(s: string): string {
  return clip(s.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ⏎ '), MAX_CELL);
}

export function elementKind(el: SlidesPageElement): string {
  if (el.shape) return 'shape';
  if (el.table) return 'table';
  if (el.image) return 'image';
  if (el.line) return 'line';
  if (el.video) return 'video';
  if (el.sheetsChart) return 'chart';
  if (el.elementGroup) return 'group';
  return 'element';
}

function describeElement(el: SlidesPageElement, indent = ''): string {
  const id = el.objectId ?? '?';
  if (el.shape) {
    const kind = el.shape.placeholder?.type ?? el.shape.shapeType ?? 'SHAPE';
    const text = shapeText(el.shape.text);
    return `${indent}- shape ${id} (${kind}): ${text ? quote(text) : '(empty)'}`;
  }
  if (el.table) {
    const rows = (el.table.tableRows ?? []).map(
      (row) =>
        `| ${(row.tableCells ?? []).map((cell) => cellText(shapeText(cell.text))).join(' | ')} |`,
    );
    return `${indent}- table ${id} ${el.table.rows ?? 0}x${el.table.columns ?? 0}: ${rows.join(' / ')}`;
  }
  if (el.elementGroup) {
    const children = (el.elementGroup.children ?? []).map((c) => describeElement(c, `${indent}  `));
    return [`${indent}- group ${id}:`, ...children].join('\n');
  }
  return `${indent}- ${elementKind(el)} ${id}`;
}

/** One block per slide: element objectIds with their text, then speaker notes. */
export function slidesOutline(p: SlidesPresentation): string {
  const blocks = (p.slides ?? []).map((slide, i) => {
    const lines = [`## Slide ${i + 1} · id=${slide.objectId ?? '?'}`];
    for (const el of slide.pageElements ?? []) lines.push(describeElement(el));
    const notesPage = slide.slideProperties?.notesPage;
    const notesId = notesPage?.notesProperties?.speakerNotesObjectId;
    const notes = notesPage?.pageElements?.find((e) => e.objectId === notesId);
    const notesText = shapeText(notes?.shape?.text);
    if (notesText) lines.push(`Notes: ${quote(notesText)}`);
    return lines.join('\n');
  });
  return blocks.join('\n\n');
}

function search(elements: SlidesPageElement[], objectId: string): SlidesPageElement | undefined {
  for (const el of elements) {
    if (el.objectId === objectId) return el;
    const inner = search(el.elementGroup?.children ?? [], objectId);
    if (inner) return inner;
  }
  return undefined;
}

/** Page element by objectId, including children of groups. */
export function findElement(
  p: SlidesPresentation,
  objectId: string,
): { slideId: string; element: SlidesPageElement } | undefined {
  for (const slide of p.slides ?? []) {
    const element = search(slide.pageElements ?? [], objectId);
    if (element) return { slideId: slide.objectId ?? '', element };
  }
  return undefined;
}
