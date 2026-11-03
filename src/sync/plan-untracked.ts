import { baseName, foldKey, parentKey } from './paths.js';
import {
  isBlocked,
  isExcluded,
  isOccupied,
  isUnknownKey,
  sameFileOnDisk,
  type PlanContext,
} from './resolve.js';
import type { Action, Candidate, LocalEntry, Note, RemoteEntry, SelectionChange } from './types.js';

export const CANDIDATE_CAP = 200;

export interface UntrackedResult {
  actions: Action[];
  notes: Note[];
  candidates: { local: Candidate[]; remote: Candidate[]; truncated: boolean };
}

export interface Claims {
  folds: ReadonlySet<string>;
  localNames: ReadonlySet<string>;
}

function rename(from: string, to: string): SelectionChange {
  return from === to ? {} : { remove: [from], add: [to] };
}

function isBaseline(ctx: PlanContext, r: RemoteEntry): boolean {
  const { pair } = ctx.input;
  return (
    pair.firstAppliedRunAt === null ||
    pair.remoteBaseline.includes(r.id) ||
    r.ancestorIds.some((id) => pair.baselineFolders.includes(id))
  );
}

function isRecentLocal(ctx: PlanContext, l: LocalEntry): boolean {
  const last = ctx.input.pair.lastAppliedRunAt;
  // ctime too: cp -p, mv and ditto keep the old mtime of files that are new here.
  return last === null || Math.max(l.mtimeMs, l.ctimeMs) > Date.parse(last);
}

/**
 * Upload key for a local file: each parent folder takes the spelling of an existing Drive
 * folder with the same fold (case-insensitive volume), so a remote `Docs/` is reused for a
 * local `docs/`. Returns null on a case-sensitive volume when only the case differs.
 */
export function uploadKey(ctx: PlanContext, localKey: string): string | null {
  const folderByFold = new Map<string, string>();
  for (const key of ctx.input.remote.folders.values()) folderByFold.set(foldKey(key), key);
  let rebuilt = '';
  for (const seg of parentKey(localKey) === '' ? [] : parentKey(localKey).split('/')) {
    const candidate = rebuilt === '' ? seg : `${rebuilt}/${seg}`;
    const existing = folderByFold.get(foldKey(candidate));
    if (existing !== undefined && existing !== candidate && !ctx.ci) return null;
    rebuilt = existing ?? candidate;
  }
  return rebuilt === '' ? baseName(localKey) : `${rebuilt}/${baseName(localKey)}`;
}

