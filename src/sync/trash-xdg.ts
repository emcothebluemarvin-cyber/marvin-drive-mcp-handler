import os from 'node:os';
import path from 'node:path';
import {
  afterChecks,
  checkTrashable,
  nodeTrashFs,
  reserveAndMove,
  trashFailure,
  type LocalTrash,
  type TrashFs,
} from './trash-common.js';

export interface XdgTrashDeps {
  env?: NodeJS.ProcessEnv;
  homedir?: string;
  uid?: number;
  now?: () => Date;
  fs?: TrashFs;
}

interface ChosenTrash {
  dir: string;
  /** Top directory for a per-filesystem trash (Path is relative to it); null for the home trash. */
  top: string | null;
}

const MAX_NAMES = 1000;
const UNRESERVED = /[A-Za-z0-9\-_.~/]/;

/** Percent-encodes every UTF-8 byte outside the unreserved set and '/' (Trash spec 1.0). */
export function encodeTrashPath(p: string): string {
  let out = '';
  for (const byte of Buffer.from(p, 'utf8')) {
    const ch = String.fromCharCode(byte);
    out +=
      byte < 0x80 && UNRESERVED.test(ch)
        ? ch
        : `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
  }
  return out;
}

/** Local time without zone, as the Trash spec requires. */
export function formatDeletionDate(d: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}` +
    `T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
  );
}

export function formatTrashInfo(trashPath: string, deletedAt: Date): string {
  return `[Trash Info]\nPath=${encodeTrashPath(trashPath)}\nDeletionDate=${formatDeletionDate(deletedAt)}\n`;
}

/** basename, then stem.2.ext, stem.3.ext, … (split at the last dot that is not the first char). */
export function* trashNames(base: string): Generator<string> {
  yield base;
  const dot = base.lastIndexOf('.');
  const stem = dot > 0 ? base.slice(0, dot) : base;
  const ext = dot > 0 ? base.slice(dot) : '';
  for (let n = 2; n <= MAX_NAMES; n++) yield `${stem}.${n}${ext}`;
}

export class XdgTrash implements LocalTrash {
  private readonly fs: TrashFs;

  constructor(private readonly deps: XdgTrashDeps = {}) {
    this.fs = deps.fs ?? nodeTrashFs;
  }

  async trash(absPath: string): Promise<void> {
    const fs = this.fs;
    await checkTrashable(absPath, fs);
    await afterChecks(absPath, fs, () => this.move(absPath));
  }

  private async move(absPath: string): Promise<void> {
    const fs = this.fs;
    const file = path.join(await fs.realpath(path.dirname(absPath)), path.basename(absPath));
    const { dev } = await fs.lstat(file);
    const trash = await this.chooseTrash(file, dev);
    const now = (this.deps.now ?? ((): Date => new Date()))();
    const recorded = trash.top === null ? file : path.relative(trash.top, file);
    await reserveAndMove({
      file,
      fs,
      metadata: formatTrashInfo(recorded, now),
      names: (function* (): Generator<{ meta: string; target: string }> {
        for (const name of trashNames(path.basename(file))) {
          yield {
            meta: path.join(trash.dir, 'info', `${name}.trashinfo`),
            target: path.join(trash.dir, 'files', name),
          };
        }
      })(),
    });
  }

  private uid(file: string): number {
    const uid = this.deps.uid ?? process.getuid?.();
    if (uid === undefined)
      throw trashFailure(file, 'this platform has no user id for an XDG trash');
    return uid;
  }

  /** Spec §5.1. */
  private async chooseTrash(file: string, dev: number): Promise<ChosenTrash> {
    const fs = this.fs;
    const uid = this.uid(file);
    const home = this.homeTrashDir();
    // A home that cannot hold a trash (read-only or missing $HOME on servers) is skipped;
    // the top-directory trash below is validated just as strictly.
    const homeReady = await ensureTrashDirs(home, fs).then(
      () => true,
      () => false,
    );
    if (homeReady && (await fs.stat(home)).dev === dev) {
      const problem = await trashProblem(home, uid, dev, fs);
      if (problem) throw trashFailure(file, `home trash is not safe: ${problem}`);
      return { dir: home, top: null };
    }

    const top = await topDirectory(file, dev, fs);
    const admin = await this.adminTrash(top, uid, dev);
    if (admin) return { dir: admin, top };

    const user = path.join(top, `.Trash-${uid}`);
    try {
      await ensureTrashDirs(user, fs);
    } catch (err) {
      throw trashFailure(file, 'no usable trash on this filesystem', err);
    }
    const problem = await trashProblem(user, uid, dev, fs);
    if (problem) throw trashFailure(file, `no usable trash on this filesystem (${problem})`);
    return { dir: user, top };
  }

  private homeTrashDir(): string {
    const env = this.deps.env ?? process.env;
    const dataHome = env.XDG_DATA_HOME;
    const base =
      dataHome && path.isAbsolute(dataHome)
        ? dataHome
        : path.join(this.deps.homedir ?? os.homedir(), '.local', 'share');
    return path.join(base, 'Trash');
  }

  /** `$top/.Trash/$uid`, only when `$top/.Trash` is a real sticky directory; else null. */
  private async adminTrash(top: string, uid: number, dev: number): Promise<string | null> {
    const fs = this.fs;
    const shared = path.join(top, '.Trash');
    try {
      const info = await fs.lstat(shared);
      if (!info.isDirectory() || (info.mode & 0o1000) === 0) return null;
      const dir = path.join(shared, String(uid));
      await ensureTrashDirs(dir, fs);
      return (await trashProblem(dir, uid, dev, fs)) === null ? dir : null;
    } catch {
      // Missing or unusable admin trash: fall back to $top/.Trash-$uid (spec §5.1 step 4).
      return null;
    }
  }
}

async function ensureTrashDirs(dir: string, fs: TrashFs): Promise<void> {
  await fs.mkdir(path.join(dir, 'files'), { recursive: true, mode: 0o700 });
  await fs.mkdir(path.join(dir, 'info'), { recursive: true, mode: 0o700 });
}

/** Why a trash dir must not be used, or null when it is safe (spec §5.1 step 5). */
async function trashProblem(
  dir: string,
  uid: number,
  dev: number,
  fs: TrashFs,
): Promise<string | null> {
  for (const p of [dir, path.join(dir, 'files'), path.join(dir, 'info')]) {
    const info = await fs.lstat(p);
    if (info.isSymbolicLink() || !info.isDirectory()) return `${p} is not a real directory`;
    if (info.uid !== uid) return `${p} belongs to another user`;
    if ((info.mode & 0o022) !== 0) return `${p} is writable by others`;
    if (info.dev !== dev) return `${p} is on another filesystem`;
  }
  return null;
}

/** The last directory above the file that is still on the file's device. */
async function topDirectory(file: string, dev: number, fs: TrashFs): Promise<string> {
  let dir = path.dirname(file);
  for (;;) {
    const parent = path.dirname(dir);
    if (parent === dir || (await fs.stat(parent)).dev !== dev) return dir;
    dir = parent;
  }
}
