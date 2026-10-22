import { hasPageScript, type CrawlConfig } from '@freecrawl/shared-types';
import type { BrowserPool } from './browser-pool.js';
import { RENDER_LIMIT_MARGIN_MS } from './page-script.js';
import { auditMobileUsability, renderUrl } from './render-fetcher.js';

export interface MobilePassResult {
  /** Path of the 375 x 667 above-the-fold PNG, when it was taken. */
  screenshotPath?: string;
  usability: { ok: boolean; overflowPx: number; hasViewportMeta: boolean } | null;
}

/**
 * The desktop's mobile pass: an optional mobile screenshot and the mobile
 * usability audit, each a second navigation on the same pool. Whatever the
 * caller's fetch timers do, these calls are cut off by their own limit.
 */
export async function runMobilePass(
  url: string,
  pool: BrowserPool,
  config: CrawlConfig,
  opts: { screenshotPath?: string; limitMs?: number },
  signal?: AbortSignal,
): Promise<MobilePassResult> {
  const out: MobilePassResult = { usability: null };
  const timeoutMs = Math.max(5000, config.requestTimeoutMs);
  // With a page script the crawler has cleared its fetch and response-time
  // timers, so each call here carries its own limit (a call without one is
  // cut off by those timers as before).
  const limitMs = hasPageScript(config.jsRender.pageScript)
    ? (opts.limitMs ?? timeoutMs + RENDER_LIMIT_MARGIN_MS)
    : undefined;
  if (config.jsRender.mobileScreenshot && opts.screenshotPath) {
    const mobileRes = await renderUrl(
      url,
      pool,
      {
        timeoutMs,
        ajaxTimeoutMs: Math.min(config.jsRender.ajaxTimeoutMs, 1000),
        waitUntil: config.jsRender.waitUntil,
        limitMs,
        screenshotMode: 'fold',
        screenshotPaths: { fold: opts.screenshotPath },
        // A mobile viewport, so the PNG matches the column name.
        viewport: { width: 375, height: 667 },
      },
      signal,
    );
    if (mobileRes.ok && mobileRes.screenshots?.fold)
      out.screenshotPath = mobileRes.screenshots.fold;
  }
  if (config.jsRender.mobileUsability) {
    const audit = await auditMobileUsability(
      url,
      pool,
      { timeoutMs, waitUntil: config.jsRender.waitUntil, limitMs },
      signal,
    );
    if (audit) {
      out.usability = {
        ok: audit.ok,
        overflowPx: audit.overflowPx,
        hasViewportMeta: audit.hasViewportMeta,
      };
    }
  }
  return out;
}
