import { describe, expect, it } from 'vitest';
import type { ProjectDb } from '@freecrawl/db';
import { runScheduledSheets } from './scheduled-export.js';

// B60 Done 8d: a scheduled export cut at the Sheets cell limit logs it and
// puts it into the errors the webhook payload carries.
const db = {} as ProjectDb;

describe('scheduled Sheets step', () => {
  it('a truncated result: warn log line and an errors entry saying "exported N of M rows"', async () => {
    const logs: string[] = [];
    const r = await runScheduledSheets(db, 'T', {
      exportToSheets: async () => ({ spreadsheetUrl: 'https://s/1', rowsWritten: 900_000, totalRows: 1_200_000, truncated: true }),
      log: (level, m) => logs.push(`${level}: ${m}`),
    });
    expect(r.sheetsUrl).toBe('https://s/1');
    expect(r.errors).toEqual([expect.stringMatching(/^sheets: exported 900000 of 1200000 rows/)]);
    expect(logs.some((l) => l.startsWith('warn:') && /exported 900000 of 1200000 rows/.test(l))).toBe(true);
  });

  it('a complete result has no errors entry; a failure is one entry with its message', async () => {
    const ok = await runScheduledSheets(db, 'T', {
      exportToSheets: async () => ({ spreadsheetUrl: 'https://s/1', rowsWritten: 5, totalRows: 5, truncated: false }),
      log: () => {},
    });
    expect(ok.errors).toEqual([]);
    const bad = await runScheduledSheets(db, 'T', {
      exportToSheets: async () => {
        throw new Error('Sheets create failed: HTTP 500');
      },
      log: () => {},
    });
    expect(bad.sheetsUrl).toBeNull();
    expect(bad.errors).toEqual(['sheets: Sheets create failed: HTTP 500']);
  });
});
