import type {
  KnownFile,
  Modifier,
  PendingFlag,
  PendingItem,
  RawChange,
  RawFile,
  WatchEntry,
} from './types.js';

/** The part of an account state that relevance reads and writes. */
export interface Tracking {
  known: Record<string, KnownFile>;
  pending: Record<string, PendingItem>;
}

export interface RelevanceInput {
  change: RawChange;
  /** Entries covering the file now (itself, or watched ancestor folders); empty = not watched. */
  covering: readonly WatchEntry[];
  /** Local observation time (ISO). */
  now: string;
}

const FOLDER_ENTRY_FLAGS: ReadonlySet<PendingFlag> = new Set(['renamed', 'trashed', 'restored']);

export function toKnown(file: RawFile, via: readonly string[]): KnownFile {
  return {
    name: file.name,
    kind: file.kind,
    parents: [...file.parents],
    trashed: file.trashed,
    modifiedTime: file.modifiedTime,
    version: file.version,
    md5: file.md5,
    size: file.size,
    via: [...via].sort(),
  };
}

function ms(iso: string): number {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? 0 : t;
}

function sameParents(a: readonly string[], b: readonly string[]): boolean {
  const x = [...a].sort();
  const y = [...b].sort();
  return x.length === y.length && x.every((v, i) => v === y[i]);
}

function changedFlags(prior: KnownFile, next: KnownFile): PendingFlag[] {
  const flags: PendingFlag[] = [];
  if (prior.modifiedTime !== next.modifiedTime || prior.md5 !== next.md5) flags.push('edited');
  if (prior.name !== next.name) flags.push('renamed');
  if (!sameParents(prior.parents, next.parents)) flags.push('moved');
  if (!prior.trashed && next.trashed) flags.push('trashed');
  if (prior.trashed && !next.trashed) flags.push('restored');
  return flags;
}

function modifierKey(m: Modifier): string {
  return `${m.email ?? ''}|${m.name ?? ''}|${m.me}`;
}

function remember(t: Tracking, id: string, known: KnownFile): Tracking {
  return { known: { ...t.known, [id]: known }, pending: t.pending };
}

function forget(t: Tracking, id: string): Tracking {
  const known = { ...t.known };
  delete known[id];
  return { known, pending: t.pending };
}

function withPending(
  t: Tracking,
  id: string,
  before: KnownFile | null,
  after: KnownFile | null,
  flags: readonly PendingFlag[],
  modifier: Modifier | null,
  now: string,
): Tracking {
  const existing = t.pending[id];
  let item: PendingItem;
  if (existing) {
    const modifiers = [...existing.modifiers];
    if (modifier && !modifiers.some((m) => modifierKey(m) === modifierKey(modifier))) {
      modifiers.push(modifier);
    }
    item = {
      ...existing,
      lastSeen: now,
      flags: [...new Set([...existing.flags, ...flags])],
      modifiers,
      after,
    };
  } else {
    item = {
      fileId: id,
      firstSeen: now,
      lastSeen: now,
      modifiers: modifier ? [modifier] : [],
      flags: [...flags],
      before,
      after,
    };
  }
  return { known: t.known, pending: { ...t.pending, [id]: item } };
}

/** A file that comes back (moved in again, access regained) cancels its removed/moved-out item. */
function dropTerminal(t: Tracking, id: string): Tracking {
  const item = t.pending[id];
  if (!item || !item.flags.some((f) => f === 'removed' || f === 'moved-out')) return t;
  const pending = { ...t.pending };
  delete pending[id];
  return { known: t.known, pending };
}

/** No-op change: an existing pending item still gets the latest state (lastSeen unchanged). */
function refreshAfter(t: Tracking, id: string, after: KnownFile): Tracking {
  const item = t.pending[id];
  if (!item) return t;
  return { known: t.known, pending: { ...t.pending, [id]: { ...item, after } } };
}

/** PURE: applies one raw change to the known/pending state of an account (spec §5.3). */
export function applyChange(t: Tracking, input: RelevanceInput): Tracking {
  const { change, covering, now } = input;
  const id = change.fileId;
  const prior = t.known[id];

  if (change.removed || change.file === null) {
    if (prior === undefined) return t;
    return withPending(forget(t, id), id, prior, null, ['removed'], null, now);
  }
  const file = change.file;
  if (covering.length === 0) {
    if (prior === undefined) return t;
    const after = toKnown(file, prior.via);
    return withPending(forget(t, id), id, prior, after, ['moved-out'], null, now);
  }
  const next = toKnown(
    file,
    covering.map((e) => e.id),
  );
  if (prior === undefined) {
    t = dropTerminal(t, id);
    const addedAt = Math.min(...covering.map((e) => ms(e.addedAt)));
    if (ms(file.createdTime) >= addedAt) {
      return withPending(remember(t, id, next), id, null, next, ['added'], file.modifier, now);
    }
    if (ms(file.modifiedTime) < addedAt || file.kind === 'folder') return remember(t, id, next);
    return withPending(
      remember(t, id, next),
      id,
      null,
      next,
      ['edited', 'first-seen'],
      file.modifier,
      now,
    );
  }
  let flags = changedFlags(prior, next);
  const self = covering.find((e) => e.id === id);
  if (self?.folder) flags = flags.filter((f) => FOLDER_ENTRY_FLAGS.has(f));
  else if (file.kind === 'folder') flags = flags.filter((f) => f !== 'edited');
  if (flags.length === 0) return refreshAfter(remember(t, id, next), id, next);
  return withPending(remember(t, id, next), id, prior, next, flags, file.modifier, now);
}
