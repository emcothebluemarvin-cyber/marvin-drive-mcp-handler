import { appendFile, mkdtemp, open, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { InboxTailer } from '../inbox.js';
import type { ChangeEvent } from '../types.js';
import { makeEvent } from './fakes.js';

let dir: string;
let file: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'tailer-'));
  file = path.join(dir, 'inbox.jsonl');
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const line = (e: ChangeEvent): string => `${JSON.stringify(e)}\n`;
const seqs = (events: ChangeEvent[]): number[] => events.map((e) => e.seq);

describe('InboxTailer', () => {
  it('returns nothing for a missing file, then new events once', async () => {
    const t = new InboxTailer(file);
    expect(await t.poll()).toEqual([]);
    await writeFile(file, line(makeEvent({ seq: 1 })) + line(makeEvent({ seq: 2 })));
    expect(seqs(await t.poll())).toEqual([1, 2]);
    expect(await t.poll()).toEqual([]);
    await appendFile(file, line(makeEvent({ seq: 3 })));
    expect(seqs(await t.poll())).toEqual([3]);
    expect(t.seenSeq).toBe(3);
  });

  it('buffers a partial last line, also inside a multi-byte character', async () => {
    const t = new InboxTailer(file);
    const bytes = Buffer.from(line(makeEvent({ seq: 1, name: 'Ayşe planı' })), 'utf8');
    const cut = bytes.indexOf(Buffer.from('ş', 'utf8')) + 1; // between the two bytes of ş
    await writeFile(file, bytes.subarray(0, cut));
    expect(await t.poll()).toEqual([]);
    await appendFile(file, bytes.subarray(cut));
    const [event] = await t.poll();
    expect(event?.name).toBe('Ayşe planı');
  });

  it('re-scans after rotation and returns only unseen seqs', async () => {
    const t = new InboxTailer(file);
    await writeFile(file, [1, 2, 3, 4].map((s) => line(makeEvent({ seq: s }))).join(''));
    expect(seqs(await t.poll())).toEqual([1, 2, 3, 4]);
    const tmp = path.join(dir, 'tmp');
    await writeFile(tmp, [3, 4, 5].map((s) => line(makeEvent({ seq: s }))).join(''));
    await rename(tmp, file);
    expect(seqs(await t.poll())).toEqual([5]);
  });

  it('re-scans when the file shrank in place', async () => {
    const t = new InboxTailer(file);
    await writeFile(file, [1, 2, 3].map((s) => line(makeEvent({ seq: s }))).join(''));
    await t.poll();
    await writeFile(file, line(makeEvent({ seq: 4 })));
    expect(seqs(await t.poll())).toEqual([4]);
  });
});

describe('InboxTailer review fixes', () => {
  it('takes inode and size from the opened file (rotation between stat and open)', async () => {
    await writeFile(file, [1, 2, 3, 4].map((s) => line(makeEvent({ seq: s }))).join(''));
    let rotateOnOpen = false;
    const t = new InboxTailer(file, {
      open: async (p, flags) => {
        if (rotateOnOpen) {
          rotateOnOpen = false;
          const tmp = path.join(dir, 'tmp');
          await writeFile(tmp, [3, 4, 5, 6].map((s) => line(makeEvent({ seq: s }))).join(''));
          await rename(tmp, file);
        }
        return open(p, flags);
      },
    });
    expect(seqs(await t.poll())).toEqual([1, 2, 3, 4]);
    rotateOnOpen = true;
    expect(seqs(await t.poll())).toEqual([5, 6]);
  });
});
