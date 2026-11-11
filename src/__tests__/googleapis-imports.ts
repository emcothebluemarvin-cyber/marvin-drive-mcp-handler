/** Statements that load googleapis at runtime; `import type` / `export type` are allowed. */
export function runtimeGoogleapisImports(source: string): string[] {
  const hits: string[] = [];
  const fromRe =
    /(?:^|\n)\s*(import|export)\s+(type\s+)?[^;]*?from\s*['"]googleapis(?:\/[^'"]*)?['"]/g;
  for (const m of source.matchAll(fromRe)) if (m[2] === undefined) hits.push(m[0].trim());
  const bareRe =
    /(?:^|\n)\s*import\s*['"]googleapis[^'"]*['"]|import\s*\(\s*['"]googleapis|require\s*\(\s*['"]googleapis/g;
  for (const m of source.matchAll(bareRe)) hits.push(m[0].trim());
  return hits;
}
