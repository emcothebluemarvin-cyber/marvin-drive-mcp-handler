import { describe, expect, it } from 'vitest';
import { clip, sliceText } from '../truncate.js';

describe('clip', () => {
  it('returns short strings unchanged', () => {
    expect(clip('abc', 3)).toBe('abc');
  });

  it('cuts with an ellipsis', () => {
    expect(clip('abcdef', 3)).toBe('abc…');
  });

  it('never splits a surrogate pair', () => {
    expect(clip('ab😀cd', 3)).toBe('ab…');
  });
});

describe('sliceText', () => {
  it('treats non-finite inputs as defaults', () => {
    const r = sliceText('hello', Number.NaN, Number.NaN);
    expect(r).toMatchObject({ content: 'hello', offset: 0, truncated: false });
  });

  it('returns everything when it fits', () => {
    expect(sliceText('hello', 0, 10)).toEqual({
      content: 'hello',
      totalChars: 5,
      offset: 0,
      truncated: false,
    });
  });

  it('pages with nextOffset', () => {
    const first = sliceText('abcdef', 0, 4);
    expect(first).toEqual({
      content: 'abcd',
      totalChars: 6,
      offset: 0,
      truncated: true,
      nextOffset: 4,
    });
    expect(sliceText('abcdef', 4, 4)).toEqual({
      content: 'ef',
      totalChars: 6,
      offset: 4,
      truncated: false,
    });
  });

  it('never splits a surrogate pair at the end', () => {
    const text = 'ab😀cd'; // 😀 occupies indexes 2-3
    const r = sliceText(text, 0, 3);
    expect(r.content).toBe('ab');
    expect(r.nextOffset).toBe(2);
    expect(sliceText(text, 2, 3).content).toBe('😀c');
  });

  it('moves a start offset that lands inside a pair back to the pair start', () => {
    expect(sliceText('ab😀cd', 3, 10)).toMatchObject({ content: '😀cd', offset: 2 });
  });

  it('always makes progress', () => {
    expect(sliceText('😀', 0, 1)).toMatchObject({ content: '😀', truncated: false });
  });

  it('clamps out-of-range offsets', () => {
    expect(sliceText('abc', 99, 10)).toEqual({
      content: '',
      totalChars: 3,
      offset: 3,
      truncated: false,
    });
  });
});
