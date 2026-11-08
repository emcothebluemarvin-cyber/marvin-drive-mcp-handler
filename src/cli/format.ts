import type { AccountStatusEntry } from '../auth/auth-service.js';

export function formatAccounts(entries: AccountStatusEntry[]): string {
  if (entries.length === 0) return 'No accounts. Run: marvin-drive auth add';
  return entries
    .map(
      (e) =>
        `${e.isDefault ? '*' : ' '} ${e.alias.padEnd(20)} ${e.email.padEnd(36)} ${e.provider.padEnd(10)} ${e.status}`,
    )
    .join('\n');
}
