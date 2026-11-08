import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { runtimeGoogleapisImports } from '../../__tests__/googleapis-imports.js';

const SRC = fileURLToPath(new URL('../..', import.meta.url));

describe('OneDrive provider boundary (spec §3)', () => {
  it('no runtime googleapis under src/onedrive, in microsoft-auth or in loopback', async () => {
    const onedrive = (await readdir(path.join(SRC, 'onedrive'), { recursive: true }))
      .filter((f) => f.endsWith('.ts'))
      .map((f) => path.join('onedrive', f));
    const files = [...onedrive, 'auth/microsoft-auth.ts', 'auth/loopback.ts'];
    expect(files.length).toBeGreaterThan(2);
    const offenders: string[] = [];
    for (const f of files) {
      const hits = runtimeGoogleapisImports(await readFile(path.join(SRC, f), 'utf8'));
      if (hits.length > 0) offenders.push(`${f}: ${hits.join(' | ')}`);
    }
    expect(offenders).toEqual([]);
  });
});
