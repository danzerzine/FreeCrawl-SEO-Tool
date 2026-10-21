import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ProjectDb } from '@freecrawl/db';
import { COMPARE_CATEGORIES } from '@freecrawl/shared-types';

// Drives the built CLI as a process (`npx tsc -b` first).
const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dist/index.js');
const run = (args: string[]) =>
  spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', timeout: 60000 });

const MANY = 5100; // more pages with a changed depth than the 5000 samples kept per kind
const TITLE_BEFORE = 'plain';
const TITLE_AFTER = 'He said "hi", ok\nnext line';
let dir: string;
let before: string;
let after: string;
let same: string;

function project(name: string, rows: { title: string; depth: number }[]): string {
  const file = path.join(dir, name);
  new ProjectDb(file).close();
  const raw = new DatabaseSync(file);
  raw.exec('BEGIN');
  const ins = raw.prepare(
    `INSERT INTO urls (id, url, is_external, content_kind, status_code, indexability, title, h1, depth)
     VALUES (?, ?, 0, 'html', 200, 'indexable', ?, 'H', ?)`,
  );
  rows.forEach((r, i) => ins.run(i + 1, `https://ex.com/p${i + 1}`, r.title, r.depth));
  raw.exec('COMMIT');
  raw.close();
  return file;
}

/** RFC 4180 reader, enough for the files under test. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(cell);
      cell = '';
    } else if (c === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += c;
  }
  return rows;
}

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-cmp-cli-'));
  const rowsBefore = Array.from({ length: MANY }, () => ({ title: TITLE_BEFORE, depth: 1 }));
  const rowsAfter = rowsBefore.map((r, i) => ({ title: i === 0 ? TITLE_AFTER : r.title, depth: 2 }));
  before = project('before.seoproject', rowsBefore);
  after = project('after.seoproject', rowsAfter);
  same = project('same.seoproject', rowsBefore);
});
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('freecrawl compare --json / --out (B22)', () => {
  it('--json prints the summary with every kind, issueChanges and notComparable; exit 1 on changes', () => {
    const r = run(['compare', before, after, '--json']);
    expect(r.status).toBe(1);
    const out = JSON.parse(r.stdout);
    expect(out.ok).toBe(true);
    expect(Object.keys(out.counts)).toEqual([...COMPARE_CATEGORIES]);
    expect(out.counts.depth).toBe(MANY);
    expect(out.counts.title).toBe(1);
    expect(out.issueChanges).toBeTypeOf('object');
    expect(out.notComparable).toBeTypeOf('object');
    expect(out.totalA).toBe(MANY);
    expect(out.samples.filter((s: { category: string }) => s.category === 'depth')).toHaveLength(5000);
  });

  it('exit 0 and ok when nothing changed', () => {
    const r = run(['compare', before, same, '--json']);
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout).counts.depth).toBe(0);
  });

  it('--out writes compare-summary.json and one CSV per kind with every row', () => {
    const out = path.join(dir, 'out');
    const r = run(['compare', before, after, '--out', out]);
    expect(r.status).toBe(1);
    const summary = JSON.parse(fs.readFileSync(path.join(out, 'compare-summary.json'), 'utf8'));
    expect(summary.counts.depth).toBe(MANY);
    for (const kind of COMPARE_CATEGORIES) {
      expect(fs.existsSync(path.join(out, `compare-${kind}.csv`)), kind).toBe(true);
    }
    const depth = parseCsv(fs.readFileSync(path.join(out, 'compare-depth.csv'), 'utf8'));
    expect(depth[0]).toEqual(['url', 'before', 'after']);
    expect(depth).toHaveLength(MANY + 1);
    expect(depth[1]).toEqual(['https://ex.com/p1', '1', '2']);
    const title = parseCsv(fs.readFileSync(path.join(out, 'compare-title.csv'), 'utf8'));
    expect(title).toEqual([
      ['url', 'before', 'after'],
      ['https://ex.com/p1', TITLE_BEFORE, TITLE_AFTER],
    ]);
  });

  it('a file that is not a project is exit 2, as JSON with --json', () => {
    const junk = path.join(dir, 'junk.seoproject');
    fs.writeFileSync(junk, 'hello');
    const r = run(['compare', junk, after, '--json']);
    expect(r.status).toBe(2);
    expect(JSON.parse(r.stdout)).toMatchObject({ ok: false });
  });
});
