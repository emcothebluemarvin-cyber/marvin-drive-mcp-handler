import type { ChangesResult } from '../watch/changes.js';
import { renderFull } from '../watch/render.js';
import type { WatchResult } from '../watch/watch-service.js';

export function formatWatchResult(r: WatchResult): string {
  switch (r.action) {
    case 'add':
      return r.alreadyWatched
        ? `Already watching "${r.entry.name}" for ${r.account}`
        : `Watching "${r.entry.name}" (${r.entry.folder ? 'folder, recursive' : r.entry.kind}) for ${r.account}`;
    case 'remove':
      return `Stopped watching "${r.removed.name}" for ${r.account}`;
    case 'list':
      if (r.watches.length === 0) return 'No watched files or folders.';
      return r.watches
        .map((w) =>
          [
            w.account,
            ...w.entries.map(
              (e) =>
                `  ${e.name} (${e.folder ? 'folder' : e.kind}) ${e.id}${e.inaccessible ? ' [inaccessible]' : ''}`,
            ),
          ].join('\n'),
        )
        .join('\n');
  }
}

export function formatChanges(r: ChangesResult): string {
  if (r.events.length === 0) return 'No new Drive changes.';
  const blocks = r.events.map(renderFull);
  if (r.more > 0) blocks.push(`… ${r.more} more; run again`);
  return blocks.join('\n\n');
}
