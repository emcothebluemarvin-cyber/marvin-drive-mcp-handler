import {
  GRAPH,
  fakeGraph,
  json,
  makeClient,
  type FakeCall,
  type Responder,
} from '../../onedrive/__tests__/fake-graph.js';
import { OneDriveSyncRemote, type SyncGraphItem } from '../remote/onedrive-remote.js';

export const DRIVE = 'b!drive1';
export const NEXT = `${GRAPH}/me/drive/items/P/children?$skiptoken=abc`;

/** A OneDriveSyncRemote for account `ms` over a fake Graph fetch (drive id answered). */
export function remoteOver(responder: Responder): {
  remote: OneDriveSyncRemote;
  calls: FakeCall[];
} {
  const fake = fakeGraph((call) =>
    call.path === '/me/drive?$select=id' ? json({ id: DRIVE }) : responder(call),
  );
  return { remote: new OneDriveSyncRemote(makeClient(fake).client, 'ms'), calls: fake.calls };
}

export function graphFile(
  id: string,
  name: string,
  extra: Partial<SyncGraphItem> = {},
): SyncGraphItem {
  return {
    id,
    name,
    size: 5,
    eTag: `"{${id}},1"`,
    createdDateTime: '2026-11-01T00:00:00Z',
    lastModifiedDateTime: '2026-11-02T00:00:00Z',
    file: { mimeType: 'application/pdf', hashes: { quickXorHash: `qx-${id}` } },
    parentReference: { id: 'P', driveId: DRIVE },
    ...extra,
  };
}

export const graphFolder = (id: string, name: string): SyncGraphItem => ({
  id,
  name,
  folder: {},
  eTag: `"{${id}},1"`,
  parentReference: { id: 'P' },
});
