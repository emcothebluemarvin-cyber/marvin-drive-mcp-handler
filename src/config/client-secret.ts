import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { ConfigError } from '../errors.js';

const clientSecretSchema = z.object({
  installed: z.object({
    client_id: z.string().endsWith('.apps.googleusercontent.com'),
    client_secret: z.string().min(1),
  }),
});

export interface ClientCredentials {
  clientId: string;
  clientSecret: string;
}

export async function loadClientSecret(file: string): Promise<ClientCredentials> {
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch (err) {
    throw new ConfigError(
      `OAuth client file not found at ${file}. Save the Google Cloud "Desktop app" client JSON there (chmod 600).`,
      { cause: err },
    );
  }

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    throw new ConfigError(
      `${file} is not valid JSON (expected Google "installed" client format).`,
      {
        cause: err,
      },
    );
  }

  const parsed = clientSecretSchema.safeParse(json);
  if (!parsed.success) {
    throw new ConfigError(
      `${file} must contain {"installed": {"client_id": "...", "client_secret": "..."}} (Google Desktop client format).`,
    );
  }
  return {
    clientId: parsed.data.installed.client_id,
    clientSecret: parsed.data.installed.client_secret,
  };
}
