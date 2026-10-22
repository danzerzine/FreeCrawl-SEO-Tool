import type { RenderHook, RenderHookResult } from './render-config.js';

/**
 * A render hook without Chromium for crawl tests: the rendered HTML of a URL
 * comes from a map. A URL not in the map renders as a failed render with
 * `error` set. `over` merges extra hook-result fields per URL (servedHtml,
 * navigatedTo, scriptRan, ...), or a function can compute them.
 */
export function fakeRender(
  map: Record<string, string>,
  over: Partial<RenderHookResult> | ((url: string) => Partial<RenderHookResult>) = {},
): RenderHook {
  return async (url) => {
    const extra = typeof over === 'function' ? over(url) : over;
    const html = map[url];
    if (html === undefined) {
      return { ok: false, html: '', timingMs: 1, error: 'fake render: no page', ...extra };
    }
    return { ok: true, html, timingMs: 5, ...extra };
  };
}
