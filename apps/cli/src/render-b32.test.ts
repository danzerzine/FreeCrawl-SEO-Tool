import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// Drives the built CLI as a process (`npx tsc -b` and `npm run build:cli` first);
// needs the Playwright Chromium (`npx playwright install chromium`).
const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dist/index.js');

let dir: string;
let site: http.Server;
let base: string;

// `/` has one plain link and three that only a script writes; `/big` has
// thirty script links to slow pages, long enough to stop mid-crawl.
const scriptLinks = (hrefs: string[]) =>
  `<div id="nav"></div><script>document.getElementById("nav").innerHTML = ${JSON.stringify(
    hrefs.map((h) => `<a href="${h}">${h}</a>`).join(''),
  )};</script>`;

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-b32-'));
  site = http.createServer((req, res) => {
    const url = req.url ?? '/';
    if (url === '/robots.txt' || url.startsWith('/sitemap')) return void res.writeHead(404).end();
    const page = (body: string) =>
      res
        .writeHead(200, { 'content-type': 'text/html' })
        .end(`<html><head><title>${url}</title></head><body><h1>${url}</h1>${body}</body></html>`);
    if (url === '/') return page('<a href="/static">s</a>' + scriptLinks(['/js/1', '/js/2', '/js/3']));
    if (url === '/big') {
      return page(scriptLinks(Array.from({ length: 30 }, (_, i) => `/slow/${i}`)));
    }
    if (url.startsWith('/slow/')) return void setTimeout(() => page('slow'), 300);
    if (url === '/static' || url.startsWith('/js/')) return page('leaf');
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => site.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(site.address() as AddressInfo).port}/`;
});

afterEach(async () => {
  await new Promise((r) => site.close(r));
  fs.rmSync(dir, { recursive: true, force: true });
});

type Exit = { code: number | null; out: string; err: string };

function start(
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
): { child: ChildProcess; done: Promise<Exit>; out: () => string; err: () => string } {
  const child = spawn(process.execPath, [CLI, ...args], { env });
  let out = '';
  let err = '';
  child.stdout!.on('data', (d) => (out += d));
  child.stderr!.on('data', (d) => (err += d));
  const done = new Promise<Exit>((r) => child.on('exit', (code) => r({ code, out, err })));
  return { child, done, out: () => out, err: () => err };
}

const db = (name: string) => path.join(dir, `${name}.seoproject`);
const total = (r: Exit) => (JSON.parse(r.out) as { summary: { total: number } }).summary.total;
/** No browser in this folder: Playwright finds no Chromium. */
const noBrowser = () => ({ ...process.env, PLAYWRIGHT_BROWSERS_PATH: path.join(dir, 'no-browsers') });

/** Every process under `pid`, from the system process table. */
function descendants(pid: number): number[] {
  const rows = execFileSync('ps', ['-A', '-o', 'pid=,ppid='], { encoding: 'utf8' })
    .trim()
    .split('\n')
    .map((l) => l.trim().split(/\s+/).map(Number) as [number, number]);
  const out: number[] = [];
  const walk = (p: number) => {
    for (const [child, parent] of rows) {
      if (parent === p) {
        out.push(child);
        walk(child);
      }
    }
  };
  walk(pid);
  return out;
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe('--render (B32)', () => {
  it('finds the links a script writes; a plain crawl does not', async () => {
    const plain = await start([base, '--json', '--db', db('plain')]).done;
    expect(plain.code).toBe(0);
    expect(total(plain)).toBe(2);
    const rendered = await start([base, '--render', '--json', '--db', db('render')]).done;
    expect(rendered.code).toBe(0);
    expect(total(rendered)).toBe(5);
  }, 120_000);

  it('turns on rendering from a config file too', async () => {
    const cfg = path.join(dir, 'render.json');
    fs.writeFileSync(cfg, JSON.stringify({ renderingMode: 'js' }));
    const r = await start([base, '--config', cfg, '--json', '--db', db('cfg')]).done;
    expect(r.code).toBe(0);
    expect(total(r)).toBe(5);
  }, 120_000);

  it('exits 2 without a browser and leaves no project file', async () => {
    const r = await start([base, '--render', '--db', db('missing')], noBrowser()).done;
    expect(r.code).toBe(2);
    expect(r.err).toContain('JavaScript rendering needs Chromium: run `npx playwright install chromium`');
    expect(fs.existsSync(db('missing'))).toBe(false);
  }, 60_000);

  it('crawls plain HTML with a warning when only the config file asks for rendering', async () => {
    const cfg = path.join(dir, 'render.json');
    fs.writeFileSync(cfg, JSON.stringify({ renderingMode: 'js' }));
    const r = await start([base, '--config', cfg, '--json', '--db', db('fallback')], noBrowser()).done;
    expect(r.code).toBe(0);
    expect(total(r)).toBe(2);
    const warns = r.err
      .split('\n')
      .filter((l) => l.trim() !== '')
      .map((l) => JSON.parse(l) as { type: string; message: string })
      .filter((e) => e.type === 'warn')
      .map((e) => e.message);
    expect(warns.some((m) => m.includes('npx playwright install chromium'))).toBe(true);
    // The fallback turns rendering off, so the crawler has nothing to warn about.
    expect(warns.some((m) => m.startsWith('JavaScript rendering is on but'))).toBe(false);
  }, 60_000);

  it('leaves no browser process after a finished crawl', async () => {
    const run = start([base, '--render', '--db', db('done')]);
    const seen = new Set<number>();
    const poll = setInterval(() => descendants(run.child.pid!).forEach((p) => seen.add(p)), 100);
    const r = await run.done;
    clearInterval(poll);
    expect(r.code).toBe(0);
    expect(seen.size).toBeGreaterThan(0);
    await new Promise((res) => setTimeout(res, 500));
    expect([...seen].filter(alive)).toEqual([]);
  }, 120_000);

  it('leaves no browser process after Ctrl-C', async () => {
    const run = start([`${base}big`, '--render', '--rps', '2', '--db', db('sigint')]);
    const seen = new Set<number>();
    // Stopped once a few pages are in, while the rest still render.
    const deadline = Date.now() + 30_000;
    while (!/\[[3-9]\/\d+\]/.test(run.out()) && Date.now() < deadline) {
      descendants(run.child.pid!).forEach((p) => seen.add(p));
      await new Promise((r) => setTimeout(r, 100));
    }
    descendants(run.child.pid!).forEach((p) => seen.add(p));
    expect(seen.size).toBeGreaterThan(0);
    run.child.kill('SIGINT');
    const r = await run.done;
    expect(r.code).not.toBe(0);
    expect(r.err).toContain('Stopping');
    // The pages in flight finish rendering: the browser outlives the first Ctrl-C.
    expect(r.err).not.toMatch(/JS render (threw|failed)/);
    await new Promise((res) => setTimeout(res, 500));
    expect([...seen].filter(alive)).toEqual([]);
    // A page stopped mid-render is fetched again, so its script links are found.
    const resumed = await start([`${base}big`, '--render', '--resume', '--json', '--db', db('sigint')]).done;
    expect(resumed.code).toBe(0);
    expect(total(resumed)).toBe(31);
  }, 120_000);
});
