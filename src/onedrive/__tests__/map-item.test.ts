import { describe, expect, it } from 'vitest';
import { FOLDER_MIME, PACKAGE_MIME, toExistingFile, toMetadata, toSummary } from '../map-item.js';

const FILE = {
  id: 'i1',
  name: 'a.txt',
  size: 12,
  file: { mimeType: 'text/plain' },
  lastModifiedDateTime: '2026-01-02T00:00:00Z',
  parentReference: { id: 'p1' },
};

describe('toSummary', () => {
  it('maps a file', () => {
    expect(toSummary(FILE)).toEqual({
      id: 'i1',
      name: 'a.txt',
      mimeType: 'text/plain',
      size: 12,
      modifiedTime: '2026-01-02T00:00:00Z',
      parents: ['p1'],
    });
  });

  it('reports folders and packages with their fixed types and no folder size', () => {
    expect(toSummary({ id: 'f', name: 'd', size: 99, folder: {} })).toEqual({
      id: 'f',
      name: 'd',
      mimeType: FOLDER_MIME,
    });
    expect(toSummary({ id: 'p', name: 'n', package: {} }).mimeType).toBe(PACKAGE_MIME);
  });

  it('falls back to octet-stream', () => {
    expect(toSummary({ id: 'x', name: 'y', file: {} }).mimeType).toBe('application/octet-stream');
  });
});

describe('toMetadata', () => {
  it('adds the OneDrive metadata fields', () => {
    expect(
      toMetadata({
        ...FILE,
        createdDateTime: '2026-01-01T00:00:00Z',
        webUrl: 'https://x',
        createdBy: { user: { displayName: 'Me', email: 'me@x.y' } },
      }),
    ).toMatchObject({
      createdTime: '2026-01-01T00:00:00Z',
      webViewLink: 'https://x',
      trashed: false,
      owners: [{ displayName: 'Me', emailAddress: 'me@x.y' }],
    });
  });

  it('marks deleted items', () => {
    expect(toMetadata({ ...FILE, deleted: {} }).trashed).toBe(true);
  });
});

describe('toExistingFile', () => {
  it('describes the file for the dialog', () => {
    expect(
      toExistingFile({
        ...FILE,
        lastModifiedBy: { user: { displayName: 'Ayse', email: 'a@x.y' } },
      }),
    ).toEqual({
      id: 'i1',
      name: 'a.txt',
      size: 12,
      modifiedTime: '2026-01-02T00:00:00Z',
      modifiedBy: 'Ayse',
    });
    expect(toExistingFile({ id: 'i', name: 'n' })).toEqual({ id: 'i', name: 'n' });
  });
});
