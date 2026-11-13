import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { runtimeGoogleapisImports } from '../../__tests__/googleapis-imports.js';

const SYNC_DIR = fileURLToPath(new URL('..', import.meta.url));
const SELF = path.basename(fileURLToPath(import.meta.url));

describe('provider boundary (addendum §4.4)', () => {
  it('detects runtime imports and allows type-only ones', () => {
    expect(runtimeGoogleapisImports("import { google } from 'googleapis';")).toHaveLength(1);
    expect(runtimeGoogleapisImports("import type { drive_v3 } from 'googleapis';")).toEqual([]);
    expect(runtimeGoogleapisImports("import type {\n  drive_v3,\n} from 'googleapis';")).toEqual(
      [],
    );
    expect(runtimeGoogleapisImports("const g = await import('googleapis');")).toHaveLength(1);
    expect(
      runtimeGoogleapisImports("import type { DriveFile } from '../drive/drive-adapter.js';"),
    ).toEqual([]);
  });
  it('no file under src/sync imports googleapis at runtime', async () => {
    const files = (await readdir(SYNC_DIR, { recursive: true })).filter(
      (f) => f.endsWith('.ts') && path.basename(f) !== SELF,
    );
    expect(files.length).toBeGreaterThan(20);
    const offenders: string[] = [];
    for (const f of files) {
      const hits = runtimeGoogleapisImports(await readFile(path.join(SYNC_DIR, f), 'utf8'));
      if (hits.length > 0) offenders.push(`${f}: ${hits.join(' | ')}`);
    }
    expect(offenders).toEqual([]);
  });
});

/** Drive shapes the engine must leave to src/sync/remote/ (OneDrive sync spec §2). */
const DRIVE_ONLY = [
  /drive\/drive-adapter\.js/,
  /files\/query\.js/,
  /files\/export-stream\.js/,
  /\bGOOGLE_MIME\b/,
  /\bisGoogleNative\b/,
  /\bresolveExport\b/,
  /\bctx\.drive\b/,
  /\bmd5Checksum\b/,
  /\bin parents\b/,
];

describe('SyncRemote boundary (OneDrive sync spec §2.3)', () => {
  it('no sync engine file outside src/sync/remote/ touches Drive shapes or queries', async () => {
    const files = (await readdir(SYNC_DIR, { recursive: true })).filter(
      (f) =>
        f.endsWith('.ts') &&
        !f.split(path.sep).includes('__tests__') &&
        !f.startsWith(`remote${path.sep}`),
    );
    expect(files.length).toBeGreaterThan(20);
    const offenders: string[] = [];
    for (const f of files) {
      const text = await readFile(path.join(SYNC_DIR, f), 'utf8');
      for (const pattern of DRIVE_ONLY) if (pattern.test(text)) offenders.push(`${f}: ${pattern}`);
    }
    expect(offenders).toEqual([]);
  });
});
