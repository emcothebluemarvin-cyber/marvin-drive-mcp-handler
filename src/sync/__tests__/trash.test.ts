import { describe, expect, it, vi } from 'vitest';
import { ValidationError } from '../../errors.js';
import { LocalTrashError } from '../errors.js';
import { TRASH_BIN, trashLocal, type ExecFn } from '../trash.js';

describe('trashLocal', () => {
  it('runs /usr/bin/trash -s with exactly one path, no shell', async () => {
    const exec = vi.fn<ExecFn>(async () => ({ stdout: '', stderr: '' }));
    await trashLocal('/Users/x/Docs/a b.pdf', exec);
    expect(TRASH_BIN).toBe('/usr/bin/trash');
    expect(exec).toHaveBeenCalledWith('/usr/bin/trash', ['-s', '/Users/x/Docs/a b.pdf']);
  });

  it('fails the action on a non-zero exit', async () => {
    const exec = vi.fn<ExecFn>(async () => {
      throw Object.assign(new Error('Command failed'), { code: 1 });
    });
    await expect(trashLocal('/Volumes/smb/a.pdf', exec)).rejects.toBeInstanceOf(LocalTrashError);
  });

  it('rejects relative paths', async () => {
    const exec = vi.fn<ExecFn>();
    await expect(trashLocal('a.pdf', exec)).rejects.toBeInstanceOf(ValidationError);
    expect(exec).not.toHaveBeenCalled();
  });
});
