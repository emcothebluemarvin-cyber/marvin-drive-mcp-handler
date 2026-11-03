import type { PlanInput } from '../resolve.js';
import type {
  LocalEntry,
  OnDiskProbe,
  Pair,
  Probe,
  RemoteEntry,
  RemoteIgnored,
  SyncRecord,
} from '../types.js';
import { ROOT_ID, makePair } from './fixtures.js';

export interface InputOptions {
  pair?: Partial<Pair>;
  records?: SyncRecord[];
  /** Extra selection keys (record paths are always selected). */
  selection?: string[];
  local?: LocalEntry[];
  remote?: RemoteEntry[];
  ignored?: RemoteIgnored[];
  probes?: Array<[string, Probe]>;
  md5s?: Array<[string, string]>;
  onDisk?: Array<[string, OnDiskProbe]>;
  blocking?: string[];
  folders?: Array<[string, string]>;
  occupied?: string[];
  unknownLocal?: string[];
  unknownRemote?: string[];
  unknownFolderIds?: string[];
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
    md5s: new Map(o.md5s ?? []),
    onDisk: new Map(o.onDisk ?? []),
  };
}
