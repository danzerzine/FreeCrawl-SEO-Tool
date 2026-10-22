import { describe, expect, it, vi } from 'vitest';
import type { GoogleDeps } from './google-retry.js';

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp' },
  safeStorage: {},
  shell: {},
}));

// Per-file guard (r2-L5): only 127.0.0.1 may be reached; a test that forgets
// `deps` fails here instead of calling Google. No other test file is touched.
const realFetch = globalThis.fetch;
const guard = ((input: string | URL | Request, init?: RequestInit) => {
  const host = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url).hostname;
  if (host !== '127.0.0.1') return Promise.reject(new Error(`guard: blocked host ${host}`));
  return realFetch(input as string, init);
}) as typeof fetch;
vi.stubGlobal('fetch', guard);

const { inspectUrl } = await import('./gsc.js');
const { runReport, listProperties } = await import('./ga4.js');
const { GoogleQuotaError, GooglePermissionError } = await import('./google-retry.js');

type Reply = { status: number; body?: unknown; headers?: Record<string, string> };

function makeDeps(replies: Reply[]) {
  const calls: { url: string; body: unknown }[] = [];
  const sleeps: number[] = [];
  let clock = 0;
  let i = 0;
  const deps: GoogleDeps = {
    fetch: (async (url: string, init: RequestInit) => {
      calls.push({ url, body: init.body ? JSON.parse(init.body as string) : undefined });
      const r = replies[Math.min(i++, replies.length - 1)]!;
      return new Response(JSON.stringify(r.body ?? {}), { status: r.status, headers: r.headers });
    }) as unknown as GoogleDeps['fetch'],
    getToken: async () => 'tok',
    sleep: async (ms) => {
      sleeps.push(ms);
      clock += ms;
    },
    now: () => clock,
    random: () => 0,
    log: () => {},
  };
  return { deps, calls, sleeps };
}

const FIXTURE = {
  inspectionResult: {
    indexStatusResult: {
      verdict: 'PASS',
      coverageState: 'Submitted and indexed',
      robotsTxtState: 'ALLOWED',
      indexingState: 'INDEXING_ALLOWED',
      lastCrawlTime: '2026-10-01T10:00:00Z',
      googleCanonical: 'https://example.test/a',
      userCanonical: 'https://example.test/a',
      pageFetchState: 'SUCCESSFUL',
      crawledAs: 'MOBILE',
      sitemap: ['https://example.test/sitemap.xml', 'https://example.test/news.xml'],
      referringUrls: Array.from({ length: 25 }, (_, n) => `https://example.test/r${n}`),
    },
    mobileUsabilityResult: { verdict: 'PASS' },
    richResultsResult: {
      verdict: 'FAIL',
      detectedItems: [
        {
          richResultType: 'Product snippets',
          items: [
            {
              name: 'Item one',
              issues: [
                { issueMessage: 'Missing field "offers"', severity: 'ERROR' },
                { issueMessage: 'Missing field "offers"', severity: 'ERROR' },
                { issueMessage: 'Missing field "review"', severity: 'WARNING' },
              ],
            },
          ],
        },
        {
          richResultType: 'Breadcrumbs',
          items: [{ name: 'Breadcrumb', issues: [{ issueMessage: 'x'.repeat(400), severity: 'WARNING' }] }],
        },
      ],
    },
  },
};

