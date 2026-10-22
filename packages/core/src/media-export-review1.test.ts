import * as fs from 'node:fs';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ProjectDb } from '@freecrawl/db';
import { exportPdfs, exportScreenshots } from './media-export.js';

// M10 code review round 1: the screenshot path guard, case-insensitive file
// names, the PDF fetch's auth and content checks, and the per-run byte cap.
let dir: string;
let n = 0;

function fixture(sql: string): { db: ProjectDb; file: string } {
  const file = path.join(dir, `p${n++}.seoproject`);
  new ProjectDb(file).close();
  const raw = new DatabaseSync(file);
  raw.exec(sql);
  raw.close();
  return { db: new ProjectDb(file, { readOnly: true }), file };
}
const csv = (f: string): string[] => fs.readFileSync(f, 'utf8').split('\n').filter(Boolean);

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-m10r1-'));
});
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('exportScreenshots path guard', () => {
  const insert = (rows: [number, string, string][]): string =>
    rows
      .map(
        ([id, url, p]) =>
          `INSERT INTO urls (id, url, status_code) VALUES (${id}, '${url}', 200);
           INSERT INTO url_sources (url_id, body, body_length, screenshot_fullpage_path) VALUES (${id}, 'x', 1, '${p}');`,
      )
      .join('\n');

  it('copies only PNGs inside the project sidecar; anything else is "outside project" and not copied', async () => {
    const secretDir = path.join(dir, 'secret');
    fs.mkdirSync(secretDir, { recursive: true });
    const secret = path.join(secretDir, 'id_rsa.png');
    fs.writeFileSync(secret, 'PRIVATE');
    const project = path.join(dir, 'guard.seoproject');
    const side = `${project}.screenshots`;
    fs.mkdirSync(side, { recursive: true });
    fs.writeFileSync(path.join(side, 'ok.png'), 'OK');
    fs.writeFileSync(path.join(side, 'notes.txt'), 'TXT');
    const { db } = fixture(
      insert([
        [1, 'https://ex.com/ok', path.join(side, 'ok.png')],
        [2, 'https://ex.com/secret', secret],
        [3, 'https://ex.com/trav', path.join(side, '..', 'secret', 'id_rsa.png')],
        [4, 'https://ex.com/txt', path.join(side, 'notes.txt')],
      ]),
    );
    const out = path.join(dir, 'out-guard');
    const r = await exportScreenshots(db, out, { projectFile: project });
    expect(fs.readdirSync(path.join(out, 'screenshots'))).toEqual(['ok-fullpage.png']);
    expect(r.errors).toHaveLength(3);
    const rows = csv(path.join(out, 'screenshots.csv'));
    expect(rows.filter((l) => l.includes('outside project'))).toHaveLength(3);
    expect(rows.join('\n')).not.toContain('PRIVATE');
  });

  it('a project moved or renamed after the crawl still exports its own sidecar', async () => {
    const project = path.join(dir, 'moved.seoproject');
    const side = `${project}.screenshots`;
    fs.mkdirSync(side, { recursive: true });
    fs.writeFileSync(path.join(side, 'a.png'), 'A');
    const stale = path.join(dir, 'old-name.seoproject.screenshots', 'a.png');
    const { db } = fixture(insert([[1, 'https://ex.com/a', stale]]));
    const out = path.join(dir, 'out-moved');
    const r = await exportScreenshots(db, out, { projectFile: project });
    expect(r.errors).toEqual([]);
    expect(fs.readFileSync(path.join(out, 'screenshots', 'a-fullpage.png'), 'utf8')).toBe('A');
  });
});

describe('file names on a case-insensitive file system', () => {
  it('Guide.pdf and guide.pdf never get the same name ignoring case; a rerun picks the same names', async () => {
    const side = path.join(dir, 'case.seoproject.screenshots');
    fs.mkdirSync(side, { recursive: true });
    fs.writeFileSync(path.join(side, 'x.png'), 'X');
    const p = path.join(side, 'x.png');
    const sql = (): string =>
      `INSERT INTO urls (id, url, status_code) VALUES (1, 'https://ex.com/Docs/Guide', 200), (2, 'https://ex.com/docs/guide', 200);
       INSERT INTO url_sources (url_id, body, body_length, screenshot_fullpage_path) VALUES (1, 'x', 1, '${p}'), (2, 'x', 1, '${p}');`;
    const names = async (): Promise<string[]> => {
      const { db } = fixture(sql());
      const out = path.join(dir, `out-case-${n}`);
      await exportScreenshots(db, out, { projectFile: path.join(dir, 'case.seoproject') });
      return fs.readdirSync(path.join(out, 'screenshots')).sort();
    };
    const first = await names();
    expect(first).toHaveLength(2);
    expect(new Set(first.map((f) => f.toLowerCase())).size).toBe(2);
    expect(await names()).toEqual(first);
  });
});

