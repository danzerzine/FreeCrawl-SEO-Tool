import { createServer, type Server } from 'node:http';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProjectDb } from '@freecrawl/db';
import { Crawler } from '@freecrawl/core';
import { DEFAULT_CRAWL_CONFIG, type CrawlConfig } from '@freecrawl/shared-types';

const userData = mkdtempSync(join(tmpdir(), 'b88d-userdata-'));

// Reversible stand-in for the OS keyring, so "encrypted" really hides the text.
vi.mock('electron', () => {
  const flip = (b: Buffer) => Buffer.from(b.map((x) => x ^ 0x5a));
  return {
    app: { getPath: () => userData },
    safeStorage: {
      isEncryptionAvailable: () => true,
      encryptString: (s: string) => flip(Buffer.from(s, 'utf8')),
      decryptString: (b: Buffer) => flip(b).toString('utf8'),
    },
  };
});

const { setCredentials, resolveCredentials, clearCredentials } = await import('./credentials.js');
const { serializeConfigWithEncryptedSecrets } = await import('./config-secrets.js');
const { alertAfterCrawl, crawlRunSaved, saveAlertsConfig, readAlertsConfig, sendTestAlert } = await import('./monitor-alerts.js');

const SLACK_SECRET = 'B0SECRET/xyzzy-slack-hook';
const TG_TOKEN = '987654:TOKEN-xyzzy';
const HOOK_SECRET = 'generic-hook-xyzzy';

let site: Server;
let capture: Server;
let base: string;
let captureBase: string;
let aboutStatus = 200;
let posts: { path: string; body: Record<string, unknown> }[] = [];
const dir = mkdtempSync(join(tmpdir(), 'b88d-'));

beforeAll(async () => {
  site = createServer((req, res) => {
    if (req.url === '/robots.txt' || req.url?.includes('sitemap')) {
      res.writeHead(404).end();
      return;
    }
    const page = (title: string) =>
      `<html><head><title>${title} page title long enough</title></head><body>` +
      `<a href="/about">about</a><a href="/contact">contact</a></body></html>`;
    res
      .writeHead(req.url === '/about' ? aboutStatus : 200, { 'content-type': 'text/html' })
      .end(page(req.url ?? 'Home'));
  });
  capture = createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString('utf8')));
    req.on('end', () => {
      posts.push({ path: req.url ?? '', body: JSON.parse(body || '{}') as Record<string, unknown> });
      res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
    });
  });
  await new Promise<void>((r) => site.listen(0, '127.0.0.1', r));
  await new Promise<void>((r) => capture.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(site.address() as { port: number }).port}/`;
  captureBase = `http://127.0.0.1:${(capture.address() as { port: number }).port}`;
});
afterAll(() => {
  site.close();
  capture.close();
  rmSync(dir, { recursive: true, force: true });
  rmSync(userData, { recursive: true, force: true });
});
beforeEach(() => {
  posts = [];
  aboutStatus = 200;
  clearCredentials('slack');
  clearCredentials('telegram');
});

const deps = (extra: { webhookUrl?: string } = {}) => ({
  credentials: resolveCredentials,
  telegramApiBase: `${captureBase}/tg`,
  log: () => {},
  ...extra,
});

/** One crawl, with the alert step hooked on 'done' the way the desktop's crawlDone handler runs it. */
async function crawlWithAlerts(db: ProjectDb, startUrl = base): Promise<void> {
  const c = new Crawler(
    {
      ...DEFAULT_CRAWL_CONFIG,
      startUrl,
      maxConcurrency: 2,
      discoverSitemaps: false,
      checkExternalLinks: false,
      probeTlsCerts: false,
      probeManifestJson: false,
      probeSocialImages: false,
      probeImageSizes: false,
    } as CrawlConfig,
    db,
  );
  let alerted: Promise<unknown> = Promise.resolve();
  c.on('error', () => {});
  c.on('done', () => {
    alerted = alertAfterCrawl(db, deps());
  });
  await c.start();
  await alerted;
}

const MORE_404 = { name: 'More 404s', metric: 'status.404', vs: 'previous' as const, op: '>' as const, value: 0 };

