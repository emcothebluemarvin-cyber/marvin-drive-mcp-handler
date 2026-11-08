import type { DriveFile } from '../drive/drive-adapter.js';
import type { ExportFormat } from './export-formats.js';
import type { SearchCriteria } from './query.js';

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

export function clampPageSize(pageSize: number | undefined): number {
  return Math.min(Math.max(Math.trunc(pageSize ?? DEFAULT_PAGE_SIZE), 1), MAX_PAGE_SIZE);
}

export interface FileSummary {
  id: string;
  name: string;
  mimeType: string;
  size?: number;
  modifiedTime?: string;
  parents?: string[];
}

export interface ListResult {
  files: FileSummary[];
  nextPageToken?: string;
}

export interface AccountInput {
  account?: string;
}

export interface ListInput extends AccountInput {
  folderId?: string;
  pageSize?: number;
  pageToken?: string;
  includeTrashed?: boolean;
}

export interface SearchInput extends AccountInput, SearchCriteria {
  pageSize?: number;
  pageToken?: string;
}

export interface FileRef extends AccountInput {
  fileId: string;
}

export interface CreateFolderInput extends AccountInput {
  name: string;
  parentId?: string;
}

export interface MoveInput extends FileRef {
  newParentId: string;
}

export interface RenameInput extends FileRef {
  newName: string;
}

export interface CopyInput extends FileRef {
  parentId?: string;
  name?: string;
}

export interface DeleteInput extends FileRef {
  permanent?: boolean;
}

export interface DeleteResult {
  fileId: string;
  name?: string;
  permanent: boolean;
}

export interface UploadInput extends AccountInput {
  localPath: string;
  parentId?: string;
  name?: string;
  convertToGoogle?: boolean;
}

export interface DownloadInput extends FileRef {
  destPath?: string;
  exportFormat?: ExportFormat;
}

export interface DownloadResult {
  path: string;
  size: number;
  mimeType: string;
  exportFormat: ExportFormat | null;
}

/** `getMetadata` on OneDrive: `FileSummary` plus what Graph can report. */
export interface OneDriveMetadata extends FileSummary {
  createdTime?: string;
  webViewLink?: string;
  trashed?: boolean;
  owners?: Array<{ displayName?: string; emailAddress?: string }>;
}

export type FileMetadata = DriveFile | OneDriveMetadata;

export interface ExistingFile {
  id: string;
  name: string;
  size?: number;
  modifiedTime?: string;
  modifiedBy?: string;
}

export type ReplaceAnswer = 'overwrite' | 'cancel' | 'no_answer';
export type ConfirmReplace = (existing: ExistingFile) => Promise<ReplaceAnswer>;

export interface UploadOptions {
  confirmReplace?: ConfirmReplace;
}

/** A successful result: nothing was written and Claude should not retry. */
export interface UploadCancelled {
  cancelled: true;
  reason: 'user' | 'no_answer';
  existing: ExistingFile;
}

/** The file operations behind the `drive_*` tools (spec §3.1). */
export interface FileProvider {
  list(input: ListInput): Promise<ListResult>;
  search(input: SearchInput): Promise<ListResult>;
  getMetadata(input: FileRef): Promise<FileMetadata>;
  createFolder(input: CreateFolderInput): Promise<FileSummary>;
  move(input: MoveInput): Promise<FileSummary>;
  rename(input: RenameInput): Promise<FileSummary>;
  copy(input: CopyInput): Promise<FileSummary>;
  delete(input: DeleteInput): Promise<DeleteResult>;
  restore(input: FileRef): Promise<FileSummary>;
  upload(input: UploadInput, options?: UploadOptions): Promise<FileSummary | UploadCancelled>;
  download(input: DownloadInput): Promise<DownloadResult>;
}