describe('inspectUrl (B38 client)', () => {
  it('parses sitemaps, referring pages, fetch state and rich-result details', async () => {
    const t = makeDeps([{ status: 200, body: FIXTURE }]);
    const r = await inspectUrl('sc-domain:example.test', 'https://example.test/a', undefined, t.deps);
    expect(r.verdict).toBe('PASS');
    expect(r.pageFetchState).toBe('SUCCESSFUL');
    expect(r.crawledAs).toBe('MOBILE');
    expect(r.sitemaps).toEqual(['https://example.test/sitemap.xml', 'https://example.test/news.xml']);
    expect(r.referringCount).toBe(25);
    expect(r.referringUrls).toHaveLength(20);
    expect(r.referringUrls![0]).toBe('https://example.test/r0');
    expect(r.richResultsVerdict).toBe('FAIL');
    expect(r.richResults).toHaveLength(2);
    expect(r.richResults![0]).toEqual({
      type: 'Product snippets',
      items: [
        {
          name: 'Item one',
          errors: 2,
          warnings: 1,
          messages: ['Missing field "offers"', 'Missing field "review"'],
        },
      ],
    });
    expect(r.richResults![1]!.items[0]!.messages[0]).toHaveLength(300);
    expect(t.calls[0]!.body).toEqual({
      inspectionUrl: 'https://example.test/a',
      siteUrl: 'sc-domain:example.test',
    });
  });

  it('caps messages at 5 per item, items at 20 and types at 20', async () => {
    const issues = Array.from({ length: 9 }, (_, n) => ({ issueMessage: `m${n}`, severity: 'WARNING' }));
    const items = Array.from({ length: 30 }, (_, n) => ({ name: `i${n}`, issues }));
    const detectedItems = Array.from({ length: 25 }, (_, n) => ({ richResultType: `T${n}`, items }));
    const t = makeDeps([
      { status: 200, body: { inspectionResult: { richResultsResult: { verdict: 'PASS', detectedItems } } } },
    ]);
    const r = await inspectUrl('p', 'u', undefined, t.deps);
    expect(r.richResults).toHaveLength(20);
    expect(r.richResults![0]!.items).toHaveLength(20);
    expect(r.richResults![0]!.items[0]!.messages).toEqual(['m0', 'm1', 'm2', 'm3', 'm4']);
    expect(r.richResults![0]!.items[0]!.warnings).toBe(9);
  });

  it('a response without the new blocks gives empty arrays and null rich results', async () => {
    const t = makeDeps([
      { status: 200, body: { inspectionResult: { indexStatusResult: { verdict: 'NEUTRAL' } } } },
    ]);
    const r = await inspectUrl('p', 'u', undefined, t.deps);
    expect(r.sitemaps).toEqual([]);
    expect(r.referringUrls).toEqual([]);
    expect(r.referringCount).toBe(0);
    expect(r.pageFetchState).toBeNull();
    expect(r.crawledAs).toBeNull();
    expect(r.richResultsVerdict).toBeNull();
    expect(r.richResults).toBeNull();
  });

  it('a verdict without detectedItems stores an empty list, not null', async () => {
    const t = makeDeps([
      { status: 200, body: { inspectionResult: { richResultsResult: { verdict: 'PASS' } } } },
    ]);
    const r = await inspectUrl('p', 'u', undefined, t.deps);
    expect(r.richResults).toEqual([]);
  });

  it('a 429 that persists after the backoff is a GoogleQuotaError', async () => {
    const t = makeDeps([{ status: 429, body: { error: { status: 'RESOURCE_EXHAUSTED' } } }]);
    const err = await inspectUrl('p', 'u', undefined, t.deps).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GoogleQuotaError);
    expect(t.sleeps.length).toBeGreaterThan(0);
  });

  it.each([
    ['rateLimitExceeded', 403],
    ['quotaExceeded', 403],
  ])('a 403 with reason %s is a GoogleQuotaError without retry', async (reason, status) => {
    const t = makeDeps([{ status, body: { error: { errors: [{ reason }], message: 'm' } } }]);
    const err = await inspectUrl('p', 'u', undefined, t.deps).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GoogleQuotaError);
    expect(t.calls).toHaveLength(1);
  });

  it('a 400 RESOURCE_EXHAUSTED status is a GoogleQuotaError', async () => {
    const t = makeDeps([{ status: 400, body: { error: { status: 'RESOURCE_EXHAUSTED', message: 'q' } } }]);
    const err = await inspectUrl('p', 'u', undefined, t.deps).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GoogleQuotaError);
  });

  it('a plain 403 stays a normal error carrying the PERMISSION_DENIED status', async () => {
    const t = makeDeps([{ status: 403, body: { error: { status: 'PERMISSION_DENIED', message: 'no' } } }]);
    const err = await inspectUrl('p', 'u', undefined, t.deps).catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(GoogleQuotaError);
    expect(err).toBeInstanceOf(GooglePermissionError);
  });
});

describe('seam on the GA4 clients (shared work)', () => {
  it('runReport uses the injected deps and retries a 503', async () => {
    const t = makeDeps([
      { status: 503 },
      { status: 200, body: { rows: [{ dimensionValues: [{ value: 'https://example.test/' }], metricValues: [{ value: '3' }] }], rowCount: 1 } },
    ]);
    const rows = await runReport('properties/1', '2026-10-01', '2026-10-07', undefined, t.deps);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.sessions).toBe(3);
    expect(t.calls).toHaveLength(2);
  });

  it('listProperties uses the injected deps', async () => {
    const t = makeDeps([
      { status: 200, body: { accountSummaries: [{ displayName: 'A', propertySummaries: [{ property: 'properties/9', displayName: 'P' }] }] } },
    ]);
    const props = await listProperties(undefined, t.deps);
    expect(props.map((p) => p.propertyId)).toEqual(['properties/9']);
  });
});

describe('guard fetch', () => {
  it('rejects Google hosts and lets 127.0.0.1 through', async () => {
    await expect(fetch('https://searchconsole.googleapis.com/x')).rejects.toThrow(/guard/);
    await expect(fetch('https://analyticsdata.googleapis.com/x')).rejects.toThrow(/guard/);
    await expect(fetch('http://127.0.0.1:1/x')).rejects.not.toThrow(/guard/);
  });

  it('an inspectUrl call that forgets deps never reaches Google', async () => {
    const err = await inspectUrl('p', 'u').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
  });
});
