import { beforeEach, describe, expect, it } from 'vitest';
import { NotFoundError, ValidationError } from '../../errors.js';
import { FILE_FIELDS, FileService, LIST_FIELDS } from '../file-service.js';
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
let runner: ReturnType<typeof createRunner>;
let service: FileService;

beforeEach(() => {
  drive = createFakeDrive();
  runner = createRunner(drive);
  service = new FileService({
    runner,
    audit: createAudit(),
    downloadsDir: '/tmp/unused',
    retry: noSleep,
    logger: silentLogger(),
  });
});

describe('FileService.list', () => {
  it('lists root children, excluding trash, with defaults', async () => {
    drive.listFiles.mockResolvedValueOnce({
      files: [
        {
          id: 'a',
          name: 'A',
          mimeType: 'text/plain',
          size: '12',
          modifiedTime: 't',
          parents: ['root'],
        },
      ],
      nextPageToken: 'next',
    });
    const res = await service.list({});
    expect(drive.listFiles).toHaveBeenCalledWith({
      q: "'root' in parents and trashed = false",
      pageSize: 50,
      fields: LIST_FIELDS,
    });
    expect(res).toEqual({
      files: [
        {
          id: 'a',
          name: 'A',
          mimeType: 'text/plain',
          size: 12,
          modifiedTime: 't',
          parents: ['root'],
        },
      ],
      nextPageToken: 'next',
    });
    expect(runner.refs).toEqual([undefined]);
  });

  it('passes account, folder, page token, trash flag and clamps pageSize', async () => {
    drive.listFiles.mockResolvedValueOnce({ files: [] });
    const res = await service.list({
      account: 'work',
      folderId: 'f1',
      pageSize: 999,
      pageToken: 'p2',
      includeTrashed: true,
    });
    expect(drive.listFiles).toHaveBeenCalledWith({
      q: "'f1' in parents",
      pageSize: 200,
      pageToken: 'p2',
      fields: LIST_FIELDS,
    });
    expect(res).toEqual({ files: [] });
    expect(runner.refs).toEqual(['work']);
  });

  it('retries transient failures', async () => {
    drive.listFiles.mockRejectedValueOnce(httpError(503)).mockResolvedValueOnce({ files: [] });
    await expect(service.list({})).resolves.toEqual({ files: [] });
    expect(drive.listFiles).toHaveBeenCalledTimes(2);
  });
});

describe('FileService.search', () => {
  it('builds the query and validates input before calling Drive', async () => {
    drive.listFiles.mockResolvedValueOnce({ files: [] });
    await service.search({ query: 'budget', pageSize: 10 });
    expect(drive.listFiles).toHaveBeenCalledWith({
      q: "(name contains 'budget' or fullText contains 'budget') and trashed = false",
      pageSize: 10,
      fields: LIST_FIELDS,
    });
    await expect(service.search({})).rejects.toThrow(ValidationError);
    expect(drive.listFiles).toHaveBeenCalledTimes(1);
  });
});

describe('FileService.getMetadata', () => {
  it('requests the standard field set', async () => {
    drive.getFile.mockResolvedValueOnce({ id: 'f1', name: 'x' });
    await expect(service.getMetadata({ fileId: 'f1' })).resolves.toEqual({ id: 'f1', name: 'x' });
    expect(drive.getFile).toHaveBeenCalledWith('f1', FILE_FIELDS);
  });

  it('maps 404 to NotFoundError', async () => {
    drive.getFile.mockRejectedValueOnce(httpError(404));
    await expect(service.getMetadata({ fileId: 'gone' })).rejects.toThrow(NotFoundError);
  });

  it('lets invalid_grant through untouched so the runner can recover', async () => {
    const grant = Object.assign(new Error('invalid_grant'), {
      response: { data: { error: 'invalid_grant' } },
    });
    drive.getFile.mockRejectedValueOnce(grant);
    await expect(service.getMetadata({ fileId: 'f1' })).rejects.toBe(grant);
  });
});
