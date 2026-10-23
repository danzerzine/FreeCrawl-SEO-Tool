import { createServer, type Server } from 'node:http';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ProjectDb } from '@freecrawl/db';
import { DEFAULT_CRAWL_CONFIG } from '@freecrawl/shared-types';
import { compareCrawls } from './compare.js';
import { Crawler } from './crawler.js';
import type { RenderHook } from './render-config.js';

// B162: a refresh crawl whose browser dies after the first rendered page. The later pages must
// store "not checked" (NULL / -1), not keep the first crawl's values, and compare must skip them.
const HTML = (links: string): string =>
  `<html><head><title>T</title></head><body><h1>H</h1>${links}</body></html>`;
const PAGES: Record<string, string> = {
  '/': HTML('<a href="/a">a</a><a href="/b">b</a>'),
  '/a': HTML(''),
  '/b': HTML(''),
};
let server: Server;
let dir: string;
let base: string;
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'fc-b162-'));
  server = createServer((req, res) => {
    const html = PAGES[req.url ?? '/'];
    if (html === undefined) return void res.writeHead(404).end('nope');
    res.writeHead(200, { 'content-type': 'text/html' }).end(html);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(() => {
  server.close();
  rmSync(dir, { recursive: true, force: true });
});

/** Renders the first `okPages` pages with every audit result, then fails: one returns ok:false, the rest throw. */
function dyingBrowser(okPages: number): { hook: RenderHook; rendered: string[] } {
  const rendered: string[] = [];
  let calls = 0;
  const hook: RenderHook = async (url) => {
    calls++;
    if (calls > okPages) {
      if (calls === okPages + 1) return { ok: false, html: '', timingMs: 1, error: 'browser disconnected' };
      throw new Error('browser pool exhausted');
    }
    rendered.push(url);
    const path = new URL(url).pathname;
    return {
      ok: true,
      html: PAGES[path]!,
      timingMs: 5,
      consoleLog: { errors: 1, failed: 1, entries: [{ kind: 'console', text: 'x' }] },
      a11y: { lowContrast: 2, sampled: 10, focusSuppressed: true, smallFont: 1, tapTargetsSmall: 1, tapTargetsSampled: 5 },
      mobileUsability: { ok: false, overflowPx: 40, hasViewportMeta: true },
      axe: { version: '4.14.0', violations: [], incomplete: [], violationsTotal: 3, seriousTotal: 2 },
      axeMs: 3,
    };
  };
  return { hook, rendered };
}

async function crawl(
  db: ProjectDb,
  hook: RenderHook,
  jsRender: Partial<typeof DEFAULT_CRAWL_CONFIG.jsRender> = {},
): Promise<void> {
  const c = new Crawler(
    {
      ...DEFAULT_CRAWL_CONFIG,
      startUrl: `${base}/`,
      renderingMode: 'js',
      maxConcurrency: 1,
      discoverSitemaps: false,
      checkExternalLinks: false,
      probeTlsCerts: false,
      probeManifestJson: false,
      probeSocialImages: false,
      probeImageSizes: false,
      jsRender: {
        ...DEFAULT_CRAWL_CONFIG.jsRender,
        consoleErrors: true,
        a11yAudit: true,
        mobileUsability: true,
        axeAudit: true,
        ...jsRender,
      },
    },
    db,
    { renderUrl: hook },
  );
  c.on('error', () => {});
  await c.start();
}

const COLS = `js_h1_changed, js_canonical_changed, js_links_changed, js_text_changed, console_errors, failed_resources,
  a11y_low_contrast, a11y_focus_suppressed, a11y_small_font, a11y_tap_targets_small, axe_violations, axe_serious, axe_incomplete`;

function raw(file: string, path: string): Record<string, number | null> {
  const d = new DatabaseSync(file);
  try {
    return d
      .prepare(`SELECT ${COLS}, mobile_usable, mobile_overflow_px, mobile_viewport_meta FROM urls WHERE url = ?`)
      .get(`${base}${path}`) as Record<string, number | null>;
  } finally {
    d.close();
  }
}

describe('refresh crawl whose browser dies after the first page (B162)', () => {
  it('later pages store not-checked, the first keeps its values, and compare skips the lost ones', async () => {
    const fileB = join(dir, 'b.seoproject');
    const fileA = join(dir, 'a.seoproject');
    let db = new ProjectDb(fileB);
    await crawl(db, dyingBrowser(99).hook);
    for (const p of ['/', '/a', '/b']) {
      const r = raw(fileB, p);
      expect(r.console_errors, p).toBe(1);
      expect(r.a11y_low_contrast, p).toBe(2);
      expect(r.axe_serious, p).toBe(2);
      expect(r.mobile_usable, p).toBe(0);
    }
    db.close();
    copyFileSync(fileB, fileA);
    db = new ProjectDb(fileB);

    const dying = dyingBrowser(1);
    await crawl(db, dying.hook);
    expect(dying.rendered).toHaveLength(1);
    const okPath = new URL(dying.rendered[0]!).pathname;
    const lost = ['/', '/a', '/b'].filter((p) => p !== okPath);
    expect(lost).toHaveLength(2);

    expect(raw(fileB, okPath).a11y_low_contrast).toBe(2);
    expect(raw(fileB, okPath).mobile_usable).toBe(0);
    for (const p of lost) {
      const r = raw(fileB, p);
      for (const col of COLS.split(/,\s*/)) expect(r[col], `${p} ${col}`).toBeNull();
      expect(r.mobile_usable, p).toBe(-1);
      expect(r.mobile_overflow_px, p).toBe(0);
      expect(r.mobile_viewport_meta, p).toBe(-1);
    }

    // The grid cell is empty for a lost page, and the issue lists hold only the rendered one.
    const row = db.getUrlById(db.getUrlIdByUrl(`${base}${lost[0]}`)!)!;
    expect(row.consoleErrors).toBeNull();
    expect(row.a11yLowContrast).toBeNull();
    expect(row.axeSerious).toBeNull();
    expect(row.mobileOverflowPx).toBeNull();
    for (const k of ['console-errors', 'low-contrast-text', 'axe-critical-serious', 'content-wider-than-screen']) {
      const rows = db.queryUrls({ limit: 10, offset: 0, category: `issues:${k}` as never }).rows;
      expect(rows, k).toHaveLength(1);
    }

    // Compare against the first crawl: nothing resolved for the lost pages.
    const a = new ProjectDb(fileA);
    try {
      const s = compareCrawls(a, db);
      for (const k of ['console-errors', 'failed-resources', 'low-contrast-text', 'font-too-small', 'axe-critical-serious', 'content-wider-than-screen', 'h1-changed-by-js']) {
        expect(s.issueChanges[`issues:${k}`], k).toBeUndefined();
      }
      expect(s.notComparable['issues:low-contrast-text']?.urls).toBe(2);
      expect(s.notComparable['issues:content-wider-than-screen']?.urls).toBe(2);
    } finally {
      a.close();
      db.close();
    }
  });

  it('with the a11y and mobile options off, a failed render leaves the old values untouched (known limit)', async () => {
    const file = join(dir, 'off.seoproject');
    let db = new ProjectDb(file);
    await crawl(db, dyingBrowser(99).hook);
    db.close();
    db = new ProjectDb(file);
    await crawl(db, dyingBrowser(0).hook, { a11yAudit: false, mobileUsability: false });
    db.close();
    for (const p of ['/', '/a', '/b']) {
      const r = raw(file, p);
      expect(r.a11y_low_contrast, p).toBe(2);
      expect(r.mobile_usable, p).toBe(0);
      expect(r.mobile_overflow_px, p).toBe(40);
    }
  });
});
