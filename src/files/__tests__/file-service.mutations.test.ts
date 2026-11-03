import { beforeEach, describe, expect, it } from 'vitest';
import { DriveApiError, ValidationError } from '../../errors.js';
import { GOOGLE_MIME } from '../export-formats.js';
import { FileService, SUMMARY_FIELDS } from '../file-service.js';
import {
  createAudit,
  createFakeDrive,
  createRunner,
  httpError,
  noSleep,
  silentLogger,
  type FakeDrive,
} from './fakes.js';

let drive: FakeDrive;
let audit: ReturnType<typeof createAudit>;
let log: ReturnType<typeof silentLogger>;
let service: FileService;

beforeEach(() => {
  drive = createFakeDrive();
  audit = createAudit();
  log = silentLogger();
  service = new FileService({
    runner: createRunner(drive),
    audit,
    downloadsDir: '/tmp/unused',
    retry: noSleep,
    logger: log,
  });
});

describe('createFolder', () => {
  it('creates under root by default and audits', async () => {
    drive.createFile.mockResolvedValueOnce({
      id: 'd1',
      name: 'New',
      mimeType: GOOGLE_MIME.folder,
      parents: ['root'],
    });
    const res = await service.createFolder({ name: 'New' });
    expect(drive.createFile).toHaveBeenCalledWith({
      requestBody: { name: 'New', mimeType: GOOGLE_MIME.folder, parents: ['root'] },
      fields: SUMMARY_FIELDS,
    });
    expect(res).toMatchObject({ id: 'd1', name: 'New' });
    expect(audit.entries).toEqual([
      {
        account: 'emco',
        op: 'create_folder',
        fileId: 'd1',
        name: 'New',
        details: { parentId: 'root' },
      },
    ]);
  });

  it('does not retry on 5xx and hints at duplicates', async () => {
    drive.createFile.mockRejectedValueOnce(httpError(500));
    await expect(service.createFolder({ name: 'X' })).rejects.toThrow(/duplicate/);
    expect(drive.createFile).toHaveBeenCalledTimes(1);
  });
});

describe('move', () => {
  it('adds the new parent and removes all old ones', async () => {
    drive.getFile.mockResolvedValueOnce({ id: 'f1', parents: ['p1', 'p2'] });
    drive.updateFile.mockResolvedValueOnce({ id: 'f1', name: 'F', parents: ['n1'] });
    const res = await service.move({ fileId: 'f1', newParentId: 'n1' });
    expect(drive.getFile).toHaveBeenCalledWith('f1', 'id, parents');
    expect(drive.updateFile).toHaveBeenCalledWith({
      fileId: 'f1',
      addParents: 'n1',
      removeParents: 'p1,p2',
      fields: SUMMARY_FIELDS,
    });
    expect(res.parents).toEqual(['n1']);
    expect(audit.entries[0]).toMatchObject({
      op: 'move',
      details: { oldParents: ['p1', 'p2'], newParentId: 'n1' },
    });
  });

  it('only removes other parents when already in the target', async () => {
    drive.getFile.mockResolvedValueOnce({ id: 'f1', parents: ['n1', 'p2'] });
    drive.updateFile.mockResolvedValueOnce({ id: 'f1', parents: ['n1'] });
    await service.move({ fileId: 'f1', newParentId: 'n1' });
    expect(drive.updateFile).toHaveBeenCalledWith({
      fileId: 'f1',
      removeParents: 'p2',
      fields: SUMMARY_FIELDS,
    });
  });

  it('is a no-op when the file is already only in the target', async () => {
    drive.getFile
      .mockResolvedValueOnce({ id: 'f1', parents: ['n1'] })
      .mockResolvedValueOnce({ id: 'f1', name: 'F', parents: ['n1'] });
    await service.move({ fileId: 'f1', newParentId: 'n1' });
    expect(drive.updateFile).not.toHaveBeenCalled();
    expect(audit.entries).toEqual([]);
  });

  it('re-reads parents before retrying after a 5xx', async () => {
    drive.getFile
      .mockResolvedValueOnce({ id: 'f1', parents: ['p1'] })
      .mockResolvedValueOnce({ id: 'f1', parents: ['n1'] }) // first update actually succeeded
      .mockResolvedValueOnce({ id: 'f1', name: 'F', parents: ['n1'] });
    drive.updateFile.mockRejectedValueOnce(httpError(502));
    await service.move({ fileId: 'f1', newParentId: 'n1' });
    expect(drive.updateFile).toHaveBeenCalledTimes(1);
    expect(audit.entries[0]).toMatchObject({ details: { oldParents: ['p1'], newParentId: 'n1' } });
  });
});

