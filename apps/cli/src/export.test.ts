import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ProjectDb, detectProjectFormat, packProject } from '@freecrawl/db';
import { killAllChildren, killChild, spawnTracked, waitFor } from './test-proc.js';

// Drives the built CLI as a process (`npx tsc -b && npm run build:cli` first).
const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dist/index.js');

let dir: string;
let server: http.Server;
let base: string;
let project: string;

// Rows added for the Ctrl-C test: enough that the bulk export takes seconds.
const BIG_ROWS = 200_000;

// Twelve pages: odd ones lack a title, every third lacks a meta description,
// even ones lack an H1, none has a canonical; /old redirects to /p/1 and
// /gone is a 404 that the home page links to.
function page(i: number): string {
  const title = i % 2 === 1 ? '' : `<title>Page ${i} of the fixture site</title>`;
  const meta = i % 3 === 0 ? '' : '<meta name="description" content="A fixture page.">';
  const h1 = i % 2 === 0 ? '' : `<h1>Heading ${i}</h1>`;
  const links = Array.from({ length: 12 }, (_, k) => `<a href="/p/${k}">p${k}</a>`).join('');
  return `<html><head>${title}${meta}</head><body>${h1}<img src="/i.png">${links}` +
    '<a href="/old">old</a><a href="/gone">gone</a></body></html>';
}

function run(args: string[], timeout = 30000) {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', timeout });
}

function runAsync(args: string[]): Promise<number | null> {
  const child = spawnTracked(process.execPath, [CLI, ...args], { stdio: 'ignore' });
  return new Promise((r) => child.on('exit', (c) => r(c)));
}

