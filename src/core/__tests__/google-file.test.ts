import { beforeEach, describe, expect, it } from 'vitest';
import { NotFoundError, ValidationError } from '../../errors.js';
import { GOOGLE_MIME } from '../../files/export-formats.js';
import { createFakeDrive, type FakeDrive } from '../../files/__tests__/fakes.js';
import { resolveGoogleFile } from '../google-file.js';

let drive: FakeDrive;
beforeEach(() => {
  drive = createFakeDrive();
});

describe('resolveGoogleFile', () => {
  it('returns id and name for the expected type', async () => {
    drive.getFile.mockResolvedValueOnce({ id: 'd1', name: 'Plan', mimeType: GOOGLE_MIME.document });
    await expect(resolveGoogleFile(drive, 'd1', 'docs')).resolves.toEqual({
      id: 'd1',
      name: 'Plan',
    });
    expect(drive.getFile).toHaveBeenCalledWith('d1', 'id, name, mimeType, shortcutDetails');
  });

  it('follows shortcuts to their target', async () => {
    drive.getFile
      .mockResolvedValueOnce({
        id: 's1',
        mimeType: GOOGLE_MIME.shortcut,
        shortcutDetails: { targetId: 't1' },
      })
      .mockResolvedValueOnce({ id: 't1', name: 'Budget', mimeType: GOOGLE_MIME.spreadsheet });
    await expect(resolveGoogleFile(drive, 's1', 'sheets')).resolves.toEqual({
      id: 't1',
      name: 'Budget',
    });
  });

  it('rejects a shortcut without a target', async () => {
    drive.getFile.mockResolvedValueOnce({ id: 's1', mimeType: GOOGLE_MIME.shortcut });
    await expect(resolveGoogleFile(drive, 's1', 'docs')).rejects.toBeInstanceOf(NotFoundError);
  });

  it('names the right tool family for another Google type', async () => {
    drive.getFile.mockResolvedValueOnce({
      id: 'x',
      name: 'Budget',
      mimeType: GOOGLE_MIME.spreadsheet,
    });
    const err = await resolveGoogleFile(drive, 'x', 'docs').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ValidationError);
    expect((err as Error).message).toBe(
      '"Budget" is a Google Sheets file; use the sheets_* tools.',
    );
  });

  it('explains non-Google files', async () => {
    drive.getFile.mockResolvedValueOnce({ id: 'x', name: 'a.pdf', mimeType: 'application/pdf' });
    await expect(resolveGoogleFile(drive, 'x', 'slides')).rejects.toThrow(
      '"a.pdf" is not a Google Slides file (type: application/pdf).',
    );
  });
});
