import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { PDFDocument, PDFName, PDFString, StandardFonts, type PDFArray } from 'pdf-lib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ProjectDb } from '@freecrawl/db';

// B42 / B155 text part: `freecrawl export --what pdf-text`, driven as a process (`npx tsc -b` first)
// against a local server. Nothing leaves 127.0.0.1.
const CLI = fileURLToPath(new URL('../dist/index.js', import.meta.url));

type Out = {
  ok: boolean;
  files: { path: string; rows: number | null }[];
  errors: { label: string; error: string }[];
  skipped: { label: string; reason: string }[];
};

let dir: string;
let server: http.Server;
let base: string;
let seen: { method: string; url: string; at: number }[] = [];
let projectFile: string;

function runAsync(args: string[]): Promise<{ status: number | null; stdout: string; stderr: string }> {
  const child = spawn(process.execPath, [CLI, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => (stdout += d));
  child.stderr.on('data', (d) => (stderr += d));
  return new Promise((resolve) => child.on('exit', (status) => resolve({ status, stdout, stderr })));
}

async function pdf(pages: string[], links: { page: number; url: string }[]): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  pages.forEach((text, i) => {
    const page = doc.addPage([300, 200]);
    page.drawText(text, { x: 20, y: 100, size: 14, font });
    const refs = links
      .filter((l) => l.page === i + 1)
      .map((l, k) =>
        doc.context.register(
          doc.context.obj({
            Type: 'Annot',
            Subtype: 'Link',
            Rect: [20, 90 - k * 20, 120, 110 - k * 20],
            A: { Type: 'Action', S: 'URI', URI: PDFString.of(l.url) },
          }),
        ),
      );
    if (refs.length > 0) page.node.set(PDFName.of('Annots'), doc.context.obj(refs) as PDFArray);
  });
  return Buffer.from(await doc.save({ useObjectStreams: true }));
}

const PDFS: Record<string, Buffer> = {};
const sql = (strings: TemplateStringsArray, ...v: unknown[]) => strings.reduce((a, s, i) => a + s + (v[i] ?? ''), '');

