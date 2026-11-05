import { spawn } from 'node:child_process';
import { once } from 'node:events';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LocalTrashError } from '../errors.js';
import { defaultExec, nodeTrashFs, type ExecFn } from '../trash-common.js';
import {
  WindowsTrash,
  encodeRecycleRecord,
  moveIntoRecycleBin,
  parseWhoamiSid,
  randomSuffix,
  recycleRoot,
} from '../trash-windows.js';

const SID = 'S-1-5-21-1004336348-1177238915-682003330-1001';

describe('encodeRecycleRecord', () => {
  it('writes the $I version 2 layout', () => {
    const deletedAt = new Date(Date.UTC(2026, 10, 5, 12, 0, 0));
    const buf = encodeRecycleRecord({ path: 'C:\\D\\ş.pdf', size: 1234n, deletedAt });
    expect(buf.length).toBe(28 + 2 * 11);
    expect(buf.readBigInt64LE(0)).toBe(2n);
    expect(buf.readBigInt64LE(8)).toBe(1234n);
    expect(buf.readBigInt64LE(16)).toBe(BigInt(deletedAt.getTime()) * 10000n + 116444736000000000n);
    expect(buf.readUInt32LE(24)).toBe(11);
    expect(buf.subarray(28).toString('utf16le')).toBe('C:\\D\\ş.pdf\0');
  });
});

describe('parseWhoamiSid', () => {
  it('reads the second CSV field', () => {
    expect(parseWhoamiSid(`"desktop-1\\emre","${SID}"\r\n`)).toBe(SID);
  });
  it('handles a comma and doubled quotes in the user name', () => {
    expect(parseWhoamiSid(`"CORP\\Doe, ""J""","${SID}"`)).toBe(SID);
  });
  it('rejects anything that is not a SID', () => {
    expect(parseWhoamiSid('"x","nope"')).toBeNull();
    expect(parseWhoamiSid('')).toBeNull();
  });
});

describe('recycleRoot', () => {
  it('accepts drive roots', () => {
    expect(recycleRoot('C:\\Users\\e\\a.pdf')).toBe('C:\\');
    expect(recycleRoot('d:\\a.pdf')).toBe('d:\\');
  });
  it.each(['\\\\srv\\share\\a.pdf', '\\\\?\\C:\\a.pdf', '\\\\.\\PhysicalDrive0\\a'])(
    'refuses %s',
    (p) => {
      expect(() => recycleRoot(p)).toThrow(LocalTrashError);
    },
  );
});

describe('randomSuffix', () => {
  it('is 6 characters from A–Z0–9', () => {
    expect(randomSuffix()).toMatch(/^[A-Z0-9]{6}$/);
  });
});

describe('moveIntoRecycleBin', () => {
  let tmp: string;
  let bin: string;
  beforeEach(async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), 'marvin-recycle-'));
    bin = path.join(tmp, 'bin');
    await mkdir(bin);
  });
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it('writes $I and moves the file to $R with the same suffix and extension', async () => {
    const file = path.join(tmp, 'Report.PDF');
    await writeFile(file, 'A');
    const record = Buffer.from('REC');
    await moveIntoRecycleBin(file, bin, record, { fs: nodeTrashFs, random: () => 'ABC123' });
    expect((await readdir(bin)).sort()).toEqual(['$IABC123.PDF', '$RABC123.PDF']);
    expect(await readFile(path.join(bin, '$IABC123.PDF'), 'utf8')).toBe('REC');
    expect(await readFile(path.join(bin, '$RABC123.PDF'), 'utf8')).toBe('A');
  });

  it('picks a new suffix when $I or $R exists, never replacing either', async () => {
    const file = path.join(tmp, 'a.txt');
    await writeFile(file, 'A');
    await writeFile(path.join(bin, '$IAAAAAA.txt'), 'theirs');
    await writeFile(path.join(bin, '$RBBBBBB.txt'), 'orphan');
    const suffixes = ['AAAAAA', 'BBBBBB', 'CCCCCC'];
    await moveIntoRecycleBin(file, bin, Buffer.from('R'), {
      fs: nodeTrashFs,
      random: () => suffixes.shift() ?? 'ZZZZZZ',
    });
    expect(await readFile(path.join(bin, '$IAAAAAA.txt'), 'utf8')).toBe('theirs');
    expect(await readFile(path.join(bin, '$RBBBBBB.txt'), 'utf8')).toBe('orphan');
    expect(await readFile(path.join(bin, '$RCCCCCC.txt'), 'utf8')).toBe('A');
    expect(await readdir(bin)).not.toContain('$IBBBBBB.txt');
  });
});

describe('WindowsTrash path checks', () => {
  it('refuses a mapped network drive (realpath gives a UNC path)', async () => {
    const t = new WindowsTrash({
      fs: {
        ...nodeTrashFs,
        lstat: (async () => ({ isFile: () => true })) as unknown as typeof nodeTrashFs.lstat,
        realpath: async () => '\\\\srv\\share\\a.pdf',
      },
      binDir: async () => {
        throw new Error('must not be reached');
      },
    });
    const abs = process.platform === 'win32' ? 'Z:\\a.pdf' : '/z/a.pdf';
    await expect(t.trash(abs)).rejects.toThrow(/network and device paths/);
  });

  it('looks up the SID once with whoami.exe by absolute path', async () => {
    const exec = vi.fn<ExecFn>(async () => ({ stdout: `"pc\\e","${SID}"\r\n` }));
    const t = new WindowsTrash({
      exec,
      env: { SystemRoot: 'C:\\Windows' },
      fs: {
        ...nodeTrashFs,
        lstat: (async () => ({
          isFile: () => true,
          isDirectory: () => false,
        })) as unknown as typeof nodeTrashFs.lstat,
        realpath: async () => 'C:\\D\\a.pdf',
      },
    });
    const abs = process.platform === 'win32' ? 'C:\\D\\a.pdf' : '/d/a.pdf';
    await expect(t.trash(abs)).rejects.toThrow(/no Recycle Bin on drive C:/);
    await expect(t.trash(abs)).rejects.toThrow(/no Recycle Bin on drive C:/);
    expect(exec).toHaveBeenCalledTimes(1);
    expect(exec).toHaveBeenCalledWith('C:\\Windows\\System32\\whoami.exe', [
      '/user',
      '/fo',
      'csv',
      '/nh',
    ]);
  });
});

