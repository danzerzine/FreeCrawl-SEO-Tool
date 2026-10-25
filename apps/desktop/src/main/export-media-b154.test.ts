import * as fs from 'node:fs';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ProjectDb } from '@freecrawl/db';
import { DEFAULT_CRAWL_CONFIG } from '@freecrawl/shared-types';
import {
  CLI_ONLY_EXPORTS,
  desktopPdfOptions,
  exportSetChoices,
  pdfExportMaxBytes,
  runDesktopExportItems,
  runSavedExportSet,
  saveDesktopExportSet,
  setPdfExportMaxBytes,
} from './export-sets.js';
import { runScheduledExport } from './scheduled-export.js';
import { parseExportWhat } from '@freecrawl/core';

// B154: the PDF files and screenshots exports run from the desktop app, its
// export sets and its schedules, with the requests built from the app's own
// crawl config (user agent, headers, auth) and the project's byte cap.
// `pdf-text` stays command-line only. Nothing leaves 127.0.0.1.
let dir: string;
let server: http.Server;
let base: string;
let seen: { url: string; headers: http.IncomingHttpHeaders }[] = [];
const BODY = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(2000, 32), Buffer.from('\n%%EOF\n')]);

function makeProject(name: string): ProjectDb {
  const file = path.join(dir, name);
  new ProjectDb(file).close();
  const raw = new DatabaseSync(file);
  raw.exec(
    `INSERT INTO urls (id, url, status_code, content_kind, is_external, content_length) VALUES
       (1, '${base}/files/a.pdf', 200, 'pdf', 0, ${BODY.length}),
       (2, '${base}/files/b.pdf', 200, 'pdf', 0, ${BODY.length});`,
  );
  raw.close();
  return new ProjectDb(file);
}

const config = {
  ...DEFAULT_CRAWL_CONFIG,
  userAgent: 'FreeCrawl-B154-Test',
  customHeaders: { 'X-Team': 'seo' },
};

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-b154-'));
  server = http.createServer((req, res) => {
    seen.push({ url: req.url ?? '', headers: req.headers });
    if (!req.url?.endsWith('.pdf')) return void res.writeHead(404).end();
    res.writeHead(200, { 'content-type': 'application/pdf', 'content-length': BODY.length });
    res.end(req.method === 'HEAD' ? undefined : BODY);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => {
  server.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('PDF files and screenshots in the desktop app (B154)', () => {
  it('only pdf-text stays command-line only; the set editor offers pdfs and screenshots', () => {
    expect([...CLI_ONLY_EXPORTS]).toEqual(['pdf-text']);
    const exportsGroup = exportSetChoices().find((g) => g.group === 'exports')!;
    const tokens = exportsGroup.choices.map((c) => c.token);
    expect(tokens).toEqual(expect.arrayContaining(['pdfs', 'screenshots']));
    expect(tokens).not.toContain('pdf-text');
  });

  it('a set with pdfs and screenshots saves from the desktop; pdf-text is still refused', () => {
    const db = makeProject('save.seoproject');
    try {
      expect(saveDesktopExportSet(db, { name: 'media', what: ['issues', 'pdfs', 'screenshots'] }).what).toEqual([
        'issues',
        'pdfs',
        'screenshots',
      ]);
      expect(() => saveDesktopExportSet(db, { name: 'text', what: ['pdf-text'] })).toThrow(/"pdf-text"/);
    } finally {
      db.close();
    }
  });

  it('the byte cap is stored in the project; none stored reads as the 2 GB default', () => {
    const db = makeProject('cap.seoproject');
    try {
      expect(pdfExportMaxBytes(db)).toBe(2 * 1024 * 1024 * 1024);
      setPdfExportMaxBytes(db, 5_000_000);
      expect(pdfExportMaxBytes(db)).toBe(5_000_000);
      expect(() => setPdfExportMaxBytes(db, 0)).toThrow();
      expect(desktopPdfOptions(config, db)).toEqual({
        pdfs: { crawlConfig: { config, secretsEnc: false }, maxBytes: 5_000_000 },
      });
    } finally {
      db.close();
    }
  });

  it('a saved set with pdfs downloads them with the app config user agent and headers', async () => {
    const db = makeProject('set.seoproject');
    try {
      saveDesktopExportSet(db, { name: 'media', what: ['pdfs'] });
      const out = path.join(dir, 'set-out');
      seen = [];
      const r = await runSavedExportSet(db, out, 'media', desktopPdfOptions(config, db));
      expect(r.errors).toEqual([]);
      expect(fs.readdirSync(path.join(out, 'pdfs')).sort()).toEqual(['a.pdf', 'b.pdf']);
      expect(r.files.map((f) => path.basename(f.path))).toContain('pdfs.csv');
      const gets = seen.filter((s) => s.url.endsWith('.pdf'));
      expect(gets.length).toBeGreaterThan(0);
      for (const g of gets) {
        expect(g.headers['user-agent']).toBe('FreeCrawl-B154-Test');
        expect(g.headers['x-team']).toBe('seo');
      }
    } finally {
      db.close();
    }
  }, 20_000);

  it('the project byte cap stops the downloads', async () => {
    const db = makeProject('capped.seoproject');
    try {
      setPdfExportMaxBytes(db, BODY.length + 10);
      const out = path.join(dir, 'capped-out');
      const r = await runDesktopExportItems(db, out, parseExportWhat('pdfs'), desktopPdfOptions(config, db));
      expect(fs.readdirSync(path.join(out, 'pdfs'))).toHaveLength(1);
      expect(r.skipped.map((s) => s.reason).join('\n')).toMatch(/run cap/);
    } finally {
      db.close();
    }
  }, 20_000);

  it('a schedule running a set with pdfs writes them, with the config it is handed', async () => {
    const db = makeProject('sched.seoproject');
    try {
      saveDesktopExportSet(db, { name: 'media', what: ['pdfs'] });
      const out = path.join(dir, 'sched-out');
      fs.mkdirSync(out);
      seen = [];
      const r = await runScheduledExport(
        db,
        { export: 'set', exportSet: 'media', outputDir: dir, sheets: false, webhook: false },
        { exportDir: out, toolVersion: 'test', writePdf: async () => {}, ...desktopPdfOptions(config, db) },
      );
      expect(r.errors).toEqual([]);
      expect(fs.readdirSync(path.join(out, 'pdfs')).sort()).toEqual(['a.pdf', 'b.pdf']);
      expect(seen.find((s) => s.url.endsWith('.pdf'))?.headers['user-agent']).toBe('FreeCrawl-B154-Test');
    } finally {
      db.close();
    }
  }, 20_000);
});