function makeProject(name: string, pdfRows: string[], config?: unknown): string {
  const file = path.join(dir, name);
  new ProjectDb(file).close();
  const raw = new DatabaseSync(file);
  const inserts = pdfRows.map((p, i) => {
    const len = PDFS[p]?.length ?? 1000;
    return `(${i + 1}, '${base}${p}', 200, 'pdf', 0, ${len})`;
  });
  raw.exec(sql`INSERT INTO urls (id, url, status_code, content_kind, is_external, content_length) VALUES ${inserts.join(', ')};`);
  raw.prepare("INSERT OR REPLACE INTO project_meta (key, value) VALUES ('lastStartUrl', ?)").run(`${base}/`);
  if (config) raw.prepare("INSERT OR REPLACE INTO project_meta (key, value) VALUES ('lastCrawlConfig', ?)").run(JSON.stringify(config));
  raw.close();
  return file;
}

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-b42-'));
  server = http.createServer((req, res) => {
    const url = req.url ?? '/';
    seen.push({ method: req.method ?? 'GET', url, at: Date.now() });
    const body = PDFS[url];
    if (!body) return void res.writeHead(404).end();
    res.writeHead(200, { 'content-type': 'application/pdf', 'content-length': body.length });
    res.end(req.method === 'HEAD' ? undefined : body);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  PDFS['/files/a.pdf'] = await pdf(['Hello PDF world'], [{ page: 1, url: 'https://example.com/a' }]);
  PDFS['/files/b.pdf'] = await pdf(
    ['Page one', 'Page two', 'Page three'],
    [
      { page: 2, url: `${base}/local-page` },
      { page: 3, url: 'https://example.org/z' },
    ],
  );
  // Order of ids is not the order of names: b, gone, a.
  projectFile = makeProject('three.seoproject', ['/files/b.pdf', '/files/gone.pdf', '/files/a.pdf']);
});
afterAll(() => {
  server.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

async function exportWhat(file: string, out: string, what: string, ...extra: string[]) {
  seen = [];
  const r = await runAsync(['export', '--project', file, '--out', out, '--what', what, '--json', ...extra]);
  let j: Out | null = null;
  try {
    j = JSON.parse(r.stdout) as Out;
  } catch {
    /* reported through r */
  }
  return { r, j: j as Out, requests: [...seen] };
}
const pdfRequests = (reqs: typeof seen) => reqs.filter((q) => q.url.endsWith('.pdf'));
const hits = (reqs: typeof seen, suffix: string) => pdfRequests(reqs).filter((q) => q.url.endsWith(suffix)).length;
const jsonl = (out: string) =>
  fs
    .readFileSync(path.join(out, 'pdf-text.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);

describe('freecrawl export --what pdf-text', () => {
  it('writes pdf-text.jsonl (one line per PDF, crawl order) and pdf-links.csv, at 2 requests/s', async () => {
    const out = path.join(dir, 'out-text');
    const { r, j, requests } = await exportWhat(projectFile, out, 'pdf-text');
    // The 404 is a failed download: an error entry and exit 1, as for --what pdfs.
    expect(r.status, r.stderr).toBe(1);
    expect(j.errors.map((e) => e.error).join('\n')).toMatch(/gone\.pdf.*HTTP 404/);
    const lines = jsonl(out);
    expect(lines.map((l) => (l.url as string).replace(base, ''))).toEqual(['/files/b.pdf', '/files/gone.pdf', '/files/a.pdf']);
    expect(lines.map((l) => l.status)).toEqual(['ok', 'error: HTTP 404', 'ok']);
    expect(Object.keys(lines[0]!)).toEqual(['url', 'file', 'pages', 'chars', 'truncated', 'status', 'text']);
    expect(lines[0]).toMatchObject({ file: 'pdfs/b.pdf', pages: 3, truncated: false });
    expect((lines[0]!.text as string).split('\f').map((t) => t.trim())).toEqual(['Page one', 'Page two', 'Page three']);
    expect(lines[0]!.chars).toBe((lines[0]!.text as string).length);
    expect(lines[1]).toMatchObject({ file: '', pages: null, chars: null, text: '' });
    expect(lines[2]!.text).toContain('Hello PDF world');
    // The PDFs stay in pdfs/ so a later --what pdfs finds them.
    expect(fs.readdirSync(path.join(out, 'pdfs')).sort()).toEqual(['a.pdf', 'b.pdf']);

    const csv = fs.readFileSync(path.join(out, 'pdf-links.csv'), 'utf8').replace(/^\uFEFF/, '').split('\n').filter(Boolean);
    expect(csv).toEqual([
      'pdf_url,page,link_url,is_internal',
      `${base}/files/b.pdf,2,${base}/local-page,true`,
      `${base}/files/b.pdf,3,https://example.org/z,false`,
      `${base}/files/a.pdf,1,https://example.com/a,false`,
    ]);

    // At most one request per PDF, 2 per second.
    const reqs = pdfRequests(requests);
    expect(reqs).toHaveLength(3);
    for (let i = 1; i < reqs.length; i++) expect(reqs[i]!.at - reqs[i - 1]!.at).toBeGreaterThanOrEqual(450);
  }, 30_000);

  it('--what pdfs,pdf-text and pdf-text,pdfs fetch each PDF once and leave pdfs.csv as the run with pdfs alone', async () => {
    const alone = path.join(dir, 'out-pdfs-alone');
    await exportWhat(projectFile, alone, 'pdfs');
    const want = fs.readFileSync(path.join(alone, 'pdfs.csv'));
    for (const what of ['pdfs,pdf-text', 'pdf-text,pdfs']) {
      const out = path.join(dir, `out-${what.replace(',', '-')}`);
      const { requests } = await exportWhat(projectFile, out, what);
      for (const f of ['/files/a.pdf', '/files/b.pdf', '/files/gone.pdf']) expect(hits(requests, f), `${what} ${f}`).toBe(1);
      expect(fs.readFileSync(path.join(out, 'pdfs.csv')).equals(want), what).toBe(true);
      expect(jsonl(out).map((l) => l.status)).toEqual(['ok', 'error: HTTP 404', 'ok']);
    }
  }, 60_000);

  it('config the PDFs cannot be fetched with: no request, every line says skipped', async () => {
    const file = makeProject(
      'auth.seoproject',
      ['/files/a.pdf', '/files/b.pdf'],
      { __fcEnc: 1, config: { auth: { type: 'basic', username: 'u', password: '' } }, secretsEnc: 'AAAA' },
    );
    const out = path.join(dir, 'out-auth');
    const { r, requests } = await exportWhat(file, out, 'pdf-text');
    expect(pdfRequests(requests)).toEqual([]);
    expect(r.status).toBe(1); // same rule as pdfs: the run reports it as an error
    const lines = jsonl(out);
    expect(lines).toHaveLength(2);
    for (const l of lines) expect(l.status).toMatch(/^skipped: auth secrets are encrypted/);
    // pdf-links.csv is always written next to the jsonl: the header alone when no PDF gave a link.
    expect(fs.readFileSync(path.join(out, 'pdf-links.csv'), 'utf8').replace(/^\uFEFF/, '')).toBe(
      'pdf_url,page,link_url,is_internal\n',
    );
  });

  it('a crawl without PDFs gives the same exit code and message as --what pdfs, and no file', async () => {
    const empty = path.join(dir, 'empty.seoproject');
    new ProjectDb(empty).close();
    const a = await exportWhat(empty, path.join(dir, 'out-empty-pdfs'), 'pdfs');
    const b = await exportWhat(empty, path.join(dir, 'out-empty-text'), 'pdf-text');
    expect(b.r.status).toBe(a.r.status);
    expect(a.r.status).toBe(1);
    expect(b.j.errors.map((e) => e.error)).toEqual(a.j.errors.map((e) => e.error));
    expect(b.j.errors[0]!.error).toBe('no PDF files in this crawl');
    expect(fs.existsSync(path.join(dir, 'out-empty-text', 'pdf-text.jsonl'))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'out-empty-text', 'pdf-links.csv'))).toBe(false);
  });

  it('manifest.json lists both files with rows, ms and peakRssMb', async () => {
    const out = path.join(dir, 'out-manifest');
    await exportWhat(projectFile, out, 'pdf-text');
    const m = JSON.parse(fs.readFileSync(path.join(out, 'manifest.json'), 'utf8')) as {
      what: string[];
      files: { path: string; rows: number | null; ms: number; peakRssMb: number }[];
    };
    expect(m.what).toEqual(['pdf-text']);
    expect(m.files.map((f) => [f.path, f.rows])).toEqual([
      ['pdf-text.jsonl', 3],
      ['pdf-links.csv', 3],
    ]);
    for (const f of m.files) {
      expect(f.ms).toBeGreaterThanOrEqual(0);
      expect(f.peakRssMb).toBeGreaterThan(0);
    }
  }, 30_000);

  it('--help describes pdf-text and an unknown --what entry lists it', async () => {
    const help = await runAsync(['--help']);
    expect(help.stdout).toMatch(/pdf-text\s+pdf-text\.jsonl \(url, file, pages, chars, truncated, status, text/);
    expect(help.stdout).toContain('pdf-links.csv (pdf_url, page, link_url, is_internal)');
    expect(help.stdout).toMatch(/--config <file>\s+With --what pdfs or pdf-text/);
    const bad = await exportWhat(projectFile, path.join(dir, 'out-bad'), 'nonsense');
    expect(bad.r.stdout + bad.r.stderr).toMatch(/Unknown --what entry: nonsense \(expected: .*pdf-text/);
  });
});
