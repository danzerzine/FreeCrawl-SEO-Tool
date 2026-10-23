import { describe, expect, it } from 'vitest';
import { DEFAULT_CRAWL_CONFIG, type CrawlConfig } from '@freecrawl/shared-types';
import {
  browserPoolOptionsFromConfig,
  renderHookFields,
  renderOptionsFromConfig,
  type RenderHookResult,
} from './render-config.js';
import type { RenderResult } from './render-fetcher.js';

const config = (jsRender: Partial<CrawlConfig['jsRender']> = {}): CrawlConfig => ({
  ...DEFAULT_CRAWL_CONFIG,
  jsRender: { ...DEFAULT_CRAWL_CONFIG.jsRender, ...jsRender },
});

describe('jsRender.cookieList (B43)', () => {
  it('is off by default: the render option is not set and the pool installs no recorder', () => {
    expect(DEFAULT_CRAWL_CONFIG.jsRender.cookieList).toBe(false);
    expect(renderOptionsFromConfig(config()).collectCookies).toBeFalsy();
    expect(browserPoolOptionsFromConfig(config()).cookieRecorder).toBeFalsy();
  });

  it('on: the render collects cookies and the pool installs the recorder', () => {
    expect(renderOptionsFromConfig(config({ cookieList: true })).collectCookies).toBe(true);
    expect(browserPoolOptionsFromConfig(config({ cookieList: true })).cookieRecorder).toBe(true);
  });
});

describe('renderHookFields (a field not listed is silently dropped)', () => {
  // Every key a full hook result can carry, apart from the ones only the desktop hook fills.
  // `Required<>` makes a new key of RenderHookResult a compile error here until it is listed.
  const DESKTOP_ONLY = ['screenshots', 'lcp', 'mobileUsability', 'a11y'] as const;
  const full: Required<RenderHookResult> = {
    ok: true,
    html: '<html></html>',
    timingMs: 1,
    error: 'e',
    screenshots: {},
    lcp: null,
    mobileUsability: null,
    a11y: null,
    spaRoutes: [],
    navigatedTo: null,
    servedHtml: 's',
    scriptRan: true,
    scriptResult: '1',
    renderedHtmlPreScript: 'p',
    consoleLog: { errors: 0, failed: 0, entries: [] },
    axe: null,
    axeMs: 1,
    cookies: { total: 1, truncated: false, list: [] },
  };

  it('copies every non-desktop key of a full hook result', () => {
    const res = { ...full, status: 200, statusText: 'OK', headers: {}, url: 'u' } as unknown as RenderResult;
    const out = renderHookFields(res) as unknown as Record<string, unknown>;
    const want = Object.keys(full).filter((k) => !(DESKTOP_ONLY as readonly string[]).includes(k));
    expect(want.filter((k) => !(k in out))).toEqual([]);
    expect(out['cookies']).toEqual(full.cookies);
  });

  it('a render without cookies gives undefined, not an empty list', () => {
    const res = { ok: true, html: '', timingMs: 1 } as unknown as RenderResult;
    expect(renderHookFields(res).cookies).toBeUndefined();
  });
});
