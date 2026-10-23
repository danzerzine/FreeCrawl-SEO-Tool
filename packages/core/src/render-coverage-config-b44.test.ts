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

describe('jsRender.coverage (B44)', () => {
  it('is off by default: the render option is not set', () => {
    expect(DEFAULT_CRAWL_CONFIG.jsRender.coverage).toBe(false);
    expect(renderOptionsFromConfig(config()).collectCoverage).toBeFalsy();
  });

  it('on: the render measures coverage', () => {
    expect(renderOptionsFromConfig(config({ coverage: true })).collectCoverage).toBe(true);
  });

  it('is independent of the cookie list and the console log', () => {
    const o = renderOptionsFromConfig(config({ coverage: true, cookieList: false, consoleErrors: true }));
    expect(o.collectCoverage).toBe(true);
    expect(o.collectCookies).toBeFalsy();
  });
});

describe('renderHookFields carries coverage (B44)', () => {
  it('copies the summary and gives undefined when the render has none', () => {
    const cov = { cssBytes: 10, cssUnusedBytes: 7, jsBytes: 20, jsUnusedBytes: 5 };
    const res = { ok: true, html: '', timingMs: 1, coverage: cov } as unknown as RenderResult;
    expect(renderHookFields(res).coverage).toEqual(cov);
    expect(renderHookFields({ ok: true, html: '', timingMs: 1 } as unknown as RenderResult).coverage).toBeUndefined();
  });
});
