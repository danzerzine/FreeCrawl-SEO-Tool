import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ProjectDb } from '@freecrawl/db';
import { EXPORT_DATASET_COLUMNS } from '@freecrawl/shared-types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { datasetRows, readCell } from './dataset-export.js';
import { CLI_EXPORT_DATASETS } from './export-items.js';

const A = 'https://ex.test/a';
const B = 'https://ex.test/b';

let dir: string;
let db: ProjectDb;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-b86x-'));
  const file = path.join(dir, 'p.seoproject');
  new ProjectDb(file).close();
  const raw = new DatabaseSync(file);
  raw.exec(`INSERT INTO urls (id, url, is_external, content_kind, status_code) VALUES (1,'${A}',0,'html',200),(2,'${B}',0,'html',200)`);
  raw.close();
  db = new ProjectDb(file);
  db.upsertAiResult(A, 'gemini', 'gemini-2.5-flash', 'g answer', 7, 3, 'ok', null, '2026-10-23T10:00:00Z');
  db.upsertAiResult(B, 'gemini', 'gemini-2.5-flash', '', null, null, 'error', 'The model returned an empty reply', '2026-10-23T10:00:01Z');
  db.upsertAiResult(A, 'openai-compatible', 'local', 'c answer', 1, 2, 'ok', null, '2026-10-23T10:00:02Z');
});
afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const tail = ['Model', 'Response', 'Tokens In', 'Tokens Out', 'Result Status', 'Error', 'Fetched At'];

describe('B86 datasets ai:gemini and ai:openai-compatible', () => {
  it.each(['ai:gemini', 'ai:openai-compatible'] as const)('%s is a CLI dataset with the ai column list', (key) => {
    expect(CLI_EXPORT_DATASETS).toContain(key);
    const headers = EXPORT_DATASET_COLUMNS[key].map((c) => c.header);
    expect(headers.slice(-7)).toEqual(tail);
    expect(headers).toEqual(EXPORT_DATASET_COLUMNS['ai:openai'].map((c) => c.header));
  });

  it('ai:gemini rows are emitted as queryAi returns them (newest first), unsorted by the test, with the error row', () => {
    const cols = EXPORT_DATASET_COLUMNS['ai:gemini'];
    const rows = [...datasetRows(db, 'ai:gemini', {})].map((r) => cols.map((c) => readCell(r, c.key)));
    const col = (h: string) => cols.findIndex((c) => c.header === h);
    expect(rows.map((r) => r[col('URL')])).toEqual([B, A]);
    expect(rows.map((r) => r[col('Result Status')])).toEqual(['error', 'ok']);
    expect(rows.map((r) => r[col('Response')])).toEqual(['', 'g answer']);
    expect(rows[0]![col('Error')]).toBe('The model returned an empty reply');
    expect(rows[1]![col('Tokens In')]).toBe(7);
  });

  it('ai:openai-compatible exports only its own provider rows', () => {
    const cols = EXPORT_DATASET_COLUMNS['ai:openai-compatible'];
    const rows = [...datasetRows(db, 'ai:openai-compatible', {})].map((r) => cols.map((c) => readCell(r, c.key)));
    const col = (h: string) => cols.findIndex((c) => c.header === h);
    expect(rows.map((r) => r[col('Response')])).toEqual(['c answer', null]);
  });
});
