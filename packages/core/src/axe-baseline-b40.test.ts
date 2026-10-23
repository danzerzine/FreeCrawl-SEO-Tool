import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ProjectDb } from '@freecrawl/db';
import { DEFAULT_CRAWL_CONFIG } from '@freecrawl/shared-types';
import { Crawler } from './crawler.js';
import { fakeRender } from './fake-render.test-support.js';

// B40 R12: the four in-page accessibility heuristics are untouched. With axeAudit off (the
// default) a crawl gives exactly the counts below; each page has one finding of each kind.
const HTML = '<html><head><title>T</title></head><body><h1>H</h1></body></html>';
let server: Server;
let dir: string;
let base: string;
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'fc-b40b-'));
  server = createServer((_req, res) => void res.writeHead(200, { 'content-type': 'text/html' }).end(HTML));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
});
afterAll(() => {
  server.close();
  rmSync(dir, { recursive: true, force: true });
});

const A11Y = { lowContrast: 4, sampled: 20, focusSuppressed: true, smallFont: 2, tapTargetsSmall: 3, tapTargetsSampled: 10 };
const BASELINE = { lowContrastText: 1, focusOutlineSuppressed: 1, fontTooSmall: 1, tapTargetsTooSmall: 1 };

async function counts(axeAudit: boolean, name: string) {
  const db = new ProjectDb(join(dir, `${name}.seoproject`));
  const c = new Crawler(
    {
      ...DEFAULT_CRAWL_CONFIG,
      startUrl: base,
      renderingMode: 'js',
      maxConcurrency: 1,
      discoverSitemaps: false,
      checkExternalLinks: false,
      probeTlsCerts: false,
      probeManifestJson: false,
      probeSocialImages: false,
      probeImageSizes: false,
      jsRender: { ...DEFAULT_CRAWL_CONFIG.jsRender, a11yAudit: true, axeAudit },
    },
    db,
    { renderUrl: fakeRender({ [base]: HTML }, { a11y: A11Y }) },
  );
  c.on('error', () => {});
  await c.start();
  const o = db.getOverviewCounts().issues as unknown as Record<string, number>;
  db.close();
  return o;
}

describe('B40 R12: existing accessibility heuristics are unchanged', () => {
  it('with axeAudit off the four heuristic counts equal the stored baseline and no axe count appears', async () => {
    const o = await counts(false, 'off');
    expect({
      lowContrastText: o['lowContrastText'],
      focusOutlineSuppressed: o['focusOutlineSuppressed'],
      fontTooSmall: o['fontTooSmall'],
      tapTargetsTooSmall: o['tapTargetsTooSmall'],
    }).toEqual(BASELINE);
    expect([o['axeCriticalSerious'], o['axeModerateMinor'], o['axeNeedsReview']]).toEqual([0, 0, 0]);
  });

  it('with axeAudit on the same page gives the same heuristic counts (no de-duplication, no replacement)', async () => {
    const o = await counts(true, 'on');
    expect({
      lowContrastText: o['lowContrastText'],
      focusOutlineSuppressed: o['focusOutlineSuppressed'],
      fontTooSmall: o['fontTooSmall'],
      tapTargetsTooSmall: o['tapTargetsTooSmall'],
    }).toEqual(BASELINE);
  });
});
