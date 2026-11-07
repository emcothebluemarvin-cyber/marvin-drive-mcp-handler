import { beforeEach, describe, expect, it } from 'vitest';
import { MAX_DEPTH, Membership } from '../membership.js';
import { fileEntry, folderEntry } from './fakes.js';

let tree: Record<string, string[] | null>;
let calls: string[];
let m: Membership;
const F = folderEntry();

beforeEach(() => {
  tree = { DEEP: ['SUB'], SUB: ['F'], F: ['ROOT'], OTHER: ['ROOT'], ROOT: [], GONE: null };
  calls = [];
  m = new Membership(async (id) => {
    calls.push(id);
    return tree[id] ?? null;
  });
});

describe('Membership', () => {
  it('finds a watched ancestor folder of a nested file', async () => {
    expect(await m.covering('x', ['DEEP'], [F])).toEqual([F]);
    expect(calls).toEqual(['DEEP', 'SUB', 'F', 'ROOT']);
  });

  it('reuses cached parents', async () => {
    await m.covering('x', ['DEEP'], [F]);
    calls = [];
    expect(await m.covering('y', ['DEEP'], [F])).toEqual([F]);
    expect(calls).toEqual([]);
  });

  it('returns nothing for a file outside every watched folder', async () => {
    expect(await m.covering('x', ['OTHER'], [F])).toEqual([]);
  });

  it('noteFolder replaces cached parents (folder moved out of the watched folder)', async () => {
    await m.covering('x', ['DEEP'], [F]);
    m.noteFolder('SUB', ['OTHER']);
    calls = [];
    expect(await m.covering('x', ['DEEP'], [F])).toEqual([]);
    expect(calls).toEqual(['OTHER']); // SUB itself is not looked up again
  });

  it('noteFolder(null) forgets a folder so it is looked up again', async () => {
    await m.covering('x', ['DEEP'], [F]);
    m.noteFolder('SUB', null);
    calls = [];
    await m.covering('x', ['DEEP'], [F]);
    expect(calls).toEqual(['SUB']);
  });

  it('a file entry covers itself and needs no lookups without folder entries', async () => {
    const D = fileEntry();
    expect(await m.covering('D', ['DEEP'], [D])).toEqual([D]);
    expect(await m.covering('x', ['DEEP'], [D])).toEqual([]);
    expect(calls).toEqual([]);
  });

  it('stops at an inaccessible parent and caches it', async () => {
    expect(await m.covering('x', ['GONE'], [F])).toEqual([]);
    await m.covering('y', ['GONE'], [F]);
    expect(calls).toEqual(['GONE']);
  });

  it(`walks at most ${MAX_DEPTH} levels`, async () => {
    tree = {};
    for (let i = 0; i < 30; i++) tree[`c${i}`] = [`c${i + 1}`];
    const near = folderEntry({ id: 'c19' });
    const far = folderEntry({ id: 'c20' });
    expect(await m.covering('x', ['c0'], [near])).toEqual([near]);
    expect(await m.covering('x', ['c0'], [far])).toEqual([]);
  });

  it('returns every covering entry for nested watched folders', async () => {
    const SUB = folderEntry({ id: 'SUB', name: 'Sub' });
    const found = await m.covering('x', ['DEEP'], [F, SUB]);
    expect(found.map((e) => e.id).sort()).toEqual(['F', 'SUB']);
  });
});

describe('Membership review fixes', () => {
  it('does not look up parents at the last depth level', async () => {
    tree = {};
    for (let i = 0; i < 30; i++) tree[`c${i}`] = [`c${i + 1}`];
    await m.covering('x', ['c0'], [folderEntry({ id: 'far' })]);
    expect(calls).toHaveLength(MAX_DEPTH - 1);
  });
});
