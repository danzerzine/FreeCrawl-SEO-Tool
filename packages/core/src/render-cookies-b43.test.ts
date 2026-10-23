import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { attachCookieCollector } from './render-cookies.js';

// The collector against a fake page: Playwright's own events and frames, no browser.
interface FakeReq {
  id: string;
  redirectedFrom(): FakeReq | null;
  response(): Promise<FakeResp | null>;
}
interface FakeResp {
  url(): string;
  request(): FakeReq;
  headersArray(): Promise<{ name: string; value: string }[]>;
}
function req(id: string, from: FakeReq | null = null): FakeReq & { resp?: FakeResp } {
  const r: FakeReq & { resp?: FakeResp } = {
    id,
    redirectedFrom: () => from,
    response: async () => r.resp ?? null,
  };
  return r;
}
function resp(url: string, r: FakeReq & { resp?: FakeResp }, lines: string[], fail = false): FakeResp {
  const x: FakeResp = {
    url: () => url,
    request: () => r,
    headersArray: async () => {
      if (fail) throw new Error('response gone');
      return [{ name: 'Content-Type', value: 'text/html' }, ...lines.map((value) => ({ name: 'Set-Cookie', value }))];
    },
  };
  r.resp = x;
  return x;
}
function fakePage(frames: { evaluate: (e: string) => Promise<unknown> }[] = []) {
  const page = Object.assign(new EventEmitter(), { frames: () => frames });
  return page;
}

describe('B43 attachCookieCollector', () => {
  it('lists Set-Cookie lines of this render\'s responses, in response order, without values', async () => {
    const page = fakePage();
    const c = attachCookieCollector(page as never);
    const r1 = req('doc');
    const r2 = req('js');
    page.emit('request', r1);
    page.emit('request', r2);
    page.emit('response', resp('https://a.test/p/x', r1, ['sid=SENTINEL_1; HttpOnly; Secure', 'pref=2; Path=/']));
    page.emit('response', resp('https://cdn.test/a.js', r2, ['tr=SENTINEL_2; SameSite=None; Secure']));
    const out = await c.collect(undefined);
    expect(out.list.map((k) => [k.n, k.d, k.p, k.h, k.by])).toEqual([
      ['sid', 'a.test', '/p', 1, 'header'],
      ['pref', 'a.test', '/', 0, 'header'],
      ['tr', 'cdn.test', '/', 0, 'header'],
    ]);
    expect(out).toMatchObject({ total: 3, truncated: false });
    expect(JSON.stringify(out)).not.toContain('SENTINEL');
  });

  it('ignores a response of a request that started before the collector (the previous URL on a reused page)', async () => {
    const page = fakePage();
    const old = req('old');
    const c = attachCookieCollector(page as never);
    page.emit('response', resp('https://a.test/', old, ['late=1']));
    expect((await c.collect(undefined)).list).toEqual([]);
  });

  it('a response whose headers cannot be read is skipped, the others still count', async () => {
    const page = fakePage();
    const c = attachCookieCollector(page as never);
    const a = req('a');
    const b = req('b');
    page.emit('request', a);
    page.emit('request', b);
    page.emit('response', resp('https://a.test/', a, [], true));
    page.emit('response', resp('https://a.test/b', b, ['ok=1']));
    expect((await c.collect(undefined)).list.map((k) => k.n)).toEqual(['ok']);
  });

  it('reads the redirect chain of the main request', async () => {
    const page = fakePage();
    const c = attachCookieCollector(page as never);
    const hop = req('hop');
    resp('https://a.test/start', hop, ['viaRedirect=1']);
    const final = req('final', hop);
    const finalResp = resp('https://a.test/end', final, ['atEnd=1']);
    page.emit('request', hop);
    page.emit('request', final);
    page.emit('response', finalResp);
    const out = await c.collect(finalResp as never);
    expect(out.list.map((k) => k.n).sort()).toEqual(['atEnd', 'viaRedirect']);
  });

  it('script writes from every frame are mapped with that frame\'s own host; a broken or hung frame is skipped', async () => {
    const top = { evaluate: async () => [{ n: 'ga', p: '/', fh: 'www.a.test', fp: '/page' }] };
    const ad = { evaluate: async () => [{ n: 'fra', fh: 'localhost', fp: '/frame/f.html' }] };
    const dead = { evaluate: async () => { throw new Error('Frame was detached'); } };
    const hung = { evaluate: () => new Promise<unknown>(() => {}) };
    const page = fakePage([top, ad, dead, hung]);
    const c = attachCookieCollector(page as never, { frameTimeoutMs: 50 });
    const out = await c.collect(undefined);
    expect(out.list.map((k) => [k.n, k.d, k.p, k.by, k.h])).toEqual([
      ['ga', 'www.a.test', '/', 'script', 0],
      ['fra', 'localhost', '/frame', 'script', 0],
    ]);
  });

  it('a header cookie wins over the same cookie written by a script', async () => {
    const page = fakePage([{ evaluate: async () => [{ n: 'sid', d: 'a.test', p: '/', fh: 'a.test', fp: '/' }] }]);
    const c = attachCookieCollector(page as never);
    const r = req('doc');
    page.emit('request', r);
    page.emit('response', resp('https://a.test/', r, ['sid=1; HttpOnly']));
    const out = await c.collect(undefined);
    expect(out.list).toHaveLength(1);
    expect(out.list[0]).toMatchObject({ n: 'sid', by: 'header', h: 1 });
  });

  it('collect detaches the listeners: a response after it is not counted; finish is safe to repeat', async () => {
    const page = fakePage();
    const c = attachCookieCollector(page as never);
    await c.collect(undefined);
    expect(page.listenerCount('response')).toBe(0);
    expect(page.listenerCount('request')).toBe(0);
    c.finish();
    c.finish();
  });
});