/** Classifies every untracked key by fold (spec §6.5, U0–U8). First match wins. */
export function planUntracked(ctx: PlanContext, claims: Claims): UntrackedResult {
  const out: UntrackedResult = {
    actions: [],
    notes: [],
    candidates: { local: [], remote: [], truncated: false },
  };
  const recordFolds = new Set(ctx.input.records.map((r) => foldKey(r.path)));
  const folds = new Set<string>();
  for (const [fold] of ctx.selectionByFold) if (!recordFolds.has(fold)) folds.add(fold);
  for (const e of ctx.input.local.entries) if (!claims.localNames.has(e.name)) folds.add(e.foldKey);
  for (const r of ctx.input.remote.entries) if (!ctx.trackedIds.has(r.id)) folds.add(r.foldKey);

  for (const fold of [...folds].sort()) {
    const sel = recordFolds.has(fold) ? undefined : ctx.selectionByFold.get(fold);
    const locals = (ctx.localByFold.get(fold) ?? []).filter((e) => !claims.localNames.has(e.name));
    const remotes = (ctx.remoteByFold.get(fold) ?? []).filter((r) => !ctx.trackedIds.has(r.id));
    const key = sel ?? remotes[0]?.key ?? locals[0]?.key;
    if (key === undefined) continue;
    const note = (
      code: Note['code'],
      rule: string,
      message?: string,
      path = key,
      remoteId?: string,
    ): void => {
      out.notes.push({
        code,
        path,
        rule,
        ...(remoteId ? { remoteId } : {}),
        ...(message ? { message } : {}),
      });
    };

    if (claims.folds.has(fold)) {
      for (const r of remotes)
        note('collision', 'U-tracked', 'a tracked file uses this path', r.key, r.id);
      continue;
    }
    if (ctx.ambiguousFolds.has(fold)) {
      const paths = new Set([...locals.map((l) => l.key), ...remotes.map((r) => r.key)]);
      for (const p of [...paths].sort())
        note('ambiguous', 'ambiguous', 'several files share this name', p);
      continue;
    }
    // U0
    if (isExcluded(ctx, key)) continue;
    if (isUnknownKey(ctx, key)) {
      note('unknown-state', 'U0', 'inside a folder that could not be read');
      continue;
    }
    if (isBlocked(ctx, key)) {
      note('unknown-state', 'U0', 'a parent folder is a symlink, special file or ignored folder');
      continue;
    }
    const L = locals[0];
    const R = remotes[0];
    if (isOccupied(ctx, key) && !L) {
      if (sel !== undefined)
        note('unknown-state', 'U0', 'local path is occupied by a non-regular or ignored entry');
      else if (R)
        note('collision', 'U7', 'a local folder or special file uses this path', R.key, R.id);
      continue;
    }
    // Fold-only matches across sides (spec §6.1 step 2): ambiguous on a case-sensitive
    // volume; on a case-insensitive one only when the volume itself maps the other spelling
    // onto the local file (lstat hits the same inode) — never on our fold alone.
    const exact = new Set([sel, L?.key, R?.key].filter((k): k is string => k !== undefined));
    if (exact.size > 1) {
      const agreed =
        ctx.ci && (!L || [...exact].every((k) => k === L.key || sameFileOnDisk(ctx, k, L)));
      if (!agreed) {
        for (const p of [...exact].sort())
          note('ambiguous', 'ambiguous', 'names differ only in case', p);
        continue;
      }
    }
    const base = { record: null, selection: {} as SelectionChange };

    if (sel !== undefined) {
      if (L && !R) {
        const target = uploadKey(ctx, L.key);
        if (target === null) {
          note('ambiguous', 'U1', 'a Drive folder name differs only in case');
          continue;
        }
        out.actions.push({
          ...base,
          kind: 'upload-new',
          rule: 'U1',
          key: target,
          local: L,
          localMd5: ctx.input.md5s.get(L.name) ?? null,
          remote: null,
          selection: rename(sel, target),
        });
      } else if (L && R) {
        const lMd5 = ctx.input.md5s.get(L.name);
        if (lMd5 === undefined) note('unknown-state', 'U2', 'local file could not be hashed');
        else if (R.md5 !== null && lMd5 === R.md5) {
          out.actions.push({
            ...base,
            kind: 'adopt',
            rule: 'U2',
            key: R.key,
            local: L,
            localMd5: lMd5,
            remote: R,
            selection: rename(sel, R.key),
          });
        } else if (!R.canEdit) {
          note('remote-readonly', 'U2', 'differs from the Drive file, which you cannot edit');
        } else {
          out.actions.push({
            ...base,
            kind: 'conflict',
            rule: 'U2',
            key: R.key,
            local: L,
            localMd5: lMd5,
            remote: R,
            updateRemote: true,
            selection: rename(sel, R.key),
          });
        }
      } else if (R) {
        out.actions.push({
          ...base,
          kind: 'download-new',
          rule: 'U3',
          key: R.key,
          local: null,
          localMd5: null,
          remote: R,
          selection: rename(sel, R.key),
        });
      } else {
        note('missing', 'U4', 'selected but present on neither side');
      }
      continue;
    }
    if (R) {
      if (isBaseline(ctx, R)) {
        out.candidates.remote.push({
          path: R.key,
          size: R.size,
          modifiedTime: R.modifiedTime,
          remoteId: R.id,
        });
      } else if (L) {
        note('collision', 'U7', 'new in Drive, but a local file has the same name', R.key, R.id);
      } else {
        out.actions.push({
          ...base,
          kind: 'download-new',
          rule: 'U6',
          key: R.key,
          local: null,
          localMd5: null,
          remote: R,
          selection: { add: [R.key] },
        });
      }
      continue;
    }
    if (L && isRecentLocal(ctx, L)) {
      out.candidates.local.push({
        path: L.key,
        size: L.size,
        modifiedTime: new Date(L.mtimeMs).toISOString(),
      });
    }
  }
  const { local, remote } = out.candidates;
  out.candidates = {
    local: local.slice(0, CANDIDATE_CAP),
    remote: remote.slice(0, CANDIDATE_CAP),
    truncated: local.length > CANDIDATE_CAP || remote.length > CANDIDATE_CAP,
  };
  return out;
}
