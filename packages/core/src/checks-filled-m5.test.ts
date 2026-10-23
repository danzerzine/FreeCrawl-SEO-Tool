import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { CHECKS_FILLED_META_KEY, CONSOLE_CHECKS, LATER_CHECKS, MARKUP_CHECKS, ProjectDb, RENDER_CHECKS } from '@freecrawl/db';
import { DEFAULT_CRAWL_CONFIG } from '@freecrawl/shared-types';
import { Crawler } from './crawler.js';

// A text-mode crawl compares nothing raw against rendered (B33), records no console (B35) and, by default, no markup (B45).
const FILLED_IN_TEXT_MODE = LATER_CHECKS.filter(
  (k) => !RENDER_CHECKS.includes(k) && !CONSOLE_CHECKS.includes(k) && !MARKUP_CHECKS.includes(k),
);

let server: Server;
let dir: string;
let base: string;
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'm5-filled-'));
  server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' }).end('<html><head><title>T</title></head><body>x</body></html>');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
});
afterAll(() => {
  server.close();
  rmSync(dir, { recursive: true, force: true });
});

async function crawl(db: ProjectDb, opts: { resumeOnly?: boolean } = {}): Promise<void> {
  const c = new Crawler(
    {
      ...DEFAULT_CRAWL_CONFIG,
      startUrl: base,
      maxUrls: 1,
      discoverSitemaps: false,
      checkExternalLinks: false,
      probeTlsCerts: false,
      probeManifestJson: false,
      probeSocialImages: false,
      probeImageSizes: false,
    },
    db,
    opts,
  );
  c.on('error', () => {});
  await c.start();
}

it('a crawl records the later checks it fills; continuing an older crawl keeps only those the older part filled (M5)', async () => {
  const db = new ProjectDb(join(dir, 'p.seoproject'));
  await crawl(db);
  expect([...db.checksFilled()]).toEqual(FILLED_IN_TEXT_MODE);

  // An older build made the crawl: no list. Continuing it fills nothing new.
  db.setMeta(CHECKS_FILLED_META_KEY, '[]');
  await crawl(db, { resumeOnly: true });
  expect(db.checksFilled().size).toBe(0);

  // A refresh re-crawls from the start: every later check is filled again.
  await crawl(db);
  expect([...db.checksFilled()]).toEqual(FILLED_IN_TEXT_MODE);
  db.close();
}, 30_000);
