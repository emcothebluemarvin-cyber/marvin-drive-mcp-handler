import { describe, expect, it } from 'vitest';
import { NotFoundError, ReauthRequiredError } from '../../errors.js';
import { GOOGLE_MIME } from '../../files/export-formats.js';
import { childrenQuery, exportKey, scanRemote } from '../remote-scanner.js';
import { DEFAULT_GOOGLE_EXPORT } from '../types.js';
import { binary, folder, treeLister } from './drive-tree.js';

const ROOT = 'root';
const NFD = 'şartname.pdf'.normalize('NFD');

describe('childrenQuery', () => {
  it('escapes the folder id', () => {
    expect(childrenQuery("a'b")).toBe("'a\\'b' in parents and trashed = false");
  });
});

describe('exportKey', () => {
  it('adds the extension unless present, NFC, under the parent key', () => {
    expect(exportKey('', 'Plan', 'docx')).toBe('Plan.docx');
    expect(exportKey('a/b', 'Report.DOCX', 'docx')).toBe('a/b/Report.DOCX');
    expect(exportKey('', 'şartname'.normalize('NFD'), 'docx')).toBe('şartname.docx');
  });
});

describe('scanRemote', () => {
  it('walks nested folders with NFC keys, ancestors and capabilities', async () => {
    const list = treeLister([
      folder('f1', 'docs', ROOT),
      folder('f2', 'inner', 'f1'),
      binary('a', 'a.pdf', ROOT),
      binary('b', NFD, 'f2', { capabilities: { canEdit: false, canTrash: false } }),
    ]);
    const scan = await scanRemote(ROOT, list);
    expect(scan.entries.map((e) => [e.id, e.key, e.parentId, e.ancestorIds])).toEqual([
      ['a', 'a.pdf', ROOT, [ROOT]],
      ['b', 'docs/inner/şartname.pdf', 'f2', ['f2', 'f1', ROOT]],
    ]);
    expect(scan.entries[1]).toMatchObject({
      canEdit: false,
      canTrash: false,
      md5: 'md5-b',
      size: 10,
    });
    expect([...scan.folders.entries()]).toEqual([
      [ROOT, ''],
      ['f1', 'docs'],
      ['f2', 'docs/inner'],
    ]);
  });

  it('follows pagination', async () => {
    const files = Array.from({ length: 5 }, (_, i) => binary(`id${i}`, `f${i}.pdf`, ROOT));
    const scan = await scanRemote(ROOT, treeLister(files, { pageSize: 2 }));
    expect(scan.entries).toHaveLength(5);
  });

  it('marks duplicate folder names as unknown subtrees without descending', async () => {
    const list = treeLister([
      folder('d1', 'dup', ROOT),
      folder('d2', 'Dup', ROOT),
      binary('x', 'x.pdf', 'd1'),
    ]);
    const scan = await scanRemote(ROOT, list);
    expect(scan.unknownSubtrees).toEqual(['Dup', 'dup']);
    expect(scan.unknownFolderIds.sort()).toEqual(['d1', 'd2']);
    expect(scan.entries).toEqual([]);
    expect(list.calls).toEqual([ROOT]);
  });

  it('ignores shortcuts, unrepresentable and dot names', async () => {
    const scan = await scanRemote(
      ROOT,
      treeLister([
        { id: 's', name: 'link', mimeType: GOOGLE_MIME.shortcut, parents: [ROOT] },
        { id: 'g', name: 'Plan', mimeType: GOOGLE_MIME.document, parents: [ROOT] },
        binary('u', 'a/b.pdf', ROOT),
        binary('h', '.hidden', ROOT),
        folder('hf', '.git', ROOT),
      ]),
    );
    expect(scan.entries.map((e) => e.key)).toEqual(['Plan.docx']);
    expect(scan.ignored.map((i) => [i.id, i.path, i.reason, i.isFolder])).toEqual([
      ['s', 'link', 'shortcut', false],
      ['u', 'a/b.pdf', 'unrepresentable', false],
      ['h', '.hidden', 'ignored-name', false],
      ['hf', '.git', 'ignored-name', true],
    ]);
  });

  it('keys Google-native files by their export name; unsupported types are ignored', async () => {
    const scan = await scanRemote(
      ROOT,
      treeLister([
        { id: 'g', name: 'Plan', mimeType: GOOGLE_MIME.document, parents: [ROOT] },
        { id: 's', name: 'Budget', mimeType: GOOGLE_MIME.spreadsheet, parents: [ROOT] },
        { id: 'f', name: 'Survey', mimeType: 'application/vnd.google-apps.form', parents: [ROOT] },
        { id: 'l', name: 'x'.repeat(252), mimeType: GOOGLE_MIME.document, parents: [ROOT] },
      ]),
      { ...DEFAULT_GOOGLE_EXPORT, spreadsheet: 'csv' },
    );
    expect(
      scan.entries.map((e) => [e.id, e.key, e.name, e.md5, e.size, e.native?.exportFormat]),
    ).toEqual([
      ['s', 'Budget.csv', 'Budget', null, null, 'csv'],
      ['g', 'Plan.docx', 'Plan', null, null, 'docx'],
    ]);
    expect(scan.ignored.map((i) => [i.id, i.reason])).toEqual([
      ['f', 'native-unsupported'],
      ['l', 'unrepresentable'],
    ]);
  });

  it('a Drive native and a binary sharing the export key are both scanned under that key', async () => {
    const scan = await scanRemote(
      ROOT,
      treeLister([
        { id: 'g', name: 'Plan', mimeType: GOOGLE_MIME.document, parents: [ROOT] },
        binary('b', 'Plan.docx', ROOT),
      ]),
    );
    expect(scan.entries.map((e) => [e.id, e.key])).toEqual([
      ['b', 'Plan.docx'],
      ['g', 'Plan.docx'],
    ]);
    expect(new Set(scan.entries.map((e) => e.foldKey)).size).toBe(1);
  });

  it('turns a failed sub-folder listing into an unknown subtree', async () => {
    const scan = await scanRemote(
      ROOT,
      treeLister([folder('f1', 'bad', ROOT), binary('a', 'a.pdf', ROOT)], {
        failing: ['f1'],
        failWith: new NotFoundError('f1'),
      }),
    );
    expect(scan.unknownSubtrees).toEqual(['bad']);
    expect(scan.unknownFolderIds).toEqual(['f1']);
    expect(scan.folders.has('f1')).toBe(false);
    expect(scan.entries.map((e) => e.id)).toEqual(['a']);
  });

  it('rethrows root failures and run-aborting errors', async () => {
    await expect(
      scanRemote(ROOT, treeLister([], { failing: [ROOT], failWith: new NotFoundError(ROOT) })),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      scanRemote(
        ROOT,
        treeLister([folder('f1', 'sub', ROOT)], {
          failing: ['f1'],
          failWith: new ReauthRequiredError('emco'),
        }),
      ),
    ).rejects.toBeInstanceOf(ReauthRequiredError);
  });
});