describe('rename', () => {
  it('renames and audits old and new names', async () => {
    drive.getFile.mockResolvedValueOnce({ id: 'f1', name: 'old.txt' });
    drive.updateFile.mockResolvedValueOnce({ id: 'f1', name: 'new.txt' });
    await service.rename({ fileId: 'f1', newName: 'new.txt' });
    expect(drive.updateFile).toHaveBeenCalledWith({
      fileId: 'f1',
      requestBody: { name: 'new.txt' },
      fields: SUMMARY_FIELDS,
    });
    expect(audit.entries[0]).toMatchObject({
      op: 'rename',
      details: { oldName: 'old.txt', newName: 'new.txt' },
    });
  });

  it('keeps the original name in the audit entry after a retry', async () => {
    drive.getFile.mockResolvedValueOnce({ id: 'f1', name: 'old.txt' });
    drive.updateFile
      .mockRejectedValueOnce(httpError(503))
      .mockResolvedValueOnce({ id: 'f1', name: 'new.txt' });
    await service.rename({ fileId: 'f1', newName: 'new.txt' });
    expect(drive.getFile).toHaveBeenCalledTimes(1);
    expect(audit.entries[0]).toMatchObject({ details: { oldName: 'old.txt', newName: 'new.txt' } });
  });
});

describe('copy', () => {
  it('copies with optional name and parent', async () => {
    drive.getFile.mockResolvedValueOnce({ id: 'f1', mimeType: 'text/plain' });
    drive.copyFile.mockResolvedValueOnce({ id: 'c1', name: 'copy' });
    await service.copy({ fileId: 'f1', parentId: 'p9', name: 'copy' });
    expect(drive.copyFile).toHaveBeenCalledWith({
      fileId: 'f1',
      requestBody: { name: 'copy', parents: ['p9'] },
      fields: SUMMARY_FIELDS,
    });
    expect(audit.entries[0]).toMatchObject({
      op: 'copy',
      fileId: 'c1',
      details: { sourceId: 'f1', parentId: 'p9' },
    });
  });

  it('omits the not-yet-computed size of a freshly copied Google file', async () => {
    drive.getFile.mockResolvedValueOnce({ id: 'g1', mimeType: GOOGLE_MIME.spreadsheet });
    drive.copyFile.mockResolvedValueOnce({ id: 'c2', mimeType: GOOGLE_MIME.spreadsheet, size: '1' });
    const res = await service.copy({ fileId: 'g1' });
    expect(res).not.toHaveProperty('size');
  });

  it('rejects folders', async () => {
    drive.getFile.mockResolvedValueOnce({ id: 'd1', mimeType: GOOGLE_MIME.folder });
    await expect(service.copy({ fileId: 'd1' })).rejects.toThrow(ValidationError);
    expect(drive.copyFile).not.toHaveBeenCalled();
  });

  it('retries a failed pre-read but not a failed copy', async () => {
    drive.getFile
      .mockRejectedValueOnce(httpError(503))
      .mockResolvedValueOnce({ id: 'f1', mimeType: 'text/plain' });
    drive.copyFile.mockRejectedValueOnce(httpError(500));
    await expect(service.copy({ fileId: 'f1' })).rejects.toThrow(/duplicate/);
    expect(drive.getFile).toHaveBeenCalledTimes(2);
    expect(drive.copyFile).toHaveBeenCalledTimes(1);
  });
});

