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
let out: string;

function seed(inlinks: boolean): void {
  project = path.join(dir, 'p.seoproject');
  new ProjectDb(project).close();
  const raw = new DatabaseSync(project);
  if (inlinks) raw.exec("INSERT INTO project_meta (key, value) VALUES ('inlinksComputed', '1')");
  raw.exec(`
    INSERT INTO urls (id, url, is_external, content_kind, status_code, indexability, title, outlinks) VALUES
      (1, 'https://ex.test/a', 0, 'html', 200, 'indexable', 'Espresso machine guide', 10),
      (2, 'https://ex.test/b', 0, 'html', 200, 'indexable', 'Espresso machine care', 10),
      (3, 'https://ex.test/c', 0, 'html', 200, 'indexable', 'Zebra migration patterns', 10);
  `);
  raw.close();
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'fc-b93c-'));
  out = path.join(dir, 'd');
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

function run(...args: string[]) {
  return spawnSync(process.execPath, [CLI, 'export', '--project', project, ...args], {
    encoding: 'utf8',
    timeout: 60000,
  });
}

describe('B93 CLI: dataset:link-suggestions', () => {
  it('writes link-suggestions.csv with the header and honours the flags', () => {
    seed(true);
    const r = run('--what', 'dataset:link-suggestions', '--per-target', '1', '--min-closeness', '10', '--out', out);
    expect(r.status, r.stderr).toBe(0);
    const lines = fs.readFileSync(path.join(out, 'link-suggestions.csv'), 'utf8').replace(/^﻿/, '').trimEnd().split('\n');
    expect(lines[0]).toBe(
      'Target URL,Target Title,Target Inlinks,Target Content Inlinks,Target Link Score,Rank,Source URL,Source Title,Closeness %,Source Link Score,Source Outlinks,Same Section,Suggested Anchor',
    );
    expect(lines.length).toBe(4);
  });

  it('a cut at --max-targets is not a warning: only the time budget makes a result truncated', () => {
    seed(true);
    const r = run('--what', 'dataset:link-suggestions', '--max-targets', '1', '--out', out);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).not.toMatch(/truncated/);
  });

  it.each([
    ['--per-target', '0'],
    ['--max-inlinks', '99'],
    ['--min-closeness', '-1'],
    ['--per-source', 'abc'],
    ['--max-targets', '0'],
    ['--max-source-outlinks', 'x'],
  ])('%s %s exits 2', (flag, value) => {
    seed(true);
    const r = run('--what', 'dataset:link-suggestions', flag, value, '--out', out);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain(flag);
  });

  it('help lists the flags', () => {
    const r = spawnSync(process.execPath, [CLI, '--help'], { encoding: 'utf8' });
    for (const f of ['--max-inlinks', '--per-target', '--per-source', '--min-closeness', '--max-targets', '--max-source-outlinks']) {
      expect(r.stdout + r.stderr).toContain(f);
    }
  });

  it('a project without the inlink pass fails with the report message and writes no file', () => {
    seed(false);
    const r = run('--what', 'dataset:link-suggestions', '--out', out);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('Link suggestions: the crawl did not compute inlinks (run a crawl with link analysis on)');
    expect(fs.existsSync(path.join(out, 'link-suggestions.csv'))).toBe(false);
  });
});
