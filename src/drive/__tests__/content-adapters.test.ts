import { google } from 'googleapis';
import { describe, expect, it } from 'vitest';
import { createDocsAdapter } from '../docs-adapter.js';
import { createSheetsAdapter } from '../sheets-adapter.js';
import { createSlidesAdapter } from '../slides-adapter.js';

interface Captured {
  url: string;
  method?: string;
  data?: unknown;
  params?: Record<string, unknown>;
}

function fakeAuth(captured: Captured[]): InstanceType<typeof google.auth.OAuth2> {
  const auth = new google.auth.OAuth2();
  auth.setCredentials({ access_token: 'test-token' });
  auth.request = (async (opts: Captured) => {
    captured.push(opts);
    return { data: { ok: true }, status: 200, headers: {}, config: opts, statusText: 'OK' };
  }) as unknown as typeof auth.request;
  return auth;
}

describe('content adapters', () => {
  it('docs batchUpdate sends writeControl only when a revision is given', async () => {
    const captured: Captured[] = [];
    const docs = createDocsAdapter(fakeAuth(captured));
    await docs.batchUpdate('d1', [{ insertText: { text: 'x', location: { index: 1 } } }], 'rev1');
    await docs.batchUpdate('d1', [{ insertText: { text: 'x', location: { index: 1 } } }]);
    expect(captured[0]?.url).toContain('/v1/documents/d1:batchUpdate');
    expect(captured[0]?.data).toEqual({
      requests: [{ insertText: { text: 'x', location: { index: 1 } } }],
      writeControl: { requiredRevisionId: 'rev1' },
    });
    expect(captured[1]?.data).not.toHaveProperty('writeControl');
  });

  it('sheets append inserts rows with the chosen input option', async () => {
    const captured: Captured[] = [];
    const sheets = createSheetsAdapter(fakeAuth(captured));
    await sheets.appendValues('s1', 'Tab', [['a', 1]], 'USER_ENTERED');
    expect(captured[0]?.url).toContain('/v4/spreadsheets/s1/values/Tab:append');
    expect(captured[0]?.params).toMatchObject({
      valueInputOption: 'USER_ENTERED',
      insertDataOption: 'INSERT_ROWS',
    });
    expect(captured[0]?.data).toEqual({ values: [['a', 1]] });
  });

  it('slides get passes the field mask', async () => {
    const captured: Captured[] = [];
    const slides = createSlidesAdapter(fakeAuth(captured));
    await slides.getPresentation('p1', 'revisionId');
    expect(captured[0]?.url).toContain('/v1/presentations/p1');
    expect(captured[0]?.params).toMatchObject({ fields: 'revisionId' });
  });

  it('slides batchUpdate sends writeControl only when a revision is given', async () => {
    const captured: Captured[] = [];
    const slides = createSlidesAdapter(fakeAuth(captured));
    const requests = [{ deleteObject: { objectId: 'o1' } }];
    await slides.batchUpdate('p1', requests, 'rev1');
    await slides.batchUpdate('p1', requests);
    expect(captured[0]?.url).toContain('/v1/presentations/p1:batchUpdate');
    expect(captured[0]?.data).toEqual({ requests, writeControl: { requiredRevisionId: 'rev1' } });
    expect(captured[1]?.data).not.toHaveProperty('writeControl');
  });

  it('sheets updateValues sends the input option and values body', async () => {
    const captured: Captured[] = [];
    const sheets = createSheetsAdapter(fakeAuth(captured));
    await sheets.updateValues('s1', 'Tab!A1', [['a', 1]], 'RAW');
    expect(captured[0]?.method).toBe('PUT');
    expect(captured[0]?.url).toContain('/v4/spreadsheets/s1/values/');
    expect(captured[0]?.params).toMatchObject({ valueInputOption: 'RAW' });
    expect(captured[0]?.data).toEqual({ values: [['a', 1]] });
  });

  it('sheets getValues passes the render option', async () => {
    const captured: Captured[] = [];
    const sheets = createSheetsAdapter(fakeAuth(captured));
    await sheets.getValues('s1', 'Tab!A1:B2', 'FORMULA');
    expect(captured[0]?.url).toContain('/v4/spreadsheets/s1/values/');
    expect(captured[0]?.params).toMatchObject({ valueRenderOption: 'FORMULA' });
  });
});
