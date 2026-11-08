import {
  isMicrosoft,
  type AccountProvider,
  type AccountRecord,
} from '../config/account-registry.js';
import { ValidationError } from '../errors.js';

/** Undefined stays undefined: step two of a login takes the provider from its waiting entry. */
export function parseProviderOption(value: string | undefined): AccountProvider | undefined {
  if (value === undefined) return undefined;
  if (value === 'google' || value === 'microsoft') return value;
  throw new ValidationError(`--provider must be google or microsoft (got "${value}")`);
}

/** What to do after --print-url printed the sign-in URL. */
export function twoStepInstructions(command: string, provider: AccountProvider): string {
  const [name, host] =
    provider === 'microsoft' ? ['Microsoft', 'localhost'] : ['Google', '127.0.0.1'];
  return (
    `\nOpen the URL above in a browser on any device and sign in. ${name} then redirects to ` +
    `http://${host}:<port>/?…, which fails to load — that is expected. Copy the full URL ` +
    'from the address bar and, within 10 minutes, run:\n' +
    `  marvin-drive ${command} --redirect-url '<that URL>'\n`
  );
}

/** A flag only when it says something the default does not. */
export function providerFlag(provider: AccountProvider): string {
  return provider === 'microsoft' ? ' --provider microsoft' : '';
}

export function removedMessage(record: AccountRecord): string {
  const removed = `Removed ${record.alias} (${record.email})`;
  if (!isMicrosoft(record)) return removed;
  return (
    `${removed}. The token was deleted on this machine; Microsoft has no per-token revoke for ` +
    'this kind of app. To end its access fully, remove the app under your Microsoft account ' +
    'privacy settings (https://account.live.com/consent/Manage) or ask your administrator.'
  );
}
