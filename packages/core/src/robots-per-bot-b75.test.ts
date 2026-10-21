import { describe, expect, it } from 'vitest';
import { xRobotsTagDirectives } from './crawler.js';
import { parseHtml, readServedHeadSignals } from './html-parser.js';
import { robotsMetaBot } from './robots.js';

const PAGE = 'https://ex.com/a';
const doc = (head: string): string =>
  `<!doctype html><html><head>${head}</head><body><a href="/b">b</a></body></html>`;
const meta = (name: string, content: string): string => `<meta name="${name}" content="${content}">`;
const asGoogle = (head: string) => parseHtml(doc(head), PAGE);
const asYandex = (head: string) => parseHtml(doc(head), PAGE, { robotsBot: 'yandex' });

describe('meta robots per bot (B75)', () => {
  it('maps the crawl user agent to the meta name it acts as', () => {
    expect(robotsMetaBot('Googlebot')).toBe('googlebot');
    expect(robotsMetaBot('FreeCrawlSEO')).toBe('googlebot');
    expect(robotsMetaBot('YandexBot')).toBe('yandex');
    expect(robotsMetaBot('YandexMobileBot')).toBe('yandex');
    expect(robotsMetaBot('bingbot')).toBe('bingbot');
  });

  it('another bot’s noindex or nofollow does not apply, and is reported', () => {
    const p = asGoogle(meta('bingbot', 'noindex, nofollow'));
    expect(p.hasNoindex).toBe(false);
    expect(p.hasNofollow).toBe(false);
    expect(p.metaNoindexBots).toBe('bingbot');
    expect(p.metaRobots).toBe('noindex, nofollow');
  });

  it('googlebot and robots apply; googlebot-news does not', () => {
    expect(asGoogle(meta('googlebot', 'noindex')).hasNoindex).toBe(true);
    expect(asGoogle(meta('robots', 'noindex')).hasNoindex).toBe(true);
    const news = asGoogle(meta('googlebot-news', 'noindex'));
    expect(news.hasNoindex).toBe(false);
    expect(news.metaNoindexBots).toBe('googlebot-news');
  });

  it('names are case-insensitive and none counts as noindex', () => {
    const p = asGoogle(meta('BINGBOT', 'none'));
    expect(p.hasNoindex).toBe(false);
    expect(p.metaNoindexBots).toBe('bingbot');
  });

  it('as Yandex: yandex noindex applies, googlebot noindex does not', () => {
    expect(asYandex(meta('yandex', 'noindex')).hasNoindex).toBe(true);
    const g = asYandex(meta('googlebot', 'noindex'));
    expect(g.hasNoindex).toBe(false);
    expect(g.metaNoindexBots).toBe('googlebot');
    expect(asGoogle(meta('yandex', 'noindex')).metaNoindexBots).toBe('yandex');
  });

  it('a page with no bot-scoped noindex has no list', () => {
    expect(asGoogle(meta('robots', 'noindex')).metaNoindexBots).toBeNull();
    expect(asGoogle('').metaNoindexBots).toBeNull();
  });

  it('the served-HTML signal uses the same rule', () => {
    expect(readServedHeadSignals(doc(meta('yandex', 'noindex')), 'yandex').noindex).toBe(true);
    expect(readServedHeadSignals(doc(meta('yandex', 'noindex'))).noindex).toBe(false);
    expect(readServedHeadSignals(doc(meta('googlebot', 'noindex')), 'yandex').noindex).toBe(false);
  });

  it('the X-Robots-Tag header follows the crawl’s bot too', () => {
    expect(xRobotsTagDirectives('yandex: noindex', 'YandexBot').noindex).toBe(true);
    expect(xRobotsTagDirectives('googlebot: noindex', 'YandexBot').noindex).toBe(false);
    expect(xRobotsTagDirectives('googlebot: noindex', 'FreeCrawlSEO').noindex).toBe(true);
    expect(xRobotsTagDirectives('bingbot: noindex', 'FreeCrawlSEO').noindex).toBe(false);
    expect(xRobotsTagDirectives('noindex', 'YandexBot').noindex).toBe(true);
  });
});
