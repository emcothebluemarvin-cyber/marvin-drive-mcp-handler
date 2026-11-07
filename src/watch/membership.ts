import type { WatchEntry } from './types.js';

/** Ancestor walk depth limit (spec §5.3). */
export const MAX_DEPTH = 20;
const CACHE_LIMIT = 10_000;

/** Is a file inside a watched folder? In-memory `id → parents` cache per account. */
export class Membership {
  private readonly parents = new Map<string, string[]>();

  constructor(private readonly parentsOf: (id: string) => Promise<string[] | null>) {}

  /** A folder appeared in the feed: replace its cached parents (null: forget it). */
  noteFolder(id: string, parents: readonly string[] | null): void {
    if (parents === null) this.parents.delete(id);
    else this.remember(id, [...parents]);
  }

  async covering(
    fileId: string,
    parents: readonly string[],
    entries: readonly WatchEntry[],
  ): Promise<WatchEntry[]> {
    const byId = new Map(entries.map((e) => [e.id, e]));
    const found = new Map<string, WatchEntry>();
    const self = byId.get(fileId);
    if (self) found.set(self.id, self);
    if (!entries.some((e) => e.folder)) return [...found.values()];

    const seen = new Set<string>([fileId]);
    let frontier = [...parents];
    for (let depth = 0; depth < MAX_DEPTH && frontier.length > 0; depth++) {
      const next: string[] = [];
      for (const id of frontier) {
        if (seen.has(id)) continue;
        seen.add(id);
        const entry = byId.get(id);
        if (entry?.folder) found.set(id, entry);
        next.push(...(await this.lookup(id)));
      }
      frontier = next;
    }
    return [...found.values()];
  }

  /** An inaccessible id is cached as "no parents" until noteFolder or a restart. */
  private async lookup(id: string): Promise<string[]> {
    const hit = this.parents.get(id);
    if (hit) return hit;
    const fetched = (await this.parentsOf(id)) ?? [];
    this.remember(id, fetched);
    return fetched;
  }

  private remember(id: string, parents: string[]): void {
    if (this.parents.size >= CACHE_LIMIT && !this.parents.has(id)) this.parents.clear();
    this.parents.set(id, parents);
  }
}
