import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ProjectDb } from '@freecrawl/db';
import { buildCrawlSnapshot } from '@freecrawl/core';

// Drives the built CLI as a process (`npx tsc -b && npm run build:cli` first).
const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dist/index.js');
const run = (args: string[]) =>
  spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', timeout: 30000 });

let dir: string;
let project: string;
let empty: string;
const START = 'https://example.test/';

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-history-'));
  project = path.join(dir, 'p.seoproject');
  empty = path.join(dir, 'e.seoproject');
  const db = new ProjectDb(project);
  // The desktop stores the typed start URL; rows hold the resolved one. The
  // default site is the newest row's, so the typed form must not matter.
  db.setMeta('lastStartUrl', 'site.test');
  const base = buildCrawlSnapshot(db);
  db.appendCrawlRun({ finishedAt: '2025-12-01T00:00:00.000Z', startUrl: 'https://other.test/', mode: 'spider', durationMs: 1, toolVersion: null, snapshot: base });
  const times = ['2026-01-01T00:00:00.000Z', '2026-02-01T00:00:00.000Z', '2026-03-01T00:00:00.000Z'];
  times.forEach((finishedAt, i) => {
    const snapshot = structuredClone(base);
    snapshot.counts.indexability.indexable = 10 + i;
    snapshot.disabledChecks = ['issues:h1-missing' as never];
    snapshot.summary.byStatus = { '200': 5, ...(i > 0 ? { '404': i } : {}) };
    db.appendCrawlRun({ finishedAt, startUrl: START, mode: 'spider', durationMs: 1, toolVersion: null, snapshot });
  });
  db.close();
  new ProjectDb(empty).close();
});
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('history', () => {
  it('JSON: rows oldest first with the chosen metrics, other start URLs excluded', () => {
    const r = run(['history', '--project', project, '--metrics', 'indexable,status.404', '--json']);
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.ok).toBe(true);
    expect(out.runs).toEqual([
      { finishedAt: '2026-01-01T00:00:00.000Z', indexable: 10, 'status.404': 0 },
      { finishedAt: '2026-02-01T00:00:00.000Z', indexable: 11, 'status.404': 1 },
      { finishedAt: '2026-03-01T00:00:00.000Z', indexable: 12, 'status.404': 2 },
    ]);
  });
  it('CSV by default with a header; not computed is an empty cell, null in JSON', () => {
    const r = run(['history', '--project', project, '--metrics', 'indexable,issues:h1-missing', '--limit', '2']);
    expect(r.status).toBe(0);
    expect(r.stdout.trim().split('\n')).toEqual([
      'finishedAt,indexable,issues:h1-missing',
      '2026-02-01T00:00:00.000Z,11,',
      '2026-03-01T00:00:00.000Z,12,',
    ]);
    const j = run(['history', '--project', project, '--metrics', 'issues:h1-missing', '--limit', '1', '--json']);
    expect(JSON.parse(j.stdout).runs[0]['issues:h1-missing']).toBeNull();
  });
  it('--start-url picks another site', () => {
    const r = run(['history', '--project', project, '--metrics', 'indexable', '--start-url', 'https://other.test/', '--json']);
    expect(JSON.parse(r.stdout).runs).toHaveLength(1);
  });
  it('project without rows: exit 0, empty list', () => {
    const j = run(['history', '--project', empty, '--metrics', 'indexable', '--json']);
    expect(j.status).toBe(0);
    expect(JSON.parse(j.stdout).runs).toEqual([]);
    expect(run(['history', '--project', empty, '--metrics', 'indexable']).stdout.trim()).toBe('finishedAt,indexable');
  });
  it('bad arguments exit 2, JSON error with --json', () => {
    const bad = run(['history', '--project', project, '--metrics', 'nope', '--json']);
    expect(bad.status).toBe(2);
    expect(JSON.parse(bad.stdout).ok).toBe(false);
    expect(JSON.parse(bad.stdout).error).toContain('indexable');
    expect(run(['history', '--project', project]).status).toBe(2);
    expect(run(['history', '--metrics', 'indexable']).status).toBe(2);
    expect(run(['history', '--project', project, '--metrics', 'indexable', '--limit', 'x']).status).toBe(2);
    expect(run(['history', '--project', path.join(dir, 'missing'), '--metrics', 'indexable']).status).toBe(2);
  });
  it('the status.<code> placeholder is not a metric: exit 2, no stack trace', () => {
    const r = run(['history', '--project', project, '--metrics', 'status.<code>', '--json']);
    expect(r.status).toBe(2);
    expect(JSON.parse(r.stdout)).toMatchObject({ ok: false });
    expect(JSON.parse(r.stdout).error).toContain('Unknown metric: status.<code>');
    const t = run(['history', '--project', project, '--metrics', 'indexable,status.<code>']);
    expect(t.status).toBe(2);
    expect(t.stderr).not.toContain('    at ');
  });
});
