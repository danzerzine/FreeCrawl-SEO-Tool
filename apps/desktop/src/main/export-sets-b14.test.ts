import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ProjectDb, packProject } from '@freecrawl/db';
import { runScheduledExport } from './scheduled-export.js';

// Drives the built CLI as a process (`npx tsc -b && npm run build:cli` first).
const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../cli/dist/index.js');
const WHAT = 'bulk,issues,tab:redirects,dataset:broken-links,error-inlinks';

let dir: string;
let server: http.Server;
let project: string;
let base: string;

function run(args: string[]) {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', timeout: 30000 });
}

function walk(d: string): string[] {
  return fs.readdirSync(d, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)],
  );
}

/** Relative file → data rows (CSV lines minus the header; null for other files). */
function snapshot(d: string): Record<string, number | null> {
  const out: Record<string, number | null> = {};
  for (const f of walk(d).sort()) {
    const rel = path.relative(d, f);
    if (rel === 'manifest.json') continue; // carries a timestamp
    out[rel] = f.endsWith('.csv')
      ? fs.readFileSync(f, 'utf8').split('\n').filter((l) => l.length > 0).length - 1
      : null;
  }
  return out;
}

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-b14-'));
  server = http.createServer((req, res) => {
    const url = req.url ?? '/';
    if (url === '/old') {
      res.writeHead(301, { location: '/p/1' });
      res.end();
      return;
    }
    if (url === '/gone') {
      res.writeHead(404, { 'content-type': 'text/html' });
      res.end('<html><head><title>Not found</title></head></body></html>');
      return;
    }
    const links = [0, 1, 2, 3].map((k) => `<a href="/p/${k}">p${k}</a>`).join('');
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(`<html><head></head><body>${links}<a href="/old">o</a><a href="/gone">g</a></body></html>`);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  project = path.join(dir, 'site.seoproject');
  const child = spawn(process.execPath, [CLI, base, '--no-robots', '--db', project, '--json'], { stdio: 'ignore' });
  const code = await new Promise<number | null>((r) => child.on('exit', (c) => r(c)));
  if (code !== 1 || !fs.existsSync(project)) throw new Error(`fixture crawl exited ${code}`);
}, 90000);

