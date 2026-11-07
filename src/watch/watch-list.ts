import { ValidationError } from '../errors.js';
import type { Logger } from '../logger.js';
import type { WatchProvider } from './feed.js';
import { toKnown } from './relevance.js';
import { sanitizeLine } from './sanitize.js';
import { emptyState, isNative, type Snapshot, type WatchEntry } from './types.js';
import type { WatchStore } from './watch-store.js';

/** Spec §4: per account; a folder counts as one entry. */
export const MAX_ENTRIES = 200;

export interface WatchListDeps {
  store: WatchStore;
  provider: WatchProvider;
  now: () => Date;
  log: Logger;
}

export interface WatchAddResult {
  action: 'add';
  account: string;
  entry: WatchEntry;
  alreadyWatched: boolean;
}

export interface WatchRemoveResult {
  action: 'remove';
  account: string;
  removed: WatchEntry;
}

export interface WatchListResult {
  action: 'list';
  watches: Array<{ account: string; entries: WatchEntry[] }>;
}

function checkLimit(count: number): void {
  if (count >= MAX_ENTRIES) {
    throw new ValidationError(
      `At most ${MAX_ENTRIES} watched files and folders per account; remove one first`,
    );
  }
}

export async function addWatch(
  deps: WatchListDeps,
  input: { fileId: string; account?: string },
): Promise<WatchAddResult> {
  const { email } = await deps.provider.resolveAccount(input.account);
  const feed = deps.provider.feed(email);
  const meta = await feed.file(input.fileId);
  const current = await deps.store.load(email);
  const existing = current.entries.find((e) => e.id === input.fileId);
  if (existing) return { action: 'add', account: email, entry: existing, alreadyWatched: true };
  checkLimit(current.entries.length);

  // Network work first; the lock only covers the local read-modify-write (spec §7.1).
  const freshCursor = await feed.start();
  let baseline: Snapshot | null = null;
  if (isNative(meta.kind)) {
    try {
      const s = await deps.provider.snapshotter(email).snapshot(input.fileId, meta.kind);
      baseline = 'tooLarge' in s ? null : s;
    } catch (err) {
      deps.log.warn('Baseline snapshot failed; the first change will have no diff', {
        fileId: input.fileId,
        error: err,
      });
    }
  }
  const addedAt = deps.now().toISOString();
  const entry: WatchEntry = {
    id: input.fileId,
    name: sanitizeLine(meta.name),
    kind: meta.kind,
    folder: meta.kind === 'folder',
    addedAt,
  };

  return deps.store.withLock(async (): Promise<WatchAddResult> => {
    const state = await deps.store.load(email);
    const dup = state.entries.find((e) => e.id === entry.id);
    if (dup) return { action: 'add', account: email, entry: dup, alreadyWatched: true };
    checkLimit(state.entries.length);
    if (state.cursor === null) state.cursor = freshCursor;
    state.entries.push(entry);
    // Keep the folders that already cover the file (else removing this entry would orphan it).
    const via = [...new Set([...(state.known[entry.id]?.via ?? []), entry.id])];
    state.known[entry.id] = toKnown(meta, via);
    if (isNative(meta.kind)) state.lastCommentCheck[entry.id] = addedAt;
    if (baseline) {
      await deps.store.saveSnapshot(email, entry.id, { takenAt: addedAt, snapshot: baseline });
    }
    await deps.store.save(email, state);
    return { action: 'add', account: email, entry, alreadyWatched: false };
  });
}

export async function removeWatch(
  deps: WatchListDeps,
  input: { fileId: string; account?: string },
): Promise<WatchRemoveResult> {
  const { email } = await deps.provider.resolveAccount(input.account);
  return deps.store.withLock(async (): Promise<WatchRemoveResult> => {
    const state = await deps.store.load(email);
    const removed = state.entries.find((e) => e.id === input.fileId);
    if (!removed) throw new ValidationError(`${input.fileId} is not watched for ${email}`);
    const remaining = new Set(state.entries.filter((e) => e.id !== removed.id).map((e) => e.id));
    const orphan = (via: readonly string[]): boolean => via.every((v) => !remaining.has(v));
    const drop = new Set<string>();
    for (const [id, k] of Object.entries(state.known)) if (orphan(k.via)) drop.add(id);
    for (const [id, p] of Object.entries(state.pending)) {
      if (orphan((p.after ?? p.before)?.via ?? [])) drop.add(id);
    }
    for (const id of drop) {
      delete state.known[id];
      delete state.pending[id];
      delete state.lastCommentCheck[id];
      await deps.store.removeSnapshot(email, id);
    }
    state.entries = state.entries.filter((e) => e.id !== removed.id);
    await deps.store.save(email, state.entries.length === 0 ? emptyState() : state);
    return { action: 'remove', account: email, removed };
  });
}

export async function listWatches(
  deps: WatchListDeps,
  input: { account?: string },
): Promise<WatchListResult> {
  if (input.account !== undefined) {
    const { email } = await deps.provider.resolveAccount(input.account);
    return {
      action: 'list',
      watches: [{ account: email, entries: (await deps.store.load(email)).entries }],
    };
  }
  const watches: WatchListResult['watches'] = [];
  for (const email of await deps.store.accounts()) {
    const { entries } = await deps.store.load(email);
    if (entries.length > 0) watches.push({ account: email, entries });
  }
  return { action: 'list', watches };
}
