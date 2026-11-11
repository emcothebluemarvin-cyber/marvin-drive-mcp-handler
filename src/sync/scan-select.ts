import { open } from 'node:fs/promises';
import { AppError } from '../errors.js';
import { uploadMimeType } from '../files/upload-mime.js';
import { hashLocal, probeOnDisk, scanLocal } from './local-scanner.js';
import { checkRoots, type SyncEnv } from './pair-admin.js';
import {
  absInside,
  ancestorKeys,
  foldKey,
  isIgnoredName,
  isUnder,
  toKey,
  validateRelPath,
} from './paths.js';
import { pruneEvidence, readDeletionFeed, type FeedRead } from './deletion-evidence.js';
import { probeRecords } from './remote-probe.js';
import { scanRemote } from './remote-scanner.js';
import { hashTargets, onDiskProbeKeys, type PlanInput } from './resolve.js';
import type { LocalScan, Pair, PairFile, RemoteScan } from './types.js';

const TEXT_MIME = /^(text\/|application\/(json|xml|javascript|x-yaml|yaml|x-sh|sql|toml))/;

export interface ScanInput {
  name: string;
  onlyUnselected?: boolean;
  previewChars?: number;
  limit?: number;
  subdir?: string;
}

export interface ScanEntry {
  path: string;
  size: number;
  modifiedTime: string;
  mimeType: string;
  preview?: string;
}

export interface ScanResult {
  entries: ScanEntry[];
  remoteCandidates: Array<{
    path: string;
    size: number | null;
    modifiedTime: string;
    mimeType: string;
  }>;
  truncated: boolean;
}

export interface SelectInput {
  name: string;
  add?: string[];
  remove?: string[];
}

export interface SelectResult {
  selected: number;
  excluded: number;
  tracked: number;
  added: string[];
  removed: string[];
  rejected: Array<{ path: string; reason: string }>;
}

async function readPreview(abs: string, chars: number): Promise<string | undefined> {
  const handle = await open(abs, 'r');
  try {
    const buf = Buffer.alloc(chars * 4);
    const { bytesRead } = await handle.read(buf, 0, buf.length, 0);
    const bytes = buf.subarray(0, bytesRead);
    if (bytes.includes(0)) return undefined;
    return Array.from(bytes.toString('utf8')).slice(0, chars).join('');
  } finally {
    await handle.close();
  }
}

/** Breadth-first scan of the pair's remote folder (no local work). */
export async function scanRemoteTree(env: SyncEnv, pair: Pair): Promise<RemoteScan> {
  return scanRemote(pair.remoteFolderId, await env.remoteFor(pair));
}

export async function scanBoth(
  env: SyncEnv,
  pair: Pair,
): Promise<{ local: LocalScan; remote: RemoteScan }> {
  const local = await scanLocal(pair.localDir);
  const remote = await scanRemoteTree(env, pair);
  return { local, remote };
}

/** Spec §5 steps 3–4: scan both sides, lstat, hash and probe → the planner's input. */
export async function gatherInput(
  env: SyncEnv,
  file: PairFile,
  releaseNames: PlanInput['releaseNames'] = null,
): Promise<{ input: PlanInput; local: LocalScan; remote: RemoteScan; feed: FeedRead | null }> {
  const { pair, records } = file;
  // The feed is read before the scan: a deletion after this point is never missed.
  const feed = await readDeletionFeed(await env.remoteFor(pair), pair, env.log);
  const { local, remote } = await scanBoth(env, pair);
  // §6.1: keys without an exact scan match may still exist on disk (through a symlinked
  // parent, or under a spelling the volume folds onto a scanned file) — ask the volume.
  const onDisk = await probeOnDisk(
    pair.localDir,
    onDiskProbeKeys({ pair, records, local, remote }),
  );
  const syncRemote = await env.remoteFor(pair);
  const base = {
    pair,
    records,
    local,
    remote,
    probes: new Map(),
    onDisk,
    remoteHashKind: syncRemote.hashKind,
    releaseNames,
  };
  const { digests, failed } = await hashLocal(
    pair.localDir,
    hashTargets(base),
    syncRemote.hashKind,
    env.digesters,
  );
  for (const name of failed) local.unknownSubtrees.push(toKey(name));
  const seen = new Set([...remote.entries.map((e) => e.id), ...remote.ignored.map((i) => i.id)]);
  const missing = records.map((r) => r.remoteId).filter((id) => !seen.has(id));
  // Spec §4.1: E = (stored ∪ feed) − ids seen present; a record's parent in E counts too.
  const present = new Set([...seen, ...remote.folders.keys(), ...remote.unknownFolderIds]);
  const evidence = feed?.evidence ?? new Set<string>();
  for (const id of present) evidence.delete(id);
  const parentOf = new Map(records.map((r) => [r.remoteId, r.remoteParentId]));
  const probed = new Set<string>();
  const probes = await probeRecords(missing, remote, syncRemote, {
    evidenced: (id) => evidence.has(id) || evidence.has(parentOf.get(id) ?? ''),
    seen: probed,
  });
  for (const id of probed) evidence.delete(id);
  return { input: { ...base, probes, digests }, local, remote, feed };
}

