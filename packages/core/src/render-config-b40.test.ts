import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_CRAWL_CONFIG, type CrawlConfig } from '@freecrawl/shared-types';
import type { BrowserPool } from './browser-pool.js';
import type { AxeAudit } from './axe-reduce.js';
import type * as RenderFetcher from './render-fetcher.js';

const audit: AxeAudit = {
  version: '4.14.0',
  violations: [],
  incomplete: [],
  violationsTotal: 0,
  seriousTotal: 0,
};

vi.mock('./render-fetcher.js', async (orig) => {
  const real = await orig<typeof RenderFetcher>();
  return {
    ...real,
    renderUrl: vi.fn(async () => ({
      status: 200,
      statusText: 'OK',
      headers: {},
      url: 'http://x.test/',
      html: '<html></html>',
      timingMs: 7,
      ok: true,
      axe: audit,
    })),
  };
});

const { createRenderHook, renderOptionsFromConfig, renderHookFields } = await import('./render-config.js');
const { renderUrl } = await import('./render-fetcher.js');

const config = (jsRender: Partial<CrawlConfig['jsRender']> = {}): CrawlConfig => ({
  ...DEFAULT_CRAWL_CONFIG,
  jsRender: { ...DEFAULT_CRAWL_CONFIG.jsRender, ...jsRender },
});

describe('jsRender.axeAudit (B40 R1, R2)', () => {
  it('is off by default and separate from a11yAudit', () => {
    expect(DEFAULT_CRAWL_CONFIG.jsRender.axeAudit).toBe(false);
    expect(renderOptionsFromConfig(config()).detectAxe).toBeFalsy();
    expect(renderOptionsFromConfig(config({ a11yAudit: true })).detectAxe).toBeFalsy();
  });

  it('turns detectAxe on without turning a11y on', () => {
    const o = renderOptionsFromConfig(config({ axeAudit: true }));
    expect(o.detectAxe).toBe(true);
    expect(o.detectA11y).toBeFalsy();
  });

  it('the CLI hook passes the axe result through', async () => {
    const pool = { isClosed: () => false } as unknown as BrowserPool;
    const hook = createRenderHook(pool, config({ axeAudit: true }));
    const res = await hook('http://x.test/', null, new AbortController().signal);
    expect(renderUrl).toHaveBeenCalled();
    expect(res.axe).toEqual(audit);
  });

  it('the shared field mapper (also used by the desktop hook) keeps axe, and null when absent', () => {
    const base = { status: 200, statusText: '', headers: {}, url: 'u', html: 'h', timingMs: 1, ok: true };
    expect(renderHookFields({ ...base, axe: audit }).axe).toEqual(audit);
    expect(renderHookFields(base).axe).toBeNull();
  });
});
