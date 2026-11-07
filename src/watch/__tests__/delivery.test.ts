import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { silentLogger } from '../../files/__tests__/fakes.js';
import { Delivery, type PushFn } from '../delivery.js';
import { Inbox, InboxTailer } from '../inbox.js';
import type { ChangeEvent } from '../types.js';
import { PREAMBLE } from '../render.js';
import { WatchStore } from '../watch-store.js';
import { makeEvent } from './fakes.js';

let tmp: string;
let store: WatchStore;
let inbox: Inbox;

function session(push: PushFn): Delivery {
  return new Delivery({ store, tailer: new InboxTailer(inbox.file), push, log: silentLogger() });
}

beforeEach(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), 'delivery-'));
  store = new WatchStore({ dir: tmp, logger: silentLogger() });
  inbox = new Inbox(path.join(tmp, 'inbox.jsonl'));
});
afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe('Delivery', () => {
  it('hook mode pushes nothing and never replays after switching to channel', async () => {
    const push = vi.fn<PushFn>(async () => {});
    const d = session(push);
    await inbox.append(makeEvent({ seq: 1 }));
    await d.start();
    await inbox.append(makeEvent({ seq: 2 }));
    await d.onTick();
    await store.saveDelivery('channel');
    await d.onTick();
    expect(push).not.toHaveBeenCalled();
  });

  it('channel mode pushes each new foreign event once with the spec meta', async () => {
    await store.saveDelivery('channel');
    const push = vi.fn<PushFn>(async () => {});
    const d = session(push);
    await d.start();
    await inbox.append(makeEvent({ seq: 1 }));
    await inbox.append(makeEvent({ seq: 2, own: true }));
    await d.onTick();
    await d.onTick();
    expect(push).toHaveBeenCalledTimes(1);
    const [content, meta] = push.mock.calls[0] ?? [];
    expect(content?.startsWith(`${PREAMBLE}\nedited "Plan"`)).toBe(true);
    expect(meta).toEqual({
      account: 'me@example.com',
      file_id: 'D',
      event_id: 'me@example.com:D:1',
      kind: 'edited',
    });
    expect(Object.keys(meta ?? {}).every((k) => /^[a-z_]+$/.test(k))).toBe(true);
    expect((await store.loadRead()).pushedSeq).toBe(1);
  });

  it('every open session receives the push', async () => {
    await store.saveDelivery('channel');
    const a = vi.fn<PushFn>(async () => {});
    const b = vi.fn<PushFn>(async () => {});
    const da = session(a);
    const db = session(b);
    await da.start();
    await db.start();
    await inbox.append(makeEvent({ seq: 1 }));
    await Promise.all([da.onTick(), db.onTick()]);
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });

  it('does not push an event that is already read', async () => {
    await store.saveDelivery('channel');
    const push = vi.fn<PushFn>(async () => {});
    const d = session(push);
    await d.start();
    await inbox.append(makeEvent({ seq: 1 }));
    await store.saveRead({ readSeq: 1, readIds: [], pushedSeq: 0 });
    await d.onTick();
    expect(push).not.toHaveBeenCalled();
  });

  it('pushes one startup summary of unread events not pushed to any session', async () => {
    await store.saveDelivery('channel');
    await inbox.append(makeEvent({ seq: 1 }));
    await inbox.append(makeEvent({ seq: 2, own: true }));
    await inbox.append(makeEvent({ seq: 3, name: 'Budget' }));
    const first = vi.fn<PushFn>(async () => {});
    await session(first).start();
    expect(first).toHaveBeenCalledTimes(1);
    const [content, meta] = first.mock.calls[0] ?? [];
    expect(content).toContain('2 Drive changes while you were away:');
    expect(meta).toMatchObject({ kind: 'summary', event_id: 'me@example.com:D:3' });
    expect((await store.loadRead()).pushedSeq).toBe(3);
    const second = vi.fn<PushFn>(async () => {});
    await session(second).start();
    expect(second).not.toHaveBeenCalled();
  });

  it('treats an invalid config.json as hook mode and warns once', async () => {
    await writeFile(path.join(tmp, 'config.json'), '{');
    const push = vi.fn<PushFn>(async () => {});
    const log = silentLogger();
    const d = new Delivery({ store, tailer: new InboxTailer(inbox.file), push, log });
    await d.start();
    for (let seq = 1; seq <= 3; seq++) {
      await inbox.append(makeEvent({ seq }));
      await d.onTick();
    }
    expect(push).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledTimes(1);
    await store.saveDelivery('channel');
    await inbox.append(makeEvent({ seq: 4 }));
    await d.onTick();
    expect(push).toHaveBeenCalledTimes(1); // the hook-mode events were consumed, not replayed
  });

  it('pushes an event once when a failed drain is followed by a rescan', async () => {
    await store.saveDelivery('channel');
    const push = vi.fn<PushFn>(async () => {});
    const e1 = makeEvent({ seq: 1 });
    const batches: ChangeEvent[][] = [[], [e1], [e1]];
    const tailer = { poll: async () => batches.shift() ?? [] } as unknown as InboxTailer;
    const d = new Delivery({ store, tailer, push, log: silentLogger() });
    await d.start();
    await writeFile(path.join(tmp, 'read.json'), '{');
    await d.onTick(); // read fails: e1 stays in the backlog
    await store.saveRead({ readSeq: 0, readIds: [], pushedSeq: 0 });
    await d.onTick(); // the rotated inbox is rescanned: e1 again
    expect(push).toHaveBeenCalledTimes(1);
  });
});
