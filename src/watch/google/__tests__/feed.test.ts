import { describe, expect, it } from 'vitest';
import { OperationRunner } from '../../../core/operation.js';
import { ReauthRequiredError } from '../../../errors.js';
import { GOOGLE_MIME } from '../../../files/export-formats.js';
import {
  createAudit,
  createFakeDrive,
  createRunner,
  httpError,
  noSleep,
  silentLogger,
} from '../../../files/__tests__/fakes.js';
import { InvalidCursorError } from '../../feed.js';
import { CHANGE_FIELDS, FILE_FIELDS, GoogleChangeFeed, MAX_PAGES, kindOfMime } from '../feed.js';

function setup() {
  const drive = createFakeDrive();
  const ops = new OperationRunner({
    runner: createRunner(drive),
    audit: createAudit(),
    retry: noSleep,
    logger: silentLogger(),
  });
  return { drive, feed: new GoogleChangeFeed(ops, 'emco@example.com') };
}

const driveFile = {
  id: 'a',
  name: 'Plan',
  mimeType: GOOGLE_MIME.document,
  parents: ['F'],
  trashed: false,
  modifiedTime: '2026-11-07T11:00:00.000Z',
  createdTime: '2026-11-01T00:00:00.000Z',
  version: '3',
  size: '12',
  lastModifyingUser: { displayName: 'Ayşe', emailAddress: 'a@x.com', me: false },
};

describe('GoogleChangeFeed', () => {
  it('uses the spec §5.1 field lists', () => {
    expect(CHANGE_FIELDS).toBe(
      'nextPageToken,newStartPageToken,changes(fileId,removed,time,file(id,name,mimeType,parents,trashed,modifiedTime,createdTime,version,md5Checksum,size,lastModifyingUser(displayName,emailAddress,me)))',
    );
    expect(FILE_FIELDS).toContain('lastModifyingUser(displayName,emailAddress,me)');
  });

  it('maps MIME types to kinds', () => {
    expect(kindOfMime(GOOGLE_MIME.document)).toBe('doc');
    expect(kindOfMime(GOOGLE_MIME.spreadsheet)).toBe('sheet');
    expect(kindOfMime(GOOGLE_MIME.presentation)).toBe('slides');
    expect(kindOfMime(GOOGLE_MIME.folder)).toBe('folder');
    expect(kindOfMime('application/pdf')).toBe('other');
    expect(kindOfMime(undefined)).toBe('other');
  });

  it('start() returns a fresh start page token', async () => {
    const { drive, feed } = setup();
    drive.getStartPageToken.mockResolvedValueOnce('100');
    expect(await feed.start()).toBe('100');
  });

  it('follows pages until newStartPageToken and maps changes', async () => {
    const { drive, feed } = setup();
    drive.listChanges
      .mockResolvedValueOnce({
        changes: [{ fileId: 'a', removed: false, time: 't1', file: driveFile }],
        nextPageToken: 'p2',
      })
      .mockResolvedValueOnce({
        changes: [{ fileId: 'b', removed: true, time: 't2' }, { time: 't3' }],
        newStartPageToken: 'n',
      });
    const res = await feed.poll('c1');
    expect(res.next).toBe('n');
    expect(res.changes).toEqual([
      {
        fileId: 'a',
        time: 't1',
        removed: false,
        file: {
          name: 'Plan',
          kind: 'doc',
          parents: ['F'],
          trashed: false,
          modifiedTime: '2026-11-07T11:00:00.000Z',
          createdTime: '2026-11-01T00:00:00.000Z',
          version: '3',
          md5: null,
          size: 12,
          modifier: { name: 'Ayşe', email: 'a@x.com', me: false },
        },
      },
      { fileId: 'b', time: 't2', removed: true, file: null },
    ]);
    expect(drive.listChanges.mock.calls.map((c) => c[0])).toEqual([
      { pageToken: 'c1', pageSize: 1000, fields: CHANGE_FIELDS },
      { pageToken: 'p2', pageSize: 1000, fields: CHANGE_FIELDS },
    ]);
  });

  it(`stops after ${MAX_PAGES} pages and continues from the last page token`, async () => {
    const { drive, feed } = setup();
    let n = 0;
    drive.listChanges.mockImplementation(async () => ({ changes: [], nextPageToken: `p${++n}` }));
    const res = await feed.poll('c1');
    expect(drive.listChanges).toHaveBeenCalledTimes(MAX_PAGES);
    expect(res.next).toBe(`p${MAX_PAGES}`);
  });

  it('turns 400/410 into InvalidCursorError and passes other errors through', async () => {
    const { drive, feed } = setup();
    drive.listChanges.mockRejectedValueOnce(httpError(410));
    await expect(feed.poll('old')).rejects.toBeInstanceOf(InvalidCursorError);
    drive.listChanges.mockRejectedValueOnce(httpError(400));
    await expect(feed.poll('old')).rejects.toBeInstanceOf(InvalidCursorError);
    drive.listChanges.mockClear();
    drive.listChanges.mockRejectedValue(httpError(500));
    await expect(feed.poll('c')).rejects.not.toBeInstanceOf(InvalidCursorError);
    expect(drive.listChanges).toHaveBeenCalledTimes(4); // 1 + 3 retries
  });

  it('lets ReauthRequiredError through', async () => {
    const ops = new OperationRunner({
      runner: {
        run: async () => {
          throw new ReauthRequiredError('emco');
        },
      },
      audit: createAudit(),
      logger: silentLogger(),
    });
    await expect(new GoogleChangeFeed(ops, 'emco@example.com').poll('c')).rejects.toBeInstanceOf(
      ReauthRequiredError,
    );
  });

  it('parentsOf returns parents, or null when not accessible', async () => {
    const { drive, feed } = setup();
    drive.getFile.mockResolvedValueOnce({ parents: ['P'] });
    expect(await feed.parentsOf('x')).toEqual(['P']);
    expect(drive.getFile).toHaveBeenLastCalledWith('x', 'parents');
    drive.getFile.mockRejectedValueOnce(httpError(404));
    expect(await feed.parentsOf('y')).toBeNull();
    drive.getFile.mockRejectedValueOnce(httpError(403));
    expect(await feed.parentsOf('z')).toBeNull();
  });

  it('file() maps one file with FILE_FIELDS', async () => {
    const { drive, feed } = setup();
    drive.getFile.mockResolvedValueOnce({
      ...driveFile,
      size: undefined,
      lastModifyingUser: undefined,
      md5Checksum: 'm',
    });
    const f = await feed.file('a');
    expect(drive.getFile).toHaveBeenCalledWith('a', FILE_FIELDS);
    expect(f).toMatchObject({ name: 'Plan', kind: 'doc', size: null, md5: 'm', modifier: null });
  });
});
