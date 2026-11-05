import { randomInt } from 'node:crypto';
import path from 'node:path';
import { LocalTrashError } from './errors.js';
import {
  checkTrashable,
  defaultExec,
  nodeTrashFs,
  reserveAndMove,
  trashFailure,
  type ExecFn,
  type LocalTrash,
  type TrashFs,
} from './trash-common.js';

export interface WindowsTrashDeps {
  exec?: ExecFn;
  /** Recycle Bin folder for a drive root like `C:\`; default `<root>$Recycle.Bin\<SID>`. */
  binDir?: (root: string) => Promise<string>;
  now?: () => Date;
  random?: () => string;
  env?: NodeJS.ProcessEnv;
  fs?: TrashFs;
}

const SUFFIX_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const MAX_SUFFIXES = 10;
/** 100 ns intervals between 1601-01-01 and 1970-01-01. */
const FILETIME_UNIX_EPOCH = 116444736000000000n;
const SID = /^S-1-[0-9]+(-[0-9]+)+$/;

export function randomSuffix(): string {
  let s = '';
  for (let i = 0; i < 6; i++) s += SUFFIX_CHARS[randomInt(SUFFIX_CHARS.length)];
  return s;
}

/** `$I` record, version 2 (Windows 10+), little-endian (spec §6.2). */
export function encodeRecycleRecord(r: { path: string; size: bigint; deletedAt: Date }): Buffer {
  const name = Buffer.from(`${r.path}\0`, 'utf16le');
  const buf = Buffer.alloc(28 + name.length);
  buf.writeBigInt64LE(2n, 0);
  buf.writeBigInt64LE(r.size, 8);
  buf.writeBigInt64LE(BigInt(r.deletedAt.getTime()) * 10000n + FILETIME_UNIX_EPOCH, 16);
  buf.writeUInt32LE(name.length / 2, 24);
  name.copy(buf, 28);
  return buf;
}

/** Splits one CSV line, honouring quotes and doubled quotes. */
function csvFields(line: string): string[] {
  const fields: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      fields.push(cur);
      cur = '';
    } else cur += ch;
  }
  fields.push(cur);
  return fields;
}

/** SID from `whoami /user /fo csv /nh` output; null if it is not there. */
export function parseWhoamiSid(stdout: string): string | null {
  const line = stdout.trim().split(/\r?\n/)[0] ?? '';
  const sid = csvFields(line)[1]?.trim();
  return sid && SID.test(sid) ? sid : null;
}

/** Drive root of an already resolved path; network and device paths are refused (spec §6.1). */
export function recycleRoot(resolved: string): string {
  const root = path.win32.parse(resolved).root;
  if (!/^[A-Za-z]:\\$/.test(root)) {
    throw trashFailure(resolved, 'network and device paths have no local Recycle Bin');
  }
  return root;
}

export class WindowsTrash implements LocalTrash {
  private readonly fs: TrashFs;
  private sid: Promise<string> | null = null;

  constructor(private readonly deps: WindowsTrashDeps = {}) {
    this.fs = deps.fs ?? nodeTrashFs;
  }

  async trash(absPath: string): Promise<void> {
    const fs = this.fs;
    await checkTrashable(absPath, fs);
    const file = await fs.realpath(path.win32.resolve(absPath));
    const root = recycleRoot(file);
    const bin = await (this.deps.binDir ?? ((r: string): Promise<string> => this.defaultBinDir(r)))(
      root,
    );
    const drive = root.slice(0, 2);
    const isDir = await fs.lstat(bin).then(
      (info) => info.isDirectory(),
      () => false,
    );
    if (!isDir) {
      throw trashFailure(
        file,
        `no Recycle Bin on drive ${drive}; delete any file there in Explorer once, or the drive does not support one`,
      );
    }
    const { size } = await fs.lstat(file, { bigint: true });
    const record = encodeRecycleRecord({
      path: file,
      size,
      deletedAt: (this.deps.now ?? ((): Date => new Date()))(),
    });
    await moveIntoRecycleBin(file, bin, record, {
      fs,
      ...(this.deps.random ? { random: this.deps.random } : {}),
    });
  }

  private async defaultBinDir(root: string): Promise<string> {
    this.sid ??= this.lookupSid();
    try {
      return `${root}$Recycle.Bin\\${await this.sid}`;
    } catch (err) {
      this.sid = null;
      throw err;
    }
  }

  private async lookupSid(): Promise<string> {
    const env = this.deps.env ?? process.env;
    const whoami = `${env.SystemRoot ?? 'C:\\Windows'}\\System32\\whoami.exe`;
    let stdout: string;
    try {
      ({ stdout } = await (this.deps.exec ?? defaultExec)(whoami, ['/user', '/fo', 'csv', '/nh']));
    } catch (err) {
      throw new LocalTrashError(
        'Could not determine the Windows user for the Recycle Bin (whoami failed). Nothing was deleted.',
        { cause: err },
      );
    }
    const sid = parseWhoamiSid(stdout);
    if (!sid) {
      throw new LocalTrashError(
        'Could not determine the Windows user SID for the Recycle Bin. Nothing was deleted.',
      );
    }
    return sid;
  }
}

/** Reserves `$I<suffix>` and moves the file to `$R<suffix>` inside `bin` (spec §6.2). */
export async function moveIntoRecycleBin(
  file: string,
  bin: string,
  record: Buffer,
  opts: { fs: TrashFs; random?: () => string },
): Promise<void> {
  const ext = path.win32.extname(file);
  const random = opts.random ?? randomSuffix;
  await reserveAndMove({
    file,
    fs: opts.fs,
    metadata: record,
    names: (function* (): Generator<{ meta: string; target: string }> {
      for (let i = 0; i < MAX_SUFFIXES; i++) {
        const suffix = random() + ext;
        yield { meta: path.join(bin, `$I${suffix}`), target: path.join(bin, `$R${suffix}`) };
      }
    })(),
  });
}
