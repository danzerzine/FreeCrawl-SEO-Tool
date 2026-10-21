import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EXPENSIVE_ISSUE_DEFINITIONS, ProjectDb } from './project-db.js';

let dir: string;
let file: string;

const NOTFOUND = 'fetch failed — getaddrinfo ENOTFOUND';
const REFUSED = 'fetch failed — connect ECONNREFUSED';
const ABORTED = 'This operation was aborted — the request timed out (raise the timeout in settings)';
const RESET = 'fetch failed — read ECONNRESET';
const AGAIN = 'fetch failed — getaddrinfo EAI_AGAIN';
const CONFIRMED = ' (no answer on 2 attempts)';
const CONNECT_TIMEOUT = 'fetch failed — UND_ERR_CONNECT_TIMEOUT Connect Timeout Error (attempted address: blocked.test:443, timeout: 10000ms)';

/*
 * One internal page /a links every external URL below. Hosts:
 * - bot.test: 418 on all 4 URLs (a bot wall answers: alive)
 * - wall.test: bot protection on 3 URLs (status NULL, unknown:bot-blocked: alive)
 * - slow.test: our own timeout on 5 URLs (neither alive nor dead)
 * - reset.test: ECONNRESET on 3 URLs (neither)
 * - gone.test: ENOTFOUND on 2 URLs (dead)
 * - one.test: ECONNREFUSED on its only URL, confirmed by the retry (dead)
 * - single.test: ENOTFOUND on its only URL, no retry marker (legacy row: not dead)
 * - again.test: EAI_AGAIN on 2 URLs (temporary DNS: not dead)
 * - half.test: ENOTFOUND on one URL, 200 on another (alive)
 * - err5.test: 503 on 3 URLs (alive: it answers)
 * - blocked.test: connect timeout on 2 URLs, confirmed (a network that blocks the host looks the same: not dead)
 */
const EXTERNAL: Array<[string, number | null, string | null, string]> = [
  ...[1, 2, 3, 4].map((i): [string, number | null, string | null, string] => [`https://bot.test/${i}`, 418, 'I\'m a teapot', 'non-indexable:client-error']),
  ...[1, 2, 3].map((i): [string, number | null, string | null, string] => [`https://wall.test/${i}`, null, 'Cloudflare challenge', 'unknown:bot-blocked']),
  ...[1, 2, 3, 4, 5].map((i): [string, number | null, string | null, string] => [`https://slow.test/${i}`, null, ABORTED, 'non-indexable:no-response']),
  ...[1, 2, 3].map((i): [string, number | null, string | null, string] => [`https://reset.test/${i}`, null, RESET, 'non-indexable:no-response']),
  [`https://gone.test/1`, null, NOTFOUND, 'non-indexable:no-response'],
  [`https://gone.test/2`, null, NOTFOUND, 'non-indexable:no-response'],
  [`https://one.test/`, null, REFUSED + CONFIRMED, 'non-indexable:no-response'],
  [`https://single.test/`, null, NOTFOUND, 'non-indexable:no-response'],
  [`https://again.test/1`, null, AGAIN + CONFIRMED, 'non-indexable:no-response'],
  [`https://again.test/2`, null, AGAIN + CONFIRMED, 'non-indexable:no-response'],
  [`https://half.test/1`, null, NOTFOUND, 'non-indexable:no-response'],
  [`https://half.test/2`, 200, 'OK', 'indexable'],
  ...[1, 2, 3].map((i): [string, number | null, string | null, string] => [`https://err5.test/${i}`, 503, 'Service Unavailable', 'non-indexable:server-error']),
  [`https://blocked.test/1`, null, CONNECT_TIMEOUT + CONFIRMED, 'non-indexable:no-response'],
  [`https://blocked.test/2`, null, CONNECT_TIMEOUT + CONFIRMED, 'non-indexable:no-response'],
];

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-b7-'));
  file = path.join(dir, 'p.seoproject');
  new ProjectDb(file).close();
  const raw = new DatabaseSync(file);
  const q = (s: string | null) => (s === null ? 'NULL' : `'${s.replace(/'/g, "''")}'`);
  raw.exec(`
    INSERT INTO urls (id, url, status_code, indexability) VALUES (1, 'https://ex.com/a', 200, 'indexable');
    INSERT INTO urls (url, status_code, status_text, indexability, is_external, content_kind) VALUES
      ${EXTERNAL.map(([u, s, t, ix]) => `(${q(u)}, ${s ?? 'NULL'}, ${q(t)}, ${q(ix)}, 1, 'other')`).join(',\n')};
    INSERT INTO links (from_url_id, to_url, is_internal)
      SELECT 1, url, 0 FROM urls WHERE is_external = 1;
  `);
  raw.close();
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('dead external domain (B7)', () => {
  it('only hosts with no HTTP answer and a network-level failure are dead', () => {
    const db = new ProjectDb(file);
    db.recomputeUrlsIssues(EXPENSIVE_ISSUE_DEFINITIONS);
    const i = db.getOverviewCounts().issues;
    const pages = [...db.iterateUrlsByCategory('issues:dead-external-domain')];
    db.close();
    // gone.test/1, gone.test/2, one.test/ — not the 418 wall, bot protection, timeouts, resets, 503s, half.test or blocked.test.
    expect(i.deadExternalDomain).toBe(3);
    expect(i.deadExternalDomainPages).toBe(1);
    expect(pages.length).toBe(1);
  });

  it('the same after reopening', () => {
    const db = new ProjectDb(file);
    db.recomputeUrlsIssues(EXPENSIVE_ISSUE_DEFINITIONS);
    db.close();
    const again = new ProjectDb(file);
    const i = again.getOverviewCounts().issues;
    again.close();
    expect(i.deadExternalDomain).toBe(3);
  });

  it('a host that answered once is alive even if its other URLs fail at network level', () => {
    const db = new ProjectDb(file);
    db.recomputeUrlsIssues(EXPENSIVE_ISSUE_DEFINITIONS);
    const raw = new DatabaseSync(file);
    const half = raw
      .prepare(
        `SELECT COUNT(*) AS n FROM urls_issues ui JOIN urls u ON u.id = ui.url_id
          WHERE ui.issue_key = 'targets:issues:dead-external-domain' AND u.url LIKE 'https://half.test/%'`,
      )
      .get() as { n: number };
    raw.close();
    db.close();
    expect(half.n).toBe(0);
  });
});
