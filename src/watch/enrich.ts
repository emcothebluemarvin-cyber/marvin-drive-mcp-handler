import type { Logger } from '../logger.js';
import { isOwnItem } from './coalesce.js';
import type { ContentSnapshotter } from './feed.js';
import { sanitizeLine, sanitizeModifier, sanitizeText } from './sanitize.js';
import { sheetDiff } from './sheet-diff.js';
import { textDiff, type DiffResult } from './text-diff.js';
import {
  isNative,
  type CommentInfo,
  type CommentNote,
  type EventDraft,
  type EventKind,
  type KnownFile,
  type PendingFlag,
  type PendingItem,
  type Snapshot,
  type StoredSnapshot,
} from './types.js';

export interface EnrichInput {
  item: PendingItem;
  account: string;
  snapshotter: ContentSnapshotter;
  previous: StoredSnapshot | null;
  /** lastCommentCheck of the file (or the item's firstSeen). */
  since: string;
  now: Date;
  log: Logger;
}

export interface EnrichResult {
  event: EventDraft | null;
  /** 'keep': leave the stored snapshot; 'drop': delete it; otherwise store this one. */
  snapshot: StoredSnapshot | 'keep' | 'drop';
  /** New lastCommentCheck, or null when comments were not checked. */
  commentCheck: string | null;
}

const KIND_ORDER: ReadonlyArray<PendingFlag & EventKind> = [
  'removed',
  'moved-out',
  'trashed',
  'restored',
  'added',
  'edited',
  'renamed',
  'moved',
];
const STRUCTURAL: ReadonlySet<PendingFlag> = new Set([
  'added',
  'renamed',
  'moved',
  'trashed',
  'restored',
  'removed',
  'moved-out',
]);
const CONTENT_FLAGS: ReadonlySet<PendingFlag> = new Set([
  'added',
  'edited',
  'first-seen',
  'restored',
]);

export function diffSnapshots(before: Snapshot, after: Snapshot): DiffResult | null {
  if (before.type === 'text' && after.type === 'text') return textDiff(before.text, after.text);
  if (before.type === 'sheet' && after.type === 'sheet')
    return sheetDiff(before.sheets, after.sheets);
  return null;
}

function emptyLike(s: Snapshot): Snapshot {
  return s.type === 'text' ? { type: 'text', text: '' } : { type: 'sheet', sheets: [] };
}

const byTime = (a: CommentNote, b: CommentNote): number =>
  a.time < b.time ? -1 : a.time > b.time ? 1 : 0;

/** Comments and replies created since `since` by someone other than the account (sanitized). */
export function newForeignNotes(comments: readonly CommentInfo[], since: string): CommentNote[] {
  const from = Date.parse(since);
  const fresh = (t: string): boolean => Number.isNaN(from) || Date.parse(t) >= from;
  const notes: CommentNote[] = [];
  for (const c of comments) {
    if (!c.author.me && fresh(c.createdTime)) {
      notes.push({
        type: 'comment',
        commentId: c.id,
        author: sanitizeModifier(c.author),
        content: sanitizeText(c.content),
        time: c.createdTime,
      });
    }
    for (const r of c.replies) {
      if (!r.author.me && fresh(r.createdTime)) {
        notes.push({
          type: 'reply',
          commentId: c.id,
          author: sanitizeModifier(r.author),
          content: sanitizeText(r.content),
          time: r.createdTime,
        });
      }
    }
  }
  return notes.sort(byTime);
}

function otherFileLines(before: KnownFile | null, after: KnownFile | null): string[] {
  if (!before || !after) return [];
  const lines: string[] = [];
  if (before.size !== after.size)
    lines.push(`size: ${before.size ?? '?'} → ${after.size ?? '?'} bytes`);
  else if (before.md5 !== after.md5) lines.push('content changed');
  return lines;
}

/** Snapshot → diff → comments → event, or null when nothing visible changed (spec §6). */
export async function enrich(input: EnrichInput): Promise<EnrichResult> {
  const { item, snapshotter, log, now } = input;
  const has = (f: PendingFlag): boolean => item.flags.includes(f);
  const state = item.after ?? item.before;
  const kind = state?.kind ?? 'other';
  const native = isNative(kind);
  const gone = has('removed') || has('moved-out');
  const notes: string[] = [];
  if (has('first-seen')) notes.push('first seen in a watched folder');
  let diff: string | null = null;
  let snapshot: EnrichResult['snapshot'] = gone ? 'drop' : 'keep';
  let contentVisible = false;
  let comments: CommentNote[] = [];
  let commentCheck: string | null = null;

  if (native && !gone && !has('trashed') && item.flags.some((f) => CONTENT_FLAGS.has(f))) {
    try {
      const snap = await snapshotter.snapshot(item.fileId, kind);
      if ('tooLarge' in snap) {
        notes.push('changed (too large to compare)');
        snapshot = 'drop';
        contentVisible = true;
      } else {
        snapshot = { takenAt: now.toISOString(), snapshot: snap };
        const base = input.previous?.snapshot ?? (has('added') ? emptyLike(snap) : null);
        if (base === null || base.type !== snap.type) {
          notes.push('no earlier version to compare');
          contentVisible = true;
        } else {
          const d = diffSnapshots(base, snap);
          if (d === null) {
            notes.push('too many changes to compare');
            contentVisible = true;
          } else if (d.changes > 0) {
            diff = sanitizeText(d.text);
            contentVisible = true;
          }
        }
      }
    } catch (err) {
      log.warn('Watch snapshot failed', { fileId: item.fileId, error: err });
      notes.push('content could not be read');
      snapshot = 'keep';
      contentVisible = true;
    }
  }

  if (native && !gone) {
    try {
      comments = newForeignNotes(
        await snapshotter.commentsSince(item.fileId, input.since),
        input.since,
      );
      commentCheck = now.toISOString();
    } catch (err) {
      log.warn('Watch comment check failed', { fileId: item.fileId, error: err });
    }
  }

  if (!native) {
    const lines = otherFileLines(item.before, item.after);
    if (lines.length > 0) {
      diff = lines.join('\n');
      contentVisible = true;
    }
  }

  const structural = item.flags.some((f) => STRUCTURAL.has(f));
  const visible = structural || contentVisible || comments.length > 0 || has('first-seen');
  if (!visible) return { event: null, snapshot, commentCheck };

  const eventKind: EventKind =
    !structural && !contentVisible && comments.length > 0
      ? 'commented'
      : (KIND_ORDER.find((f) => has(f)) ?? 'edited');
  const own = isOwnItem(item) && comments.length === 0;
  const event: EventDraft = {
    id: `${input.account}:${item.fileId}:${item.lastSeen}`,
    account: input.account,
    kind: eventKind,
    flags: [...item.flags],
    fileId: item.fileId,
    name: sanitizeLine(state?.name ?? ''),
    previousName: has('renamed') && item.before ? sanitizeLine(item.before.name) : null,
    fileKind: kind,
    time: item.lastSeen,
    firstSeen: item.firstSeen,
    modifiers: item.modifiers.map(sanitizeModifier),
    own,
    alsoByYou: !own && item.modifiers.some((m) => m.me),
    diff,
    note: notes.length > 0 ? notes.join('; ') : null,
    comments,
    untrusted: true,
  };
  return { event, snapshot, commentCheck };
}
