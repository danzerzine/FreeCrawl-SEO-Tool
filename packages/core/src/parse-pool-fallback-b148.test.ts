import { describe, expect, it } from 'vitest';
import { parseHtml } from './html-parser.js';
import { ParserTimeoutError, poolParseHtml, type ParserPool } from './parse-pool.js';

// B148: what poolParseHtml does when the pool's parse fails.
const PAGE = 'https://example.com/';
const HTML = '<html><head><title>Fallback page</title></head><body><h1>Hi</h1></body></html>';

function fakePool(parse: () => Promise<never>): { pool: ParserPool; calls: () => number } {
  let n = 0;
  const pool = {
    isReady: () => true,
    parse: () => {
      n++;
      return parse();
    },
  } as unknown as ParserPool;
  return { pool, calls: () => n };
}

describe('poolParseHtml failure rules (B148)', () => {
  it('a worker timeout is rejected and the page is not re-parsed on the main thread', async () => {
    const err = new ParserTimeoutError(60_000);
    const { pool, calls } = fakePool(() => Promise.reject(err));
    const log: string[] = [];
    await expect(poolParseHtml(pool, (_l, m) => log.push(m))(HTML, PAGE, {})).rejects.toBe(err);
    expect(calls()).toBe(1);
    expect(log.some((m) => m.includes('timed out'))).toBe(true);
  });

  it('a crashed worker falls back to parsing the page on the main thread', async () => {
    const { pool } = fakePool(() => Promise.reject(new Error('worker exited with code 1')));
    const log: string[] = [];
    const out = await poolParseHtml(pool, (_l, m) => log.push(m))(HTML, PAGE, {});
    expect(out).toEqual(parseHtml(HTML, PAGE, {}));
    expect(out.title).toBe('Fallback page');
    expect(log.some((m) => m.includes('inline parseHtml as fallback'))).toBe(true);
  });
});
