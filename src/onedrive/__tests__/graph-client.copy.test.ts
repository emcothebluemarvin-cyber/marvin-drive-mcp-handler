import { describe, expect, it } from 'vitest';
import { CopyStillRunningError, GraphApiError, NameConflictError } from '../../errors.js';
import {
  GRAPH,
  empty,
  fakeGraph,
  graphError,
  json,
  makeClient,
  type FakeCall,
} from './fake-graph.js';

const MONITOR = 'https://monitor.example/op?sig=secret';
const accepted = (): Response => empty(202, { location: MONITOR });
const readItem = async (id: string): Promise<{ id: string }> => ({ id });
const posts = (calls: FakeCall[]): FakeCall[] => calls.filter((c) => c.method === 'POST');

function client(responder: Parameters<typeof fakeGraph>[0]) {
  let clock = 0;
  const fake = fakeGraph(responder);
  const { client: c } = makeClient(fake, {
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
  });
  return { fake, c };
}

describe('GraphClient.copy', () => {
  it('polls the monitor without the token and reads the new item', async () => {
    let polls = 0;
    const { fake, c } = client((call) => {
      if (call.url.startsWith(GRAPH)) return accepted();
      polls++;
      return polls < 3
        ? json({ status: 'inProgress' }, 202)
        : json({ status: 'completed', resourceId: 'new-id' });
    });
    await expect(c.copy('/x/copy', { name: 'n' }, 'n', readItem)).resolves.toEqual({
      id: 'new-id',
    });
    const monitorCalls = fake.calls.filter((call) => call.url === MONITOR);
    expect(monitorCalls).toHaveLength(3);
    expect(monitorCalls.every((call) => call.headers.authorization === undefined)).toBe(true);
    expect(posts(fake.calls)).toHaveLength(1);
  });

  it('maps a failed copy with a name conflict', async () => {
    const { c } = client((call) =>
      call.url.startsWith(GRAPH)
        ? accepted()
        : json({ status: 'failed', error: { code: 'nameAlreadyExists', message: 'x' } }),
    );
    await expect(c.copy('/x', {}, 'a.txt', readItem)).rejects.toThrow(NameConflictError);
  });

  it('reports another failure generically', async () => {
    const { c } = client((call) =>
      call.url.startsWith(GRAPH)
        ? accepted()
        : json({ status: 'failed', error: { code: 'other', message: 'private' } }),
    );
    const err = (await c.copy('/x', {}, 'a', readItem).catch((e: unknown) => e)) as Error;
    expect(err).toBeInstanceOf(GraphApiError);
    expect(err.message).not.toContain('private');
  });

  it('gives up after 60 s without repeating the copy', async () => {
    const { fake, c } = client((call) =>
      call.url.startsWith(GRAPH) ? accepted() : json({ status: 'inProgress' }, 202),
    );
    await expect(c.copy('/x', {}, 'a', readItem)).rejects.toThrow(CopyStillRunningError);
    expect(posts(fake.calls)).toHaveLength(1);
    expect(fake.calls.filter((call) => call.url === MONITOR)).toHaveLength(30);
  });

  it('keeps polling through a failed monitor read', async () => {
    let polls = 0;
    const { c } = client((call) => {
      if (call.url.startsWith(GRAPH)) return accepted();
      if (polls++ === 0) throw new TypeError('fetch failed');
      return json({ status: 'completed', resourceId: 'id2' });
    });
    await expect(c.copy('/x', {}, 'a', readItem)).resolves.toEqual({ id: 'id2' });
  });

  it('retries only a 429 on the initial POST', async () => {
    let n = 0;
    const { fake, c } = client((call) => {
      if (!call.url.startsWith(GRAPH)) return json({ status: 'completed', resourceId: 'i' });
      return n++ === 0 ? json({}, 429) : accepted();
    });
    await c.copy('/x', {}, 'a', readItem);
    expect(posts(fake.calls)).toHaveLength(2);

    const failed = client(() => graphError(500, 'x'));
    await expect(failed.c.copy('/x', {}, 'a', readItem)).rejects.toThrow(GraphApiError);
    expect(posts(failed.fake.calls)).toHaveLength(1);
  });

  it('fails when Graph gives no monitor URL', async () => {
    const { c } = client(() => empty(202));
    await expect(c.copy('/x', {}, 'a', readItem)).rejects.toThrow(GraphApiError);
  });
});
