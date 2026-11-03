import { google, type Auth, type slides_v1 } from 'googleapis';

export type SlidesPresentation = slides_v1.Schema$Presentation;
export type SlidesPageElement = slides_v1.Schema$PageElement;
export type SlidesTextContent = slides_v1.Schema$TextContent;
export type SlidesRequest = slides_v1.Schema$Request;
export type SlidesBatchResponse = slides_v1.Schema$BatchUpdatePresentationResponse;

/** Narrow, test-friendly view of the Slides v1 API. */
export interface SlidesAdapter {
  getPresentation(presentationId: string, fields: string): Promise<SlidesPresentation>;
  batchUpdate(
    presentationId: string,
    requests: SlidesRequest[],
    requiredRevisionId?: string,
  ): Promise<SlidesBatchResponse>;
}

export function createSlidesAdapter(auth: Auth.OAuth2Client): SlidesAdapter {
  const slides = google.slides({ version: 'v1', auth, retry: false });
  const adapter: SlidesAdapter = {
    async getPresentation(presentationId, fields) {
      return (await slides.presentations.get({ presentationId, fields })).data;
    },
    async batchUpdate(presentationId, requests, requiredRevisionId) {
      const res = await slides.presentations.batchUpdate({
        presentationId,
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
