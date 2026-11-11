import { describe, expect, it } from 'vitest';
import { fromRemote } from '../exec-records.js';
import { toRemoteItem } from '../remote/google-remote.js';
import { DEFAULT_GOOGLE_EXPORT } from '../types.js';
import { binary } from './drive-tree.js';

describe('fromRemote', () => {
  it('takes the uploaded file fields, md5 and first parent', () => {
    const item = toRemoteItem(binary('n1', 'a.pdf', 'P'), DEFAULT_GOOGLE_EXPORT);
    expect(fromRemote(item, 'fallback')).toEqual({
      id: 'n1',
      name: 'a.pdf',
      parentId: 'P',
      md5: 'md5-n1',
      size: 10,
      modifiedTime: '2026-11-02T00:00:00.000Z',
      native: null,
    });
  });
  it('falls back to the upload parent when Drive returns no parents', () => {
    const item = toRemoteItem({ id: 'n1' }, DEFAULT_GOOGLE_EXPORT);
    expect(fromRemote(item, 'P')).toMatchObject({ parentId: 'P', md5: null, size: null });
  });
});
