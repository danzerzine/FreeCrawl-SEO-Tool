import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { GoogleDeps } from './google-retry.js';

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp' },
  safeStorage: {},
  shell: {},
}));

// Per-file guard (r2-L5, S1): only 127.0.0.1 may be reached. It replaces both the global fetch and
// `apiFetch` (undici's own fetch, the clients' default transport), so a test that forgets `deps`
// is stopped here instead of calling Google.
const guard = vi.hoisted(() => {
  const realFetch = globalThis.fetch;
  return ((input: string | URL | Request, init?: RequestInit) => {
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const host = new URL(href).hostname;
    if (host !== '127.0.0.1') return Promise.reject(new Error(`guard: blocked host ${host}`));
    return realFetch(input as string, init);
  }) as typeof fetch;
});
vi.mock('./api-fetch.js', () => ({ apiFetch: guard }));
vi.stubGlobal('fetch', guard);

const { getMetadata, clearMetadataCache, runCustomReport, Ga4BadRequestError } = await import('./ga4.js');
const { GoogleQuotaError } = await import('./google-retry.js');

type Reply = { status: number; body?: unknown };
function makeDeps(replies: Reply[]) {
  const calls: { url: string; method: string; body: { offset: number } & Record<string, unknown> }[] = [];
  let i = 0;
  let clock = 0;
  const deps: GoogleDeps = {
    fetch: (async (url: string, init: RequestInit) => {
      calls.push({ url, method: String(init.method), body: JSON.parse((init.body as string | undefined) ?? "{}") });
      const r = replies[Math.min(i++, replies.length - 1)]!;
      return new Response(JSON.stringify(r.body ?? {}), { status: r.status });
    }) as unknown as GoogleDeps['fetch'],
    getToken: async () => 'tok',
    sleep: async (ms) => {
      clock += ms;
    },
    now: () => clock,
    random: () => 0,
    log: () => {},
  };
  return { deps, calls };
}

const METADATA = {
  dimensions: [
    { apiName: 'pageLocation', uiName: 'Page location', description: 'd', customDefinition: false, category: 'Page / screen' },
    { apiName: 'customEvent:author', uiName: 'Author', description: 'who wrote it', customDefinition: true, category: 'Custom' },
    { apiName: 'customEvent:section', uiName: 'Section', description: '', customDefinition: true, category: 'Custom' },
    { apiName: 'customItem:colour', uiName: 'Colour', description: '', customDefinition: true, category: 'Custom' },
  ],
  metrics: [
    { apiName: 'sessions', uiName: 'Sessions', description: '', customDefinition: false, category: 'Session' },
    { apiName: 'customEvent:word_count', uiName: 'Word count', description: '', customDefinition: true, category: 'Custom', type: 'TYPE_INTEGER' },
  ],
};

beforeEach(() => clearMetadataCache());

describe('getMetadata (B37)', () => {
  it('parses custom and standard fields and keeps customDefinition; customItem: is not offered', async () => {
    const t = makeDeps([{ status: 200, body: METADATA }]);
    const fields = await getMetadata('properties/1', undefined, t.deps);
    expect(t.calls[0]!.url).toBe('https://analyticsdata.googleapis.com/v1beta/properties/1/metadata');
    expect(t.calls[0]!.method).toBe('GET');
    expect(fields.map((f) => `${f.kind}:${f.apiName}`)).toEqual([
      'dimension:pageLocation',
      'dimension:customEvent:author',
      'dimension:customEvent:section',
      'metric:sessions',
      'metric:customEvent:word_count',
    ]);
    const author = fields.find((f) => f.apiName === 'customEvent:author')!;
    expect(author).toMatchObject({ uiName: 'Author', description: 'who wrote it', customDefinition: true, kind: 'dimension' });
    expect(fields.find((f) => f.apiName === 'sessions')!.customDefinition).toBe(false);
  });

  it('is cached per account and property for the session; refresh asks again', async () => {
    const t = makeDeps([{ status: 200, body: METADATA }]);
    await getMetadata('properties/1', 'a', t.deps);
    await getMetadata('properties/1', 'a', t.deps);
    expect(t.calls).toHaveLength(1);
    await getMetadata('properties/2', 'a', t.deps);
    await getMetadata('properties/1', 'b', t.deps);
    expect(t.calls).toHaveLength(3);
    await getMetadata('properties/1', 'a', t.deps, { refresh: true });
    expect(t.calls).toHaveLength(4);
  });

  it('an old property answer with no arrays gives an empty list', async () => {
    const t = makeDeps([{ status: 200, body: {} }]);
    expect(await getMetadata('properties/9', undefined, t.deps)).toEqual([]);
  });
});

describe('runCustomReport (B37)', () => {
  const req = { startDate: '2026-10-01', endDate: '2026-10-07', dimensions: ['pageLocation'], metrics: ['customEvent:word_count'] };

  it('asks for property quota, pages with offset and returns the last quota reading', async () => {
    const row = (u: string, v: string) => ({ dimensionValues: [{ value: u }], metricValues: [{ value: v }] });
    const t = makeDeps([
      { status: 200, body: { rows: [row('u1', '5')], rowCount: 2, propertyQuota: { tokensPerDay: { consumed: 1, remaining: 190000 } } } },
      {
        status: 200,
        body: {
          rows: [row('u2', '7')],
          rowCount: 2,
          propertyQuota: {
            tokensPerDay: { consumed: 2, remaining: 189999 },
            tokensPerHour: { consumed: 2, remaining: 4000 },
            tokensPerProjectPerHour: { consumed: 2, remaining: 13000 },
          },
        },
      },
    ]);
    const r = await runCustomReport('properties/1', req, undefined, t.deps);
    expect(t.calls[0]!.body).toMatchObject({
      dimensions: [{ name: 'pageLocation' }],
      metrics: [{ name: 'customEvent:word_count' }],
      returnPropertyQuota: true,
      offset: 0,
    });
    expect(t.calls[1]!.body.offset).toBe(1);
    expect(r.rows).toEqual([
      { dims: ['u1'], metrics: ['5'] },
      { dims: ['u2'], metrics: ['7'] },
    ]);
    expect(r.quota).toEqual({ tokensPerDay: 189999, tokensPerHour: 4000, tokensPerProjectPerHour: 13000 });
  });

  it('a 400 is a Ga4BadRequestError carrying Google message; a persistent 429 is a GoogleQuotaError', async () => {
    const bad = makeDeps([{ status: 400, body: { error: { message: 'Field customEvent:x is not a valid metric' } } }]);
    const err = await runCustomReport('properties/1', req, undefined, bad.deps).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Ga4BadRequestError);
    expect((err as Error).message).toContain('not a valid metric');
    const q = makeDeps([{ status: 429, body: { error: { status: 'RESOURCE_EXHAUSTED' } } }]);
    expect(await runCustomReport('properties/1', req, undefined, q.deps).catch((e: unknown) => e)).toBeInstanceOf(GoogleQuotaError);
  });

  it('the guard stops a call that forgot deps', async () => {
    await expect(getMetadata('properties/77')).rejects.toBeInstanceOf(Error);
  });
});
