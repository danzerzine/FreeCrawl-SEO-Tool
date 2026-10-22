import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it } from 'vitest';
import { readServedSignalsInline } from './html-parser.js';
import { ParserPool, poolReadServedSignals } from './parse-pool.js';

// The built worker (`npx tsc -b` first).
const WORKER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dist/parse-worker.js');
const PAGE = 'https://example.com/a';
const served = '<html><head><link rel="canonical" href="/a"></head><body><h1>Old</h1><a href="/x">x</a></body></html>';
const pre = '<html><body><h1>New</h1><a href="/y">y</a><a href="https://o.org/">o</a></body></html>';

let pool: ParserPool | null = null;
afterEach(async () => {
  await pool?.terminate();
  pool = null;
});

it('a worker request returns what the inline read returns, with and without a pre-script document', async () => {
  pool = new ParserPool(WORKER);
  pool.init(1);
  expect(await pool.whenReady()).toBe(true);
  const read = poolReadServedSignals(pool);
  expect(await read({ servedHtml: served }, PAGE, {})).toEqual(readServedSignalsInline({ servedHtml: served }, PAGE, {}));
  const both = await read({ servedHtml: served, preScriptHtml: pre }, PAGE, {});
  expect(both).toEqual(readServedSignalsInline({ servedHtml: served, preScriptHtml: pre }, PAGE, {}));
  expect(both.preScript?.h1).toBe('New');
});

it('reads inline when the pool is not ready', async () => {
  pool = new ParserPool(path.join(path.dirname(WORKER), 'no-such-worker.js'));
  pool.init(1);
  expect(await pool.whenReady()).toBe(false);
  const r = await poolReadServedSignals(pool)({ servedHtml: served }, PAGE, {});
  expect(r.served.h1).toBe('Old');
});
