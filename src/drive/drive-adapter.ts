import { Readable } from 'node:stream';
import type { ReadableStream as NodeWebReadableStream } from 'node:stream/web';
import { google, type Auth, type drive_v3 } from 'googleapis';

export type DriveFile = drive_v3.Schema$File;
export type DriveFileList = drive_v3.Schema$FileList;

export interface ListParams {
  q: string;
  pageSize: number;
  pageToken?: string;
  fields: string;
}

/** Narrow, test-friendly view of the Drive v3 API used by FileService. */
export interface DriveAdapter {
  getFile(fileId: string, fields: string): Promise<DriveFile>;
  listFiles(params: ListParams): Promise<DriveFileList>;
  downloadMedia(fileId: string): Promise<Readable>;
  exportMedia(fileId: string, mimeType: string): Promise<Readable>;
  /** GET an `exportLinks` URL with the account's bearer token (10 MB export-limit fallback). */
  fetchExportLink(url: string): Promise<Readable>;
  createFile(params: {
    requestBody: DriveFile;
    media?: { mimeType: string; body: Readable };
    fields: string;
  }): Promise<DriveFile>;
  updateFile(params: {
    fileId: string;
    requestBody?: DriveFile;
    addParents?: string;
    removeParents?: string;
    fields: string;
  }): Promise<DriveFile>;
  copyFile(params: { fileId: string; requestBody: DriveFile; fields: string }): Promise<DriveFile>;
  deleteFile(fileId: string): Promise<void>;
}

export function createDriveAdapter(auth: Auth.OAuth2Client): DriveAdapter {
  const drive = google.drive({ version: 'v3', auth });
  const allDrives = { supportsAllDrives: true } as const;

  const adapter: DriveAdapter = {
    async getFile(fileId, fields) {
      return (await drive.files.get({ fileId, fields, ...allDrives })).data;
    },

    async listFiles({ q, pageSize, pageToken, fields }) {
      const res = await drive.files.list({
        q,
        pageSize,
        pageToken,
        fields,
        includeItemsFromAllDrives: true,
        ...allDrives,
      });
      return res.data;
    },

    async downloadMedia(fileId) {
      const res = await drive.files.get(
        { fileId, alt: 'media', ...allDrives },
        { responseType: 'stream' },
      );
      return res.data;
    },

    async exportMedia(fileId, mimeType) {
      // files.export has no supportsAllDrives parameter in the Drive v3 API — this is intentional.
      const res = await drive.files.export({ fileId, mimeType }, { responseType: 'stream' });
      return res.data;
    },

    async fetchExportLink(url) {
      // Only ever send the bearer token to Google hosts.
      const { hostname, protocol } = new URL(url);
      if (protocol !== 'https:' || !/(^|\.)(google\.com|googleapis\.com)$/.test(hostname)) {
        throw new Error(`Refusing to send credentials to ${hostname}`);
      }
      const { token } = await auth.getAccessToken();
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${token ?? ''}` },
        signal: AbortSignal.timeout(5 * 60_000),
      });
      if (!res.ok || !res.body) {
        await res.body?.cancel();
        throw Object.assign(new Error(`Export link request failed with ${res.status}`), {
          status: res.status,
        });
      }
      return Readable.fromWeb(res.body as NodeWebReadableStream<Uint8Array>);
    },

    async createFile({ requestBody, media, fields }) {
      const res = await drive.files.create({ requestBody, media, fields, ...allDrives });
      return res.data;
    },

    async updateFile({ fileId, requestBody, addParents, removeParents, fields }) {
      const res = await drive.files.update({
        fileId,
        requestBody,
        addParents,
        removeParents,
        fields,
        ...allDrives,
      });
      return res.data;
    },

    async copyFile({ fileId, requestBody, fields }) {
      const res = await drive.files.copy({ fileId, requestBody, fields, ...allDrives });
      return res.data;
    },

    async deleteFile(fileId) {
      await drive.files.delete({ fileId, ...allDrives });
    },
  };
  return adapter;
}
