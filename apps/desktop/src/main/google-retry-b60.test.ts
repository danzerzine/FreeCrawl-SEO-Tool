import { describe, expect, it } from 'vitest';
import { googleRequest, type GoogleDeps } from './google-retry.js';

type Reply = { status: number; headers?: Record<string, string>; body?: unknown } | 'network';

function makeDeps(replies: Reply[], opts: { start?: number; random?: number } = {}) {
  const sleeps: number[] = [];
  const calls: { url: string; auth: string | null }[] = [];
  const tokens: boolean[] = [];
  let clock = opts.start ?? 0;
  let i = 0;
  const deps: GoogleDeps = {
    fetch: (async (url: string, init: RequestInit) => {
      calls.push({ url, auth: new Headers(init.headers).get('authorization') });
      const r = replies[Math.min(i++, replies.length - 1)]!;
      if (r === 'network') throw new Error(`connect failed ${url} Bearer SECRET-TOKEN`);
      return new Response(JSON.stringify(r.body ?? {}), { status: r.status, headers: r.headers });
    }) as unknown as GoogleDeps['fetch'],
    getToken: async (refresh) => {
      tokens.push(!!refresh);
      return refresh ? 'fresh' : 'old';
    },
    sleep: async (ms) => {
      sleeps.push(ms);
      clock += ms;
    },
    now: () => clock,
    random: () => opts.random ?? 0,
    log: () => {},
  };
  return { deps, sleeps, calls, tokens };
}

const req = { op: 'test op', method: 'GET', url: 'https://x.test/a' };

describe('googleRequest (B60)', () => {
  it('does not retry a 400', async () => {
    const t = makeDeps([{ status: 400, body: { error: { message: 'bad' } } }]);
    const r = await googleRequest(t.deps, req);
    expect(r.status).toBe(400);
    expect(t.calls).toHaveLength(1);
    expect(t.sleeps).toEqual([]);
  });

  it('retries 500 twice then succeeds, sleeping 1 s then 2 s through deps.sleep', async () => {
    const t = makeDeps([{ status: 500 }, { status: 500 }, { status: 200, body: { ok: 1 } }]);
    const r = await googleRequest(t.deps, req);
    expect(r.ok).toBe(true);
    expect(r.json).toEqual({ ok: 1 });
    expect(t.sleeps).toEqual([1000, 2000]);
  });

  it('backs off 1,2,4,8,16,32,64 s plus injected jitter, then throws before passing 180 s', async () => {
    const t = makeDeps([{ status: 503 }], { random: 0.5 });
    const err = await googleRequest(t.deps, req).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect(t.sleeps).toEqual([1500, 2500, 4500, 8500, 16500, 32500, 64500]);
    expect(t.sleeps.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(180_000);
    const msg = (err as Error).message;
    expect(msg).toContain('test op');
    expect(msg).toContain('503');
    expect(msg).toContain('131 s'); // 127 s of backoff + 7 x 0.5 s of jitter, rounded
  });

  it('a Retry-After of 90 s replaces the computed delay', async () => {
    const t = makeDeps([{ status: 429, headers: { 'retry-after': '90' } }, { status: 200 }]);
    await googleRequest(t.deps, req);
    expect(t.sleeps).toEqual([90_000]);
  });

  it('reads a Retry-After HTTP date against the injected clock', async () => {
    const start = Date.parse('2026-01-01T00:00:00Z');
    const t = makeDeps(
      [{ status: 429, headers: { 'retry-after': 'Thu, 01 Jan 2026 00:00:03 GMT' } }, { status: 200 }],
      { start },
    );
    await googleRequest(t.deps, req);
    expect(t.sleeps).toEqual([3000]);
  });

  it('retries 408 and network errors but never leaks the error text', async () => {
    const t = makeDeps([{ status: 408 }, 'network', { status: 200 }]);
    const logs: string[] = [];
    t.deps.log = (_l, m) => logs.push(m);
    await googleRequest(t.deps, req);
    expect(t.sleeps).toEqual([1000, 2000]);
    expect(logs.join('\n')).not.toContain('SECRET-TOKEN');
    expect(logs.join('\n')).not.toContain('x.test');
  });

  it('does not retry a network error when retryNetwork is off', async () => {
    const t = makeDeps(['network', { status: 200 }]);
    const err = await googleRequest(t.deps, { ...req, retryNetwork: false }).catch((e: Error) => e);
    expect((err as Error).message).toContain('test op');
    expect((err as Error).message).not.toContain('SECRET-TOKEN');
    expect(t.calls).toHaveLength(1);
  });

  it('refreshes the token once on 401, then returns a second 401', async () => {
    const t = makeDeps([{ status: 401 }, { status: 200 }]);
    expect((await googleRequest(t.deps, req)).ok).toBe(true);
    expect(t.tokens).toEqual([false, true]);
    expect(t.calls.map((c) => c.auth)).toEqual(['Bearer old', 'Bearer fresh']);
    const t2 = makeDeps([{ status: 401 }]);
    expect((await googleRequest(t2.deps, req)).status).toBe(401);
    expect(t2.calls).toHaveLength(2);
  });
});
