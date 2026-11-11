import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { runtimeGoogleapisImports } from '../../__tests__/googleapis-imports.js';

const WATCH_DIR = fileURLToPath(new URL('..', import.meta.url));

describe('watch provider boundary (spec §3)', () => {
  it('no file under src/watch outside google/ imports googleapis at runtime', async () => {
    const files = (await readdir(WATCH_DIR, { recursive: true })).filter(
      (f) => f.endsWith('.ts') && !f.split(path.sep).includes('google'),
    );
    expect(files).toContain('types.ts');
    const offenders: string[] = [];
    for (const f of files) {
      const hits = runtimeGoogleapisImports(await readFile(path.join(WATCH_DIR, f), 'utf8'));
      if (hits.length > 0) offenders.push(`${f}: ${hits.join(' | ')}`);
    }
    expect(offenders).toEqual([]);
  });
});
