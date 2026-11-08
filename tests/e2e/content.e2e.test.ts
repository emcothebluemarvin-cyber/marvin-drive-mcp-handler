import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { ConflictError } from '../../src/errors.js';

const account = process.env.MARVIN_E2E_ACCOUNT;

describe.runIf(account)('Content E2E (live)', () => {
  it('reads and edits Docs, Sheets and Slides in place', async () => {
    const { googleFiles: files, docs, sheets, slides } = buildApp();
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'marvin-content-e2e-'));
    const root = await files.createFolder({ account, name: `marvin-content-e2e-${Date.now()}` });
    try {
      // Docs
      const md = path.join(tmp, 'plan.md');
      await writeFile(
        md,
        '# Plan\n\n## Goals\n\nShip it.\n\n## Data\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n## Last\n',
      );
      const doc = await files.upload({
        account,
        localPath: md,
        parentId: root.id,
        convertToGoogle: true,
      });
      const read1 = await docs.read({ account, fileId: doc.id });
      expect(read1.content).toContain('Ship it.');
      const rep = await docs.replaceText({
        account,
        fileId: doc.id,
        find: 'Ship it.',
        replace: 'Ship it today.',
        requiredRevisionId: read1.revisionId,
      });
      expect(rep.occurrencesChanged).toBe(1);
      await expect(
        docs.replaceText({
          account,
          fileId: doc.id,
          find: 'Plan',
          replace: 'Plan',
          requiredRevisionId: read1.revisionId,
        }),
      ).rejects.toBeInstanceOf(ConflictError);
      await docs.insertText({
        account,
        fileId: doc.id,
        text: 'First goal\n',
        position: { at: 'afterHeading', heading: 'Goals' },
      });
      // heading directly above a table, and heading as the last paragraph
      await docs.insertText({
        account,
        fileId: doc.id,
        text: 'Table intro',
        position: { at: 'afterHeading', heading: 'Data' },
      });
      await docs.insertText({
        account,
        fileId: doc.id,
        text: 'Closing\n',
        position: { at: 'afterHeading', heading: 'Last' },
      });
      const outline = await docs.read({ account, fileId: doc.id, format: 'structure' });
      expect(outline.content).toMatch(/NORMAL_TEXT "First goal"/);
      expect(outline.content).toMatch(/NORMAL_TEXT "Table intro"\n\[\d+-\d+\] TABLE/);
      expect(outline.content).toMatch(/HEADING_2 "Last"\n\[\d+-\d+\] NORMAL_TEXT "Closing"/);
      await docs.batchUpdate({
        account,
        fileId: doc.id,
        requests: [{ insertText: { endOfSegmentLocation: {}, text: '\nThe end' } }],
        requiredRevisionId: outline.revisionId,
      });
      expect((await docs.read({ account, fileId: doc.id })).content).toContain('The end');

      // Sheets
      const csv = path.join(tmp, 'data.csv');
      await writeFile(csv, 'name,qty\napple,3\n');
      const sheet = await files.upload({
        account,
        localPath: csv,
        parentId: root.id,
        convertToGoogle: true,
      });
      const info = await sheets.info({ account, fileId: sheet.id });
      const tab = info.sheets[0]?.title ?? 'Sheet1';
      await sheets.writeRange({
        account,
        fileId: sheet.id,
        range: `${tab}!C1:C2`,
        values: [['total'], ['=B2*2']],
      });
      await sheets.appendRows({ account, fileId: sheet.id, range: tab, values: [['pear', 5]] });
      const vals = await sheets.readRange({ account, fileId: sheet.id, range: `${tab}!A1:C3` });
      expect(vals.values).toEqual([
        ['name', 'qty', 'total'],
        ['apple', '3', '6'],
        ['pear', '5'],
      ]);
      await sheets.writeRange({ account, fileId: sheet.id, range: `${tab}!C1`, values: [[null]] });
      const cleared = await sheets.readRange({ account, fileId: sheet.id, range: `${tab}!C1` });
      expect(cleared.values).toEqual([]);

      // Slides
      const deck = await files.upload({
        account,
        localPath: path.resolve('tests/e2e/fixtures/deck.pptx'),
        parentId: root.id,
        convertToGoogle: true,
      });
      const s1 = await slides.read({ account, fileId: deck.id });
      expect(s1.slideCount).toBe(2);
      const helloId = /shape (\S+) \(TEXT_BOX\): "Hello slides"/.exec(s1.content)?.[1];
      expect(helloId).toBeTruthy();
      const set = await slides.setText({
        account,
        fileId: deck.id,
        objectId: helloId ?? '',
        text: 'Hi there',
      });
      const r = await slides.replaceText({
        account,
        fileId: deck.id,
        find: 'Second',
        replace: '2nd',
        requiredRevisionId: set.revisionId ?? undefined,
      });
      expect(r.occurrencesChanged).toBe(1);
      const s2 = await slides.read({ account, fileId: deck.id });
      expect(s2.content).toContain('"Hi there"');
      expect(s2.content).toContain('2nd slide');
      const emptyId = /shape (\S+) \(TEXT_BOX\): \(empty\)/.exec(s2.content)?.[1];
      expect(emptyId).toBeTruthy();
      await slides.setText({ account, fileId: deck.id, objectId: emptyId ?? '', text: 'filled' });
      const s3 = await slides.read({ account, fileId: deck.id });
      expect(s3.content).toContain('"filled"');
      await slides.batchUpdate({
        account,
        fileId: deck.id,
        requests: [{ deleteObject: { objectId: emptyId } }],
        requiredRevisionId: s3.revisionId,
      });
      expect((await slides.read({ account, fileId: deck.id })).content).not.toContain('"filled"');
      // Stale revision (s1 predates several edits) must surface as a ConflictError.
      await expect(
        slides.replaceText({
          account,
          fileId: deck.id,
          find: 'Hi there',
          replace: 'stale',
          requiredRevisionId: s1.revisionId,
        }),
      ).rejects.toBeInstanceOf(ConflictError);
    } finally {
      await files.delete({ account, fileId: root.id, permanent: true });
      await rm(tmp, { recursive: true, force: true });
    }
  });
});
