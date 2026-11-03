import { google, type Auth, type docs_v1 } from 'googleapis';

export type DocsDocument = docs_v1.Schema$Document;
export type DocsRequest = docs_v1.Schema$Request;
export type DocsBatchResponse = docs_v1.Schema$BatchUpdateDocumentResponse;

/** Narrow, test-friendly view of the Docs v1 API. */
export interface DocsAdapter {
  getDocument(documentId: string, fields: string): Promise<DocsDocument>;
  batchUpdate(
    documentId: string,
    requests: DocsRequest[],
    requiredRevisionId?: string,
  ): Promise<DocsBatchResponse>;
}

export function createDocsAdapter(auth: Auth.OAuth2Client): DocsAdapter {
  const docs = google.docs({ version: 'v1', auth, retry: false });
  const adapter: DocsAdapter = {
    async getDocument(documentId, fields) {
      return (await docs.documents.get({ documentId, fields })).data;
    },
    async batchUpdate(documentId, requests, requiredRevisionId) {
      const res = await docs.documents.batchUpdate({
        documentId,
        requestBody: {
          requests,
          ...(requiredRevisionId ? { writeControl: { requiredRevisionId } } : {}),
        },
      });
      return res.data;
    },
  };
  return adapter;
}
