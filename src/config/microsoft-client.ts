import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { ConfigError, hasErrorCode } from '../errors.js';

const schema = z.object({ clientId: z.uuid() });

const REGISTRATION_STEPS = [
  'Microsoft Entra admin center -> App registrations -> New registration:',
  '  1. Supported accounts: any organizational directory and personal Microsoft accounts.',
  '  2. Redirect: platform "Mobile and desktop applications", http://localhost',
  '  3. API permissions (Microsoft Graph, delegated): Files.ReadWrite, offline_access, User.Read, openid, profile, email.',
  '  4. Save the Application (client) ID in that file.',
].join('\n');

/** Reads `<configDir>/microsoft-client.json`. The client ID is not a secret. */
export async function loadMicrosoftClientId(file: string): Promise<string> {
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch (err) {
    if (!hasErrorCode(err, 'ENOENT')) throw new ConfigError(`Cannot read ${file}`, { cause: err });
    throw new ConfigError(
      `Microsoft client file not found at ${file}. It holds {"clientId": "<guid>"}.\n${REGISTRATION_STEPS}`,
      { cause: err },
    );
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    throw new ConfigError(`${file} is not valid JSON; expected {"clientId": "<guid>"}.`, {
      cause: err,
    });
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) throw new ConfigError(`${file} must contain {"clientId": "<guid>"}.`);
  return parsed.data.clientId;
}
