import open from 'open';
import { AuthService } from './auth/auth-service.js';
import { selectTokenStore } from './auth/select-token-store.js';
import {
  finishTwoStepLogin,
  runLoginFlow,
  startTwoStepLogin,
  type LoginFlowOptions,
  type LoginResult,
  type TwoStepStart,
} from './auth/login-flow.js';
import { MicrosoftAuth } from './auth/microsoft-auth.js';
import { PendingLoginStore } from './auth/pending-login.js';
import { FileAuditLog } from './audit/audit-log.js';
import { AccountRegistry } from './config/account-registry.js';
import { loadClientSecret, type ClientCredentials } from './config/client-secret.js';
import { loadMicrosoftClientId } from './config/microsoft-client.js';
import { resolvePaths, type Paths } from './config/paths.js';
import { DocsService } from './content/docs-service.js';
import { SheetsService } from './content/sheets-service.js';
import { SlidesService } from './content/slides-service.js';
import { DriveClientFactory } from './drive/client-factory.js';
import { PairStore } from './sync/pair-store.js';
import { SyncService } from './sync/sync-service.js';
import { createLocalTrash } from './sync/trash.js';
import { FileRouter } from './files/file-router.js';
import { FileService } from './files/file-service.js';
import { GraphClient } from './onedrive/graph-client.js';
import { OneDriveFileService } from './onedrive/onedrive-file-service.js';
import { createGoogleWatchProvider } from './watch/google/provider.js';
import { WatchService, pollIntervalMs } from './watch/watch-service.js';
import { WatchStore } from './watch/watch-store.js';

export interface App {
  paths: Paths;
  auth: AuthService;
  /** All accounts: picks Google or OneDrive from the account record. */
  files: FileRouter;
  googleFiles: FileService;
  docs: DocsService;
  sheets: SheetsService;
  slides: SlidesService;
  sync: SyncService;
  watch: WatchService;
}

export interface BuildAppOptions {
  /** No-browser login: print the URL and read the pasted redirect URL with this reader. */
  manualLogin?: NonNullable<LoginFlowOptions['manual']>;
}

/** Composition root: wires real implementations together. */
export function buildApp(env: NodeJS.ProcessEnv = process.env, options: BuildAppOptions = {}): App {
  const paths = resolvePaths(env);
  const registry = new AccountRegistry(paths.accounts);
  const tokens = selectTokenStore(env, paths.tokens);
  const pending = new PendingLoginStore(paths.pendingLogins);
  const openUrl = async (url: string): Promise<void> => {
    await open(url);
  };
  const print = (message: string): void => {
    process.stderr.write(`${message}\n`);
  };
  const microsoft = new MicrosoftAuth({
    registry,
    tokens,
    pending,
    loadClientId: (): Promise<string> => loadMicrosoftClientId(paths.microsoftClient),
    openUrl,
    print,
    ...(options.manualLogin ? { manual: options.manualLogin } : {}),
  });
  const auth = new AuthService({
    registry,
    tokens,
    microsoft,
    loadCredentials: (): Promise<ClientCredentials> => loadClientSecret(paths.clientSecret),
    login: ({ credentials, loginHint, onVerified }): Promise<LoginResult> =>
      runLoginFlow({
        clientId: credentials.clientId,
        clientSecret: credentials.clientSecret,
        ...(loginHint ? { loginHint } : {}),
        onVerified,
        ...(options.manualLogin ? { manual: options.manualLogin } : {}),
        openUrl,
        print,
      }),
    twoStep: {
      pending,
      start: (credentials, loginHint): Promise<TwoStepStart> =>
        startTwoStepLogin({ ...credentials, ...(loginHint ? { loginHint } : {}) }),
      finish: (credentials, pending, redirectUrl): Promise<LoginResult> =>
        finishTwoStepLogin(credentials, pending, redirectUrl),
    },
  });
  const runner = new DriveClientFactory(auth);
  const audit = new FileAuditLog(paths.audit);
  const googleFiles = new FileService({ runner, audit, downloadsDir: paths.downloadsDir });
  const files = new FileRouter({
    registry,
    google: googleFiles,
    microsoft: new OneDriveFileService({
      clients: async (alias): Promise<GraphClient> => {
        const record = await registry.resolve(alias);
        return new GraphClient({
          alias: record.alias,
          accessToken: (tokenOptions): Promise<string> =>
            microsoft.accessToken(record, tokenOptions),
        });
      },
      audit,
      downloadsDir: paths.downloadsDir,
    }),
  });
  const docs = new DocsService({ runner, audit });
  const sheets = new SheetsService({ runner, audit });
  const slides = new SlidesService({ runner, audit });
  const sync = new SyncService({
    runner,
    audit,
    store: new PairStore({ dir: paths.syncDir }),
    trash: createLocalTrash(),
  });
  const watch = new WatchService({
    store: new WatchStore({ dir: paths.watchDir }),
    provider: createGoogleWatchProvider({
      runner,
      audit,
      resolveAccount: (ref) => auth.resolveAccount(ref),
    }),
    intervalMs: pollIntervalMs(env),
  });
  return { paths, auth, files, googleFiles, docs, sheets, slides, sync, watch };
}
