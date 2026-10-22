import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { ProjectDb } from '@freecrawl/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Streaming check (audit item 12): the peak memory of the generator must not
// grow with the number of URLs. Each run is a fresh child process, so
// `maxRSS` is that run's own high-water mark. Needs `npx tsc -b` first.
const CHILD = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'sitemap-memory-child-b61.mjs');
const N = 50_000;
/**
 * MB. The old array-based generator grew 140-240 MB between N and 4N with default V8 settings and about
 * 1100 MB with the semi-space cap below; the streaming one grows 0-35 MB. The bar sits between, under 25%
 * of the smallest old growth.
 */
const BAR_MB = 50;
/** Peak memory moves by tens of MB with garbage-collection timing: each size runs this often, the median counts. */
const RUNS = 3;
/** A small young generation keeps short-lived garbage from piling up and moving the peak with GC timing (also under load). */
const NODE_FLAGS = ['--max-semi-space-size=2'];

let dir: string;

/** `count` realistic indexable pages: 60-char title, 155-char description, 2 headers, a sitemap lastmod. */
function buildProject(file: string, count: number): void {
  new ProjectDb(file).close();
  const raw = new DatabaseSync(file);
  const url = raw.prepare(
    `INSERT INTO urls (id, url, status_code, indexability, depth, title, meta_description, h1, crawled_at)
     VALUES (?, ?, 200, 'indexable', ?, ?, ?, ?, '2026-10-20 10:00:00')`,
  );
  const hdr = raw.prepare('INSERT INTO headers (url_id, name, value) VALUES (?, ?, ?)');
  const sm = raw.prepare('INSERT INTO sitemap_urls (url, lastmod, source_sitemap) VALUES (?, ?, ?)');
  raw.exec('BEGIN');
  for (let i = 1; i <= count; i++) {
    const u = `https://example.com/section-${i % 97}/article-number-${i}`;
    const title = `Article ${i}: a realistic page title of about sixty chars`.padEnd(60, '.');
    const desc = `Meta description of article ${i}, written to be roughly as long as a real one is in practice.`.padEnd(155, ' x');
    url.run(i, u, i % 6, title, desc, title);
    hdr.run(i, 'last-modified', 'Wed, 01 Jul 2026 08:00:00 GMT');
    hdr.run(i, 'date', 'Tue, 20 Oct 2026 10:00:00 GMT');
    sm.run(u, '2026-06-30', 'https://example.com/sitemap.xml');
  }
  raw.exec('COMMIT');
  raw.close();
}

function peakMb(count: number): number {
  const file = path.join(dir, `p${count}.seoproject`);
  buildProject(file, count);
  const peaks: number[] = [];
  for (let i = 0; i < RUNS; i++) {
    const r = spawnSync(process.execPath, [...NODE_FLAGS, CHILD, file, path.join(dir, `out${count}.xml`)], {
      encoding: 'utf8',
      timeout: 300_000,
    });
    if (r.status !== 0) throw new Error(`child failed: ${r.stderr}`);
    const j = JSON.parse(r.stdout) as { urlsWritten: number; maxRssMb: number };
    expect(j.urlsWritten).toBe(count);
    peaks.push(j.maxRssMb);
  }
  return peaks.sort((a, b) => a - b)[Math.floor(RUNS / 2)]!;
}

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-b61mem-'));
});
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('B61 sitemap export memory', () => {
  it(`peak(4N) - peak(N) stays under ${BAR_MB} MB (N = ${N}, median of ${RUNS} runs)`, () => {
    const small = peakMb(N);
    const big = peakMb(4 * N);
    console.log(`B61 memory: N=${N} peak=${small} MB, 4N=${4 * N} peak=${big} MB, growth=${big - small} MB`);
    expect(big - small).toBeLessThan(BAR_MB);
  }, 900_000);
});
