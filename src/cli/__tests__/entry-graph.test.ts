import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const CLI = fileURLToPath(new URL('..', import.meta.url));

/** Static runtime import specifiers (type-only imports and dynamic import() excluded). */
function staticImports(source: string): string[] {
  const re = /^\s*(?:import|export)\s+(?!type\b)(?:[^'";]*?\sfrom\s+)?['"]([^'"]+)['"]/gm;
  return [...source.matchAll(re)].map((m) => m[1] ?? '');
}

function packageOf(spec: string): string {
  const parts = spec.split('/');
  return spec.startsWith('@') ? parts.slice(0, 2).join('/') : (parts[0] ?? spec);
}

async function graph(entry: string): Promise<{ files: Set<string>; packages: Set<string> }> {
  const files = new Set<string>();
  const packages = new Set<string>();
  const visit = async (file: string): Promise<void> => {
    if (files.has(file)) return;
    files.add(file);
    for (const spec of staticImports(await readFile(file, 'utf8'))) {
      if (spec.startsWith('.'))
        await visit(path.resolve(path.dirname(file), spec.replace(/\.js$/, '.ts')));
      else if (!spec.startsWith('node:')) packages.add(packageOf(spec));
    }
  };
  await visit(entry);
  return { files, packages };
}

describe('CLI entry (spec §8.3: hook path without network modules)', () => {
  it('detects static imports only', () => {
    expect(
      staticImports(
        "import { a } from './a.js';\nimport type { B } from 'b';\nconst c = await import('./c.js');",
      ),
    ).toEqual(['./a.js']);
  });

  it('main.ts loads nothing statically', async () => {
    expect((await graph(path.join(CLI, 'main.ts'))).files.size).toBe(1);
  });

  it('the hook module graph has no googleapis, MCP SDK, commander, open or app.ts', async () => {
    const { files, packages } = await graph(path.join(CLI, 'hook.ts'));
    for (const banned of [
      'googleapis',
      '@modelcontextprotocol/sdk',
      'commander',
      'open',
      '@napi-rs/keyring',
    ]) {
      expect(packages.has(banned)).toBe(false);
    }
    expect([...files].some((f) => f.endsWith(`${path.sep}app.ts`))).toBe(false);
    expect(files.size).toBeGreaterThan(3);
  });
});
