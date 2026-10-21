import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { formatAlert, sendSlack, sendTelegram, sendWebhook, type AlertRuleResult } from './notify.js';

function fired(i: number, over: Partial<AlertRuleResult> = {}): AlertRuleResult {
  return {
    name: `Rule ${i}`, metric: 'status.404', level: 'fail', status: 'fired',
    previous: 10, current: 70, change: 60, threshold: { op: '>', value: 50 }, ...over,
  };
}

interface Hit { url: string; body: string }
let server: http.Server;
let base: string;
let hits: Hit[];
let respond: (res: http.ServerResponse) => void;

beforeEach(async () => {
  hits = [];
  respond = (res) => { res.statusCode = 200; res.end('ok'); };
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => { hits.push({ url: req.url ?? '', body }); respond(res); });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(() => { server.closeAllConnections(); server.close(); });

describe('formatAlert', () => {
  it('lists only fired rules with previous -> current', () => {
    const text = formatAlert([fired(1), fired(2, { status: 'pass', name: 'Quiet' })]);
    expect(text).toContain('Rule 1');
    expect(text).toContain('10 → 70');
    expect(text).not.toContain('Quiet');
  });
  it('cuts a long list to the limit with "and N more"', () => {
    const text = formatAlert(Array.from({ length: 300 }, (_, i) => fired(i)), { maxChars: 4096 });
    expect(text.length).toBeLessThanOrEqual(4096);
    expect(text).toMatch(/and \d+ more$/);
  });
});

describe('sendSlack', () => {
  it('posts {text} listing fired rules', async () => {
    const r = await sendSlack(`${base}/services/T/B/SECRETPART`, [fired(1)]);
    expect(r.ok).toBe(true);
    const body = JSON.parse(hits[0]!.body);
    expect(Object.keys(body)).toEqual(['text']);
    expect(body.text).toContain('10 → 70');
  });
  it('returns ok:false on 500 and hides the URL secret', async () => {
    respond = (res) => { res.statusCode = 500; res.end('boom'); };
    const r = await sendSlack(`${base}/services/T/B/SECRETPART`, [fired(1)]);
    expect(r.ok).toBe(false);
    expect(r.detail).not.toContain('SECRETPART');
  });
  it('returns ok:false on timeout without throwing', async () => {
    respond = () => { /* never answers */ };
    const r = await sendSlack(`${base}/x/SECRETPART`, [fired(1)], { timeoutMs: 100 });
    expect(r.ok).toBe(false);
    expect(r.detail).not.toContain('SECRETPART');
  });
  it('returns ok:false for an unparseable URL', async () => {
    const r = await sendSlack('not a url SECRETPART', [fired(1)]);
    expect(r.ok).toBe(false);
    expect(r.detail).not.toContain('SECRETPART');
  });
});

describe('sendTelegram', () => {
  const cfg = () => ({ apiBase: base, token: '123:SECRETTOKEN', chatId: '-100500' });
  it('calls sendMessage with chat id and text under 4096 chars', async () => {
    const r = await sendTelegram(cfg(), Array.from({ length: 300 }, (_, i) => fired(i)));
    expect(r.ok).toBe(true);
    expect(hits[0]!.url).toBe('/bot123:SECRETTOKEN/sendMessage');
    const body = JSON.parse(hits[0]!.body);
    expect(body.chat_id).toBe('-100500');
    expect(body.text.length).toBeLessThanOrEqual(4096);
    expect(body.text).toMatch(/and \d+ more$/);
  });
  it('never leaks the token on 500, timeout or echo', async () => {
    respond = (res) => { res.statusCode = 500; res.end('bad /bot123:SECRETTOKEN/sendMessage'); };
    const a = await sendTelegram(cfg(), [fired(1)]);
    expect(a.ok).toBe(false);
    expect(a.detail).not.toContain('SECRETTOKEN');
    respond = () => { /* hang */ };
    const b = await sendTelegram(cfg(), [fired(1)], { timeoutMs: 100 });
    expect(b.ok).toBe(false);
    expect(b.detail).not.toContain('SECRETTOKEN');
  });
});

describe('sendWebhook', () => {
  it('posts the JSON results', async () => {
    const results = [fired(1), fired(2, { status: 'pass' })];
    const r = await sendWebhook(`${base}/hook`, results);
    expect(r.ok).toBe(true);
    expect(JSON.parse(hits[0]!.body).results).toEqual(results);
  });
  it('names the site in the JSON title', async () => {
    await sendWebhook(`${base}/hook`, [fired(1)], { title: 'FreeCrawl alert for https://site.test/' });
    expect(JSON.parse(hits.at(-1)!.body).title).toBe('FreeCrawl alert for https://site.test/');
  });
  it('returns ok:false on 500', async () => {
    respond = (res) => { res.statusCode = 500; res.end('x'); };
    expect((await sendWebhook(`${base}/hook`, [fired(1)])).ok).toBe(false);
  });
});
