import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ProjectDb, runMigrations } from '@freecrawl/db';
import { fetchPagespeedAudit, runPagespeedBatch, storePagespeedResult } from './pagespeed.js';

const KEY = 'SECRETKEY-abc123';
const PSI = fs.readFileSync(
  new URL('../../../../packages/core/src/fixtures/psi/lighthouse-13.5.0-trimmed.json', import.meta.url),
  'utf8',
);

let server: http.Server;
let base: string;
const seen: string[] = [];
beforeAll(async () => {
  server = http.createServer((req, res) => {
    seen.push(req.url ?? '');
    if (req.url?.startsWith('/ok')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(PSI);
    } else if (req.url?.startsWith('/echo-error')) {
      // Google-style error that repeats the request URL, key included.
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: `Bad request: http://x/runPagespeed${req.url} was rejected` } }));
    } else if (req.url?.startsWith('/no-message')) {
      res.writeHead(500, { 'content-type': 'text/plain' });
      res.end('boom');
    } else {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ lighthouseResult: { audits: {}, categories: { performance: { score: 1 } } } }));
    }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

describe('B41 R11: the endpoint can be overridden for tests', () => {
  it('reads metrics and audits from the response of the given endpoint', async () => {
    const r = await fetchPagespeedAudit('https://ex.test/a', 'mobile', KEY, { endpoint: `${base}/ok` });
    expect(r.status).toBe('ok');
    expect(r.performance).toBe(Math.round(JSON.parse(PSI).lighthouseResult.categories.performance.score * 100));
    expect(r.audits?.lighthouseVersion).toBe('13.5.0');
    const ids = r.audits!.audits.map((a) => a.auditId);
    expect(ids).toContain('image-delivery-insight');
    expect(ids).toContain('unused-javascript');
    expect(seen.some((u) => u.startsWith('/ok?') && u.includes('strategy=mobile') && u.includes('category=performance'))).toBe(true);
  });

  it('a response with a perfect score still carries an (empty) audits list so old rows get replaced', async () => {
    const r = await fetchPagespeedAudit('https://ex.test/a', 'desktop', undefined, { endpoint: `${base}/clean` });
    expect(r.status).toBe('ok');
    expect(r.audits).toEqual({ lighthouseVersion: null, audits: [] });
  });
});

describe('B41 R10: the key never reaches a stored or logged message', () => {
  it('strips key= from a Google error that echoes the request URL', async () => {
    const r = await fetchPagespeedAudit('https://ex.test/a', 'mobile', KEY, { endpoint: `${base}/echo-error` });
    expect(r.status).toBe('error');
    expect(seen.some((u) => u.includes(`key=${KEY}`))).toBe(true); // the key was sent
    expect(r.error).toContain('Bad request');
    expect(r.error).not.toContain(KEY);
    expect(r.error).not.toContain('key=');
    expect(r.audits).toBeUndefined();
  });

  it('strips the key from a transport error whose message holds the URL', async () => {
    const r = await fetchPagespeedAudit('https://ex.test/a', 'mobile', KEY, { endpoint: 'http://127.0.0.1:1/x' });
    expect(r.status).toBe('error');
    expect(r.error).not.toContain(KEY);
  });

  it('the key also goes if it shows up without the key= prefix', async () => {
    const r = await fetchPagespeedAudit(`https://ex.test/${KEY}`, 'mobile', KEY, { endpoint: `${base}/echo-error` });
    expect(r.error).not.toContain(KEY);
  });

  it('the batch log summary and onResult get the scrubbed text only', async () => {
    const got: (string | null)[] = [];
    await runPagespeedBatch({
      items: [{ url: 'https://ex.test/a', strategy: 'mobile' }],
      apiKey: KEY,
      endpoint: `${base}/echo-error`,
      isCancelled: () => false,
      onResult: (_u, _s, m) => got.push(m.error),
      onProgress: () => {},
    });
    expect(got).toHaveLength(1);
    expect(got[0]).not.toContain(KEY);
  });
});

describe('B41 R5: the fetch result is stored with its audits', () => {
  it('storePagespeedResult writes the metrics row and the audit rows of a successful run', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-b41d-'));
    const file = path.join(dir, 'p.seoproject');
    const raw = new DatabaseSync(file);
    runMigrations(raw);
    raw.exec(`INSERT INTO urls (id, url, is_external, content_kind, status_code) VALUES (1, 'https://ex.test/a', 0, 'html', 200)`);
    raw.close();
    const db = new ProjectDb(file);
    try {
      const ok = await fetchPagespeedAudit('https://ex.test/a', 'mobile', undefined, { endpoint: `${base}/ok` });
      storePagespeedResult(db, 'https://ex.test/a', 'mobile', ok);
      const { rows } = db.queryPagespeedAudits({ url: 'https://ex.test/a', strategy: 'mobile', limit: 100, offset: 0 });
      expect(rows.length).toBe(ok.audits!.audits.length);
      expect(rows[0]!.lighthouseVersion).toBe('13.5.0');
      // a failed re-run overwrites the metrics row and keeps the audits
      const bad = await fetchPagespeedAudit('https://ex.test/a', 'mobile', undefined, { endpoint: `${base}/no-message` });
      storePagespeedResult(db, 'https://ex.test/a', 'mobile', bad);
      expect(db.queryPagespeedAudits({ limit: 100, offset: 0 }).total).toBe(rows.length);
      expect(db.queryPagespeed({ limit: 5, offset: 0 }).rows[0]!.mobile?.status).toBe('error');
    } finally {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
