import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ProjectDb } from '@freecrawl/db';

// B17: screenshots and PDF files out of a project. Drives the built CLI as a
// process (`npx tsc -b` first); the PDF tests serve from a local server.
const CLI = fileURLToPath(new URL('../dist/index.js', import.meta.url));

let dir: string;

function run(args: string[]) {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', timeout: 60_000 });
}

type Out = {
  ok: boolean;
  files: { path: string; rows: number | null }[];
  errors: { label: string; error: string }[];
  skipped: { label: string; reason: string }[];
};

function exportJson(project: string, out: string, what: string, ...extra: string[]) {
  const r = run(['export', '--project', project, '--out', out, '--what', what, '--json', ...extra]);
  return { r, j: JSON.parse(r.stdout) as Out };
}

/** An empty project file; `rows` go in with raw SQL, as in packages/db link-target-reports.test.ts. */
function fixtureProject(name: string, sql: string): string {
  const file = path.join(dir, name);
  new ProjectDb(file).close();
  const raw = new DatabaseSync(file);
  raw.exec(sql);
  raw.close();
  return file;
}

function csvLines(file: string): string[] {
  return fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.length > 0);
}

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-b17-'));
});
afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('screenshots', () => {
  // Only PNGs in the project's own `<file>.screenshots/` folder are copied.
  const shots = (project: string): string => path.join(dir, `${project}.screenshots`);
  const png = (project: string, name: string): string => {
    const p = path.join(shots(project), name);
    fs.mkdirSync(shots(project), { recursive: true });
    fs.writeFileSync(p, Buffer.from(`PNG:${name}`));
    return p;
  };

  it('copies the PNGs and lists them in screenshots.csv; a missing file is an error, the rest are still written', () => {
    const a = png('shots.seoproject', 'a-full.png');
    const b = png('shots.seoproject', 'a-fold.png');
    const missing = path.join(shots('shots.seoproject'), 'gone.png');
    const project = fixtureProject(
      'shots.seoproject',
      `INSERT INTO urls (id, url, status_code) VALUES (1, 'https://ex.com/a', 200), (2, 'https://ex.com/b', 200);
       INSERT INTO url_sources (url_id, body, body_length, screenshot_fullpage_path, screenshot_fold_path)
         VALUES (1, 'x', 1, '${a}', '${b}');
       INSERT INTO url_sources (url_id, body, body_length, screenshot_fullpage_path)
         VALUES (2, 'x', 1, '${missing}');`,
    );
    const out = path.join(dir, 'out-shots');
    const { r, j } = exportJson(project, out, 'screenshots');
    expect(r.status, r.stderr).toBe(1);
    expect(fs.readdirSync(path.join(out, 'screenshots')).sort()).toEqual(['a-fold.png', 'a-fullpage.png']);
    expect(fs.readFileSync(path.join(out, 'screenshots', 'a-fullpage.png'), 'utf8')).toBe('PNG:a-full.png');
    const lines = csvLines(path.join(out, 'screenshots.csv'));
    expect(lines).toHaveLength(3);
    expect(lines[1]).toContain('https://ex.com/a');
    expect(lines.join('\n')).toContain('a-fullpage.png');
    expect(j.errors).toHaveLength(1);
    expect(j.errors[0]!.error).toContain(missing);
  });
  it('two URLs with the same last path segment get different names', () => {
    const a = png('shots-same-stem.seoproject', 'one.png');
    const b = png('shots-same-stem.seoproject', 'two.png');
    const project = fixtureProject(
      'shots-same-stem.seoproject',
      `INSERT INTO urls (id, url, status_code) VALUES (1, 'https://ex.com/a/pricing', 200), (2, 'https://ex.com/b/pricing', 200);
       INSERT INTO url_sources (url_id, body, body_length, screenshot_fullpage_path) VALUES (1, 'x', 1, '${a}'), (2, 'x', 1, '${b}');`,
    );
    const out = path.join(dir, 'out-same-stem');
    const { r, j } = exportJson(project, out, 'screenshots');
    expect(r.status, r.stderr).toBe(0);
    expect(j.errors).toEqual([]);
    const files = fs.readdirSync(path.join(out, 'screenshots'));
    expect(files).toHaveLength(2);
    expect(files).toContain('pricing-fullpage.png');
    expect(new Set(files.map((f) => fs.readFileSync(path.join(out, 'screenshots', f), 'utf8')))).toEqual(
      new Set(['PNG:one.png', 'PNG:two.png']),
    );
    expect(csvLines(path.join(out, 'screenshots.csv'))).toHaveLength(3);
  });

  it('a project without screenshots: explicit request exits 1 with the reason and writes no folder; bulk attempts nothing', () => {
    const project = fixtureProject(
      'no-shots.seoproject',
      `INSERT INTO urls (id, url, status_code, content_kind) VALUES (1, 'https://ex.com/a', 200, 'html');
       INSERT INTO url_sources (url_id, body, body_length) VALUES (1, 'x', 1);`,
    );
    const out = path.join(dir, 'out-no-shots');
    const { r, j } = exportJson(project, out, 'screenshots');
    expect(r.status).toBe(1);
    expect(j.ok).toBe(false);
    expect(j.errors[0]?.error).toMatch(/no screenshots stored/);
    expect(r.stderr).toMatch(/no screenshots stored/);
    expect(fs.existsSync(path.join(out, 'screenshots'))).toBe(false);
    expect(fs.existsSync(path.join(out, 'screenshots.csv'))).toBe(false);

    const bulk = path.join(dir, 'out-no-shots-bulk');
    const b = exportJson(project, bulk, 'bulk');
    expect(b.r.status, b.r.stderr).toBe(0);
    expect(fs.existsSync(path.join(bulk, 'screenshots'))).toBe(false);
    expect(b.j.errors).toEqual([]);
  });
});