describe('alerts after a finished crawl (B88d)', () => {
  it('one rule that fires and a Slack channel: exactly one post, previous from the same resolved start URL', async () => {
    const file = join(dir, 'fires.seoproject');
    const db = new ProjectDb(file);
    // Set up before the first crawl: the first crawl of a project must not wipe it.
    saveAlertsConfig(db, { rules: [MORE_404], channels: ['slack'] });
    setCredentials('slack', { webhookUrl: `${captureBase}/slack/${SLACK_SECRET}` });
    setCredentials('telegram', { botToken: TG_TOKEN, chatId: '42' }); // configured but not turned on
    await crawlWithAlerts(db);
    // The desktop's typed URL differs from the crawler's resolved one.
    db.setMeta('lastStartUrl', base.replace(/\/$/, ''));
    expect(posts).toHaveLength(0); // no previous crawl: the rule is skipped
    aboutStatus = 404;
    await crawlWithAlerts(db);
    expect(posts).toHaveLength(1);
    expect(posts[0]!.path).toBe(`/slack/${SLACK_SECRET}`);
    expect(String(posts[0]!.body.text)).toContain('More 404s: status.404 0 → 1');
    expect(String(posts[0]!.body.text)).toContain(`FreeCrawl alert for ${base}: `);

    // The project file carries the rules but no channel secret in plain text.
    db.setMeta(
      'lastCrawlConfig',
      serializeConfigWithEncryptedSecrets({
        ...DEFAULT_CRAWL_CONFIG,
        startUrl: base,
        webhookUrl: `${captureBase}/${HOOK_SECRET}`,
      } as CrawlConfig),
    );
    db.close();
    const bytes = Buffer.concat(
      readdirSync(dir)
        .filter((f) => f.startsWith('fires.seoproject'))
        .map((f) => readFileSync(join(dir, f))),
    ).toString('latin1');
    expect(bytes).toContain('More 404s');
    for (const secret of ['xyzzy', SLACK_SECRET, TG_TOKEN, HOOK_SECRET, captureBase]) {
      expect(bytes).not.toContain(secret);
    }
  });

  it('a crawl whose history row was not saved sends no alert about an older crawl', async () => {
    const db = new ProjectDb(join(dir, 'unsaved.seoproject'));
    try {
      saveAlertsConfig(db, { rules: [{ ...MORE_404, vs: 'absolute' }], channels: ['slack'] });
      setCredentials('slack', { webhookUrl: `${captureBase}/slack/${SLACK_SECRET}` });
      aboutStatus = 404;
      await crawlWithAlerts(db);
      const before = posts.length;
      expect(before).toBeGreaterThan(0);
      // The next crawl started after the newest row: its own row is missing.
      const logs: string[] = [];
      const out = await alertAfterCrawl(
        db,
        { ...deps(), log: (_l: string, m: string) => logs.push(m) },
        { since: new Date(Date.now() + 1000).toISOString() },
      );
      expect(out).toEqual([]);
      expect(posts).toHaveLength(before);
      expect(logs.join('\n')).toMatch(/not saved/);
      // The scheduler marks such a run failed instead of successful.
      expect(crawlRunSaved(db, new Date(Date.now() + 1000).toISOString())).toBe(false);
      expect(crawlRunSaved(db, '2000-01-01T00:00:00.000Z')).toBe(true);
      expect(crawlRunSaved(new ProjectDb(join(dir, 'never.seoproject')), '2000-01-01T00:00:00.000Z')).toBe(false);
    } finally {
      aboutStatus = 200;
      db.close();
    }
  });

  it('no rules: no post', async () => {
    const db = new ProjectDb(join(dir, 'norules.seoproject'));
    saveAlertsConfig(db, { rules: [], channels: ['slack'] });
    setCredentials('slack', { webhookUrl: `${captureBase}/slack/${SLACK_SECRET}` });
    await crawlWithAlerts(db);
    aboutStatus = 404;
    await crawlWithAlerts(db);
    expect(posts).toHaveLength(0);
    db.close();
  });

  it('rules and channels survive a crawl of another site', async () => {
    const db = new ProjectDb(join(dir, 'moved.seoproject'));
    saveAlertsConfig(db, { rules: [MORE_404], channels: ['slack', 'webhook'] });
    await crawlWithAlerts(db);
    await crawlWithAlerts(db, `${base}contact`);
    expect(readAlertsConfig(db)).toEqual({
      rules: [{ ...MORE_404, change: 'count', level: 'fail' }],
      channels: ['slack', 'webhook'],
    });
    db.close();
  });

  it('a channel that fails is reported, never thrown, and the others still get theirs', async () => {
    const db = new ProjectDb(join(dir, 'fail.seoproject'));
    saveAlertsConfig(db, {
      rules: [{ name: 'Any page', metric: 'urls.total', op: '>', value: 0 }],
      channels: ['slack', 'telegram', 'webhook'],
    });
    setCredentials('slack', { webhookUrl: 'http://127.0.0.1:1/slack/closed-port' });
    setCredentials('telegram', { botToken: TG_TOKEN, chatId: '42' });
    const c = new Crawler({ ...DEFAULT_CRAWL_CONFIG, startUrl: base, discoverSitemaps: false } as CrawlConfig, db);
    c.on('error', () => {});
    await c.start();
    const out = await alertAfterCrawl(db, deps({ webhookUrl: `${captureBase}/hook/${HOOK_SECRET}` }));
    expect(out.map((d) => [d.channel, d.ok])).toEqual([
      ['slack', false],
      ['telegram', true],
      ['webhook', true],
    ]);
    expect(JSON.stringify(out)).not.toContain(TG_TOKEN);
    expect(JSON.stringify(out)).not.toContain('closed-port');
    expect(posts.map((p) => p.path).sort()).toEqual([`/hook/${HOOK_SECRET}`, `/tg/bot${TG_TOKEN}/sendMessage`]);
    db.close();
  });

  it('send test reaches each chosen channel; one without credentials says so', async () => {
    setCredentials('slack', { webhookUrl: `${captureBase}/slack/${SLACK_SECRET}` });
    const out = await sendTestAlert(['slack', 'telegram'], deps());
    expect(out.map((d) => [d.channel, d.ok])).toEqual([
      ['slack', true],
      ['telegram', false],
    ]);
    expect(posts).toHaveLength(1);
    expect(String(posts[0]!.body.text)).toContain('test');
  });
});
