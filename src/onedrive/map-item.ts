import type { ExistingFile, FileSummary, OneDriveMetadata } from '../files/file-provider.js';

export const FOLDER_MIME = 'inode/directory';
export const PACKAGE_MIME = 'application/x-onedrive-package';
const DEFAULT_MIME = 'application/octet-stream';

interface GraphIdentity {
  displayName?: string;
  email?: string;
}

export interface GraphItem {
  id: string;
  name: string;
  size?: number;
  eTag?: string;
  webUrl?: string;
  createdDateTime?: string;
  lastModifiedDateTime?: string;
  folder?: object;
  file?: { mimeType?: string };
  package?: object;
  remoteItem?: object;
  deleted?: object;
  parentReference?: { id?: string; driveId?: string };
  createdBy?: { user?: GraphIdentity };
  lastModifiedBy?: { user?: GraphIdentity };
}

export function mimeOf(item: GraphItem): string {
  if (item.folder) return FOLDER_MIME;
  if (item.package) return PACKAGE_MIME;
  return item.file?.mimeType ?? DEFAULT_MIME;
}

export function toSummary(item: GraphItem): FileSummary {
  const parent = item.parentReference?.id;
  return {
    id: item.id,
    name: item.name,
    mimeType: mimeOf(item),
    ...(item.size !== undefined && !item.folder ? { size: item.size } : {}),
    ...(item.lastModifiedDateTime ? { modifiedTime: item.lastModifiedDateTime } : {}),
    ...(parent ? { parents: [parent] } : {}),
  };
}

export function toMetadata(item: GraphItem): OneDriveMetadata {
  const owner = item.createdBy?.user;
  return {
    ...toSummary(item),
    ...(item.createdDateTime ? { createdTime: item.createdDateTime } : {}),
    ...(item.webUrl ? { webViewLink: item.webUrl } : {}),
    trashed: item.deleted !== undefined,
    ...(owner
      ? {
          owners: [
            {
              ...(owner.displayName ? { displayName: owner.displayName } : {}),
              ...(owner.email ? { emailAddress: owner.email } : {}),
            },
          ],
        }
      : {}),
  };
}

export function toExistingFile(item: GraphItem): ExistingFile {
  const modifier = item.lastModifiedBy?.user;
  const modifiedBy = modifier?.displayName ?? modifier?.email;
  return {
    id: item.id,
    name: item.name,
    ...(item.size !== undefined ? { size: item.size } : {}),
    ...(item.lastModifiedDateTime ? { modifiedTime: item.lastModifiedDateTime } : {}),
    ...(modifiedBy ? { modifiedBy } : {}),
  };
}
