import type {
  ChangeEvent,
  EventDraft,
  Modifier,
  RawChange,
  RawFile,
  WatchEntry,
} from '../types.js';

export const ME: Modifier = { name: 'Emco', email: 'me@example.com', me: true };
export const AYSE: Modifier = { name: 'Ayşe Demir', email: 'ayse@example.com', me: false };
export const BORA: Modifier = { name: 'Bora', email: 'bora@example.com', me: false };

export const ADDED_AT = '2026-11-07T10:00:00.000Z';

export function rawFile(over: Partial<RawFile> = {}): RawFile {
  return {
    name: 'Plan',
    kind: 'doc',
    parents: ['F'],
    trashed: false,
    modifiedTime: '2026-11-07T11:00:00.000Z',
    createdTime: '2026-11-01T00:00:00.000Z',
    version: '5',
    md5: null,
    size: null,
    modifier: AYSE,
    ...over,
  };
}

export function change(fileId: string, file: RawFile | null): RawChange {
  return { fileId, time: '2026-11-07T11:00:01.000Z', removed: file === null, file };
}

export function folderEntry(over: Partial<WatchEntry> = {}): WatchEntry {
  return { id: 'F', name: 'Team', kind: 'folder', folder: true, addedAt: ADDED_AT, ...over };
}

export function fileEntry(over: Partial<WatchEntry> = {}): WatchEntry {
  return { id: 'D', name: 'Plan', kind: 'doc', folder: false, addedAt: ADDED_AT, ...over };
}

export function makeDraft(over: Partial<EventDraft> = {}): EventDraft {
  return {
    id: 'me@example.com:D:2026-11-07T11:00:00.000Z',
    account: 'me@example.com',
    kind: 'edited',
    flags: ['edited'],
    fileId: 'D',
    name: 'Plan',
    previousName: null,
    fileKind: 'doc',
    time: '2026-11-07T11:00:00.000Z',
    firstSeen: '2026-11-07T11:00:00.000Z',
    modifiers: [AYSE],
    own: false,
    alsoByYou: false,
    diff: '- a\n+ b',
    note: null,
    comments: [],
    untrusted: true,
    ...over,
  };
}

/** An inbox event; the id defaults to one derived from `seq`. */
export function makeEvent(over: Partial<ChangeEvent> = {}): ChangeEvent {
  const seq = over.seq ?? 1;
  return { ...makeDraft({ id: `me@example.com:D:${seq}` }), seq, ...over };
}
