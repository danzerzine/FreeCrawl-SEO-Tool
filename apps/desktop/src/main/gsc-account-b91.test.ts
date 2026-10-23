import { DatabaseSync } from 'node:sqlite';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ProjectDb } from '@freecrawl/db';
import { datasetRows } from '@freecrawl/core';
import { mergeGscSettings, type GscIntegrationSettings } from '@freecrawl/shared-types';
import {
  gscCrawlNewUrlCandidates,
  gscExportContext,
  gscReadAccount,
  gscTabQuery,
  type GscReadEnv,
} from './gsc-account.js';

const A = 'https://ex.test/a';
const B = 'https://ex.test/b';
const ORPHAN = 'https://ex.test/only-in-bq';

let dir: string;
let file: string;
let db: ProjectDb;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-b91acc-'));
  file = path.join(dir, 'p.seoproject');
  new ProjectDb(file).close();
  const raw = new DatabaseSync(file);
  raw.exec(`INSERT INTO urls (id, url, status_code, content_type, indexability) VALUES
    (1,'${A}',200,'text/html','indexable'),(2,'${B}',200,'text/html','indexable')`);
  raw.close();
  db = new ProjectDb(file);
  // API account: small numbers. bq: big numbers plus a URL the crawl never saw.
  db.replaceGscResults([{ url: A, clicks: 1, impressions: 10, ctr: 0.1, position: 3 }], '2026-10-01T00:00:00Z', 'google-acc');
  db.replaceGscResults(
    [
      { url: A, clicks: 100, impressions: 1000, ctr: 0.1, position: 4 },
      { url: ORPHAN, clicks: 5, impressions: 50, ctr: 0.1, position: 9 },
    ],
    '2026-10-02T00:00:00Z',
    'bq',
  );
});
afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

/** An env whose OAuth resolver answers `oauth` ('' = no account linked). */
function env(over: Partial<GscIntegrationSettings>, oauth: string): GscReadEnv & { oauthCalls: string[] } {
  const oauthCalls: string[] = [];
  return {
    oauthCalls,
    settings: mergeGscSettings({ matchSlash: true, ...over }),
    resolveGoogleAccount: (_id, requested) => {
      oauthCalls.push(requested ?? '');
      return oauth;
    },
  };
}

describe('gscReadAccount (r1 H2)', () => {
  it('is bq for the BigQuery source, linked account or not, and never asks OAuth', () => {
    for (const oauth of ['google-acc', '']) {
      const e = env({ source: 'bigquery' }, oauth);
      expect(gscReadAccount(e, 'whatever')).toBe('bq');
      expect(e.oauthCalls).toEqual([]);
    }
  });

  it('is the OAuth resolution for the API source and passes the requested id on', () => {
    const e = env({ source: 'api' }, 'google-acc');
    expect(gscReadAccount(e, 'x')).toBe('google-acc');
    expect(e.oauthCalls).toEqual(['x']);
  });
});