// The fixture project plus BIG_ROWS copies of one page, built on first use so a
// lone `-t` run of either Ctrl-C test works.
let bigPath: string | undefined;
function bigProject(): string {
  if (bigPath) return bigPath;
  const big = path.join(dir, 'big.seoproject');
  fs.copyFileSync(project, big);
  const raw = new DatabaseSync(big);
  const cols = (raw.prepare('PRAGMA table_info(urls)').all() as { name: string }[])
    .map((c) => c.name)
    .filter((c) => c !== 'id' && c !== 'url');
  raw.exec(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${BIG_ROWS})
    INSERT INTO urls (url, ${cols.join(', ')})
    SELECT u.url || '?copy=' || n.i, ${cols.map((c) => `u.${c}`).join(', ')}
      FROM n JOIN (SELECT * FROM urls WHERE content_kind = 'html' LIMIT 1) u`);
  raw.close();
  bigPath = big;
  return big;
}

function csvRows(file: string): number {
  const text = fs.readFileSync(file, 'utf8');
  // Data rows only: the fixture has no newline inside a cell.
  return text.split('\n').filter((l) => l.length > 0).length - 1;
}

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-export-'));
  server = http.createServer((req, res) => {
    const url = req.url ?? '/';
    if (url === '/old') {
      res.writeHead(301, { location: '/p/1' });
      res.end();
      return;
    }
    if (url === '/gone') {
      res.writeHead(404, { 'content-type': 'text/html' });
      res.end('<html><head><title>Not found here</title></head><body></body></html>');
      return;
    }
    if (url === '/i.png') {
      res.writeHead(200, { 'content-type': 'image/png' });
      res.end(Buffer.alloc(10));
      return;
    }
    const m = /^\/p\/(\d+)$/.exec(url);
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(page(m ? Number(m[1]) : 0));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  project = path.join(dir, 'site.seoproject');
  // Async: the fixture server lives in this process, so it must keep serving.
  const code = await runAsync([base, '--no-robots', '--db', project, '--json']);
  // Exit 1 is expected: the fixture links a 404.
  if (code !== 1 || !fs.existsSync(project)) throw new Error(`fixture crawl exited ${code}`);
}, 90000);

afterAll(async () => {
  killAllChildren();
  await new Promise((r) => server.close(r));
  fs.rmSync(dir, { recursive: true, force: true });
});

function walk(d: string): string[] {
  return fs.readdirSync(d, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)],
  );
}

describe('freecrawl export', () => {
  it('bulk writes one CSV per category whose rows match the overview counts', () => {
    const out = path.join(dir, 'bulk-out', 'nested');
    const r = run(['export', '--project', project, '--out', out, '--json']);
    expect(r.status, r.stderr).toBe(0);
    const summary = JSON.parse(r.stdout) as {
      ok: boolean;
      files: { path: string; label: string; rows: number }[];
      errors: unknown[];
    };
    expect(summary.ok).toBe(true);
    expect(summary.errors).toEqual([]);

    const db = new ProjectDb(project);
    const issues = db.getOverviewCounts().issues;
    db.close();
    const expected: [string, number | null][] = [
      ['issues-title-missing.csv', issues.titleMissing],
      ['issues-meta-missing.csv', issues.metaMissing],
      ['issues-h1-missing.csv', issues.h1Missing],
      ['issues-canonical-missing.csv', issues.canonicalMissing],
      ['image-missing-alt.csv', issues.imageMissingAlt],
    ];
    for (const [file, count] of expected) {
      expect(count, file).toBeGreaterThan(0);
      expect(csvRows(path.join(out, file)), file).toBe(count);
      const listed = summary.files.find((f) => path.basename(f.path) === file);
      expect(listed?.rows, file).toBe(count);
    }
    expect(fs.existsSync(path.join(out, 'links-internal.csv'))).toBe(true);
    expect(csvRows(path.join(out, 'broken-links.csv'))).toBeGreaterThan(0);
    expect(walk(out).filter((f) => f.endsWith('.csv.csv'))).toEqual([]);
    expect(walk(out).filter((f) => f.endsWith('.part'))).toEqual([]);
  });

  it.each([
    [['--what', 'bulk,pdf'], 'Unknown --what entry: pdf'],
    [['--what', 'tab:nope'], 'tab:redirects'],
    [['--what', 'issues:nope'], 'issues:title-missing'],
  ])('%j exits 2 with a JSON error naming the valid keys', (extra, needle) => {
    const out = path.join(dir, 'bad-what');
    const r = run(['export', '--project', project, '--out', out, '--json', ...extra]);
    expect(r.status).toBe(2);
    const j = JSON.parse(r.stdout) as { ok: boolean; error: string; files: unknown[] };
    expect(j.ok).toBe(false);
    expect(j.error).toContain(needle);
    expect(j.files).toEqual([]);
    expect(fs.existsSync(out)).toBe(false);
  });

  it('--out that is a file, a missing --out and a missing project exit 2 with JSON', () => {
    const file = path.join(dir, 'a-file.txt');
    fs.writeFileSync(file, 'x');
    for (const args of [
      ['--project', project, '--out', file],
      ['--project', project],
      ['--project', path.join(dir, 'missing.seoproject'), '--out', path.join(dir, 'm-out')],
    ]) {
      const r = run(['export', ...args, '--json']);
      expect(r.status, args.join(' ')).toBe(2);
      expect((JSON.parse(r.stdout) as { ok: boolean }).ok).toBe(false);
    }
    expect(fs.existsSync(path.join(dir, 'missing.seoproject'))).toBe(false);
  });

  it('an unknown option or a missing option value exits 2 with a JSON error and no stack', () => {
    for (const args of [
      ['--project', project, '--out', path.join(dir, 'x-out'), '--bogus'],
      ['--project', project, '--out'],
    ]) {
      const r = run(['export', '--json', ...args]);
      expect(r.status, args.join(' ')).toBe(2);
      const j = JSON.parse(r.stdout) as { ok: boolean; error: string };
      expect(j.ok).toBe(false);
      expect(j.error).toMatch(/--bogus|--out/);
      expect(r.stderr).not.toMatch(/\n\s+at /);
    }
    const plain = run(['export', '--project', project, '--bogus']);
    expect(plain.status).toBe(2);
    expect(plain.stdout).toBe('');
    expect(plain.stderr).toContain('--bogus');
    expect(plain.stderr).not.toMatch(/\n\s+at /);
  });

  it('a --save-set whose project cannot be written back exits 2 with a JSON error', async () => {
    const archive = path.join(dir, 'unsavable.seoproject');
    await packProject(project, archive);
    // The repack writes <project>.part first: a folder there makes it fail.
    fs.mkdirSync(`${archive}.part`);
    const r = run(['export', '--project', archive, '--save-set', 'x', '--what', 'issues', '--json']);
    fs.rmSync(`${archive}.part`, { recursive: true });
    expect(r.status).toBe(2);
    const j = JSON.parse(r.stdout) as { ok: boolean; error: string };
    expect(j.ok).toBe(false);
    expect(j.error).toContain(archive);
    expect(r.stderr).not.toMatch(/\n\s+at /);
  });

  it('every run writes one manifest.json listing every file the run wrote', () => {
    const out = path.join(dir, 'manifest-out');
    const r = run(['export', '--project', project, '--out', out, '--json', '--what',
      'bulk,issues,error-inlinks,redirects-to-error']);
    expect(r.status, r.stderr).toBe(0);
    const j = JSON.parse(r.stdout) as { files: { path: string; label: string; rows: number | null }[] };
    const m = JSON.parse(fs.readFileSync(path.join(out, 'manifest.json'), 'utf8')) as {
      toolVersion: string | null;
      projectFile: string | null;
      what: string[];
      files: { path: string; label: string; rows: number | null; ms?: number; peakRssMb?: number; sharedPass?: boolean }[];
      errors: unknown[];
      skipped: { label: string; reason: string }[];
    };
    expect(m.what).toEqual(['bulk', 'issues', 'error-inlinks', 'redirects-to-error']);
    expect(m.projectFile).toBe(project);
    expect(m.toolVersion).toBeTruthy();
    // B94: the manifest adds each file's write time; stdout keeps its shape.
    expect(j.files.every((f) => !('ms' in f) && !('peakRssMb' in f) && !('sharedPass' in f))).toBe(true);
    expect(m.files.every((f) => Number.isInteger(f.peakRssMb))).toBe(true);
    expect(m.files.every((f) => Number.isInteger(f.ms))).toBe(true);
    expect(m.files.map(({ ms: _ms, peakRssMb: _mb, sharedPass: _sp, ...f }) => f)).toEqual(
      j.files.map((f) => ({ path: path.relative(out, f.path).split(path.sep).join('/'), label: f.label, rows: f.rows })),
    );
    const listed = m.files.map((f) => f.path);
    expect(listed).toContain('issues-summary.csv');
    expect(listed).toContain('error-inlinks.csv');
    expect(listed).toContain('issues-title-missing.csv');
    // The bulk dump skips the sitemap table of a crawl that read no sitemap (B61).
    expect(m.skipped.map((s) => s.label)).toEqual([
      'Sitemap URLs',
      'Sitemap vs Crawl',
      'Internal Links — Redirects to Error',
    ]);
    // Sitemap URLs is empty and says why; the fixture does hold a sitemap-files row (the failed probe), so that file is written.
    expect(m.skipped[0]!.reason).toMatch(/no sitemap urls are stored/i);
    expect(m.errors).toEqual([]);
    expect(fs.existsSync(path.join(out, 'manifest.json.part'))).toBe(false);
  });

  it('tab:<key> writes only that category, overwriting an old file and keeping others', () => {
    const out = path.join(dir, 'one-tab');
    fs.mkdirSync(out);
    fs.writeFileSync(path.join(out, 'all-redirects.csv'), 'stale');
    fs.writeFileSync(path.join(out, 'mine.txt'), 'keep me');
    const r = run(['export', '--project', project, '--out', out, '--what', 'tab:redirects', '--json']);
    expect(r.status, r.stderr).toBe(0);
    expect(fs.readdirSync(out).sort()).toEqual(['all-redirects.csv', 'manifest.json', 'mine.txt']);
    expect(csvRows(path.join(out, 'all-redirects.csv'))).toBe(1);
    expect(fs.readFileSync(path.join(out, 'mine.txt'), 'utf8')).toBe('keep me');
  });

  it('seo-audit, html and issues write their files', () => {
    const out = path.join(dir, 'three');
    const r = run(['export', '--project', project, '--out', out, '--what', 'seo-audit,html,issues', '--json']);
    expect(r.status, r.stderr).toBe(0);
    expect(fs.existsSync(path.join(out, 'seo-audit', 'internal_all.csv'))).toBe(true);
    expect(fs.readFileSync(path.join(out, 'report.html'), 'utf8')).toContain('</html>');
    const summary = fs.readFileSync(path.join(out, 'issues-summary.csv'), 'utf8');
    const db = new ProjectDb(project);
    const titleMissing = db.getOverviewCounts().issues.titleMissing;
    db.close();
    expect(summary).toContain(`issues:title-missing,Missing,Page Titles,critical,${titleMissing}`);
    expect(walk(out).filter((f) => f.endsWith('.part'))).toEqual([]);
  });

  it('writes the four link-target reports, one row per target', () => {
    const out = path.join(dir, 'links');
    const r = run(['export', '--project', project, '--out', out, '--json', '--what',
      'redirects-to-error,error-inlinks,non-indexable-inlinks,redirect-inlinks']);
    expect(r.status, r.stdout).toBe(0);
    const err = fs.readFileSync(path.join(out, 'error-inlinks.csv'), 'utf8');
    expect(err).toContain(`${base}gone,404`);
    expect(csvRows(path.join(out, 'error-inlinks.csv'))).toBe(1);
    expect(csvRows(path.join(out, 'redirect-inlinks.csv'))).toBe(1);
    // /old ends on a 200, so no redirect ends in an error: no file.
    expect(fs.existsSync(path.join(out, 'redirects-to-error.csv'))).toBe(false);
    expect(csvRows(path.join(out, 'non-indexable-inlinks.csv'))).toBe(2);
  });

  it('an empty link report or dataset is listed under skipped, not as a file or an error', () => {
    const out = path.join(dir, 'skipped-out');
    const r = run(['export', '--project', project, '--out', out, '--json', '--what',
      'redirects-to-error,dataset:sitemap-urls,error-inlinks']);
    expect(r.status, r.stdout).toBe(0);
    const j = JSON.parse(r.stdout) as {
      ok: boolean;
      files: { path: string }[];
      errors: unknown[];
      skipped: { label: string; reason: string }[];
    };
    expect(j.ok).toBe(true);
    expect(j.errors).toEqual([]);
    expect(j.files.map((f) => path.basename(f.path))).toEqual(['error-inlinks.csv']);
    expect(j.skipped.map((s) => s.label)).toEqual(['Internal Links — Redirects to Error', 'dataset:sitemap-urls']);
    for (const s of j.skipped) expect(s.reason).toMatch(/no file written/i);
    const plain = run(['export', '--project', project, '--out', out, '--what', 'dataset:sitemap-urls']);
    expect(plain.status).toBe(0);
    expect(plain.stderr).toMatch(/Skipped: dataset:sitemap-urls/);
  });

  it('a redirect report before the redirect-chain pass writes no file and says not computed', () => {
    const copy = path.join(dir, 'no-chains.seoproject');
    fs.copyFileSync(project, copy);
    const raw = new DatabaseSync(copy);
    raw.exec("DELETE FROM project_meta WHERE key = 'redirectChainsComputed'");
    raw.close();
    const out = path.join(dir, 'no-chains-out');
    const r = run(['export', '--project', copy, '--out', out, '--what', 'redirect-inlinks,error-inlinks', '--json']);
    expect(r.status).toBe(1);
    const j = JSON.parse(r.stdout) as { ok: boolean; errors: { label: string; error: string }[] };
    expect(j.ok).toBe(false);
    expect(j.errors).toHaveLength(1);
    expect(j.errors[0]!.error).toMatch(/^Not computed/);
    expect(fs.readdirSync(out).sort()).toEqual(['error-inlinks.csv', 'manifest.json']);
  });

  it('Ctrl-C mid-export exits 130 and leaves no .part file', async () => {
    const big = bigProject();
    const out = path.join(dir, 'sigint-out');
    const child = spawnTracked(process.execPath, [CLI, 'export', '--project', big, '--out', out], { stdio: 'ignore' });
    const exited = new Promise<number | null>((r) => child.on('exit', (c) => r(c)));
    try {
      // Interrupt once the first file is being written; wait for that event, not for a fixed time.
      const started = await waitFor(() => fs.existsSync(out) && fs.readdirSync(out).some((f) => f.endsWith('.part')));
      expect(started).toBe(true);
      child.kill('SIGINT');
      expect(await exited).toBe(130);
      expect(walk(out).filter((f) => f.endsWith('.part'))).toEqual([]);
    } finally {
      killChild(child);
    }
  }, 180000);

  it('Ctrl-C under --json prints ok:false, error interrupted and the files done so far', async () => {
    const big = bigProject(); // same copy as the test above; built here when run alone (-t)
    const out = path.join(dir, 'sigint-json-out');
    const child = spawnTracked(process.execPath, [CLI, 'export', '--project', big, '--out', out, '--what', 'issues,bulk', '--json'],
      { stdio: ['ignore', 'pipe', 'ignore'] });
    let stdout = '';
    child.stdout!.on('data', (b: Buffer) => (stdout += b.toString()));
    // 'close' fires once stdout is drained too, so no fixed pause before parsing it.
    const exited = new Promise<number | null>((r) => child.on('close', (c) => r(c)));
    const inBulk = () =>
      fs.existsSync(path.join(out, 'issues-summary.csv')) && fs.readdirSync(out).some((f) => f.endsWith('.part'));
    try {
      expect(await waitFor(() => fs.existsSync(out) && inBulk())).toBe(true);
      child.kill('SIGINT');
      expect(await exited).toBe(130);
      const j = JSON.parse(stdout) as { ok: boolean; error: string; files: { path: string }[] };
      expect(j.ok).toBe(false);
      expect(j.error).toBe('interrupted');
      expect(j.files.map((f) => path.basename(f.path))).toEqual(['issues-summary.csv']);
      expect(walk(out).filter((f) => f.endsWith('.part'))).toEqual([]);
      expect(fs.existsSync(path.join(out, 'manifest.json'))).toBe(false);
    } finally {
      killChild(child);
    }
  }, 180000);

  it('a desktop-saved project exports the same files; a locked one is refused with exit 2 and the pid', async () => {
    const container = path.join(dir, 'desktop.seoproject');
    await packProject(project, container);
    const bare = path.join(dir, 'bare-out');
    const boxed = path.join(dir, 'boxed-out');
    expect(run(['export', '--project', project, '--out', bare]).status).toBe(0);
    const r = run(['export', '--project', container, '--out', boxed, '--json']);
    expect(r.status, r.stdout).toBe(0);
    const listing = (d: string) =>
      (fs.readdirSync(d, { recursive: true }) as string[])
        .filter((f) => fs.statSync(path.join(d, f)).isFile())
        .sort()
        .map((f) => `${f}:${csvRows(path.join(d, f))}`);
    expect(listing(boxed)).toEqual(listing(bare));
    expect(detectProjectFormat(container)).toBe('archive');

    fs.writeFileSync(`${container}.lock`, JSON.stringify({ pid: process.pid }));
    const locked = run(['export', '--project', container, '--out', path.join(dir, 'locked-out'), '--json']);
    fs.rmSync(`${container}.lock`);
    expect(locked.status).toBe(2);
    expect((JSON.parse(locked.stdout) as { error: string }).error).toContain(`pid ${process.pid}`);
  });

  it('a project materialised by older checks is recomputed first, in the working copy only', async () => {
    const container = path.join(dir, 'stale.seoproject');
    const work = path.join(dir, 'stale-work.sqlite');
    fs.copyFileSync(project, work);
    const raw = new DatabaseSync(work);
    raw.exec("DELETE FROM urls_issues; UPDATE project_meta SET value = 'old' WHERE key = 'urlsIssuesVersion'");
    raw.close();
    await packProject(work, container);
    const before = fs.readFileSync(container);
    const out = path.join(dir, 'stale-out');
    const r = run(['export', '--project', container, '--out', out, '--what', 'issues:title-missing']);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toContain('recomputing');
    const db = new ProjectDb(project);
    const titleMissing = db.getOverviewCounts().issues.titleMissing;
    db.close();
    expect(csvRows(path.join(out, 'issues-title-missing.csv'))).toBe(titleMissing);
    expect(fs.readFileSync(container).equals(before)).toBe(true);
  });

  it('stale issue lists are left alone when the run reads no issue data', () => {
    const bare = path.join(dir, 'stale-bare.seoproject');
    fs.copyFileSync(project, bare);
    const raw = new DatabaseSync(bare);
    raw.exec("UPDATE project_meta SET value = 'old' WHERE key = 'urlsIssuesVersion'");
    raw.close();
    const out = path.join(dir, 'stale-bare-out');
    const r = run(['export', '--project', bare, '--out', out, '--what', 'error-inlinks,dataset:broken-links,tab:redirects']);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).not.toContain('recomputing');
    const check = new DatabaseSync(bare);
    const v = check.prepare("SELECT value FROM project_meta WHERE key = 'urlsIssuesVersion'").get() as { value: string };
    check.close();
    expect(v.value).toBe('old');
    // An issue list in the run: recomputed, in place for a bare project.
    const r2 = run(['export', '--project', bare, '--out', out, '--what', 'issues:title-missing']);
    expect(r2.stderr).toContain('recomputing');
  });

  it('--export-dir writes the exports right after a crawl; a bad --export fails before crawling', async () => {
    const bad = run([base, '--db', path.join(dir, 'never.seoproject'), '--export-dir', path.join(dir, 'x'), '--export', 'nope']);
    expect(bad.status).toBe(2);
    expect(fs.existsSync(path.join(dir, 'never.seoproject'))).toBe(false);

    const out = path.join(dir, 'after-crawl');
    const code = await runAsync([base, '--no-robots', '--db', path.join(dir, 'again.seoproject'),
      '--export-dir', out, '--export', 'bulk,issues']);
    expect(code).toBe(1); // the 404, as in the fixture crawl
    expect(fs.existsSync(path.join(out, 'issues-title-missing.csv'))).toBe(true);
    expect(fs.existsSync(path.join(out, 'issues-summary.csv'))).toBe(true);
  }, 60000);

  describe('--what dataset:<key>', () => {
    const exportJson = (out: string, what: string, ...extra: string[]) => {
      const r = run(['export', '--project', project, '--out', out, '--json', '--what', what, ...extra]);
      return { r, j: JSON.parse(r.stdout) as { ok: boolean; error?: string; files: { path: string; rows: number }[]; errors: { label: string; error: string }[] } };
    };

    it('writes CSV datasets named after the key, with human headers or raw keys', () => {
      const out = path.join(dir, 'ds-csv');
      const { r, j } = exportJson(out, 'dataset:issues-long,dataset:broken-links,dataset:sitemap-urls');
      expect(r.status, r.stderr).toBe(0);
      expect(csvRows(path.join(out, 'issues-long.csv'))).toBeGreaterThan(0);
      expect(csvRows(path.join(out, 'broken-links.csv'))).toBeGreaterThan(0);
      expect(j.files.find((f) => f.path.endsWith('issues-long.csv'))?.rows).toBe(csvRows(path.join(out, 'issues-long.csv')));
      // The fixture has no sitemap: no file, and no error for an empty plain table.
      expect(fs.existsSync(path.join(out, 'sitemap-urls.csv'))).toBe(false);
      expect(walk(out).filter((f) => f.endsWith('.part'))).toEqual([]);
      const raw = path.join(dir, 'ds-raw');
      exportJson(raw, 'dataset:issues-long', '--raw-headers');
      expect(fs.readFileSync(path.join(raw, 'issues-long.csv'), 'utf8')).toContain('issueKey');
    });

    it('issue-inlinks writes every issue into the issue-inlinks/ subfolder', () => {
      const out = path.join(dir, 'ds-inlinks');
      const { r } = exportJson(out, 'dataset:issue-inlinks');
      expect(r.status, r.stderr).toBe(0);
      expect(fs.existsSync(path.join(out, 'issue-inlinks.csv'))).toBe(false);
      const files = fs.readdirSync(path.join(out, 'issue-inlinks'));
      expect(files.length).toBeGreaterThan(0);
      expect(files.every((f) => f.startsWith('inlinks-') && f.endsWith('.csv'))).toBe(true);
    });

    it('page-html and page-text are JSON Lines; nothing stored writes no file and exits 1 with the reason', () => {
      const out = path.join(dir, 'ds-jsonl');
      const { r, j } = exportJson(out, 'dataset:page-html,dataset:page-text');
      expect(r.status, r.stderr).toBe(0);
      const lines = fs.readFileSync(path.join(out, 'page-html.jsonl'), 'utf8').trim().split('\n');
      expect(JSON.parse(lines[0]!)).toHaveProperty('html');
      expect(fs.readFileSync(path.join(out, 'page-text.jsonl'), 'utf8')).toContain('Heading');
      expect(j.errors).toEqual([]);
      expect(fs.existsSync(path.join(out, 'page-html.csv'))).toBe(false);

      const bare = path.join(dir, 'no-bodies.seoproject');
      fs.copyFileSync(project, bare);
      const raw = new DatabaseSync(bare);
      raw.exec('DELETE FROM url_sources');
      raw.close();
      const out2 = path.join(dir, 'ds-empty');
      const r2 = run(['export', '--project', bare, '--out', out2, '--json', '--what', 'dataset:page-html']);
      expect(r2.status).toBe(1);
      const j2 = JSON.parse(r2.stdout) as { ok: boolean; errors: { error: string }[] };
      expect(j2.ok).toBe(false);
      expect(j2.errors[0]?.error).toMatch(/storeBodySnapshots/);
      expect(r2.stderr).toMatch(/storeBodySnapshots/);
      expect(fs.existsSync(path.join(out2, 'page-html.jsonl'))).toBe(false);
    });

    describe('sitemap-reconciliation (B61)', () => {
      type Out = {
        ok: boolean;
        files: { path: string }[];
        errors: { label: string; error: string }[];
        skipped: { label: string; reason: string }[];
      };

      it('a project that read no sitemap: an explicit request writes no file and exits 1 with the reason', () => {
        const out = path.join(dir, 'rec-none');
        const { r, j } = exportJson(out, 'dataset:sitemap-reconciliation');
        expect(r.status).toBe(1);
        expect(j.ok).toBe(false);
        expect(j.errors[0]?.error).toMatch(/no sitemap/i);
        expect(r.stderr).toMatch(/no sitemap/i);
        expect(fs.existsSync(path.join(out, 'sitemap-reconciliation.csv'))).toBe(false);
      });

      it('inside bulk the same item is skipped with the reason in the manifest, exit 0', () => {
        const out = path.join(dir, 'rec-bulk');
        const r = run(['export', '--project', project, '--out', out, '--json', '--what', 'bulk']);
        expect(r.status, r.stderr).toBe(0);
        expect(fs.existsSync(path.join(out, 'sitemap-reconciliation.csv'))).toBe(false);
        const m = JSON.parse(fs.readFileSync(path.join(out, 'manifest.json'), 'utf8')) as Out;
        expect(m.errors).toEqual([]);
        const skip = m.skipped.find((s) => s.label === 'Sitemap vs Crawl');
        expect(skip?.reason).toMatch(/no sitemap/i);
        expect((JSON.parse(r.stdout) as Out).skipped.map((s) => s.label)).toContain('Sitemap vs Crawl');
      });

      it('a project with sitemap data: the CSV has the defined columns and one verdict per URL', () => {
        const withSitemap = path.join(dir, 'with-sitemap.seoproject');
        fs.copyFileSync(project, withSitemap);
        const raw = new DatabaseSync(withSitemap);
        raw.prepare('INSERT INTO sitemap_urls (url, lastmod, source_sitemap) VALUES (?, ?, ?)').run(
          `${base}p/1`, '2026-01-02', `${base}sitemap.xml`);
        raw.prepare('INSERT INTO sitemap_urls (url, lastmod, source_sitemap) VALUES (?, ?, ?)').run(
          `${base}never-crawled`, null, `${base}sitemap.xml`);
        raw.close();
        const out = path.join(dir, 'rec-ok');
        const r = run(['export', '--project', withSitemap, '--out', out, '--json', '--raw-headers', '--what', 'dataset:sitemap-reconciliation']);
        expect(r.status, r.stderr).toBe(0);
        const lines = fs.readFileSync(path.join(out, 'sitemap-reconciliation.csv'), 'utf8').trim().split('\n');
        expect(lines[0]).toBe(
          'url,inCrawl,inSitemap,statusCode,indexability,sitemapLastmod,lastModifiedHeader,lastmodDiffDays,verdict,note',
        );
        const row = (url: string) => lines.find((l) => l.startsWith(url + ','));
        expect(row(`${base}never-crawled`)).toBe(`${base}never-crawled,false,true,,,,,,sitemap-not-fetched,not-in-crawl`);
        expect(row(`${base}p/1`)).toMatch(/,true,true,200,indexable,2026-01-02,.*,ok,$/);
        expect(row(`${base}p/2`)).toMatch(/,true,false,200,indexable,,,,crawled-not-in-sitemap,$/);
      });
    });

    it.each([
      ['dataset:nope', 'issues-long'],
      ['dataset:selected-inlinks', '--urls'],
      ['dataset:metrica', 'account'],
    ])('%s exits 2 listing the valid keys', (what, needle) => {
      const out = path.join(dir, 'ds-bad');
      const { r, j } = exportJson(out, what);
      expect(r.status).toBe(2);
      expect(j.error).toContain(needle);
      expect(j.error).toContain('Valid keys: ');
      expect(j.error).not.toMatch(/Valid keys:.*selected-/);
      expect(fs.existsSync(out)).toBe(false);
    });
  });
});