describe('delete', () => {
  it('moves to trash by default', async () => {
    drive.updateFile.mockResolvedValueOnce({ id: 'f1', name: 'F' });
    await expect(service.delete({ fileId: 'f1' })).resolves.toEqual({
      fileId: 'f1',
      name: 'F',
      permanent: false,
    });
    expect(drive.updateFile).toHaveBeenCalledWith({
      fileId: 'f1',
      requestBody: { trashed: true },
      fields: 'id, name',
    });
    expect(drive.deleteFile).not.toHaveBeenCalled();
    expect(audit.entries[0]).toMatchObject({ op: 'delete', details: { permanent: false } });
  });

  it('permanent delete fetches the name first for the audit entry', async () => {
    drive.getFile.mockResolvedValueOnce({ id: 'f1', name: 'F' });
    drive.deleteFile.mockResolvedValueOnce(undefined);
    await expect(service.delete({ fileId: 'f1', permanent: true })).resolves.toEqual({
      fileId: 'f1',
      name: 'F',
      permanent: true,
    });
    expect(audit.entries[0]).toMatchObject({
      op: 'delete',
      name: 'F',
      details: { permanent: true },
    });
  });

  it('treats a 404 on retry of a permanent delete as success', async () => {
    drive.getFile.mockResolvedValueOnce({ id: 'f1', name: 'F' });
    drive.deleteFile.mockRejectedValueOnce(httpError(500)).mockRejectedValueOnce(httpError(404));
    await expect(service.delete({ fileId: 'f1', permanent: true })).resolves.toMatchObject({
      permanent: true,
    });
    expect(drive.getFile).toHaveBeenCalledTimes(1);
  });

  it('reports a 404 on the first delete send as not found', async () => {
    drive.getFile.mockResolvedValueOnce({ id: 'f1', name: 'F' });
    drive.deleteFile.mockRejectedValueOnce(httpError(404));
    await expect(service.delete({ fileId: 'f1', permanent: true })).rejects.toThrow(
      /File not found/,
    );
    expect(audit.entries).toEqual([]);
  });

  it('reports a 404 on the first attempt as not found', async () => {
    drive.getFile.mockRejectedValueOnce(httpError(404));
    await expect(service.delete({ fileId: 'nope', permanent: true })).rejects.toThrow(
      /File not found/,
    );
  });
});

describe('restore', () => {
  it('untrashes and audits', async () => {
    drive.updateFile.mockResolvedValueOnce({ id: 'f1', name: 'F' });
    await service.restore({ fileId: 'f1' });
    expect(drive.updateFile).toHaveBeenCalledWith({
      fileId: 'f1',
      requestBody: { trashed: false },
      fields: SUMMARY_FIELDS,
    });
    expect(audit.entries[0]).toMatchObject({ op: 'restore', details: {} });
  });
});

describe('audit failures', () => {
  it('still succeeds and logs a warning', async () => {
    const failing = new FileService({
      runner: createRunner(drive),
      audit: {
        record: async () => {
          throw new Error('disk full');
        },
      },
      downloadsDir: '/tmp/unused',
      retry: noSleep,
      logger: log,
    });
    drive.updateFile.mockResolvedValueOnce({ id: 'f1', name: 'F' });
    await expect(failing.restore({ fileId: 'f1' })).resolves.toMatchObject({ id: 'f1' });
    expect(log.warn).toHaveBeenCalledWith('Audit log write failed', expect.anything());
  });
});

describe('error mapping on mutations', () => {
  it('wraps unknown failures', async () => {
    drive.updateFile.mockRejectedValueOnce(httpError(400, 'badRequest'));
    await expect(service.restore({ fileId: 'f1' })).rejects.toThrow(DriveApiError);
  });
});