// ---- PDF files -------------------------------------------------------------

/** Async twin of `run`: the fixture server lives in this process and must keep answering. */
function runAsync(args: string[]): Promise<{ status: number | null; stdout: string; stderr: string }> {
  const child = spawn(process.execPath, [CLI, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => (stdout += d));
  child.stderr.on('data', (d) => (stderr += d));
  return new Promise((resolve) => child.on('exit', (status) => resolve({ status, stdout, stderr })));
}

/** Binary-looking bytes, so a text round trip would corrupt them. */
const pdfBytes = (tag: string, n = 3000): Buffer =>
  Buffer.concat([Buffer.from(`%PDF-1.4\n%\xff\xfe${tag}\n`, 'latin1'), Buffer.from(Array.from({ length: n }, (_, i) => (i * 7 + tag.length) % 256))]);

describe('pdfs', () => {
  const PDFS: Record<string, Buffer> = {
    '/files/a.pdf': pdfBytes('A'),
    '/files/b.pdf': pdfBytes('B', 4100),
    '/files/gone.pdf': pdfBytes('G'),
    '/files/big.pdf': pdfBytes('BIG'),
    '/files/chunked.pdf': pdfBytes('C', 2500),
  };
  let server: http.Server;
  let base: string;
  // 'broken': gone.pdf answers 404 and big.pdf declares 60 MB; 'clean': everything is served.
  let phase: 'clean' | 'broken' = 'clean';
  let seen: { method: string; url: string; headers: http.IncomingHttpHeaders }[] = [];
  let project: string;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      const url = req.url ?? '/';
      const method = req.method ?? 'GET';
      seen.push({ method, url, headers: req.headers });
      if (url === '/') {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end(
          '<html><head><title>Docs</title></head><body>' +
            Object.keys(PDFS).map((p) => `<a href="${p}">${p}</a>`).join('') +
            '</body></html>',
        );
        return;
      }
      const body = PDFS[url];
      if (!body) return void res.writeHead(404).end();
      if (phase === 'broken' && url === '/files/gone.pdf') return void res.writeHead(404).end();
      if (phase === 'broken' && url === '/files/big.pdf') {
        // Declares 60 MB and sends nothing: the per-file cap must refuse it before reading a byte.
        res.writeHead(200, { 'content-type': 'application/pdf', 'content-length': 60_000_000 });
        res.flushHeaders();
        return;
      }
      if (url === '/files/chunked.pdf') {
        if (method === 'HEAD') {
          res.writeHead(200, { 'content-type': 'application/pdf', 'content-length': body.length });
          return void res.end();
        }
        res.writeHead(200, { 'content-type': 'application/pdf' });
        res.write(body.subarray(0, 1000));
        res.end(body.subarray(1000));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/pdf', 'content-length': body.length });
      res.end(method === 'HEAD' ? undefined : body);
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    project = path.join(dir, 'pdfs.seoproject');
    await runAsync([`${base}/`, '--no-robots', '--db', project, '--json']);
    seen = [];
  }, 90_000);
  afterAll(() => void server.close());

  async function exportPdfs(out: string, ...extra: string[]) {
    seen = [];
    const r = await runAsync(['export', '--project', project, '--out', out, '--what', 'pdfs', '--json', ...extra]);
    return { r, j: JSON.parse(r.stdout) as Out, requests: [...seen] };
  }
  const pdfGets = (reqs: typeof seen) => reqs.filter((q) => q.url.endsWith('.pdf') && q.method === 'GET');

  it('writes the PDFs byte for byte and lists them in pdfs.csv', async () => {
    const out = path.join(dir, 'out-pdfs');
    const { j } = await exportPdfs(out);
    for (const p of ['/files/a.pdf', '/files/b.pdf']) {
      expect(fs.readFileSync(path.join(out, 'pdfs', path.basename(p))).equals(PDFS[p]!)).toBe(true);
    }
    const lines = csvLines(path.join(out, 'pdfs.csv'));
    expect(lines[0]).toContain('url');
    expect(lines.find((l) => l.includes('/files/a.pdf'))).toContain(`${PDFS['/files/a.pdf']!.length}`);
    expect(j.files.some((f) => f.path.endsWith('pdfs.csv'))).toBe(true);
  });
  const pdfRequests = (reqs: typeof seen) => reqs.filter((q) => q.url.endsWith('.pdf'));

  /** A copy of the crawled project whose `lastCrawlConfig` is `config` (raw text). */
  function projectWithConfig(name: string, config: unknown): string {
    const file = path.join(dir, name);
    fs.copyFileSync(project, file);
    const raw = new DatabaseSync(file);
    raw.prepare("INSERT OR REPLACE INTO project_meta (key, value) VALUES ('lastCrawlConfig', ?)").run(JSON.stringify(config));
    raw.close();
    return file;
  }
  async function exportFrom(file: string, out: string, ...extra: string[]) {
    seen = [];
    const r = await runAsync(['export', '--project', file, '--out', out, '--what', 'pdfs', '--json', ...extra]);
    return { r, j: JSON.parse(r.stdout) as Out, requests: [...seen] };
  }

  it('a PDF that now answers 404 is an error, one over the per-file cap is skipped with its reason, a chunked one is written', async () => {
    phase = 'broken';
    try {
      const out = path.join(dir, 'out-pdfs-broken');
      const { r, j, requests } = await exportPdfs(out);
      expect(r.status).toBe(1);
      expect(j.errors.map((e) => e.error).join('\n')).toMatch(/gone\.pdf.*404/);
      expect(j.skipped.map((e) => e.reason).join('\n')).toMatch(/big\.pdf.*per-file cap/);
      expect(fs.existsSync(path.join(out, 'pdfs', 'big.pdf'))).toBe(false);
      expect(fs.existsSync(path.join(out, 'pdfs', 'gone.pdf'))).toBe(false);
      expect(fs.readFileSync(path.join(out, 'pdfs', 'chunked.pdf')).equals(PDFS['/files/chunked.pdf']!)).toBe(true);
      const csv = fs.readFileSync(path.join(out, 'pdfs.csv'), 'utf8');
      expect(csv).toMatch(/gone\.pdf.*failed: HTTP 404/);
      expect(csv).toMatch(/big\.pdf.*per-file cap/);
      // Content-Length is only the file size when nothing is compressed.
      expect(requests.length).toBeGreaterThan(0);
      for (const q of pdfRequests(requests)) expect(q.headers['accept-encoding']).toBe('identity');
    } finally {
      phase = 'clean';
    }
  });

  it('a second run into the same folder downloads nothing again; a chunked file is decided by a HEAD', async () => {
    const out = path.join(dir, 'out-pdfs-resume');
    const first = await exportPdfs(out);
    expect(first.r.status, first.r.stderr).toBe(0);
    expect(pdfGets(first.requests)).toHaveLength(Object.keys(PDFS).length);
    const second = await exportPdfs(out);
    expect(second.r.status, second.r.stderr).toBe(0);
    expect(pdfGets(second.requests)).toEqual([]);
    expect(pdfRequests(second.requests).map((q) => `${q.method} ${q.url}`)).toEqual(['HEAD /files/chunked.pdf']);
    expect(fs.readFileSync(path.join(out, 'pdfs.csv'), 'utf8')).toContain('already present');
  });

  it('a file of the wrong size is downloaded again', async () => {
    const out = path.join(dir, 'out-pdfs-stale');
    fs.mkdirSync(path.join(out, 'pdfs'), { recursive: true });
    fs.writeFileSync(path.join(out, 'pdfs', 'a.pdf'), 'half');
    const { r } = await exportPdfs(out);
    expect(r.status, r.stderr).toBe(0);
    expect(fs.readFileSync(path.join(out, 'pdfs', 'a.pdf')).equals(PDFS['/files/a.pdf']!)).toBe(true);
  });

  describe('crawl config of the project', () => {
    it.each([
      ['basic', { auth: { type: 'basic', username: 'u', password: '' } }],
      ['digest', { auth: { type: 'digest', username: 'u', password: '' } }],
      ['bearer', { auth: { type: 'bearer', token: '' } }],
      ['browser login', { formLogin: { enabled: true, steps: [], mode: 'browser', browser: { passwordValue: '' } } }],
    ])('%s auth with encrypted secrets: no PDF is requested, every row says why, explicit request exits 1', async (_n, partial) => {
      const file = projectWithConfig(`cfg-${_n.replace(' ', '-')}.seoproject`, { __fcEnc: 1, config: partial, secretsEnc: 'AAAA' });
      const out = path.join(dir, `out-cfg-${_n.replace(' ', '-')}`);
      const { r, j, requests } = await exportFrom(file, out);
      expect(pdfRequests(requests)).toEqual([]);
      expect(r.status).toBe(1);
      expect(j.errors).toHaveLength(1);
      expect(j.errors[0]!.error).toMatch(/auth secrets are encrypted by the desktop app/);
      const rows = csvLines(path.join(out, 'pdfs.csv')).slice(1);
      expect(rows).toHaveLength(Object.keys(PDFS).length);
      for (const row of rows) expect(row).toContain('skipped: auth secrets are encrypted by the desktop app');
      expect(fs.existsSync(path.join(out, 'pdfs'))).toBe(false);
      const manifest = JSON.parse(fs.readFileSync(path.join(out, 'manifest.json'), 'utf8')) as { errors: unknown[] };
      expect(manifest.errors).toHaveLength(1);
    });

    it('an envelope whose secrets are only proxy / webhook: downloaded with the user agent and header, one proxy warning', async () => {
      const file = projectWithConfig('cfg-proxy.seoproject', {
        __fcEnc: 1,
        config: { userAgent: 'B17-agent/1', customHeaders: { 'X-B17': 'yes' }, proxyUrl: '', webhookUrl: '', auth: { type: 'none' } },
        secretsEnc: 'AAAA',
      });
      const out = path.join(dir, 'out-cfg-proxy');
      const { r, j, requests } = await exportFrom(file, out);
      expect(r.status, r.stderr).toBe(0);
      expect(j.errors).toEqual([]);
      expect(fs.readdirSync(path.join(out, 'pdfs')).sort()).toEqual(['a.pdf', 'b.pdf', 'big.pdf', 'chunked.pdf', 'gone.pdf']);
      for (const q of pdfRequests(requests)) {
        expect(q.headers['user-agent']).toBe('B17-agent/1');
        expect(q.headers['x-b17']).toBe('yes');
      }
      expect(r.stderr.match(/proxy/g)).toHaveLength(1);
    });

    it('a bare config (as the CLI saves it) sends its custom header; --config overrides the project', async () => {
      const file = projectWithConfig('cfg-bare.seoproject', { customHeaders: { 'X-Bare': '1' } });
      const { r, requests } = await exportFrom(file, path.join(dir, 'out-cfg-bare'));
      expect(r.status, r.stderr).toBe(0);
      for (const q of pdfRequests(requests)) expect(q.headers['x-bare']).toBe('1');

      const cfgFile = path.join(dir, 'export-config.json');
      fs.writeFileSync(cfgFile, JSON.stringify({ config: { customHeaders: { 'X-File': '2' } } }));
      const viaFile = await exportFrom(file, path.join(dir, 'out-cfg-file'), '--config', cfgFile);
      expect(viaFile.r.status, viaFile.r.stderr).toBe(0);
      for (const q of pdfRequests(viaFile.requests)) {
        expect(q.headers['x-file']).toBe('2');
        expect(q.headers['x-bare']).toBeUndefined();
      }
    });
  });

  it('--max-bytes stops the run: what would pass the cap is skipped with a reason', async () => {
    const out = path.join(dir, 'out-pdfs-cap');
    const { j } = await exportPdfs(out, '--max-bytes', '5000');
    expect(fs.readdirSync(path.join(out, 'pdfs'))).toEqual(['a.pdf']);
    expect(j.skipped.length).toBeGreaterThan(0);
    expect(j.skipped.every((s) => /run cap/.test(s.reason))).toBe(true);
  });

  it('a project with no PDF at all: explicit request exits 1 with the reason, nothing written', async () => {
    const empty = fixtureProject('no-pdfs.seoproject', "INSERT INTO urls (id, url, status_code, content_kind) VALUES (1, 'https://ex.com/', 200, 'html');");
    const out = path.join(dir, 'out-no-pdfs');
    const { r, j } = await exportFrom(empty, out);
    expect(r.status).toBe(1);
    expect(j.errors[0]?.error).toMatch(/no PDF files/);
    expect(fs.existsSync(path.join(out, 'pdfs.csv'))).toBe(false);
  });
});

describe('crawl-queue (B17 c)', () => {
  // A `--max` stop ends cleanly and clears the queue (checked: 0 rows), so the
  // stopped project is what a soft stop (Ctrl-C) leaves: rows in crawl_queue.
  it('a stopped project exports the unfetched queue: one CSV row per queued URL', () => {
    const rows = Array.from({ length: 5 }, (_, i) => `('https://ex.com/q/${i}', ${i % 3}, 'https://ex.com/')`);
    const file = fixtureProject(
      'queue.seoproject',
      `INSERT INTO urls (id, url, status_code, content_kind) VALUES (1, 'https://ex.com/', 200, 'html');
       INSERT INTO crawl_queue (url, depth, seed_url) VALUES ${rows.join(', ')};`,
    );
    const out = path.join(dir, 'out-queue');
    const { r, j } = exportJson(file, out, 'dataset:crawl-queue');
    expect(r.status, r.stderr).toBe(0);
    expect(j.errors).toEqual([]);
    const lines = csvLines(path.join(out, 'crawl-queue.csv'));
    expect(lines).toHaveLength(6);
    expect(lines.join('\n')).toContain('https://ex.com/q/4');
  });
});