/** sync_scan: local files (with text previews) and remote candidates for Claude to choose from. */
export async function scanPair(env: SyncEnv, input: ScanInput): Promise<ScanResult> {
  const file = await env.store.load(input.name);
  const { pair } = file;
  await checkRoots(env, pair);
  const subdir = input.subdir ? validateRelPath(input.subdir) : undefined;
  const limit = input.limit ?? 200;
  const previewChars = input.previewChars ?? 300;
  const local = await scanLocal(pair.localDir, subdir ? { subdir } : {});
  const remote = await scanRemoteTree(env, pair);
  const selected = new Set(pair.selection.map(foldKey));
  const excluded = new Set(pair.excluded.map(foldKey));
  const tracked = new Set(file.records.map((r) => r.remoteId));
  const onlyUnselected = input.onlyUnselected ?? true;
  const localHits = local.entries.filter(
    (e) => !excluded.has(e.foldKey) && !(onlyUnselected && selected.has(e.foldKey)),
  );
  const remoteHits = remote.entries.filter(
    (r) =>
      !tracked.has(r.id) &&
      !selected.has(r.foldKey) &&
      !excluded.has(r.foldKey) &&
      (subdir === undefined || isUnder(r.key, subdir)),
  );
  const entries: ScanEntry[] = [];
  for (const e of localHits.slice(0, limit)) {
    const mimeType = uploadMimeType(e.name);
    const entry: ScanEntry = {
      path: e.key,
      size: e.size,
      modifiedTime: new Date(e.mtimeMs).toISOString(),
      mimeType,
    };
    if (previewChars > 0 && TEXT_MIME.test(mimeType)) {
      try {
        const preview = await readPreview(absInside(pair.localDir, e.name), previewChars);
        if (preview !== undefined) entry.preview = preview;
      } catch (err) {
        env.log.warn('Preview failed', { path: e.key, error: err });
      }
    }
    entries.push(entry);
  }
  return {
    entries,
    remoteCandidates: remoteHits.slice(0, limit).map((r) => ({
      path: r.key,
      size: r.size,
      modifiedTime: r.modifiedTime,
      mimeType: r.mimeType,
    })),
    truncated: localHits.length > limit || remoteHits.length > limit,
  };
}

/** sync_select: add/remove relative paths (spec §8). */
export async function selectPaths(env: SyncEnv, input: SelectInput): Promise<SelectResult> {
  return env.store.withLock(input.name, async () => {
    const file = await env.store.load(input.name);
    const { pair } = file;
    const result: SelectResult = {
      selected: 0,
      excluded: 0,
      tracked: 0,
      added: [],
      removed: [],
      rejected: [],
    };
    const validated = (raw: string): string | null => {
      try {
        return validateRelPath(raw);
      } catch (err) {
        result.rejected.push({
          path: raw,
          reason: err instanceof AppError ? err.message : 'invalid path',
        });
        return null;
      }
    };
    for (const raw of input.remove ?? []) {
      const key = validated(raw);
      if (key === null) continue;
      const fold = foldKey(key);
      pair.selection = pair.selection.filter((k) => foldKey(k) !== fold);
      file.records = file.records.filter((r) => foldKey(r.path) !== fold);
      if (!pair.excluded.some((k) => foldKey(k) === fold)) pair.excluded.push(key);
      result.removed.push(key);
    }
    if (input.add && input.add.length > 0) {
      await checkRoots(env, pair);
      const { local, remote } = await scanBoth(env, pair);
      const localByFold = new Map(local.entries.map((e) => [e.foldKey, e.key]));
      const remoteByFold = new Map(remote.entries.map((r) => [r.foldKey, r.key]));
      const unknown = [...local.unknownSubtrees, ...remote.unknownSubtrees];
      const blocking = local.blocking.map(foldKey);
      for (const raw of input.add) {
        const key = validated(raw);
        if (key === null) continue;
        const fold = foldKey(key);
        const reject = (reason: string): void => {
          result.rejected.push({ path: raw, reason });
        };
        if (key.split('/').some(isIgnoredName)) reject('dot-files and temp files are never synced');
        else if (unknown.some((u) => isUnder(key, u)))
          reject('inside a folder that could not be read');
        else if (ancestorKeys(key).some((a) => blocking.includes(foldKey(a))))
          reject('inside a symlinked, special or ignored folder');
        else if (file.records.some((r) => r.remoteOnly && foldKey(r.path) === fold)) {
          // Spec §8: add on a released file restores it on the next run (O0/O1).
          for (const r of file.records) {
            if (!r.remoteOnly || foldKey(r.path) !== fold) continue;
            r.restorePending = true;
            pair.excluded = pair.excluded.filter((k) => foldKey(k) !== fold);
            if (!pair.selection.some((k) => foldKey(k) === fold)) pair.selection.push(r.path);
            result.added.push(r.path);
          }
        } else if (pair.selection.some((k) => foldKey(k) === fold)) continue;
        else {
          const canonical = localByFold.get(fold) ?? remoteByFold.get(fold);
          if (canonical === undefined) reject('not found locally or in the Drive folder');
          else {
            pair.excluded = pair.excluded.filter((k) => foldKey(k) !== fold);
            pair.selection.push(canonical);
            result.added.push(canonical);
          }
        }
      }
    }
    pruneEvidence(file);
    await env.store.save(file);
    return {
      ...result,
      selected: pair.selection.length,
      excluded: pair.excluded.length,
      tracked: file.records.length,
    };
  });
}
