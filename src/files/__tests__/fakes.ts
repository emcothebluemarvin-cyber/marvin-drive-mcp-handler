import { vi, type Mock } from 'vitest';
import type { AuditEntry, AuditSink } from '../../audit/audit-log.js';
import type { AccountRecord } from '../../config/account-registry.js';
import type { DriveContext, DriveRunner } from '../../drive/client-factory.js';
import type { DriveAdapter } from '../../drive/drive-adapter.js';
import { createLogger, type Logger } from '../../logger.js';
import type { RetryOptions } from '../retry.js';

export const ACCOUNT: AccountRecord = {
  alias: 'emco',
  email: 'emco@example.com',
  addedAt: '2026-11-03T00:00:00.000Z',
};

export type FakeDrive = { [K in keyof DriveAdapter]: Mock<DriveAdapter[K]> };

function strict<K extends keyof DriveAdapter>(name: K): Mock<DriveAdapter[K]> {
  const impl = (() =>
    Promise.reject(new Error(`unexpected call: ${name}`))) as unknown as DriveAdapter[K];
  return vi.fn(impl);
}

/** Every method rejects until a test stubs it — unexpected calls fail loudly. */
export function createFakeDrive(): FakeDrive {
  return {
    getFile: strict('getFile'),
    listFiles: strict('listFiles'),
    downloadMedia: strict('downloadMedia'),
    exportMedia: strict('exportMedia'),
    fetchExportLink: strict('fetchExportLink'),
    createFile: strict('createFile'),
    updateFile: strict('updateFile'),
    copyFile: strict('copyFile'),
    deleteFile: strict('deleteFile'),
  };
}

export function createRunner(
  drive: DriveAdapter,
): DriveRunner & { refs: Array<string | undefined> } {
  const refs: Array<string | undefined> = [];
  return {
    refs,
    run<T>(ref: string | undefined, fn: (ctx: DriveContext) => Promise<T>): Promise<T> {
      refs.push(ref);
      return fn({ account: ACCOUNT, drive });
    },
  };
}

export function createAudit(): AuditSink & { entries: Array<Omit<AuditEntry, 'ts'>> } {
  const entries: Array<Omit<AuditEntry, 'ts'>> = [];
  return {
    entries,
    async record(entry) {
      entries.push(entry);
    },
  };
}

export const noSleep: RetryOptions = { sleep: async () => {}, random: () => 0 };

export const silentLogger = (): Logger & { warn: Mock } => {
  const base = createLogger(() => {});
  return { ...base, warn: vi.fn() };
};

export function httpError(status: number, reason?: string, message = `HTTP ${status}`): Error {
  return Object.assign(new Error(message), {
    status,
    ...(reason ? { errors: [{ reason }] } : {}),
  });
}
