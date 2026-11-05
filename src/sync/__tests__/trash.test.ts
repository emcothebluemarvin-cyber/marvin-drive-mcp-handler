import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ValidationError } from '../../errors.js';
import { LocalTrashError } from '../errors.js';
import { MacTrash, TRASH_BIN, createLocalTrash, type ExecFn } from '../trash.js';
import { WindowsTrash } from '../trash-windows.js';
import { XdgTrash } from '../trash-xdg.js';

let tmp: string;
beforeEach(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), 'marvin-trash-'));
});
afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe('createLocalTrash', () => {
  it('picks the implementation per platform', () => {
    expect(createLocalTrash('darwin')).toBeInstanceOf(MacTrash);
    expect(createLocalTrash('win32')).toBeInstanceOf(WindowsTrash);
    expect(createLocalTrash('linux')).toBeInstanceOf(XdgTrash);
    expect(createLocalTrash('freebsd')).toBeInstanceOf(XdgTrash);
  });
});

describe('MacTrash', () => {
  it('runs /usr/bin/trash -s with exactly one path, no shell', async () => {
    const file = path.join(tmp, 'a b.pdf');
    await writeFile(file, 'x');
    const exec = vi.fn<ExecFn>(async () => ({ stdout: '' }));
    await new MacTrash(exec).trash(file);
    expect(TRASH_BIN).toBe('/usr/bin/trash');
    expect(exec).toHaveBeenCalledWith('/usr/bin/trash', ['-s', file]);
  });

  it('fails the action on a non-zero exit', async () => {
    const file = path.join(tmp, 'a.pdf');
    await writeFile(file, 'x');
    const exec = vi.fn<ExecFn>(async () => {
      throw Object.assign(new Error('Command failed'), { code: 1 });
    });
    await expect(new MacTrash(exec).trash(file)).rejects.toBeInstanceOf(LocalTrashError);
  });

  it('rejects relative paths and non-files before running anything', async () => {
    const exec = vi.fn<ExecFn>();
    await expect(new MacTrash(exec).trash('a.pdf')).rejects.toBeInstanceOf(ValidationError);
    await expect(new MacTrash(exec).trash(tmp)).rejects.toBeInstanceOf(ValidationError);
    expect(exec).not.toHaveBeenCalled();
  });

  it('passes ENOENT through unchanged', async () => {
    const exec = vi.fn<ExecFn>();
    await expect(new MacTrash(exec).trash(path.join(tmp, 'gone.pdf'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });
});
