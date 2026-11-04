import { describe, expect, it, vi } from 'vitest';
import { renameReplacing } from '../rename-replacing.js';

const fsError = (code: string): NodeJS.ErrnoException =>
  Object.assign(new Error(`${code}: busy`), { code });

describe('renameReplacing', () => {
  it('renames once when it works', async () => {
    const rename = vi.fn(async () => {});
    await renameReplacing('a', 'b', { platform: 'win32', rename, sleep: async () => {} });
    expect(rename).toHaveBeenCalledTimes(1);
    expect(rename).toHaveBeenCalledWith('a', 'b');
  });

  it('retries transient EPERM/EACCES/EBUSY on win32 with growing delays', async () => {
    const rename = vi
      .fn<(from: string, to: string) => Promise<void>>()
      .mockRejectedValueOnce(fsError('EPERM'))
      .mockRejectedValueOnce(fsError('EBUSY'))
      .mockRejectedValueOnce(fsError('EACCES'))
      .mockResolvedValueOnce();
    const delays: number[] = [];
    await renameReplacing('a', 'b', {
      platform: 'win32',
      rename,
      sleep: async (ms) => {
        delays.push(ms);
      },
    });
    expect(rename).toHaveBeenCalledTimes(4);
    expect(delays).toHaveLength(3);
    expect(delays[0]).toBeLessThan(delays[2] ?? 0);
  });

  it('gives up after the attempt limit with the last error', async () => {
    const rename = vi.fn(async () => {
      throw fsError('EBUSY');
    });
    await expect(
      renameReplacing('a', 'b', { platform: 'win32', rename, sleep: async () => {} }),
    ).rejects.toThrow('EBUSY');
    expect(rename.mock.calls.length).toBeGreaterThan(1);
    expect(rename.mock.calls.length).toBeLessThanOrEqual(10);
  });

  it('never retries on other platforms or for other errors', async () => {
    for (const [platform, code] of [
      ['darwin', 'EPERM'],
      ['linux', 'EBUSY'],
      ['win32', 'ENOENT'],
    ] as const) {
      const rename = vi.fn(async () => {
        throw fsError(code);
      });
      await expect(
        renameReplacing('a', 'b', { platform, rename, sleep: async () => {} }),
      ).rejects.toThrow(code);
      expect(rename).toHaveBeenCalledTimes(1);
    }
  });
});
