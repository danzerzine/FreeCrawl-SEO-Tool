import type { CrawlConfig } from '@freecrawl/shared-types';
import type { BrowserPool, BrowserPoolOptions } from './browser-pool.js';
import { MOBILE_DEVICE_SCALE_FACTOR, MOBILE_USER_AGENT, MOBILE_VIEWPORT } from './http-client.js';
import { renderUrl, type RenderOptions } from './render-fetcher.js';

/**
 * The Playwright pool a crawl renders with, from its settings. The desktop
 * and the CLI both build their pool here, so they render alike.
 */
export function browserPoolOptionsFromConfig(config: CrawlConfig): BrowserPoolOptions {
  const js = config.jsRender;
  const blocked = new Set<string>();
  if (js.blockResources.image) blocked.add('image');
  if (js.blockResources.font) blocked.add('font');
  if (js.blockResources.media) blocked.add('media');
  if (js.blockResources.stylesheet) blocked.add('stylesheet');
  if (js.blockResources.script) blocked.add('script');
  // Mobile device mode renders the real mobile view (UA + mobile viewport
  // + touch + DPR), matching the mobile User-Agent the HTTP paths use.
  const mobile = config.deviceMode === 'mobile';
  return {
    maxPages: js.maxPages > 0 ? js.maxPages : Math.max(1, Math.min(8, config.maxConcurrency)),
    headless: js.headless,
    viewport: mobile
      ? { width: MOBILE_VIEWPORT.width, height: MOBILE_VIEWPORT.height }
      : { width: js.viewportWidth, height: js.viewportHeight },
    isMobile: mobile || undefined,
    deviceScaleFactor: mobile ? MOBILE_DEVICE_SCALE_FACTOR : undefined,
    userAgent: (mobile ? MOBILE_USER_AGENT : config.userAgent) || undefined,
    acceptLanguage: config.acceptLanguage || undefined,
    channel: js.browserChannel || undefined,
    blockResourceTypes: blocked.size > 0 ? blocked : undefined,
    // Registered once at context level: set on each page it accumulated
    // across reused slots and ran N times per navigation.
    prerenderJs: js.prerenderJs || undefined,
  };
}

/** How one URL is rendered: timeouts and waits from the crawl's settings. */
export function renderOptionsFromConfig(config: CrawlConfig): RenderOptions {
  return {
    timeoutMs: Math.max(5000, config.requestTimeoutMs),
    ajaxTimeoutMs: config.jsRender.ajaxTimeoutMs,
    waitSelector: config.jsRender.waitSelector || undefined,
    waitUntil: config.jsRender.waitUntil,
    discoverSpaRoutes: config.jsRender.spaRouting,
  };
}

export type RenderHook = (
  url: string,
  urlId: number | null,
  signal: AbortSignal,
) => Promise<{
  ok: boolean;
  html: string;
  timingMs: number;
  error?: string;
  spaRoutes?: string[];
  navigatedTo?: string | null;
}>;

/**
 * The crawler's `renderUrl` hook over a pool: the DOM after the scripts
 * ran. No screenshots, LCP, accessibility or mobile checks; the desktop
 * adds those in its own hook.
 */
export function createRenderHook(pool: BrowserPool, config: CrawlConfig): RenderHook {
  const opts = renderOptionsFromConfig(config);
  return async (url, _urlId, signal) => {
    if (pool.isClosed()) return { ok: false, html: '', timingMs: 0, error: 'pool closed' };
    const res = await renderUrl(url, pool, opts, signal);
    return {
      ok: res.ok,
      html: res.html,
      timingMs: res.timingMs,
      error: res.error,
      spaRoutes: res.spaRoutes,
      navigatedTo: res.navigatedTo ?? null,
    };
  };
}
