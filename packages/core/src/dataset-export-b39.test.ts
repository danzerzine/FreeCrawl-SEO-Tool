import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ProjectDb } from '@freecrawl/db';
import { EXPORT_DATASET_COLUMNS } from '@freecrawl/shared-types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { datasetRows, readCell } from './dataset-export.js';
import { CLI_EXPORT_DATASETS } from './export-items.js';

const HOST = 'https:ex.test:443';
const A = 'https://ex.test/a';
const B = 'https://ex.test/b';
const GONE = 'https://ex.test/gone';

let dir: string;
let db: ProjectDb;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-b39x-'));
  const file = path.join(dir, 'p.seoproject');
  new ProjectDb(file).close();
  const raw = new DatabaseSync(file);
  raw.exec(`
    INSERT INTO urls (id, url, status_code, content_type, indexability, content_kind, is_external) VALUES
      (1,'${A}',200,'text/html','indexable','html',0),
      (2,'${B}',404,'text/html','non-indexable','html',0);
    INSERT INTO links (from_url_id, to_url, is_internal) VALUES (1,'${B}',1);
  `);
  raw.close();
  db = new ProjectDb(file);
  const e = (url: string, over = {}) => ({
    url, title: null, event: 'REMOVED_FROM_SEARCH', reason: 'HTTP_ERROR', badHttpStatus: 404, targetUrl: null,
    eventDate: '2026-10-01T00:00:00.000Z', lastAccess: '2026-10-02T00:00:00.000Z', ...over,
  });
  db.upsertWebmasterEvents(
    HOST,
    [e(A, { reason: 'NOT_CANONICAL', badHttpStatus: null, targetUrl: 'https://ex.test/canon' }), e(GONE, { eventDate: '2026-09-01T00:00:00.000Z' }), e(B, { event: 'APPEARED_IN_SEARCH' })],
    't',
  );
  db.upsertWebmasterEvents('other:host:443', [e('https://other.test/x')], 't');
  const l = (s: string, d: string) => ({ sourceUrl: s, destinationUrl: d, discoveryDate: '2026-10-01T00:00:00.000Z', sourceLastAccessDate: '2026-10-02T00:00:00.000Z' });
  db.upsertWebmasterBrokenLinks(HOST, [l(A, B), l(A, GONE)], 't');
});
afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const table = (key: 'webmaster' | 'webmaster-broken-links', host: string | null = HOST) =>
  [...datasetRows(db, key, { webmasterHostId: host ?? undefined })].map((r) =>
    EXPORT_DATASET_COLUMNS[key].map((c) => readCell(r, c.key)),
  );

describe('webmaster datasets (B39)', () => {
  it('excluded pages: static columns, only REMOVED events of the host, crawl status next to them', () => {
    expect(EXPORT_DATASET_COLUMNS.webmaster.map((c) => c.header)).toEqual([
      'URL', 'Yandex Reason', 'Yandex HTTP Status', 'Yandex Target URL', 'Event Date', 'Last Access', 'Crawl Status', 'Crawl Indexability',
    ]);
    expect(table('webmaster')).toEqual([
      [A, 'NOT_CANONICAL', null, 'https://ex.test/canon', '2026-10-01T00:00:00.000Z', '2026-10-02T00:00:00.000Z', 200, 'indexable'],
      [GONE, 'HTTP_ERROR', 404, null, '2026-09-01T00:00:00.000Z', '2026-10-02T00:00:00.000Z', null, null],
    ]);
  });

  it('broken links: source, destination, dates, crawl status of the destination and the also-in-crawl flag', () => {
    expect(EXPORT_DATASET_COLUMNS['webmaster-broken-links'].map((c) => c.header)).toEqual([
      'Source URL', 'Destination URL', 'Discovered', 'Source Last Access', 'Destination Crawl Status', 'Also In Crawl Broken Links',
    ]);
    expect(table('webmaster-broken-links')).toEqual([
      [A, B, '2026-10-01T00:00:00.000Z', '2026-10-02T00:00:00.000Z', 404, true],
      [A, GONE, '2026-10-01T00:00:00.000Z', '2026-10-02T00:00:00.000Z', null, false],
    ]);
  });

  it('the export context host picks the rows; another host has its own; none gives nothing', () => {
    expect(table('webmaster', 'other:host:443').map((r) => r[0])).toEqual(['https://other.test/x']);
    expect(table('webmaster', null)).toEqual([]);
    expect(table('webmaster-broken-links', 'other:host:443')).toEqual([]);
  });

  it('is an account dataset: the CLI does not offer it', () => {
    expect(CLI_EXPORT_DATASETS).not.toContain('webmaster');
    expect(CLI_EXPORT_DATASETS).not.toContain('webmaster-broken-links');
  });
});
