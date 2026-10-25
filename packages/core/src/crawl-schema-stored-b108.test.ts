import { createServer, type Server } from 'node:http';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ProjectDb } from '@freecrawl/db';
import { DEFAULT_CRAWL_CONFIG } from '@freecrawl/shared-types';
import { compareCrawls } from './compare.js';
import { Crawler } from './crawler.js';

// B108 wiring: Crawler.start() passes `continued` to db.beginSchemaTypesCrawl. The DB-level
// tests cannot see that argument flip, so these two run a real crawl and read the result.
const HTML = (links: string): string =>
  `<html><head><title>T</title></head><body><h1>H</h1>${links}</body></html>`;
const PAGES: Record<string, string> = {
  '/': HTML('<a href="/a">a</a><a href="/b">b</a>'),
  '/a': HTML(''),
  '/b': HTML(''),
};
let server: Server;
let dir: string;
let base: string;
/** Called when the server is asked for /a, before it answers (B108b stops the crawl there). */
let onA: (() => void) | null = null;
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'fc-b108c-'));
  server = createServer((req, res) => {
    if (req.url === '/a') onA?.();
    const html = PAGES[req.url ?? '/'];
    if (html === undefined) return void res.writeHead(404).end('nope');
    res.writeHead(200, { 'content-type': 'text/html' }).end(html);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(() => {
  server.close();
  rmSync(dir, { recursive: true, force: true });
});

async function crawl(db: ProjectDb, resumeOnly = false, stopAtA = false): Promise<void> {
  const c = new Crawler(
    {
      ...DEFAULT_CRAWL_CONFIG,
      startUrl: `${base}/`,
      renderingMode: 'text',
      maxConcurrency: 1,
      discoverSitemaps: false,
      checkExternalLinks: false,
      probeTlsCerts: false,
      probeManifestJson: false,
      probeSocialImages: false,
      probeImageSizes: false,
    },
    db,
    { resumeOnly },
  );
  c.on('error', () => {});
  onA = stopAtA ? () => c.stop() : null;
  try {
    await c.start();
  } finally {
    onA = null;
  }
}

/** A project crawled before 25.04.2026: no stored key, no partial marker, empty schema columns. */
async function oldProject(file: string): Promise<ProjectDb> {
  const db = new ProjectDb(file);
  await crawl(db);
  db.close();
  const raw = new DatabaseSync(file);
  raw.exec(
    `DELETE FROM project_meta WHERE key IN ('schemaTypesStored', 'schemaTypesPartial');
     UPDATE urls SET schema_types = NULL, schema_block_count = 0;`,
  );
  raw.close();
  return new ProjectDb(file);
}

describe('crawl start records whether structured data is stored (B108)', () => {
  it('a fresh crawl and a refresh of pages without markup stay stored and comparable', async () => {
    const fileB = join(dir, 'fresh-b.seoproject');
    const fileA = join(dir, 'fresh-a.seoproject');
    let db = new ProjectDb(fileB);
    await crawl(db);
    expect(db.schemaTypesStored()).toBe(true);
    db.close();
    copyFileSync(fileB, fileA);
    db = new ProjectDb(fileB);
    await crawl(db); // same start URL: a refresh
    expect(db.schemaTypesStored()).toBe(true);
    const a = new ProjectDb(fileA);
    try {
      expect(a.schemaTypesStored()).toBe(true);
      const s = compareCrawls(a, db);
      expect(s.notComparable.structured_data).toBeUndefined();
    } finally {
      a.close();
      db.close();
    }
  });

  it('a continued crawl of a project that never stored structured data marks it partial', async () => {
    const file = join(dir, 'old.seoproject');
    let db = new ProjectDb(file);
    await crawl(db);
    db.close();
    // Make it an old project: no stored key, no partial marker, empty schema columns.
    const raw = new DatabaseSync(file);
    raw.exec(
      `DELETE FROM project_meta WHERE key IN ('schemaTypesStored', 'schemaTypesPartial');
       UPDATE urls SET schema_types = NULL, schema_block_count = 0;`,
    );
    raw.close();
    db = new ProjectDb(file);
    try {
      expect(db.schemaTypesStored()).toBe(false);
      await crawl(db, true); // resume: a continued crawl
      expect(db.getMeta('schemaTypesPartial')).toBe('1');
      expect(db.schemaTypesStored()).toBe(false);
    } finally {
      db.close();
    }
  });

  it('a refresh of an old project stopped halfway leaves it partial, a finished one marks it stored (B108b)', async () => {
    const db = await oldProject(join(dir, 'refresh-old.seoproject'));
    try {
      expect(db.schemaTypesStored()).toBe(false);
      await crawl(db, false, true); // same start URL: a refresh, stopped at /a
      expect(db.getMeta('schemaTypesStored')).not.toBe('1');
      expect(db.schemaTypesStored()).toBe(false);
      await crawl(db); // a refresh that runs to the end
      expect(db.getMeta('schemaTypesStored')).toBe('1');
      expect(db.getMeta('schemaTypesPartial')).toBe('');
      expect(db.schemaTypesStored()).toBe(true);
    } finally {
      db.close();
    }
  });
});
