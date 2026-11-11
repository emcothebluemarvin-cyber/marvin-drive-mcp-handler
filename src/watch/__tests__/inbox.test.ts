import {
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  utimes,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { expectMode } from '../../__tests__/fs-mode.js';
import { Inbox, InboxWriter, KEEP_NEWEST, ROTATE_AT_LINES, parseEvents } from '../inbox.js';
import type { ChangeEvent } from '../types.js';
import { makeDraft, makeEvent } from './fakes.js';

let dir: string;
let file: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'inbox-'));
  file = path.join(dir, 'watch', 'inbox.jsonl');
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const line = (e: ChangeEvent): string => `${JSON.stringify(e)}\n`;

describe('Inbox', () => {
  it('appends JSON lines (0600) and reads them back', async () => {
    const inbox = new Inbox(file);
    expect(await inbox.readAll()).toEqual([]);
    await inbox.append(makeEvent({ seq: 1 }));
    await inbox.append(makeEvent({ seq: 2 }));
    expect((await inbox.readAll()).map((e) => e.seq)).toEqual([1, 2]);
    await expectMode(file, 0o600);
  });

  it('parses complete lines only and skips malformed ones', () => {
    const text = `${line(makeEvent({ seq: 1 }))}not json\n{"x":1}\n${JSON.stringify(makeEvent({ seq: 2 })).slice(0, 20)}`;
    expect(parseEvents(text).map((e) => e.seq)).toEqual([1]);
  });

  it('rotates over 1000 lines: newest 500 plus young unread events', async () => {
    const now = new Date('2026-11-07T12:00:00.000Z');
    const old = '2026-09-01T00:00:00.000Z';
    const young = '2026-11-06T00:00:00.000Z';
    const events = Array.from({ length: ROTATE_AT_LINES + 1 }, (_, i) =>
      makeEvent({ seq: i + 1, time: i + 1 === 10 ? old : young }),
    );
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, events.map(line).join(''));
    const unread = new Set([5, 10, 600]);
    const inbox = new Inbox(file);
    expect(await inbox.rotateIfNeeded((e) => unread.has(e.seq), now)).toBe(true);
    const kept = (await inbox.readAll()).map((e) => e.seq);
    expect(kept).toHaveLength(KEEP_NEWEST + 1);
    expect(kept[0]).toBe(5);
    expect(kept).not.toContain(10);
    expect(kept.slice(1)[0]).toBe(ROTATE_AT_LINES + 1 - KEEP_NEWEST + 1);
    await expectMode(file, 0o600);
    expect(await inbox.rotateIfNeeded(() => true, now)).toBe(false);
  });
});

describe('InboxWriter', () => {
  it('continues the sequence of the existing file', async () => {
    const inbox = new Inbox(file);
    await inbox.append(makeEvent({ seq: 7 }));
    const writer = new InboxWriter(inbox);
    await writer.init();
    const appended = await writer.append(makeDraft({ id: 'new' }));
    expect(appended?.seq).toBe(8);
    expect(writer.lastSeq).toBe(8);
  });

  it('skips an id already in the last 500 events (crash between append and removal)', async () => {
    const inbox = new Inbox(file);
    const first = new InboxWriter(inbox);
    await first.init();
    await first.append(makeDraft({ id: 'me@example.com:D:t1' }));
    const restarted = new InboxWriter(inbox);
    await restarted.init();
    expect(await restarted.append(makeDraft({ id: 'me@example.com:D:t1' }))).toBeNull();
    const lines = (await readFile(file, 'utf8')).trim().split('\n');
    expect(lines).toHaveLength(1);
  });

  it('ends a torn last line before appending', async () => {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, `${line(makeEvent({ seq: 1 }))}{"seq":2,"id":"tor`);
    const writer = new InboxWriter(new Inbox(file));
    await writer.init();
    await writer.append(makeDraft({ id: 'next' }));
    expect((await new Inbox(file).readAll()).map((e) => e.id)).toEqual([
      makeEvent({ seq: 1 }).id,
      'next',
    ]);
  });
});

describe('Inbox review fixes', () => {
  const now = new Date('2026-11-07T12:00:00.000Z');
  const young = '2026-11-06T00:00:00.000Z';
  const many = (n: number): ChangeEvent[] =>
    Array.from({ length: n }, (_, i) => makeEvent({ seq: i + 1, time: young }));

  it('does not rewrite the file when rotation would drop fewer than 100 events', async () => {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(
      file,
      many(ROTATE_AT_LINES + 1)
        .map(line)
        .join(''),
    );
    const inode = (await stat(file)).ino;
    const inbox = new Inbox(file);
    expect(await inbox.rotateIfNeeded(() => true, now)).toBe(false);
    expect(await inbox.rotateIfNeeded(() => true, now)).toBe(false);
    expect((await stat(file)).ino).toBe(inode);
  });

  it('rotates to repair torn or blank lines even when few events are dropped', async () => {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(
      file,
      `${many(ROTATE_AT_LINES + 1)
        .map(line)
        .join('')}\nnot json\n`,
    );
    const inbox = new Inbox(file);
    expect(await inbox.rotateIfNeeded(() => true, now)).toBe(true);
    const text = await readFile(file, 'utf8');
    expect(text.trim().split('\n')).toHaveLength(ROTATE_AT_LINES + 1);
    expect(text).not.toContain('not json');
  });

  it('InboxWriter never reuses a seq at or below the given floor', async () => {
    const writer = new InboxWriter(new Inbox(file));
    await writer.init(41);
    expect((await writer.append(makeDraft({ id: 'n' })))?.seq).toBe(42);
  });

  it('InboxWriter.init sweeps temp files older than an hour', async () => {
    const watchDir = path.dirname(file);
    await mkdir(watchDir, { recursive: true });
    const oldTmp = path.join(watchDir, '.inbox.jsonl.abc.tmp');
    const newTmp = path.join(watchDir, '.inbox.jsonl.def.tmp');
    await writeFile(oldTmp, 'x');
    await writeFile(newTmp, 'x');
    const hourAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await utimes(oldTmp, hourAgo, hourAgo);
    await new InboxWriter(new Inbox(file)).init();
    await expect(stat(oldTmp)).rejects.toThrow();
    await expect(stat(newTmp)).resolves.toBeDefined();
  });

  it('InboxWriter repairs a torn tail left by a failed append before the next one', async () => {
    const inbox = new Inbox(file);
    const writer = new InboxWriter(inbox);
    await writer.init();
    const real = inbox.append.bind(inbox);
    vi.spyOn(inbox, 'append').mockImplementationOnce(async () => {
      await mkdir(path.dirname(file), { recursive: true });
      await appendFile(file, '{"seq":1,"id":"torn'); // partial write, then the failure
      throw new Error('ENOSPC');
    });
    await expect(writer.append(makeDraft({ id: 'a' }))).rejects.toThrow('ENOSPC');
    vi.mocked(inbox.append).mockImplementation(real);
    await writer.append(makeDraft({ id: 'b' }));
    expect((await inbox.readAll()).map((e) => e.id)).toEqual(['b']);
  });
});