describe('read entry points return the bq rows (r1 H2)', () => {
  const query = (e: GscReadEnv) =>
    gscTabQuery(
      {
        ...e,
        queryGsc: async (p) => db.queryGsc(p),
        getMeta: (k) => db.getMeta(k),
      },
      { limit: 100, offset: 0 },
    );

  for (const oauth of ['google-acc', '']) {
    const label = oauth ? 'with an API account linked' : 'with NO OAuth account linked';

    it(`the tab query and its meta ${label}`, async () => {
      db.setMeta('gscFetchMeta:bq', JSON.stringify({ property: 'sc-domain:ex.test', source: 'bigquery' }));
      db.setMeta('gscFetchMeta:google-acc', JSON.stringify({ property: 'api-prop' }));
      const res = await query(env({ source: 'bigquery' }, oauth));
      const a = res.rows.find((r) => r.url === A)!;
      expect(a.gsc?.clicks).toBe(100);
      expect(res.meta?.property).toBe('sc-domain:ex.test');
      expect(res.meta?.source).toBe('bigquery');
    });

    it(`the search-console export ${label}`, () => {
      const ctx = gscExportContext(env({ source: 'bigquery' }, oauth));
      const rows = [...datasetRows(db, 'search-console', ctx)] as { url: string; gsc?: { clicks?: number } }[];
      expect(rows.find((r) => r.url === A)?.gsc?.clicks).toBe(100);
    });

    it(`gscCrawlNewUrls candidates ${label}`, () => {
      const urls = gscCrawlNewUrlCandidates(env({ source: 'bigquery' }, oauth), db);
      expect(urls).toEqual([ORPHAN]);
    });

    it(`the detail panel ${label}`, () => {
      const acc = gscReadAccount(env({ source: 'bigquery' }, oauth));
      expect(db.getUrlAnalytics(A, acc, '', '')?.gsc?.clicks).toBe(100);
    });
  }

  it('with source api the same entry points return the API rows', async () => {
    const res = await query(env({ source: 'api' }, 'google-acc'));
    expect(res.rows.find((r) => r.url === A)!.gsc?.clicks).toBe(1);
    const ctx = gscExportContext(env({ source: 'api' }, 'google-acc'));
    const rows = [...datasetRows(db, 'search-console', ctx)] as { url: string; gsc?: { clicks?: number } }[];
    expect(rows.find((r) => r.url === A)?.gsc?.clicks).toBe(1);
    expect(gscCrawlNewUrlCandidates(env({ source: 'api' }, 'google-acc'), db)).toEqual([]);
  });

  it('latestGoogleAccountId never returns bq', () => {
    // bq is the newest pull here; the answer is still the API account
    expect(db.latestGoogleAccountId('gsc_results')).toBe('google-acc');
  });

  it('bq rows join crawled URLs with matchSlash and matchCase like API rows', async () => {
    const raw = new DatabaseSync(file);
    raw.exec(`INSERT INTO urls (id, url, status_code, content_type, indexability) VALUES (3,'https://ex.test/Case/',200,'text/html','indexable')`);
    raw.close();
    db.close();
    db = new ProjectDb(file);
    db.replaceGscResults([{ url: 'https://ex.test/case', clicks: 7, impressions: 70, ctr: 0.1, position: 2 }], 'now', 'bq');
    const res = await gscTabQuery(
      { ...env({ source: 'bigquery', matchSlash: true, matchCase: true }, ''), queryGsc: async (p) => db.queryGsc(p), getMeta: (k) => db.getMeta(k) },
      { limit: 100, offset: 0 },
    );
    expect(res.rows.find((r) => r.url === 'https://ex.test/Case/')?.gsc?.clicks).toBe(7);
  });
});

describe('source text: only gsc-account.ts and the API-only sites resolve an OAuth account', () => {
  // Changes only with a review note (spec B91, r2 L3).
  const ALLOWED_INDEX = [
    "const account = resolveGoogleAccount('gsc', accountId);", // list sites
    "const accountId = resolveGoogleAccount('gsc', input.accountId);", // gscFetch pull
    "const inspectAccountId = resolveGoogleAccount('gsc', input.accountId);", // URL Inspection
    "resolveGoogleAccount('gsc', input.accountId),", // URL Inspection (second site)
    "const accountId = resolveGoogleAccount('gsc', i.accountId);", // bridge pull
    "resolveGoogleAccount: (_id, requested) => resolveGoogleAccount('gsc', requested),", // the adapter handed to gscReadAccount
  ];
  const root = path.resolve(__dirname, '../../../..');
  const hits = (rel: string) =>
    fs
      .readFileSync(path.join(root, rel), 'utf8')
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.includes("resolveGoogleAccount('gsc'"));

  it('index.ts has exactly the named API-only sites', () => {
    expect(hits('apps/desktop/src/main/index.ts').sort()).toEqual([...ALLOWED_INDEX].sort());
  });

  it('no other main-process or MCP file asks for the OAuth account directly', () => {
    for (const rel of fs.readdirSync(path.join(root, 'apps/desktop/src/main'))) {
      if (!rel.endsWith('.ts') || rel.endsWith('.test.ts') || rel === 'index.ts' || rel === 'gsc-account.ts') continue;
      expect(hits(`apps/desktop/src/main/${rel}`), rel).toEqual([]);
    }
    expect(hits('apps/mcp-server/src/tools.ts')).toEqual([]);
  });
});