afterAll(async () => {
  await new Promise((r) => server.close(r));
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('saved export sets (B14)', () => {
  it('--save-set stores a set that --list-sets shows', () => {
    const r = run(['export', '--project', project, '--save-set', 'weekly', '--what', WHAT, '--raw-headers', '--json']);
    expect(r.status, r.stderr + r.stdout).toBe(0);
    const l = run(['export', '--project', project, '--list-sets', '--json']);
    expect(l.status, l.stderr).toBe(0);
    expect(JSON.parse(l.stdout)).toEqual({
      ok: true,
      sets: [{ name: 'weekly', what: WHAT.split(','), rawHeaders: true }],
    });
  });

  it('--save-set with a bad --what exits 2 and saves nothing', () => {
    const r = run(['export', '--project', project, '--save-set', 'bad', '--what', 'bulk,pdf', '--json']);
    expect(r.status).toBe(2);
    expect((JSON.parse(r.stdout) as { error: string }).error).toContain('Unknown --what entry: pdf');
    const l = JSON.parse(run(['export', '--project', project, '--list-sets', '--json']).stdout) as {
      sets: { name: string }[];
    };
    expect(l.sets.map((s) => s.name)).toEqual(['weekly']);
  });

  it('--set with an unknown name exits 2 naming the saved sets', () => {
    const out = path.join(dir, 'nope');
    const r = run(['export', '--project', project, '--out', out, '--set', 'monthly', '--json']);
    expect(r.status).toBe(2);
    expect((JSON.parse(r.stdout) as { error: string }).error).toContain('weekly');
    expect(fs.existsSync(out)).toBe(false);
  });

  it('a set run by the CLI and by the scheduler fire path gives the same files and rows', async () => {
    const cliOut = path.join(dir, 'cli-out');
    const r = run(['export', '--project', project, '--out', cliOut, '--set', 'weekly', '--json']);
    expect(r.status, r.stderr + r.stdout).toBe(0);
    const cli = JSON.parse(r.stdout) as { files: { path: string; rows: number | null }[] };
    expect(cli.files.length).toBeGreaterThan(5);
    // Raw headers came from the set: camelCase keys, not grid labels.
    expect(fs.readFileSync(path.join(cliOut, 'broken-links.csv'), 'utf8')).toMatch(/^\uFEFF?fromUrl,/);

    const schedOut = path.join(dir, 'sched-out');
    fs.mkdirSync(schedOut);
    const db = new ProjectDb(project);
    let sched;
    try {
      sched = await runScheduledExport(
        db,
        { export: 'set', exportSet: 'weekly', outputDir: dir, sheets: false, webhook: false },
        { exportDir: schedOut, toolVersion: 'test', writePdf: async () => {} },
      );
    } finally {
      db.close();
    }
    expect(sched.errors).toEqual([]);

    const a = snapshot(cliOut);
    const b = snapshot(schedOut);
    expect(Object.keys(a).length).toBeGreaterThan(5);
    expect(b).toEqual(a);
    const rows = (files: { path: string; rows: number | null }[], root: string) =>
      Object.fromEntries(files.map((f) => [path.relative(root, f.path), f.rows]));
    expect(rows(sched.files, schedOut)).toEqual(rows(cli.files, cliOut));
  });

  it.each(['bulk', 'seo-audit', 'html'] as const)(
    'a schedule exporting %s writes what freecrawl export --what writes',
    async (what) => {
      const cliOut = path.join(dir, `cli-${what}`);
      const r = run(['export', '--project', project, '--out', cliOut, '--what', what, '--json']);
      expect(r.status, r.stderr + r.stdout).toBe(0);
      const schedOut = path.join(dir, `sched-${what}`);
      fs.mkdirSync(schedOut);
      const db = new ProjectDb(project);
      let sched;
      try {
        sched = await runScheduledExport(
          db,
          { export: what, outputDir: dir, sheets: false, webhook: false },
          { exportDir: schedOut, toolVersion: 'test', writePdf: async () => {} },
        );
      } finally {
        db.close();
      }
      expect(sched.errors).toEqual([]);
      expect(snapshot(schedOut)).toEqual(snapshot(cliOut));
      expect(fs.existsSync(path.join(schedOut, 'manifest.json'))).toBe(true);
    },
  );

  it('--set with --urls adds the selected links to the set\'s files', () => {
    const urls = path.join(dir, 'urls.txt');
    fs.writeFileSync(urls, `${base}\n`);
    const out = path.join(dir, 'set-urls-out');
    const r = run(['export', '--project', project, '--out', out, '--set', 'weekly', '--urls', urls, '--json']);
    expect(r.status, r.stderr + r.stdout).toBe(0);
    const names = (JSON.parse(r.stdout) as { files: { path: string }[] }).files.map((f) => path.basename(f.path));
    expect(names).toContain('selected-inlinks.csv');
    expect(names).toContain('broken-links.csv');
    // Raw headers from the set reach the selected links too.
    expect(fs.readFileSync(path.join(out, 'selected-inlinks.csv'), 'utf8')).not.toMatch(/^\uFEFF?Source,/);
  });

  it('--set whose stored list has a token this version does not know exits 2 and writes nothing', () => {
    const copy = path.join(dir, 'old-set.seoproject');
    fs.copyFileSync(project, copy);
    const db = new ProjectDb(copy);
    db.setMeta('exportSets', JSON.stringify([{ name: 'old', what: ['issues', 'pdf'] }]));
    db.close();
    const out = path.join(dir, 'old-set-out');
    const r = run(['export', '--project', copy, '--out', out, '--set', 'old', '--json']);
    expect(r.status).toBe(2);
    expect((JSON.parse(r.stdout) as { error: string }).error).toContain('pdf');
    expect(fs.existsSync(path.join(out, 'issues-summary.csv'))).toBe(false);
  });

  it('the scheduler reports a set that is not in the project as an error', async () => {
    const db = new ProjectDb(project);
    try {
      const r = await runScheduledExport(
        db,
        { export: 'set', exportSet: 'gone', outputDir: dir, sheets: false, webhook: false },
        { exportDir: path.join(dir, 'gone-out'), toolVersion: 'test', writePdf: async () => {} },
      );
      expect(r.files).toEqual([]);
      expect(r.errors.join(' ')).toContain('gone');
    } finally {
      db.close();
    }
  });

  it('a set saved into a desktop-saved (archive) project survives the repack', async () => {
    const archive = path.join(dir, 'packed.seoproject');
    await packProject(project, archive);
    const r = run(['export', '--project', archive, '--save-set', 'audit', '--what', 'seo-audit', '--json']);
    expect(r.status, r.stderr + r.stdout).toBe(0);
    const l = JSON.parse(run(['export', '--project', archive, '--list-sets', '--json']).stdout) as {
      sets: { name: string; what: string[] }[];
    };
    expect(l.sets).toEqual([
      { name: 'weekly', what: WHAT.split(','), rawHeaders: true },
      { name: 'audit', what: ['seo-audit'] },
    ]);
  });
});
