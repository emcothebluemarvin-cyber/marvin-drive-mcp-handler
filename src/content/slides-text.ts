import type {
  SlidesPageElement,
  SlidesPresentation,
  SlidesTextContent,
} from '../drive/slides-adapter.js';

const TEXT = 'text(textElements(textRun(content)))';
/** Field mask for presentations.get used by slides_read and slides_set_text. */
export const SLIDE_FIELDS = `presentationId,title,revisionId,slides(objectId,pageElements(objectId,shape(shapeType,placeholder(type),${TEXT}),table(rows,columns,tableRows(tableCells(${TEXT}))),image(contentUrl),line(lineType),elementGroup(children(objectId)),video(id),sheetsChart(spreadsheetId)),slideProperties(notesPage(notesProperties(speakerNotesObjectId),pageElements(objectId,shape(${TEXT})))))`;

const MAX_TEXT = 300;

/** Plain text of a shape/cell, without the trailing newline Slides always keeps. */
export function shapeText(text: SlidesTextContent | undefined): string {
  return (text?.textElements ?? [])
    .map((e) => e.textRun?.content ?? '')
    .join('')
    .replace(/\n$/, '');
}

function quote(s: string): string {
  return JSON.stringify(s.length > MAX_TEXT ? `${s.slice(0, MAX_TEXT)}…` : s);
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

function describeElement(el: SlidesPageElement): string {
  const id = el.objectId ?? '?';
  if (el.shape) {
    const kind = el.shape.placeholder?.type ?? el.shape.shapeType ?? 'SHAPE';
    const text = shapeText(el.shape.text);
    return `- shape ${id} (${kind}): ${text ? quote(text) : '(empty)'}`;
  }
  if (el.table) {
    const rows = (el.table.tableRows ?? []).map(
      (row) => `| ${(row.tableCells ?? []).map((cell) => shapeText(cell.text)).join(' | ')} |`,
    );
    return `- table ${id} ${el.table.rows ?? 0}x${el.table.columns ?? 0}: ${rows.join(' / ')}`;
  }
  if (el.elementGroup) {
    const children = (el.elementGroup.children ?? []).map((c) => c.objectId ?? '?');
    return `- group ${id}: ${children.join(', ')}`;
  }
  return `- ${elementKind(el)} ${id}`;
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

/** Top-level page element by objectId (group children are not searched). */
export function findElement(
  p: SlidesPresentation,
  objectId: string,
): { slideId: string; element: SlidesPageElement } | undefined {
  for (const slide of p.slides ?? []) {
    const element = (slide.pageElements ?? []).find((e) => e.objectId === objectId);
    if (element) return { slideId: slide.objectId ?? '', element };
  }
  return undefined;
}
