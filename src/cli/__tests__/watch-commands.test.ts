import { Command } from 'commander';
import { describe, expect, it, vi } from 'vitest';
import { ValidationError } from '../../errors.js';
import type { DeliveryMode } from '../../watch/types.js';
import { fileEntry, folderEntry, makeEvent } from '../../watch/__tests__/fakes.js';
import { registerWatchCommands, type WatchCliDeps } from '../watch-commands.js';

function setup() {
  const lines: string[] = [];
  let mode: DeliveryMode = 'hook';
  const service = {
    watch: vi.fn(async (input: { action: string }) => {
      if (input.action === 'add') {
        return {
          action: 'add' as const,
          account: 'me@example.com',
          entry: folderEntry(),
          alreadyWatched: false,
        };
      }
      if (input.action === 'remove') {
        return { action: 'remove' as const, account: 'me@example.com', removed: fileEntry() };
      }
      return {
        action: 'list' as const,
        watches: [
          {
            account: 'me@example.com',
            entries: [fileEntry(), folderEntry({ inaccessible: true })],
          },
        ],
      };
    }),
    changes: vi.fn(async () => ({ events: [makeEvent({ seq: 3 })], more: 2, unread: 2 })),
    getDelivery: vi.fn(async () => mode),
    setDelivery: vi.fn(async (m: DeliveryMode) => {
      mode = m;
    }),
  };
  const hook = vi.fn(async () => {});
  const deps: WatchCliDeps = { watch: () => service, out: (l) => lines.push(l), hook };
  const program = new Command().exitOverride();
  registerWatchCommands(program, deps);
  const run = (...args: string[]) => program.parseAsync(['node', 'marvin-drive', ...args]);
  return { lines, service, hook, run };
}

describe('watch CLI', () => {
  it('adds, removes and lists watches', async () => {
    const { lines, service, run } = setup();
    await run('watch', 'add', 'F', '--account', 'me');
    expect(service.watch).toHaveBeenLastCalledWith({ action: 'add', fileId: 'F', account: 'me' });
    expect(lines.pop()).toBe('Watching "Team" (folder, recursive) for me@example.com');
    await run('watch', 'remove', 'D');
    expect(service.watch).toHaveBeenLastCalledWith({ action: 'remove', fileId: 'D' });
    expect(lines.pop()).toBe('Stopped watching "Plan" for me@example.com');
    await run('watch', 'list');
    expect(lines.pop()).toBe('me@example.com\n  Plan (doc) D\n  Team (folder) F [inaccessible]');
  });

  it('shows and sets the delivery mode', async () => {
    const { lines, service, run } = setup();
    await run('watch', 'delivery');
    expect(lines.pop()).toBe('Delivery: hook');
    await run('watch', 'delivery', 'channel');
    expect(service.setDelivery).toHaveBeenCalledWith('channel');
    expect(lines.pop()).toBe('Delivery: channel');
    await expect(run('watch', 'delivery', 'push')).rejects.toBeInstanceOf(ValidationError);
  });

  it('prints changes with flags, as JSON, or as the hook', async () => {
    const { lines, service, hook, run } = setup();
    await run('changes');
    expect(service.changes).toHaveBeenLastCalledWith({ unreadOnly: true, includeOwn: false });
    expect(lines.pop()).toBe(
      '#3 edited "Plan" by Ayşe Demir at 2026-11-07T11:00:00.000Z\n- a\n+ b\nid: me@example.com:D:3\n\n… 2 more; run again',
    );
    await run('changes', '--all', '--own', '--json');
    expect(service.changes).toHaveBeenLastCalledWith({ unreadOnly: false, includeOwn: true });
    expect(JSON.parse(lines.pop() ?? '')).toMatchObject({ more: 2, unread: 2 });
    await run('changes', '--hook');
    expect(hook).toHaveBeenCalledTimes(1);
  });
});
