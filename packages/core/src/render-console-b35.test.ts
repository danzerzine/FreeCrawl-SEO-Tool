import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { attachConsoleCollector, CONSOLE_LOG_MAX_ENTRIES } from './render-console.js';

// A fake Page and fake requests: the collector without Chromium (M11 B35).
type FakeReq = {
  resourceType: () => string;
  failure: () => { errorText: string } | null;
  isNavigationRequest: () => boolean;
  url: () => string;
};
const req = (url: string, type = 'script', failure: string | null = null): FakeReq => ({
  url: () => url,
  resourceType: () => type,
  failure: () => (failure ? { errorText: failure } : null),
  isNavigationRequest: () => false,
});
const resp = (r: FakeReq, status: number) => ({
  status: () => status,
  url: () => r.url(),
  request: () => r,
});
const consoleMsg = (type: string, text: string) => ({ type: () => type, text: () => text });

function setup(blocked?: ReadonlySet<string>) {
  const page = new EventEmitter();
  const c = attachConsoleCollector(page as never, { blockedTypes: blocked });
  const start = (r: FakeReq) => page.emit('request', r);
  return { page, c, start };
}

describe('attachConsoleCollector (B35 step 1)', () => {
  it('counts console errors and page errors; other console types are ignored', () => {
    const { page, c } = setup();
    page.emit('console', consoleMsg('error', 'x'));
    page.emit('console', consoleMsg('warning', 'w'));
    page.emit('console', consoleMsg('log', 'l'));
    page.emit('pageerror', new Error('boom'));
    const log = c.finish();
    expect(log.errors).toBe(2);
    expect(log.failed).toBe(0);
    expect(log.entries.map((e) => [e.kind, e.text])).toEqual([
      ['console', 'x'],
      ['pageerror', 'boom'],
    ]);
  });

  it('drops the browser echo "Failed to load resource" (the resource is counted under failed)', () => {
    const { page, c, start } = setup();
    const r = req('http://x/a.js');
    start(r);
    page.emit('response', resp(r, 404));
    page.emit('console', consoleMsg('error', 'Failed to load resource: the server responded with a status of 404 (Not Found)'));
    const log = c.finish();
    expect(log.errors).toBe(0);
    expect(log.failed).toBe(1);
  });

  it('counts a request once: a response >= 400 wins over the later ERR_ABORTED', () => {
    const { page, c, start } = setup();
    const r = req('http://x/a.js', 'script', 'net::ERR_ABORTED');
    start(r);
    page.emit('response', resp(r, 404));
    page.emit('requestfailed', r);
    const log = c.finish();
    expect(log.failed).toBe(1);
    expect(log.entries).toEqual([{ kind: 'http', url: 'http://x/a.js', type: 'script', status: 404 }]);
  });

  it('records a failed request with its error text and type', () => {
    const { page, c, start } = setup();
    const r = req('http://x/i.png', 'image', 'net::ERR_CONNECTION_REFUSED');
    start(r);
    page.emit('requestfailed', r);
    expect(c.finish().entries).toEqual([
      { kind: 'failed', url: 'http://x/i.png', type: 'image', text: 'net::ERR_CONNECTION_REFUSED' },
    ]);
  });

  it('skips requests of a type the crawl blocks on purpose', () => {
    const { page, c, start } = setup(new Set(['image']));
    const r = req('http://x/i.png', 'image', 'net::ERR_FAILED');
    start(r);
    page.emit('requestfailed', r);
    expect(c.finish().failed).toBe(0);
  });

  it('ignores a request that started before the listeners were attached', () => {
    const { page, c } = setup();
    const old = req('http://x/old.js', 'script', 'net::ERR_ABORTED');
    page.emit('requestfailed', old);
    page.emit('response', resp(old, 500));
    expect(c.finish().failed).toBe(0);
  });

  it('ignores the main document response (a navigation request)', () => {
    const { page, c, start } = setup();
    const r = { ...req('http://x/'), isNavigationRequest: () => true };
    start(r);
    page.emit('response', resp(r, 500));
    expect(c.finish().failed).toBe(0);
  });

  it('clips console text to 300 chars', () => {
    const { page, c } = setup();
    page.emit('console', consoleMsg('error', 'e'.repeat(1000)));
    expect(c.finish().entries[0]?.text).toHaveLength(300);
  });

  it('keeps at most 50 entries but counts everything', () => {
    const { page, c } = setup();
    for (let i = 0; i < 10_000; i++) page.emit('console', consoleMsg('error', `e${i}`));
    const log = c.finish();
    expect(CONSOLE_LOG_MAX_ENTRIES).toBe(50);
    expect(log.entries).toHaveLength(50);
    expect(log.errors).toBe(10_000);
    expect(log.entries[0]?.text).toBe('e0');
  });

  it('detaches every listener on finish', () => {
    const { page, c } = setup();
    c.finish();
    for (const ev of ['console', 'pageerror', 'request', 'requestfailed', 'response']) {
      expect(page.listenerCount(ev)).toBe(0);
    }
    page.emit('console', consoleMsg('error', 'late'));
    expect(c.finish().errors).toBe(0);
  });
});
