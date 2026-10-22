import { describe, expect, it } from 'vitest';
import { DEFAULT_CRAWL_CONFIG } from '@freecrawl/shared-types';
import { mergeCrawlConfig } from './crawl-config.js';

const ok = (r: ReturnType<typeof mergeCrawlConfig>) => {
  if (r.kind !== 'ok') throw new Error(`expected ok, got ${JSON.stringify(r)}`);
  return r;
};

describe('mergeCrawlConfig (B50)', () => {
  it('merges nested objects: a file that sets one login field keeps the others from the defaults', () => {
    const r = ok(mergeCrawlConfig({ formLogin: { enabled: true } }, {}, { url: 'https://ex.com/' }));
    expect(r.config.formLogin).toEqual({ ...DEFAULT_CRAWL_CONFIG.formLogin, enabled: true });
  });

  it('--header replaces the file headers instead of adding to them', () => {
    const r = ok(
      mergeCrawlConfig({ customHeaders: { A: '1', B: '2' } }, { customHeaders: { C: '3' } }, { url: 'https://ex.com/' }),
    );
    expect(r.config.customHeaders).toEqual({ C: '3' });
  });

  it('a flag beats the file, arrays replace', () => {
    const r = ok(
      mergeCrawlConfig(
        { crawlExternal: true, excludePatterns: ['/a'] },
        { crawlExternal: false, excludePatterns: ['/b'] },
        { url: 'https://ex.com/' },
      ),
    );
    expect(r.config.crawlExternal).toBe(false);
    expect(r.config.excludePatterns).toEqual(['/b']);
  });

  it('takes the start URL from the file when the command line gives none', () => {
    const r = ok(mergeCrawlConfig({ startUrl: 'https://file.example/' }, {}, {}));
    expect(r.listMode).toBe(false);
    expect(r.config.mode).toBe('spider');
    expect(r.config.startUrl).toBe('https://file.example/');
  });

  it('takes a list from the file when the command line gives none', () => {
    const r = ok(mergeCrawlConfig({ mode: 'list', urlList: ['https://a.example/x', 'https://a.example/y'] }, {}, {}));
    expect(r.listMode).toBe(true);
    expect(r.config.mode).toBe('list');
    expect(r.config.startUrl).toBe('https://a.example/x');
  });

  it('the command line wins over the file start', () => {
    const file = { mode: 'list', urlList: ['https://a.example/x'], startUrl: 'https://file.example/' };
    const spider = ok(mergeCrawlConfig(file, {}, { url: 'https://cli.example/' }));
    expect(spider.listMode).toBe(false);
    expect(spider.config.startUrl).toBe('https://cli.example/');
    expect(spider.config.urlList).toEqual([]);
    const list = ok(mergeCrawlConfig(file, {}, { listUrls: ['https://cli.example/1'] }));
    expect(list.config.urlList).toEqual(['https://cli.example/1']);
  });

  it('an empty list in the file is an error; no start anywhere is a usage error', () => {
    expect(mergeCrawlConfig({ mode: 'list', urlList: [] }, {}, {})).toMatchObject({ kind: 'error' });
    expect(mergeCrawlConfig({}, {}, {})).toEqual({ kind: 'usage' });
  });

  it('warns once per unknown top-level key', () => {
    const r = ok(mergeCrawlConfig({ maxUrls: 5, colour: 'red', tpyo: 1 }, {}, { url: 'https://ex.com/' }));
    expect(r.notes).toEqual(['unknown key in --config: colour', 'unknown key in --config: tpyo']);
    expect(r.config.maxUrls).toBe(5);
  });

  it('--proxy turns off the file active proxy profile, with a note', () => {
    const r = ok(
      mergeCrawlConfig(
        { proxyProfiles: [{ name: 'office', url: 'http://office:3128' }], proxyProfileActive: 'office' },
        { proxyUrl: 'http://cli:8080' },
        { url: 'https://ex.com/' },
      ),
    );
    expect(r.config.proxyUrl).toBe('http://cli:8080');
    expect(r.config.proxyProfileActive).toBe('');
    expect(r.notes.join('\n')).toContain('office');
  });
});