describe('file names Windows cannot create', () => {
  it('a page called /con.html gets a name that is not a reserved device name', async () => {
    const project = path.join(dir, 'reserved.seoproject');
    const side = `${project}.screenshots`;
    fs.mkdirSync(side, { recursive: true });
    fs.writeFileSync(path.join(side, 'x.png'), 'X');
    const p = path.join(side, 'x.png');
    const { db } = fixture(
      `INSERT INTO urls (id, url, status_code) VALUES (1, 'https://ex.com/con.html', 200);
       INSERT INTO url_sources (url_id, body, body_length, screenshot_fullpage_path) VALUES (1, 'x', 1, '${p}');`,
    );
    const out = path.join(dir, 'out-reserved');
    await exportScreenshots(db, out, { projectFile: project });
    // The stem is guarded (it is also the whole name of a PDF: con.pdf), so the screenshot name carries it too.
    expect(fs.readdirSync(path.join(out, 'screenshots'))).toEqual(['con_-fullpage.png']);
  });
});

describe('exportPdfs', () => {
  let server: http.Server;
  let base: string;
  const pdf = (tag: string, size = 2000): Buffer =>
    Buffer.concat([Buffer.from(`%PDF-1.4\n${tag}\n`), Buffer.alloc(size, 7)]);
  const FILES: Record<string, Buffer> = {
    '/a.pdf': pdf('A'),
    '/b.pdf': pdf('B'),
    '/c.pdf': pdf('C'),
  };
  let seen: string[] = [];

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      const url = req.url ?? '/';
      seen.push(`${req.method} ${url}`);
      if (url === '/login.pdf') {
        res.writeHead(200, { 'content-type': 'text/html' });
        return void res.end('<html>please log in</html>');
      }
      const body = FILES[url];
      if (!body) return void res.writeHead(404).end();
      res.writeHead(200, { 'content-type': 'application/pdf', 'content-length': body.length });
      res.end(req.method === 'HEAD' ? undefined : body);
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => void server.close());

  const project = (paths: string[]): ProjectDb =>
    fixture(
      paths
        .map(
          (p, i) =>
            `INSERT INTO urls (id, url, status_code, content_kind, content_length) VALUES (${i + 1}, '${base}${p}', 200, 'pdf', ${FILES[p]?.length ?? 'NULL'});`,
        )
        .join('\n'),
    ).db;
  const opts = { requestGapMs: 0 };

  it('a login page served with 200 is not saved as a PDF', async () => {
    const out = path.join(dir, 'out-login');
    const r = await exportPdfs(project(['/login.pdf']), out, opts);
    expect(r.errors.join('\n')).toMatch(/not a PDF \(got text\/html\)/);
    expect(fs.existsSync(path.join(out, 'pdfs', 'login.pdf'))).toBe(false);
    expect(csv(path.join(out, 'pdfs.csv')).join('\n')).toMatch(/failed: not a PDF/);
  });

  it.each([
    ['digest', { auth: { type: 'digest', username: 'u', password: 'p' } }, /digest/i],
    ['form login', { formLogin: { enabled: true, mode: 'http', steps: [{}] } }, /form login/i],
  ])('%s with a readable config: no request, an explicit status per file', async (name, config, re) => {
    seen = [];
    const out = path.join(dir, `out-${name.replace(' ', '-')}`);
    const r = await exportPdfs(project(['/a.pdf', '/b.pdf']), out, {
      ...opts,
      crawlConfig: { config: config as never, secretsEnc: false },
    });
    expect(seen).toEqual([]);
    expect(r.errors.join('\n')).toMatch(re);
    expect(csv(path.join(out, 'pdfs.csv')).slice(1).every((l) => /skipped: .*not supported/.test(l))).toBe(true);
  });

  it('an enabled form login with no steps does nothing, so PDFs are still fetched', async () => {
    const out = path.join(dir, 'out-emptylogin');
    const r = await exportPdfs(project(['/a.pdf']), out, {
      ...opts,
      crawlConfig: { config: { formLogin: { enabled: true, mode: 'http', steps: [] } }, secretsEnc: false },
    });
    expect(r.errors).toEqual([]);
    expect(fs.existsSync(path.join(out, 'pdfs', 'a.pdf'))).toBe(true);
  });

  it('the run cap counts only bytes downloaded in this run: files already on disk do not count', async () => {
    const out = path.join(dir, 'out-cap');
    const size = FILES['/a.pdf']!.length;
    const cap = size * 2 + 10; // room for two downloads
    const db = project(['/a.pdf', '/b.pdf', '/c.pdf']);
    const first = await exportPdfs(db, out, { ...opts, maxBytes: cap });
    expect(first.skipped).toHaveLength(1);
    expect(fs.readdirSync(path.join(out, 'pdfs')).sort()).toEqual(['a.pdf', 'b.pdf']);
    const second = await exportPdfs(db, out, { ...opts, maxBytes: cap });
    expect(second.skipped).toEqual([]);
    expect(fs.readdirSync(path.join(out, 'pdfs')).sort()).toEqual(['a.pdf', 'b.pdf', 'c.pdf']);
  });

  it('an error message is the readable fetch error, not a bare "fetch failed"', async () => {
    const dead = fixture(
      "INSERT INTO urls (id, url, status_code, content_kind) VALUES (1, 'http://127.0.0.1:1/x.pdf', 200, 'pdf');",
    ).db;
    const out = path.join(dir, 'out-dead');
    const r = await exportPdfs(dead, out, opts);
    expect(r.errors.join('\n')).toMatch(/fetch failed -> /);
  });
});
