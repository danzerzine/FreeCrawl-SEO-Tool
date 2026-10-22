import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { ProjectDb } from '@freecrawl/db';
import { DEFAULT_CRAWL_CONFIG } from '@freecrawl/shared-types';
import { Crawler } from './crawler.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'b29-held-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

// A stop that lands before the held saved queue is queued must still write
// it: the checkpoint is a full replace, so leaving it out erases it.
it('a checkpoint written before the held saved queue is queued keeps it (B29)', async () => {
  const db = new ProjectDb(join(dir, 'p.seoproject'));
  try {
    const c = new Crawler({ ...DEFAULT_CRAWL_CONFIG, startUrl: 'http://127.0.0.1:9/' }, db, { resumeOnly: true });
    c.enqueueCheckpointed([{ url: 'http://127.0.0.1:9/a', depth: 2 }]);
    await c.saveQueueCheckpoint();
    expect(db.loadQueueCheckpoint().map((r) => [r.url, r.depth])).toEqual([['http://127.0.0.1:9/a', 2]]);
  } finally {
    db.close();
  }
});
