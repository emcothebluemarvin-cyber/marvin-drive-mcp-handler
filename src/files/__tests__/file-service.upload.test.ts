import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { beforeEach, describe, expect, it } from 'vitest';
import { ValidationError } from '../../errors.js';
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

let dir: string;
let drive: FakeDrive;
let audit: ReturnType<typeof createAudit>;
let service: FileService;

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'marvin-upload-'));
  drive = createFakeDrive();
  audit = createAudit();
  service = new FileService({
    runner: createRunner(drive),
    audit,
    downloadsDir: dir,
    retry: noSleep,
    logger: silentLogger(),
  });
});

describe('upload', () => {
  it('rejects relative local paths', async () => {
    await expect(service.upload({ localPath: 'relative/file.txt' })).rejects.toThrow(
      'localPath must be an absolute path (got "relative/file.txt")',
    );
  });

  it('expands ~/ before resolving', async () => {
    const err = await service
      .upload({ localPath: '~/marvin-nonexistent-file.txt' })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ValidationError);
    expect((err as Error).message).toBe(
      `Cannot read ${path.join(os.homedir(), 'marvin-nonexistent-file.txt')}`,
    );
  });

  it('streams the file with its detected MIME type and audits', async () => {
    const local = path.join(dir, 'notes.txt');
    await writeFile(local, 'hello');
    drive.createFile.mockResolvedValueOnce({ id: 'u1', name: 'notes.txt', mimeType: 'text/plain' });

    const res = await service.upload({ localPath: local, parentId: 'p1' });

    expect(res).toMatchObject({ id: 'u1', name: 'notes.txt' });
    const call = drive.createFile.mock.calls[0]?.[0];
    expect(call?.requestBody).toEqual({ name: 'notes.txt', parents: ['p1'] });
    expect(call?.fields).toBe(SUMMARY_FIELDS);
    expect(call?.media?.mimeType).toBe('text/plain');
    expect(call?.media?.body).toBeInstanceOf(Readable);
    expect(audit.entries[0]).toEqual({
      account: 'emco',
      op: 'upload',
      fileId: 'u1',
      name: 'notes.txt',
      details: { localPath: local, parentId: 'p1', size: 5, converted: false },
    });
  });

  it('converts to a Google type and honours a custom name', async () => {
    const local = path.join(dir, 'sheet.csv');
    await writeFile(local, 'a,b');
    drive.createFile.mockResolvedValueOnce({ id: 'u2', name: 'Budget' });
    await service.upload({ localPath: local, name: 'Budget', convertToGoogle: true });
    expect(drive.createFile.mock.calls[0]?.[0].requestBody).toEqual({
      name: 'Budget',
      parents: ['root'],
      mimeType: GOOGLE_MIME.spreadsheet,
    });
  });

  it('validates the local path and conversion before calling Drive', async () => {
    await expect(service.upload({ localPath: path.join(dir, 'missing.txt') })).rejects.toThrow(
      ValidationError,
    );
    await expect(service.upload({ localPath: dir })).rejects.toThrow(/not a regular file/);
    const zip = path.join(dir, 'a.zip');
    await writeFile(zip, 'x');
    await expect(service.upload({ localPath: zip, convertToGoogle: true })).rejects.toThrow(
      ValidationError,
    );
    expect(drive.createFile).not.toHaveBeenCalled();
  });

  it('retries rate limits with a fresh stream but never 5xx', async () => {
    const local = path.join(dir, 'a.txt');
    await writeFile(local, 'x');
    drive.createFile.mockRejectedValueOnce(httpError(429)).mockResolvedValueOnce({ id: 'u3' });
    await service.upload({ localPath: local });
    const [first, second] = drive.createFile.mock.calls.map((c) => c[0].media?.body);
    expect(first).not.toBe(second);

    drive.createFile.mockReset();
    drive.createFile.mockRejectedValueOnce(httpError(503));
    await expect(service.upload({ localPath: local })).rejects.toThrow(/duplicate/);
    expect(drive.createFile).toHaveBeenCalledTimes(1);
  });
});
