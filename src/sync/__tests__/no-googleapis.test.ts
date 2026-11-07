import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SYNC_DIR = fileURLToPath(new URL('..', import.meta.url));
const SELF = path.basename(fileURLToPath(import.meta.url));

/** Statements that load googleapis at runtime; `import type` / `export type` are allowed. */
function runtimeGoogleapisImports(source: string): string[] {
  const hits: string[] = [];
  const fromRe =
    /(?:^|\n)\s*(import|export)\s+(type\s+)?[^;]*?from\s*['"]googleapis(?:\/[^'"]*)?['"]/g;
  for (const m of source.matchAll(fromRe)) if (m[2] === undefined) hits.push(m[0].trim());
  const bareRe =
    /(?:^|\n)\s*import\s*['"]googleapis[^'"]*['"]|import\s*\(\s*['"]googleapis|require\s*\(\s*['"]googleapis/g;
  for (const m of source.matchAll(bareRe)) hits.push(m[0].trim());
  return hits;
}
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
