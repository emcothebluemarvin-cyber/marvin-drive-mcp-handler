import { isMicrosoft, type AccountRegistry } from '../config/account-registry.js';
import type {
  AccountInput,
  CopyInput,
  CreateFolderInput,
  DeleteInput,
  DeleteResult,
  DownloadInput,
  DownloadResult,
  FileMetadata,
  FileProvider,
  FileRef,
  FileSummary,
  ListInput,
  ListResult,
  MoveInput,
  RenameInput,
  SearchInput,
  UploadCancelled,
  UploadInput,
  UploadOptions,
} from './file-provider.js';

export interface FileRouterDeps {
  registry: Pick<AccountRegistry, 'resolve'>;
  google: FileProvider;
  microsoft: FileProvider;
}

/** Picks the provider from the account record; a provider only ever sees the alias (spec §3.1). */
export class FileRouter implements FileProvider {
  constructor(private readonly deps: FileRouterDeps) {}

  private async route<I extends AccountInput>(
    input: I,
  ): Promise<{ provider: FileProvider; resolved: I & { account: string } }> {
    const record = await this.deps.registry.resolve(input.account);
    return {
      provider: isMicrosoft(record) ? this.deps.microsoft : this.deps.google,
      resolved: { ...input, account: record.alias },
    };
  }

  async list(input: ListInput): Promise<ListResult> {
    const { provider, resolved } = await this.route(input);
    return provider.list(resolved);
  }

  async search(input: SearchInput): Promise<ListResult> {
    const { provider, resolved } = await this.route(input);
    return provider.search(resolved);
  }

  async getMetadata(input: FileRef): Promise<FileMetadata> {
    const { provider, resolved } = await this.route(input);
    return provider.getMetadata(resolved);
  }

  async createFolder(input: CreateFolderInput): Promise<FileSummary> {
    const { provider, resolved } = await this.route(input);
    return provider.createFolder(resolved);
  }

  async move(input: MoveInput): Promise<FileSummary> {
    const { provider, resolved } = await this.route(input);
    return provider.move(resolved);
  }

  async rename(input: RenameInput): Promise<FileSummary> {
    const { provider, resolved } = await this.route(input);
    return provider.rename(resolved);
  }

  async copy(input: CopyInput): Promise<FileSummary> {
    const { provider, resolved } = await this.route(input);
    return provider.copy(resolved);
  }

  async delete(input: DeleteInput): Promise<DeleteResult> {
    const { provider, resolved } = await this.route(input);
    return provider.delete(resolved);
  }

  async restore(input: FileRef): Promise<FileSummary> {
    const { provider, resolved } = await this.route(input);
    return provider.restore(resolved);
  }

  async upload(
    input: UploadInput,
    options?: UploadOptions,
  ): Promise<FileSummary | UploadCancelled> {
    const { provider, resolved } = await this.route(input);
    return provider.upload(resolved, options);
  }

  async download(input: DownloadInput): Promise<DownloadResult> {
    const { provider, resolved } = await this.route(input);
    return provider.download(resolved);
  }
}
