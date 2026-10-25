/**
 * Running axe-core inside a rendered page (B40 R3-R6).
 *
 * axe-core is an unmodified npm dependency (MPL-2.0); its minified build is read
 * from the package at first use (createRequire, so it works from ESM and from the
 * bundled desktop main process) and injected with `page.evaluate`, which is not
 * subject to the page's Content-Security-Policy.
 */

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { reduceAxeResults } from './axe-reduce.js';

/**
 * How long one `axe.run` may take. Keep this ABOVE the small `requestTimeoutMs` used by the
 * R6a test (axe-chromium-b40.test.ts): that test only proves the crawler's fetch timer no
 * longer cuts an axe run short while the run is longer than the fetch timeout.
 */
export const AXE_RUN_MS = 10_000;
/** After a timeout: how long the page gets to answer a trivial evaluate before it is replaced. */
export const AXE_PROBE_MS = 2_000;

const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

let cached: string | null | undefined;

/** Default resolver: the path of axe-core's minified build. */
function resolveAxePath(): string {
  return createRequire(import.meta.url).resolve('axe-core/axe.min.js');
}

/**
 * The axe-core source, read once. Null when the package cannot be found or read
 * (reported by the caller as a failed run, never thrown). A custom resolver (tests)
 * is not cached.
 */
export function loadAxeSource(resolve?: () => string): string | null {
  if (!resolve && cached !== undefined) return cached;
  let src: string | null;
  try {
    src = readFileSync((resolve ?? resolveAxePath)(), 'utf8');
  } catch {
    src = null;
  }
  if (!resolve) cached = src;
  return src;
}

/**
 * The in-page expression: runs axe on the document and returns only the reduced result.
 * Only constants go into it (`AXE_TAGS` through `JSON.stringify`, the source of
 * `reduceAxeResults`), no crawled data, so code scanning's bad-code-sanitization
 * finding here is a false positive (B201). It runs in the crawled page's own context,
 * though, so the page can tamper with the result: it is reduced and stored as data,
 * never trusted.
 */
export function axeRunExpression(): string {
  const opts = JSON.stringify({
    resultTypes: ['violations', 'incomplete'],
    runOnly: { type: 'tag', values: AXE_TAGS },
    iframes: false,
  });
  return `(() => { const reduce = ${reduceAxeResults.toString()}; return Promise.resolve(axe.run(document, ${opts})).then((r) => reduce(r)); })()`;
}

/** A rejected evaluate that means the tab or context is gone, not a JS error from the page. */
export function isDeadPageError(message: string): boolean {
  return /crash|closed|destroyed|detached|disconnected|Target /i.test(message);
}
