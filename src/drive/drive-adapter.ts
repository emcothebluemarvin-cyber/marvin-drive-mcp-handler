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
    /** New content for the same fileId (Drive keeps the previous revision). */
    media?: { mimeType: string; body: Readable };
    addParents?: string;
    removeParents?: string;
    fields: string;
  }): Promise<DriveFile>;
  copyFile(params: { fileId: string; requestBody: DriveFile; fields: string }): Promise<DriveFile>;
  deleteFile(fileId: string): Promise<void>;
}

/** Only https URLs on google.com / googleapis.com (and subdomains) may receive the bearer token. */
export function isAllowedExportUrl(url: string): boolean {
  try {
    const { hostname, protocol } = new URL(url);
    return protocol === 'https:' && /(^|\.)(google\.com|googleapis\.com)$/.test(hostname);
  } catch {
    return false;
  }
}

/** googleapis retries by default; withRetry is the single retry layer, so disable it. */
export const DRIVE_CLIENT_OPTIONS = { version: 'v3', retry: false } as const;

export function createDriveAdapter(auth: Auth.OAuth2Client): DriveAdapter {
  const drive = google.drive({ ...DRIVE_CLIENT_OPTIONS, auth });
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
      if (!isAllowedExportUrl(url)) {
        throw new Error('Refusing to send credentials to a non-Google export link');
      }
      const { token } = await auth.getAccessToken();
      if (!token) throw new Error('No access token available for export link request');
      // Timeout only covers waiting for response headers, not the body download.
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 60_000);
      timer.unref();
      let res: Response;
      try {
        res = await fetch(url, {
          headers: { Authorization: `Bearer ${token}` },
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }
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

    async updateFile({ fileId, requestBody, media, addParents, removeParents, fields }) {
      const res = await drive.files.update({
        fileId,
        requestBody,
        media,
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