describe('WindowsTrash SID lookup failure', () => {
  const fs = {
    ...nodeTrashFs,
    lstat: (async () => ({
      isFile: () => true,
      isDirectory: () => true,
    })) as unknown as typeof nodeTrashFs.lstat,
    realpath: async () => 'C:\\D\\a.pdf',
  };
  const abs = process.platform === 'win32' ? 'C:\\D\\a.pdf' : '/d/a.pdf';

  it('fails with LocalTrashError and retries whoami on the next call', async () => {
    const exec = vi.fn<ExecFn>(async () => {
      throw new Error('whoami failed');
    });
    const t = new WindowsTrash({ exec, fs });
    await expect(t.trash(abs)).rejects.toThrow(/whoami failed\)/);
    await expect(t.trash(abs)).rejects.toBeInstanceOf(LocalTrashError);
    expect(exec).toHaveBeenCalledTimes(2);
  });

  it('normalises C:/ paths to backslashes before locating the bin', async () => {
    const roots: string[] = [];
    const input = process.platform === 'win32' ? 'C:/D/a.pdf' : '/d/a.pdf';
    const realpaths: string[] = [];
    const t = new WindowsTrash({
      fs: {
        ...fs,
        lstat: (async () => ({
          isFile: () => true,
          isDirectory: () => false,
        })) as unknown as typeof nodeTrashFs.lstat,
        realpath: async (p: string) => {
          realpaths.push(p);
          return 'C:\\D\\a.pdf';
        },
      },
      binDir: async (root) => {
        roots.push(root);
        return 'C:\\nope';
      },
    });
    await expect(t.trash(input)).rejects.toThrow(/no Recycle Bin on drive C:/);
    expect(roots).toEqual(['C:\\']);
    if (process.platform === 'win32') expect(realpaths).toEqual(['C:\\D\\a.pdf']);
  });
});

describe.runIf(process.platform === 'win32')('WindowsTrash on Windows', () => {
  let tmp: string;
  let bin: string;
  beforeEach(async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), 'marvin-recycle-win-'));
    bin = path.join(tmp, 'bin');
    await mkdir(bin);
  });
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true, maxRetries: 5 });
  });

  it('real whoami.exe returns a SID', async () => {
    const env = process.env.SystemRoot ?? 'C:\\Windows';
    const { stdout } = await defaultExec(`${env}\\System32\\whoami.exe`, [
      '/user',
      '/fo',
      'csv',
      '/nh',
    ]);
    expect(parseWhoamiSid(stdout)).toMatch(/^S-1-/);
  });

  it('moves a file end to end into a (temp) bin with a matching $I record', async () => {
    const file = path.join(tmp, 'ş a.txt');
    await writeFile(file, 'hello');
    const resolved = await realpath(file);
    await new WindowsTrash({ binDir: async () => bin, random: () => 'Q1W2E3' }).trash(file);
    const rec = await readFile(path.join(bin, '$IQ1W2E3.txt'));
    expect(rec.readBigInt64LE(8)).toBe(5n);
    expect(rec.subarray(28).toString('utf16le')).toBe(`${resolved}\0`);
    expect(await readFile(path.join(bin, '$RQ1W2E3.txt'), 'utf8')).toBe('hello');
  });

  it('keeps the read-only attribute', async () => {
    const file = path.join(tmp, 'ro.txt');
    await writeFile(file, 'x');
    await chmod(file, 0o444);
    await new WindowsTrash({ binDir: async () => bin, random: () => 'RO0001' }).trash(file);
    const moved = path.join(bin, '$RRO0001.txt');
    expect((await stat(moved)).mode & 0o200).toBe(0);
    await chmod(moved, 0o666);
  });

  it('fails and keeps a file another process holds open without delete sharing', async () => {
    const file = path.join(tmp, 'busy.txt');
    await writeFile(file, 'x');
    const hold = spawn(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `$f=[IO.File]::Open('${file.replace(/'/g, "''")}','Open','Read','Read'); ` +
          `[Console]::Out.WriteLine('ready'); [Console]::Out.Flush(); Start-Sleep 30; $f.Close()`,
      ],
      { stdio: ['ignore', 'pipe', 'inherit'] },
    );
    const exited = once(hold, 'exit');
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error('PowerShell did not open the file')),
          25_000,
        );
        hold.once('error', reject);
        hold.stdout.on('data', (chunk: Buffer) => {
          if (chunk.toString().includes('ready')) {
            clearTimeout(timer);
            resolve();
          }
        });
      });
      await expect(
        new WindowsTrash({ binDir: async () => bin, random: () => 'BUSY01' }).trash(file),
      ).rejects.toThrow(/in use or access was denied/);
      expect(await readFile(file, 'utf8')).toBe('x');
      expect(await readdir(bin)).toEqual([]);
    } finally {
      hold.kill();
      await exited;
    }
  }, 60_000);
});
