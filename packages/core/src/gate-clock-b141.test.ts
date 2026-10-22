import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { ProjectDb } from '@freecrawl/db';
import { DEFAULT_CRAWL_CONFIG } from '@freecrawl/shared-types';
import { Crawler } from './crawler.js';
import { loadRobots } from './robots.js';
import { resolveStartUrl } from './url-utils.js';

/*
 * A wait at the rate gate never counts against a request's timeout. The gate
 * here moves the fake clock far past every timeout before it lets the
 * request go; a timer started before the gate would abort the request.
 */
let server: Server;
let base: string;
let dir: string;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'b141-'));
  server = createServer((req, res) => {
    if (req.url === '/robots.txt') {
      return void res.writeHead(200, { 'content-type': 'text/plain' }).end('User-agent: *\nDisallow: /x\n');
    }
    res.writeHead(200, { 'content-type': 'text/html' }).end('<html></html>');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(() => {
  server.close();
  rmSync(dir, { recursive: true, force: true });
});
beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] }));
afterEach(() => vi.useRealTimers());

const slowGate = async (): Promise<void> => {
  await vi.advanceTimersByTimeAsync(60_000);
};

it('the start-URL probe starts its clock after the gate', async () => {
  const attempts: { method: string; outcome: string }[] = [];
  await resolveStartUrl(`${base}/`, 'test', 3000, (a) => attempts.push(a), { beforeRequest: slowGate });
  // An absolute URL that never answered comes back as given: the attempts tell.
  expect(attempts.map((a) => `${a.method} ${a.outcome}`)).toEqual(['HEAD ok']);
});

it('robots.txt starts its clock after the gate', async () => {
  const robots = await loadRobots(base, 'test', undefined, [], slowGate);
  // The file was read, not replaced by the allow-all of a failed fetch.
  expect(robots.isAllowed(`${base}/x`)).toBe(false);
});

it('a sitemap budget does not count the time spent at the gate', async () => {
  const db = new ProjectDb(join(dir, 'deadline.seoproject'));
  try {
    const c = new Crawler({ ...DEFAULT_CRAWL_CONFIG, startUrl: `${base}/` }, db);
    const gated = c as unknown as {
      acquireRateSlot: () => Promise<void>;
      gatedDeadline: (
        controller: AbortController,
        budgetMs: number,
      ) => { beforeRequest: () => Promise<void>; clear: () => void };
    };
    gated.acquireRateSlot = slowGate;
    const controller = new AbortController();
    const deadline = gated.gatedDeadline(controller, 1000);
    await vi.advanceTimersByTimeAsync(400);
    await deadline.beforeRequest();
    expect(controller.signal.aborted).toBe(false);
    // 400 ms were spent before the gate: 600 ms of the budget are left.
    await vi.advanceTimersByTimeAsync(599);
    expect(controller.signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(controller.signal.aborted).toBe(true);
    deadline.clear();
  } finally {
    db.close();
  }
});
