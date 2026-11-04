import open from 'open';
import { AuthService } from './auth/auth-service.js';
import { selectTokenStore } from './auth/select-token-store.js';
import { runLoginFlow, type LoginFlowOptions, type LoginResult } from './auth/login-flow.js';
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

export interface BuildAppOptions {
  /** No-browser login: print the URL and read the pasted redirect URL with this reader. */
  manualLogin?: NonNullable<LoginFlowOptions['manual']>;
}

/** Composition root: wires real implementations together. */
export function buildApp(env: NodeJS.ProcessEnv = process.env, options: BuildAppOptions = {}): App {
  const paths = resolvePaths(env);
  const auth = new AuthService({
    registry: new AccountRegistry(paths.accounts),
    tokens: selectTokenStore(env, paths.tokens),
    loadCredentials: (): Promise<ClientCredentials> => loadClientSecret(paths.clientSecret),
    login: ({ credentials, loginHint, onVerified }): Promise<LoginResult> =>
      runLoginFlow({
        clientId: credentials.clientId,
        clientSecret: credentials.clientSecret,
        ...(loginHint ? { loginHint } : {}),
        onVerified,
        ...(options.manualLogin ? { manual: options.manualLogin } : {}),
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
