import { vi, type Mock } from 'vitest';
import type { AuditEntry, AuditSink } from '../../audit/audit-log.js';
import type { AccountRecord } from '../../config/account-registry.js';
import type { DriveContext, DriveRunner } from '../../drive/client-factory.js';
import type { DocsAdapter } from '../../drive/docs-adapter.js';
import type { SheetsAdapter } from '../../drive/sheets-adapter.js';
import type { SlidesAdapter } from '../../drive/slides-adapter.js';
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
    getStartPageToken: strict('getStartPageToken'),
    listChanges: strict('listChanges'),
    listComments: strict('listComments'),
  };
}

type FakeOf<T> = { [K in keyof T]: Mock<Extract<T[K], (...args: never[]) => unknown>> };
export type FakeDocs = FakeOf<DocsAdapter>;
export type FakeSheets = FakeOf<SheetsAdapter>;
export type FakeSlides = FakeOf<SlidesAdapter>;

function strictFn<F extends (...args: never[]) => unknown>(name: string): Mock<F> {
  return vi.fn((() => Promise.reject(new Error(`unexpected call: ${name}`))) as unknown as F);
}

export function createFakeDocs(): FakeDocs {
  return {
    getDocument: strictFn<DocsAdapter['getDocument']>('getDocument'),
    batchUpdate: strictFn<DocsAdapter['batchUpdate']>('docs.batchUpdate'),
  };
}

export function createFakeSheets(): FakeSheets {
  return {
    getSpreadsheet: strictFn<SheetsAdapter['getSpreadsheet']>('getSpreadsheet'),
    getValues: strictFn<SheetsAdapter['getValues']>('getValues'),
    batchGetValues: strictFn<SheetsAdapter['batchGetValues']>('batchGetValues'),
    updateValues: strictFn<SheetsAdapter['updateValues']>('updateValues'),
    appendValues: strictFn<SheetsAdapter['appendValues']>('appendValues'),
    batchUpdate: strictFn<SheetsAdapter['batchUpdate']>('sheets.batchUpdate'),
  };
}

export function createFakeSlides(): FakeSlides {
  return {
    getPresentation: strictFn<SlidesAdapter['getPresentation']>('getPresentation'),
    batchUpdate: strictFn<SlidesAdapter['batchUpdate']>('slides.batchUpdate'),
  };
}

export function createRunner(
  drive: DriveAdapter,
  content: Partial<Pick<DriveContext, 'docs' | 'sheets' | 'slides'>> = {},
): DriveRunner & { refs: Array<string | undefined> } {
  const refs: Array<string | undefined> = [];
  const ctx: DriveContext = {
    account: ACCOUNT,
    drive,
    docs: content.docs ?? createFakeDocs(),
    sheets: content.sheets ?? createFakeSheets(),
    slides: content.slides ?? createFakeSlides(),
  };
  return {
    refs,
    run<T>(ref: string | undefined, fn: (ctx: DriveContext) => Promise<T>): Promise<T> {
      refs.push(ref);
      return fn(ctx);
    },
  };
}

/** Stubs Drive pre-flight getFile for a Google file of the given MIME type. */
export function stubFile(drive: FakeDrive, id: string, mimeType: string, name = 'Demo'): void {
  drive.getFile.mockResolvedValueOnce({ id, name, mimeType });
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
