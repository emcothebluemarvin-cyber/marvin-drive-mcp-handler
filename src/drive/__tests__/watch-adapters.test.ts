import { google } from 'googleapis';
import { describe, expect, it } from 'vitest';
import { createDriveAdapter } from '../drive-adapter.js';
import { createSheetsAdapter } from '../sheets-adapter.js';

interface Captured {
  url: string;
  method?: string;
  params?: Record<string, unknown>;
}

function fakeAuth(
  captured: Captured[],
  data: unknown = {},
): InstanceType<typeof google.auth.OAuth2> {
  const auth = new google.auth.OAuth2();
  auth.setCredentials({ access_token: 'test-token' });
  auth.request = (async (opts: Captured) => {
    captured.push(opts);
    return { data, status: 200, headers: {}, config: opts, statusText: 'OK' };
  }) as unknown as typeof auth.request;
  return auth;
}

describe('watch adapter methods', () => {
  it('getStartPageToken returns the token for all drives', async () => {
    const captured: Captured[] = [];
    const drive = createDriveAdapter(fakeAuth(captured, { startPageToken: '42' }));
    expect(await drive.getStartPageToken()).toBe('42');
    expect(captured[0]?.url).toContain('/drive/v3/changes/startPageToken');
    expect(captured[0]?.params).toMatchObject({ supportsAllDrives: true });
  });

  it('getStartPageToken fails without a token', async () => {
    const drive = createDriveAdapter(fakeAuth([], {}));
    await expect(drive.getStartPageToken()).rejects.toThrow('no start page token');
  });

  it('listChanges sends the spec §5.1 parameters', async () => {
    const captured: Captured[] = [];
    const drive = createDriveAdapter(fakeAuth(captured, { changes: [] }));
    await drive.listChanges({ pageToken: 't1', pageSize: 1000, fields: 'f' });
    expect(captured[0]?.url).toContain('/drive/v3/changes');
    expect(captured[0]?.params).toMatchObject({
      pageToken: 't1',
      pageSize: 1000,
      fields: 'f',
      spaces: 'drive',
      includeItemsFromAllDrives: true,
      supportsAllDrives: true,
      includeRemoved: true,
    });
  });

  it('listComments excludes deleted comments', async () => {
    const captured: Captured[] = [];
    const drive = createDriveAdapter(fakeAuth(captured, { comments: [] }));
    await drive.listComments({
      fileId: 'd1',
      startModifiedTime: '2026-11-07T10:00:00.000Z',
      pageSize: 100,
      fields: 'comments(id)',
    });
    expect(captured[0]?.url).toContain('/drive/v3/files/d1/comments');
    expect(captured[0]?.params).toMatchObject({
      startModifiedTime: '2026-11-07T10:00:00.000Z',
      pageSize: 100,
      fields: 'comments(id)',
      includeDeleted: false,
    });
  });

  it('sheets batchGetValues sends every range and the render option', async () => {
    const captured: Captured[] = [];
    const sheets = createSheetsAdapter(fakeAuth(captured, { valueRanges: [] }));
    await sheets.batchGetValues('s1', ["'A'", "'B c'"], 'FORMATTED_VALUE');
    expect(captured[0]?.url).toContain('/v4/spreadsheets/s1/values:batchGet');
    expect(captured[0]?.params).toMatchObject({
      ranges: ["'A'", "'B c'"],
      valueRenderOption: 'FORMATTED_VALUE',
    });
  });
});
