import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { ConfirmReplace, ExistingFile } from '../files/file-provider.js';
import type { Logger } from '../logger.js';

/** The user decides at their own pace; the SDK's default of 60 s is too short. */
export const CONFIRM_TIMEOUT_MS = 10 * 60_000;

function describeFile(file: ExistingFile): string {
  const size = file.size === undefined ? 'unknown size' : `${file.size} bytes`;
  const when = file.modifiedTime ? `, last modified ${file.modifiedTime}` : '';
  const who = file.modifiedBy ? ` by ${file.modifiedBy}` : '';
  return `"${file.name}" already exists on OneDrive (${size}${when}${who}). Overwrite it?`;
}

/** True when the connected client declared form elicitation, which `elicitInput` requires. */
export function supportsConfirmReplace(server: Server): boolean {
  return server.getClientCapabilities()?.elicitation?.form !== undefined;
}

/** The Overwrite / Cancel dialog behind the `ConfirmReplace` callback (spec §6). */
export function createConfirmReplace(server: Server, log: Logger): ConfirmReplace {
  return async (file) => {
    try {
      const result = await server.elicitInput(
        {
          mode: 'form',
          message: describeFile(file),
          requestedSchema: {
            type: 'object',
            properties: {
              choice: { type: 'string', title: 'Action', enum: ['Overwrite', 'Cancel'] },
            },
            required: ['choice'],
          },
        },
        { timeout: CONFIRM_TIMEOUT_MS },
      );
      if (result.action !== 'accept') return 'cancel';
      return result.content?.choice === 'Overwrite' ? 'overwrite' : 'cancel';
    } catch (err) {
      log.warn('Overwrite question got no answer', { error: err });
      return 'no_answer';
    }
  };
}
