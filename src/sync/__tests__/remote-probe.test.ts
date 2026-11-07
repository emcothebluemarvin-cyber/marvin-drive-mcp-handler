import { describe, expect, it } from 'vitest';
import type { DriveFile } from '../../drive/drive-adapter.js';
import {
  DriveApiError,
  NotFoundError,
  PermissionDeniedError,
  QuotaExceededError,
} from '../../errors.js';
import { GOOGLE_MIME } from '../../files/export-formats.js';
import { probeRecord, probeRecords, type FileGetter } from '../remote-probe.js';
import type { RemoteScan } from '../types.js';
import { binary } from './drive-tree.js';

const ROOT = 'root';

function scan(overrides: Partial<RemoteScan> = {}): RemoteScan {
  return {
    entries: [],
    ignored: [],
    folders: new Map([
      [ROOT, ''],
      ['f1', 'docs'],
    ]),
    unknownSubtrees: ['dup'],
    unknownFolderIds: ['d1'],
    ...overrides,
  };
}

function getter(files: Record<string, DriveFile | Error>): FileGetter {
  return async (id) => {
    const f = files[id];
    if (f === undefined) throw new NotFoundError(id);
    if (f instanceof Error) throw f;
    return f;
  };
}

describe('probeRecord', () => {
  it('reports trashed files', async () => {
    const get = getter({ r: binary('r', 'a.pdf', ROOT, { trashed: true }) });
    expect(await probeRecord('r', scan(), get)).toEqual({ state: 'trashed' });
  });

  it('resolves a file whose parent was scanned as present with its key', async () => {
    const probe = await probeRecord('r', scan(), getter({ r: binary('r', 'b.pdf', 'f1') }));
    expect(probe).toMatchObject({ state: 'present', entry: { key: 'docs/b.pdf', parentId: 'f1' } });
  });

  it('is unknown when renamed to an unsyncable name or inside an ambiguous folder', async () => {
    expect((await probeRecord('r', scan(), getter({ r: binary('r', 'a/b', 'f1') }))).state).toBe(
      'unknown',
    );
    expect((await probeRecord('r', scan(), getter({ r: binary('r', '.x', 'f1') }))).state).toBe(
      'unknown',
    );
    expect((await probeRecord('r', scan(), getter({ r: binary('r', 'a.pdf', 'd1') }))).state).toBe(
      'unknown',
    );
  });

  it('classifies Google-native files like the scanner (export key; unsupported → unknown)', async () => {
    const doc = { ...binary('r', 'Plan', 'f1'), mimeType: GOOGLE_MIME.document };
    expect(await probeRecord('r', scan(), getter({ r: doc }))).toMatchObject({
      state: 'present',
      entry: { key: 'docs/Plan.docx', md5: null, native: { exportFormat: 'docx' } },
    });
    const form = { ...binary('r', 'Survey', 'f1'), mimeType: 'application/vnd.google-apps.form' };
    expect(await probeRecord('r', scan(), getter({ r: form }))).toEqual({
      state: 'unknown',
      reason: 'is a Google file type that cannot be exported',
    });
    const dir = { ...binary('r', 'sub', 'f1'), mimeType: GOOGLE_MIME.folder };
    expect((await probeRecord('r', scan(), getter({ r: dir }))).state).toBe('unknown');
  });

  it('is unknown when nested under an unscanned folder inside the pair', async () => {
    const get = getter({
      r: binary('r', 'a.pdf', 'hidden-sub'),
      'hidden-sub': { id: 'hidden-sub', parents: ['dot-folder'] },
      'dot-folder': { id: 'dot-folder', parents: [ROOT] },
    });
    expect(await probeRecord('r', scan(), get)).toEqual({
      state: 'unknown',
      reason: 'inside a Drive folder that was not scanned',
    });
  });

  it('reports moved-out when the ancestry leaves the pair', async () => {
    const get = getter({
      r: binary('r', 'a.pdf', 'elsewhere'),
      elsewhere: { id: 'elsewhere', parents: ['my-drive'] },
      'my-drive': { id: 'my-drive' },
    });
    expect(await probeRecord('r', scan(), get)).toEqual({ state: 'moved-out' });
    const orphan = getter({ r: { ...binary('r', 'a.pdf', ROOT), parents: [] } });
    expect(await probeRecord('r', scan(), orphan)).toEqual({ state: 'moved-out' });
  });

  it('maps 404/403 to unavailable and other failures to unknown', async () => {
    expect(await probeRecord('r', scan(), getter({}))).toEqual({ state: 'unavailable' });
    const denied = getter({ r: new PermissionDeniedError('r') });
    expect(await probeRecord('r', scan(), denied)).toEqual({ state: 'unavailable' });
    const flaky = getter({ r: new DriveApiError(500, 'boom') });
    expect((await probeRecord('r', scan(), flaky)).state).toBe('unknown');
    const parentGone = getter({ r: binary('r', 'a.pdf', 'x') });
    expect(await probeRecord('r', scan(), parentGone)).toEqual({
      state: 'unknown',
      reason: 'a parent folder cannot be read',
    });
  });

  it('rethrows run-aborting errors', async () => {
    const get = getter({ r: new QuotaExceededError('emco') });
    await expect(probeRecord('r', scan(), get)).rejects.toBeInstanceOf(QuotaExceededError);
  });

  it('probes many ids', async () => {
    const get = getter({ a: binary('a', 'a.pdf', ROOT, { trashed: true }) });
    const probes = await probeRecords(['a', 'b'], scan(), get);
    expect([...probes.entries()]).toEqual([
      ['a', { state: 'trashed' }],
      ['b', { state: 'unavailable' }],
    ]);
  });
});
