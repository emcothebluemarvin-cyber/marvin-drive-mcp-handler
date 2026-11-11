import { describe, expect, it } from 'vitest';
import {
  HEADLINE_LIMIT,
  HOOK_LIMIT,
  PREAMBLE,
  PREAMBLE_MANY,
  PUSH_LIMIT,
  SUMMARY_LIMIT,
  authors,
  detailsLine,
  headline,
  renderEvent,
  renderEvents,
  renderFull,
  renderSummary,
} from '../render.js';
import { AYSE, BORA, ME, makeEvent } from './fakes.js';

const longDiff = Array.from({ length: 400 }, (_, i) => `+ line ${i} ${'x'.repeat(20)}`).join('\n');

describe('headline and authors', () => {
  it('names foreign modifiers, you, someone and mixed authorship', () => {
    expect(authors(makeEvent({ modifiers: [AYSE, BORA] }))).toBe('Ayşe Demir, Bora');
    expect(authors(makeEvent({ modifiers: [ME], own: true }))).toBe('you');
    expect(authors(makeEvent({ modifiers: [] }))).toBe('someone');
    expect(authors(makeEvent({ modifiers: [AYSE, ME], alsoByYou: true }))).toBe(
      'Ayşe Demir (also edited by you)',
    );
    const commented = makeEvent({
      kind: 'commented',
      modifiers: [],
      comments: [{ type: 'comment', commentId: 'c', author: BORA, content: 'hi', time: 't' }],
    });
    expect(authors(commented)).toBe('Bora');
  });

  it('formats file and system headlines', () => {
    expect(headline(makeEvent())).toBe('edited "Plan" by Ayşe Demir at 2026-11-07T11:00:00.000Z');
    expect(headline(makeEvent({ kind: 'renamed', name: 'Plan v2', previousName: 'Plan' }))).toBe(
      'renamed "Plan v2" (was "Plan") by Ayşe Demir at 2026-11-07T11:00:00.000Z',
    );
    expect(
      headline(
        makeEvent({ kind: 'gap', fileId: null, note: 'changes between A and B may be missing' }),
      ),
    ).toBe('gap: changes between A and B may be missing (me@example.com)');
    expect(headline(makeEvent({ kind: 'watch-paused', note: 'sign in again' }))).toBe(
      'watch paused: sign in again',
    );
  });
});

describe('renderEvent (channel push)', () => {
  it('follows the spec §8.2 template', () => {
    const e = makeEvent({ seq: 4, note: 'first seen in a watched folder' });
    expect(renderEvent(e).split('\n')).toEqual([
      PREAMBLE,
      'edited "Plan" by Ayşe Demir at 2026-11-07T11:00:00.000Z',
      '(first seen in a watched folder)',
      '- a',
      '+ b',
      'Full details: drive_changes { "eventId": "me@example.com:D:4" }',
    ]);
  });

  it('lists new comments', () => {
    const e = makeEvent({
      diff: null,
      comments: [{ type: 'reply', commentId: 'c', author: BORA, content: 'ok\nmore', time: 't' }],
    });
    expect(renderEvent(e)).toContain('\nreply by Bora: ok\n');
  });

  it(`stays within ${PUSH_LIMIT} characters and points to drive_changes`, () => {
    const text = renderEvent(makeEvent({ diff: longDiff }));
    expect(text.length).toBeLessThanOrEqual(PUSH_LIMIT);
    expect(text).toMatch(/… \d+ more changes; use drive_changes\nFull details/);
  });

  it('adds the changes behind a stored tail line to the pushed count', () => {
    const stored = `${longDiff}\n… 37 more changed lines not shown`;
    const text = renderEvent(makeEvent({ diff: stored }));
    const shownLines = text.split('\n').filter((l) => l.startsWith('+ line')).length;
    expect(text).toContain(`… ${400 - shownLines + 37} more changes; use drive_changes`);
    expect(text).not.toContain('not shown');
  });

  it('clamps a long headline without splitting a surrogate pair and keeps the footer', () => {
    for (const name of ['😀'.repeat(1200), `x${'😀'.repeat(1200)}`]) {
      const e = makeEvent({ name });
      expect(headline(e).length).toBeLessThanOrEqual(HEADLINE_LIMIT);
      expect(headline(e).endsWith('…')).toBe(true);
      const text = renderEvent(e);
      expect(text.length).toBeLessThanOrEqual(PUSH_LIMIT);
      expect(text).toContain('\n- a\n+ b\n');
      expect(text.endsWith(detailsLine(e))).toBe(true);
      expect(text).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
    }
  });
});

describe('renderEvents (hook)', () => {
  it('prints the preamble once and every event while it fits', () => {
    const { text, shown } = renderEvents([makeEvent({ seq: 1 }), makeEvent({ seq: 2 })]);
    expect(text.startsWith(`${PREAMBLE_MANY}\nedited "Plan"`)).toBe(true);
    expect(text.split(PREAMBLE_MANY)).toHaveLength(2);
    expect(shown.map((e) => e.seq)).toEqual([1, 2]);
  });

  it(`caps at ${HOOK_LIMIT} characters and counts the rest`, () => {
    const events = Array.from({ length: 30 }, (_, i) => makeEvent({ seq: i + 1, diff: longDiff }));
    const { text, shown } = renderEvents(events);
    expect(text.length).toBeLessThanOrEqual(HOOK_LIMIT);
    expect(shown.length).toBeGreaterThan(0);
    expect(shown.length).toBeLessThan(30);
    expect(text).toMatch(
      new RegExp(`… ${30 - shown.length} more Drive changes; use drive_changes$`),
    );
  });
});

describe('renderSummary and renderFull', () => {
  it('summarises unread events for the startup push', () => {
    const text = renderSummary([makeEvent({ seq: 1 }), makeEvent({ seq: 2, name: 'Budget' })]);
    expect(text).toContain('2 Drive changes while you were away:');
    expect(text).toContain('- edited "Budget" by Ayşe Demir');
    expect(text.endsWith('Details: drive_changes {}')).toBe(true);
    const many = renderSummary(Array.from({ length: 200 }, (_, i) => makeEvent({ seq: i + 1 })));
    expect(many.length).toBeLessThanOrEqual(SUMMARY_LIMIT);
    expect(many).toMatch(/… \d+ more/);
  });

  it('prints the whole stored diff for the CLI', () => {
    const text = renderFull(
      makeEvent({
        seq: 9,
        diff: longDiff,
        comments: [
          { type: 'comment', commentId: 'c', author: BORA, content: 'one\ntwo', time: 't' },
        ],
      }),
    );
    expect(text).toContain('#9 edited "Plan"');
    expect(text).toContain('+ line 399');
    expect(text).toContain('comment by Bora: one\ntwo');
  });
});
