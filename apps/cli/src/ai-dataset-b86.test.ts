import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ProjectDb } from '@freecrawl/db';

// Drives the built CLI as a process (`npx tsc -b && npm run build:cli` first).
const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dist/index.js');
let dir: string;
let project: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-b86c-'));
  project = path.join(dir, 'p.seoproject');
  new ProjectDb(project).close();
  const raw = new DatabaseSync(project);
  raw.exec(`INSERT INTO urls (id, url, is_external, content_kind, status_code) VALUES
    (1,'https://ex.test/a',0,'html',200),(2,'https://ex.test/b',0,'html',200)`);
  raw.close();
  const db = new ProjectDb(project);
  db.upsertAiResult('https://ex.test/a', 'gemini', 'gemini-2.5-flash', 'hello', 7, 3, 'ok', null, '2026-10-23T10:00:00Z');
  db.upsertAiResult('https://ex.test/b', 'gemini', 'gemini-2.5-flash', '', null, null, 'error', 'boom', '2026-10-23T10:00:01Z');
  db.close();
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('B86 CLI export of dataset:ai:gemini', () => {
  it('writes the file and the manifest lists it with rows, ms and peakRssMb', () => {
    const out = path.join(dir, 'out');
    const r = spawnSync(process.execPath, [CLI, 'export', '--project', project, '--out', out, '--what', 'dataset:ai:gemini'], {
      encoding: 'utf8',
      timeout: 30000,
    });
    expect(r.status, r.stderr).toBe(0);
    const m = JSON.parse(fs.readFileSync(path.join(out, 'manifest.json'), 'utf8')) as {
      what: string[];
      files: { path: string; rows: number | null; ms: number; peakRssMb: number }[];
      errors: unknown[];
    };
    expect(m.what).toEqual(['dataset:ai:gemini']);
    expect(m.files).toHaveLength(1);
    expect(m.files[0]!.path).toMatch(/ai.*gemini.*\.csv$/);
    expect(m.files[0]!.rows).toBe(2);
    expect(Number.isInteger(m.files[0]!.ms)).toBe(true);
    expect(Number.isInteger(m.files[0]!.peakRssMb)).toBe(true);
    expect(m.errors).toEqual([]);
    const csv = fs.readFileSync(path.join(out, m.files[0]!.path), 'utf8').split('\n');
    expect(csv[0]).toMatch(/Model,Response,Tokens In,Tokens Out,Result Status,Error,Fetched At$/);
    // newest first, as for the other ai datasets
    expect(csv[1]).toContain('https://ex.test/b');
    expect(csv[1]).toContain('boom');
    expect(csv[2]).toContain('https://ex.test/a');
    expect(fs.existsSync(path.join(out, 'manifest.json.part'))).toBe(false);
  });
});
