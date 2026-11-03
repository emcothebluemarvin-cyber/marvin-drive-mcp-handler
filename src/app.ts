import open from 'open';
import { AuthService } from './auth/auth-service.js';
import { KeychainTokenStore } from './auth/keychain-token-store.js';
import { runLoginFlow, type LoginResult } from './auth/login-flow.js';
import { FileAuditLog } from './audit/audit-log.js';
import { AccountRegistry } from './config/account-registry.js';
import { loadClientSecret, type ClientCredentials } from './config/client-secret.js';
import { resolvePaths, type Paths } from './config/paths.js';
import { DriveClientFactory } from './drive/client-factory.js';
import { FileService } from './files/file-service.js';

export interface App {
  paths: Paths;
  auth: AuthService;
  files: FileService;
}

/** Composition root: wires real implementations together. */
export function buildApp(env: NodeJS.ProcessEnv = process.env): App {
  const paths = resolvePaths(env);
  const auth = new AuthService({
    registry: new AccountRegistry(paths.accounts),
    tokens: new KeychainTokenStore(),
    loadCredentials: (): Promise<ClientCredentials> => loadClientSecret(paths.clientSecret),
    login: ({ credentials, loginHint }): Promise<LoginResult> =>
      runLoginFlow({
        clientId: credentials.clientId,
        clientSecret: credentials.clientSecret,
        ...(loginHint ? { loginHint } : {}),
        openUrl: async (url) => {
          await open(url);
        },
        print: (message) => {
          process.stderr.write(`${message}\n`);
        },
      }),
  });
  const files = new FileService({
    runner: new DriveClientFactory(auth),
    audit: new FileAuditLog(paths.audit),
    downloadsDir: paths.downloadsDir,
  });
  return { paths, auth, files };
}
