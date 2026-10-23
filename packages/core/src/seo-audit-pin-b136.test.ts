import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ProjectDb } from '@freecrawl/db';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { runSeoAuditExport, SEO_AUDIT_HEADERS } from './seo-audit-export.js';

// B136 adds columns to the full pages export only. The Screaming-Frog-compatible
// audit export must stay as it was at b210305: its header row and the bytes of
// a fixed fixture's output are pinned here.
let dir: string;
let db: ProjectDb;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-b136a-'));
  const file = path.join(dir, 'p.seoproject');
  const first = new ProjectDb(file);
  for (const [u, over] of [
    ['head', { titleOutsideHead: 2, hreflangOutsideHead: 1, h2First: 'Same' }],
    ['og', { ogNameAttr: 1, internalUtmLinks: 4, metaNoindexBots: 'bingbot,yandex', h2First: 'Same' }],
    ['gone', { statusCode: 404 }],
  ] as const) {
    first.upsertUrl({
      url: `https://ex.com/${u}`,
      depth: 0,
      statusCode: 200,
      indexability: 'indexable',
      contentKind: 'html',
      title: `Title ${u}`,
      h2Count: 1,
      h2First: u,
      ...(over as Record<string, unknown>),
    });
  }
  first.close();
  const raw = new DatabaseSync(file);
  raw.exec(`UPDATE urls SET pagination_loop = 1 WHERE url = 'https://ex.com/head'`);
  raw.close();
  db = new ProjectDb(file);
});
afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

it('seo-audit: header row and fixture output are unchanged', async () => {
  const out = path.join(dir, 'audit');
  await runSeoAuditExport(db, out);
  const h = createHash('sha256');
  for (const f of fs.readdirSync(out).sort()) h.update(f).update(fs.readFileSync(path.join(out, f), 'utf8').replace(/\d{4}-\d\d-\d\d \d\d:\d\d:\d\d/g, 'TS'));
  const headers = createHash('sha256').update(SEO_AUDIT_HEADERS.join('|')).digest('hex');
  expect([headers, h.digest('hex')]).toEqual(['e65587502bd9f9b2bb6574bfb30a803b24c5a551db168c93286ec25131fe5f4a', 'dfaf5b12fddec6fabf047b06d339b03a3fd7ca5b9bb4b1ae167548ee84d4e2dc']);
});
