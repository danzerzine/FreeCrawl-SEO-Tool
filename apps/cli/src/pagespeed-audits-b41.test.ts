import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ProjectDb, runMigrations } from '@freecrawl/db';

// Drives the built CLI as a process (`npx tsc -b && npm run build:cli` first).
const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dist/index.js');
const A = 'https://ex.test/a';

let dir: string;
let withAudits: string;
let without: string;
beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-b41cli-'));
  const make = (name: string) => {
    const file = path.join(dir, name);
    const raw = new DatabaseSync(file);
    runMigrations(raw);
    raw.exec(`INSERT INTO urls (id, url, is_external, content_kind, status_code) VALUES (1,'${A}',0,'html',200)`);
    raw.close();
    return file;
  };
  withAudits = make('with.seoproject');
  without = make('without.seoproject');
  const db = new ProjectDb(withAudits);
  db.upsertPagespeedResult(
    A,
    'mobile',
    { performance: 70, lcp: 1, cls: 0, fcp: 1, tbt: 1, speedIndex: 1, tti: 1, maxPotentialFid: 1, inp: null, status: 'ok', error: null, fetchedAt: '2026-10-23T10:00:00.000Z' },
    { lighthouseVersion: '13.5.0', audits: [{ auditId: 'unused-javascript', kind: 'diagnostic', title: 'Reduce unused JavaScript', score: 0, displayValue: 'Est savings of 92 KiB', savingsMs: 580, savingsBytes: 94194, items: [{ url: 'https://ex.test/a.js', wastedBytes: 94194 }], itemsTruncated: false }] },
  );
  db.close();
});
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

const run = (project: string, out: string, what: string) =>
  spawnSync(process.execPath, [CLI, 'export', '--project', project, '--out', out, '--json', '--what', what], { encoding: 'utf8', timeout: 30000 });

describe('B41 R9: export --what dataset:pagespeed-audits (the CLI as a process)', () => {
  it('writes pagespeed-audits.csv with a header and one row per audit', () => {
    const out = path.join(dir, 'out1');
    const r = run(withAudits, out, 'dataset:pagespeed-audits');
    expect(r.status, r.stderr).toBe(0);
    const lines = fs.readFileSync(path.join(out, 'pagespeed-audits.csv'), 'utf8').replace(/^\uFEFF/, '').split('\n').filter(Boolean);
    expect(lines[0]).toBe('URL,Strategy,Audit,Kind,Title,Score,Display Value,Savings (ms),Savings (bytes),Resources Count,Resources JSON,Lighthouse Version,Fetched At');
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain('unused-javascript');
    expect(lines[1]).toContain('94194');
  });

  it('a project with no stored audits writes no file and says why', () => {
    const out = path.join(dir, 'out2');
    const r = run(without, out, 'dataset:pagespeed-audits');
    const j = JSON.parse(r.stdout) as { errors: { label: string; error: string }[] };
    expect(fs.existsSync(path.join(out, 'pagespeed-audits.csv'))).toBe(false);
    // Nothing stored: reason in errors, exit 1 (as the CLI help says for datasets in this state).
    expect(r.status).toBe(1);
    expect(j.errors[0]).toMatchObject({ label: 'dataset:pagespeed-audits' });
    expect(j.errors[0]!.error).toMatch(/No Lighthouse audits are stored/);
  });

  it('the help names the dataset', () => {
    const r = spawnSync(process.execPath, [CLI, '--help'], { encoding: 'utf8' });
    expect(r.stdout + r.stderr).toContain('pagespeed-audits');
  });
});
