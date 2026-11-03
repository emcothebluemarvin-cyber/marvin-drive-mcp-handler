import open from 'open';
import { AuthService } from './auth/auth-service.js';
import { KeychainTokenStore } from './auth/keychain-token-store.js';
import { runLoginFlow, type LoginResult } from './auth/login-flow.js';
import { FileAuditLog } from './audit/audit-log.js';
import { AccountRegistry } from './config/account-registry.js';
import { loadClientSecret, type ClientCredentials } from './config/client-secret.js';
import { resolvePaths, type Paths } from './config/paths.js';
import { DocsService } from './content/docs-service.js';
import { SheetsService } from './content/sheets-service.js';
import { SlidesService } from './content/slides-service.js';
import { DriveClientFactory } from './drive/client-factory.js';
import { PairStore } from './sync/pair-store.js';
import { SyncService } from './sync/sync-service.js';
import { defaultExec } from './sync/trash.js';
import { FileService } from './files/file-service.js';

export interface App {
  paths: Paths;
  auth: AuthService;
  files: FileService;
  docs: DocsService;
  sheets: SheetsService;
  slides: SlidesService;
  sync: SyncService;
}

/** Composition root: wires real implementations together. */
export function buildApp(env: NodeJS.ProcessEnv = process.env): App {
  const paths = resolvePaths(env);
  const auth = new AuthService({
    registry: new AccountRegistry(paths.accounts),
    tokens: new KeychainTokenStore(),
    loadCredentials: (): Promise<ClientCredentials> => loadClientSecret(paths.clientSecret),
    login: ({ credentials, loginHint, onVerified }): Promise<LoginResult> =>
      runLoginFlow({
        clientId: credentials.clientId,
        clientSecret: credentials.clientSecret,
        ...(loginHint ? { loginHint } : {}),
        onVerified,
        openUrl: async (url) => {
          await open(url);
        },
        print: (message) => {
          process.stderr.write(`${message}\n`);
        },
      }),
  });
  const runner = new DriveClientFactory(auth);
  const audit = new FileAuditLog(paths.audit);
  const files = new FileService({ runner, audit, downloadsDir: paths.downloadsDir });
  const docs = new DocsService({ runner, audit });
  const sheets = new SheetsService({ runner, audit });
  const slides = new SlidesService({ runner, audit });
  const sync = new SyncService({
    runner,
    audit,
    store: new PairStore({ dir: paths.syncDir }),
    trashExec: defaultExec,
  });
  return { paths, auth, files, docs, sheets, slides, sync };
}
