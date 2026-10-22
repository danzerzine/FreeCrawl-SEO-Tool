import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ProjectDb } from '@freecrawl/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildTools } from './tools.js';

const HOST = 'https:ex.test:443';
const A = 'https://ex.test/a';
const GONE = 'https://ex.test/gone';

let dir: string;
let db: ProjectDb;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-b39m-'));
  const file = path.join(dir, 'p.seoproject');
  new ProjectDb(file).close();
  const raw = new DatabaseSync(file);
  raw.exec(`INSERT INTO urls (id, url, status_code, content_type, indexability, content_kind, is_external)
            VALUES (1,'${A}',200,'text/html','indexable','html',0)`);
  raw.close();
  db = new ProjectDb(file);
  const e = (url: string) => ({
    url, title: null, event: 'REMOVED_FROM_SEARCH', reason: 'HTTP_ERROR', badHttpStatus: 404, targetUrl: null,
    eventDate: '2026-10-01T00:00:00.000Z', lastAccess: null,
  });
  db.upsertWebmasterEvents(HOST, [e(A), e(GONE)], 't');
  db.upsertWebmasterBrokenLinks(HOST, [{ sourceUrl: A, destinationUrl: GONE, discoveryDate: null, sourceLastAccessDate: null }], 't');
  db.setMeta(`webmasterFetchMeta:${HOST}`, JSON.stringify({ hostName: 'ex.test', eventRows: 2, brokenLinkRows: 1, truncatedAtCap: false }));
});
afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const tool = () => buildTools().find((t) => t.name === 'query_webmaster')!;
interface Row {
  url: string;
  crawlStatusCode?: number | null;
  reason?: string;
  sourceUrl?: string;
  destinationUrl?: string;
  seenByCrawl?: boolean;
}
interface Out {
  hostId: string;
  total: number;
  rows: Row[];
  meta: Record<string, unknown> | null;
}
const run = (args: Record<string, unknown>) => tool().handler(args, db) as Out;

describe('query_webmaster (B39, the only Webmaster MCP tool)', () => {
  it('is the only Webmaster tool', () => {
    expect(buildTools().filter((t) => /webmaster/i.test(t.name)).map((t) => t.name)).toEqual(['query_webmaster']);
  });

  it('reads the excluded view of the saved host with meta', async () => {
    db.setMeta('integrationSettings:webmaster', JSON.stringify({ hostId: HOST, hostName: 'ex.test' }));
    const r = await run({ view: 'excluded' });
    expect(r.hostId).toBe(HOST);
    expect(r.total).toBe(2);
    expect(r.rows.find((x: Row) => x.url === A)).toMatchObject({ crawlStatusCode: 200, reason: 'HTTP_ERROR' });
    expect(r.meta).toMatchObject({ hostName: 'ex.test', truncatedAtCap: false });
  });

  it('filters and pages', async () => {
    const r = await run({ view: 'excluded', hostId: HOST, filter: 'not-in-crawl', limit: 1 });
    expect(r.rows.map((x: Row) => x.url)).toEqual([GONE]);
    const b = await run({ view: 'broken-links', hostId: HOST, filter: 'not-seen-by-crawl' });
    expect(b.rows).toHaveLength(1);
    expect(b.rows[0]).toMatchObject({ sourceUrl: A, destinationUrl: GONE, seenByCrawl: false });
  });

  it('a host with no stored data is a clear error that lists the stored hosts', async () => {
    await expect(Promise.resolve().then(() => run({ view: 'excluded', hostId: 'https:nope.test:443' }))).rejects.toThrow(
      /no Yandex Webmaster data.*https:nope\.test:443.*https:ex\.test:443/i,
    );
  });

  it('no host given and none saved is a clear error', async () => {
    await expect(Promise.resolve().then(() => run({ view: 'excluded' }))).rejects.toThrow(/host/i);
  });

  it('an unknown view is rejected', async () => {
    await expect(Promise.resolve().then(() => run({ view: 'whatever', hostId: HOST }))).rejects.toThrow(/view/i);
  });
});
