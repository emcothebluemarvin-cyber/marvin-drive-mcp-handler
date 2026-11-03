import { google, type Auth, type sheets_v4 } from 'googleapis';

export type Spreadsheet = sheets_v4.Schema$Spreadsheet;
export type SheetsValueRange = sheets_v4.Schema$ValueRange;
export type SheetsUpdateResponse = sheets_v4.Schema$UpdateValuesResponse;
export type SheetsAppendResponse = sheets_v4.Schema$AppendValuesResponse;
export type SheetsRequest = sheets_v4.Schema$Request;
export type SheetsBatchResponse = sheets_v4.Schema$BatchUpdateSpreadsheetResponse;
export type ValueRender = 'FORMATTED_VALUE' | 'UNFORMATTED_VALUE' | 'FORMULA';
export type ValueInput = 'USER_ENTERED' | 'RAW';
export type CellValue = string | number | boolean;

/** Narrow, test-friendly view of the Sheets v4 API. */
export interface SheetsAdapter {
  getSpreadsheet(spreadsheetId: string, fields: string): Promise<Spreadsheet>;
  getValues(spreadsheetId: string, range: string, render: ValueRender): Promise<SheetsValueRange>;
  updateValues(
    spreadsheetId: string,
    range: string,
    values: CellValue[][],
    input: ValueInput,
  ): Promise<SheetsUpdateResponse>;
  appendValues(
    spreadsheetId: string,
    range: string,
    values: CellValue[][],
    input: ValueInput,
  ): Promise<SheetsAppendResponse>;
  batchUpdate(spreadsheetId: string, requests: SheetsRequest[]): Promise<SheetsBatchResponse>;
}

export function createSheetsAdapter(auth: Auth.OAuth2Client): SheetsAdapter {
  const sheets = google.sheets({ version: 'v4', auth, retry: false });
  const adapter: SheetsAdapter = {
    async getSpreadsheet(spreadsheetId, fields) {
      return (await sheets.spreadsheets.get({ spreadsheetId, fields })).data;
    },
    async getValues(spreadsheetId, range, render) {
      return (
        await sheets.spreadsheets.values.get({ spreadsheetId, range, valueRenderOption: render })
      ).data;
    },
    async updateValues(spreadsheetId, range, values, input) {
      const res = await sheets.spreadsheets.values.update({
        spreadsheetId,
        range,
        valueInputOption: input,
        requestBody: { values },
      });
      return res.data;
    },
    async appendValues(spreadsheetId, range, values, input) {
      const res = await sheets.spreadsheets.values.append({
        spreadsheetId,
        range,
        valueInputOption: input,
        insertDataOption: 'INSERT_ROWS',
        requestBody: { values },
      });
      return res.data;
    },
    async batchUpdate(spreadsheetId, requests) {
      return (await sheets.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests } }))
        .data;
    },
  };
  return adapter;
}
