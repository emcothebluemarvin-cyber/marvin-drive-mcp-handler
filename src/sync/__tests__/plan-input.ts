import type { HashKind } from '../remote/sync-remote.js';
import type { PlanInput } from '../resolve.js';
import type {
  LocalEntry,
  OnDiskProbe,
  Pair,
  Probe,
  RemoteEntry,
  RemoteIgnored,
  LocalDigests,
  SyncRecord,
} from '../types.js';
import { ROOT_ID, makePair, md5Hash } from './fixtures.js';

export interface InputOptions {
  pair?: Partial<Pair>;
  records?: SyncRecord[];
  /** Extra selection keys (record paths are always selected). */
  selection?: string[];
  local?: LocalEntry[];
  remote?: RemoteEntry[];
  ignored?: RemoteIgnored[];
  probes?: Array<[string, Probe]>;
  /** Shorthand: local md5 by on-disk name (its remote digest is the same md5). */
  md5s?: Array<[string, string]>;
  digests?: Array<[string, LocalDigests]>;
  remoteHashKind?: HashKind;
  onDisk?: Array<[string, OnDiskProbe]>;
  blocking?: string[];
  folders?: Array<[string, string]>;
  occupied?: string[];
  unknownLocal?: string[];
  unknownRemote?: string[];
  unknownFolderIds?: string[];
}

/** The digests of a file whose md5 is `md5` on an md5 remote. */
export function md5Digests(md5: string): LocalDigests {
  return { md5, remote: md5Hash(md5) };
}

export function planInput(o: InputOptions = {}): PlanInput {
  const records = o.records ?? [];
  const pair = makePair({
    selection: [...records.map((r) => r.path), ...(o.selection ?? [])],
    ...o.pair,
  });
  return {
    pair,
    records,
    local: {
      entries: o.local ?? [],
      occupied: o.occupied ?? [],
      unknownSubtrees: o.unknownLocal ?? [],
      blocking: o.blocking ?? [],
      partFiles: [],
    },
    remote: {
      entries: o.remote ?? [],
      ignored: o.ignored ?? [],
      folders: new Map([[ROOT_ID, ''], ...(o.folders ?? [])]),
      unknownSubtrees: o.unknownRemote ?? [],
      unknownFolderIds: o.unknownFolderIds ?? [],
    },
    probes: new Map(o.probes ?? []),
    digests: new Map([
      ...(o.md5s ?? []).map(([name, md5]): [string, LocalDigests] => [name, md5Digests(md5)]),
      ...(o.digests ?? []),
    ]),
    remoteHashKind: o.remoteHashKind ?? 'md5',
    onDisk: new Map(o.onDisk ?? []),
  };
}
