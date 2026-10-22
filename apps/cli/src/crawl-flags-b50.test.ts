import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, request, type Server } from 'node:http';
import { connect, createServer as createTcpServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

// Drives the built CLI as a process (`npm run build:cli` first).
const CLI = join(__dirname, '../dist/index.js');

let dir: string;
let site: Server;
let ext: Server;
let base: string;
let extPort: number;
const hits: string[] = [];
const extHits: string[] = [];

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'b50-'));
  ext = createServer((req, res) => {
    extHits.push(`${req.method} ${req.url}`);
    res.writeHead(200, { 'content-type': 'text/html' }).end('<html><body>ext</body></html>');
  });
  await new Promise<void>((r) => ext.listen(0, '127.0.0.1', r));
  extPort = (ext.address() as AddressInfo).port;
  site = createServer((req, res) => {
    const url = req.url ?? '';
    hits.push(url);
    if (url === '/robots.txt') return void res.writeHead(200, { 'content-type': 'text/plain' }).end('User-agent: *\nDisallow: /blocked\n');
    if (url === '/seed.xml') {
      res
        .writeHead(200, { 'content-type': 'application/xml' })
        .end(`<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${base}/from-seed</loc></url></urlset>`);
      return;
    }
    if (url.startsWith('/sitemap')) return void res.writeHead(404).end();
    res
      .writeHead(200, { 'content-type': 'text/html' })
      .end(`<html><head><title>t</title></head><body><a href="/blocked">b</a><a href="http://localhost:${extPort}/x">x</a></body></html>`);
  });
  await new Promise<void>((r) => site.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(site.address() as AddressInfo).port}`;
});
afterAll(() => {
  site.close();
  ext.close();
  rmSync(dir, { recursive: true, force: true });
});
beforeEach(() => {
  hits.length = 0;
  extHits.length = 0;
});

let n = 0;
function cli(args: string[], file?: object): Promise<{ code: number | null; out: string; err: string }> {
  const db = join(dir, `p${++n}.seoproject`);
  const extra: string[] = [];
  if (file) {
    const path = join(dir, `c${n}.json`);
    writeFileSync(path, JSON.stringify(file));
    extra.push('--config', path);
  }
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [CLI, ...args, '--db', db, '--max', '5', ...extra]);
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('exit', (code) => resolve({ code, out, err }));
  });
}

describe('on/off flags in both directions (B50)', () => {
  it('--robots turns robots.txt back on over a file that switched it off', async () => {
    await cli([`${base}/`], { respectRobotsTxt: false, discoverSitemaps: false });
    expect(hits).toContain('/blocked');
    hits.length = 0;
    await cli([`${base}/`, '--robots'], { respectRobotsTxt: false, discoverSitemaps: false });
    expect(hits).not.toContain('/blocked');
  }, 60_000);

  it('--no-robots still ignores robots.txt', async () => {
    await cli([`${base}/`, '--no-robots', '--no-sitemap-discovery']);
    expect(hits).toContain('/blocked');
  }, 60_000);

  it('--check-external turns external checks on over a file that switched them off', async () => {
    await cli([`${base}/`, '--no-sitemap-discovery'], { checkExternalLinks: false });
    expect(extHits).toEqual([]);
    await cli([`${base}/`, '--no-sitemap-discovery', '--check-external'], { checkExternalLinks: false });
    expect(extHits.length).toBeGreaterThan(0);
  }, 60_000);

  it('a --no- form of a flag that has none exits 2', async () => {
    const r = await cli([`${base}/`, '--no-json']);
    expect(r.code).toBe(2);
    expect(r.err).toContain('--no-json');
    expect(hits).toEqual([]);
  }, 30_000);
});

describe('sitemap flags (B50)', () => {
  it('--sitemap seeds the crawl from that file', async () => {
    await cli([`${base}/`, '--sitemap', `${base}/seed.xml`, '--no-sitemap-discovery']);
    expect(hits).toContain('/seed.xml');
    expect(hits).toContain('/from-seed');
  }, 60_000);

  it('--no-sitemap-discovery asks for no /sitemap.xml; discovery on by default does', async () => {
    await cli([`${base}/`]);
    expect(hits.some((h) => h.startsWith('/sitemap'))).toBe(true);
    hits.length = 0;
    await cli([`${base}/`, '--no-sitemap-discovery']);
    expect(hits.some((h) => h.startsWith('/sitemap'))).toBe(false);
  }, 60_000);
});

describe('--config start and keys (B50)', () => {
  it('crawls the start URL from the file when the command line has none', async () => {
    const r = await cli(['--no-sitemap-discovery'], { startUrl: `${base}/start` });
    expect(r.code).toBe(0);
    expect(hits).toContain('/start');
  }, 60_000);

  it('a file list with --resume against a spider project is refused', async () => {
    const db = join(dir, 'spider.seoproject');
    await new Promise<void>((resolve) =>
      spawn(process.execPath, [CLI, `${base}/`, '--db', db, '--max', '2', '--no-sitemap-discovery']).on('exit', () => resolve()),
    );
    const path = join(dir, 'list.json');
    writeFileSync(path, JSON.stringify({ mode: 'list', urlList: [`${base}/a`] }));
    const r = await new Promise<{ code: number | null; err: string }>((resolve) => {
      const p = spawn(process.execPath, [CLI, '--resume', '--config', path, '--db', db]);
      let err = '';
      p.stderr.on('data', (d) => (err += d));
      p.on('exit', (code) => resolve({ code, err }));
    });
    expect(r.code).toBe(2);
    expect(r.err).toContain('--resume --list cannot continue it');
  }, 60_000);

  it('an empty list in the file exits 2', async () => {
    const r = await cli([], { mode: 'list', urlList: [] });
    expect(r.code).toBe(2);
    expect(hits).toEqual([]);
  }, 30_000);

  it('an unknown key is a warn line and the crawl runs', async () => {
    const r = await cli([`${base}/`, '--no-sitemap-discovery'], { colour: 'red' });
    expect(r.code).toBe(0);
    expect(r.err).toContain('unknown key in --config: colour');
  }, 60_000);
});

describe('--proxy (B50)', () => {
  it('reaches a real local proxy and beats the file active profile', async () => {
    const seen: string[] = [];
    // A forward proxy: plain requests in absolute form, CONNECT tunnels.
    const proxy = createServer((req, res) => {
      seen.push(req.url ?? '');
      const up = request(req.url!, { method: req.method, headers: req.headers }, (r) => {
        res.writeHead(r.statusCode ?? 502, r.headers);
        r.pipe(res);
      });
      up.on('error', () => res.writeHead(502).end());
      req.pipe(up);
    });
    proxy.on('connect', (req, sock, head) => {
      seen.push(req.url ?? '');
      const [host, port] = (req.url ?? '').split(':');
      const up = connect(Number(port), host, () => {
        sock.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        up.write(head);
        up.pipe(sock).pipe(up);
      });
      up.on('error', () => sock.destroy());
    });
    await new Promise<void>((r) => proxy.listen(0, '127.0.0.1', r));
    const closed = await closedPort();
    try {
      const r = await cli([`${base}/`, '--no-sitemap-discovery', '--proxy', `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`], {
        proxyProfiles: [{ name: 'office', url: `http://127.0.0.1:${closed}` }],
        proxyProfileActive: 'office',
      });
      expect(r.code).toBe(0);
      expect(seen.length).toBeGreaterThan(0);
      expect(hits).toContain('/');
    } finally {
      proxy.close();
    }
  }, 60_000);

  it('a proxy password is in no output line', async () => {
    const closed = await closedPort();
    const r = await cli([`${base}/`, '--json', '--no-sitemap-discovery', '--proxy', `http://u:s3cretpw@127.0.0.1:${closed}`]);
    expect(r.out + r.err).not.toContain('s3cretpw');
    expect(r.out + r.err).toContain('127.0.0.1');
  }, 60_000);
});

/** A port nothing listens on. */
async function closedPort(): Promise<number> {
  const s = createTcpServer();
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  const port = (s.address() as AddressInfo).port;
  await new Promise((r) => s.close(r));
  return port;
}
