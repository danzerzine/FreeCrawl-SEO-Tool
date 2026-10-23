import { describe, expect, it } from 'vitest';
import { checkSerpRows, parseSerpInput, SERP_CSV_COLUMNS, serpRowsToCsv } from './serp-check.js';
import { estimatePixelWidth, META_DESCRIPTION_FONT_PX, parseHtml } from './html-parser.js';

const row = (title: string, description = 'd', url?: string) => ({ url, title, description });

describe('B85 checkSerpRows: statuses', () => {
  it('61 chars is too-long, 59 chars at 620 px is pixel-too-long, empty description is missing', () => {
    const [long, wide, nodesc] = checkSerpRows([
      row('a'.repeat(61)),
      row('W'.repeat(59)),
      row('Normal title that fits the line nicely ok', ''),
    ]);
    expect(long!.titleChars).toBe(61);
    expect(long!.titleStatus).toBe('too-long');
    expect(wide!.titleChars).toBe(59);
    expect(wide!.titlePx).toBeGreaterThan(600);
    expect(wide!.titleStatus).toBe('pixel-too-long');
    expect(nodesc!.descStatus).toBe('missing');
    expect(nodesc!.descChars).toBe(0);
  });

  it('chars are checked before pixels; short and narrow are told apart', () => {
    const [short, narrow, ok] = checkSerpRows([
      row('Short'),
      row('i'.repeat(35)),
      row('Normal title that fits the line nicely ok'),
    ]);
    expect(short!.titleStatus).toBe('too-short');
    expect(narrow!.titleChars).toBe(35);
    expect(narrow!.titleStatus).toBe('pixel-too-short');
    expect(ok!.titleStatus).toBe('ok');
  });

  it('keeps the four independent flags next to the single status (r1 L3)', () => {
    const [r] = checkSerpRows([row('W'.repeat(61))]);
    expect(r!.titleStatus).toBe('too-long');
    expect(r!.flags).toMatchObject({
      titleTooShort: false,
      titleTooLong: true,
      titlePxShort: false,
      titlePxLong: true,
    });
  });

  it('counts characters as code points, like the crawl', () => {
    const [r] = checkSerpRows([row('🚀'.repeat(31))]);
    expect(r!.titleChars).toBe(31);
  });

  it('limits come from the thresholds passed in', () => {
    const [r] = checkSerpRows([row('x'.repeat(40))], { titleMaxChars: 10 });
    expect(r!.titleStatus).toBe('too-long');
  });

  it('refuses more than 100 000 rows', () => {
    const rows = Array.from({ length: 100_001 }, () => row('t'));
    expect(() => checkSerpRows(rows)).toThrow(/100000|100 000/);
  });

  it('titlesTruncatedAt is the title up to the last char that fits titleMaxPx', () => {
    const [r] = checkSerpRows([row('W'.repeat(40))]);
    const cut = r!.titleTruncated;
    expect(estimatePixelWidth(cut)).toBeLessThanOrEqual(600);
    expect(estimatePixelWidth(cut + 'W')).toBeGreaterThan(600);
    const [fits] = checkSerpRows([row('Short title')]);
    expect(fits!.titleTruncated).toBe('Short title');
  });
});

describe('B85 checkSerpRows: duplicates', () => {
  it('trimmed, case-folded text is a duplicate in every row of its group, with the group size', () => {
    const rs = checkSerpRows([row('Home '), row('home'), row('About')]);
    expect(rs.map((r) => r.duplicateTitle)).toEqual([2, 2, 0]);
    expect(rs.map((r) => r.duplicateDescription)).toEqual([3, 3, 3]);
  });

  it('empty text is never a duplicate', () => {
    const rs = checkSerpRows([row('', ''), row('', '')]);
    expect(rs.map((r) => r.duplicateTitle)).toEqual([0, 0]);
    expect(rs.map((r) => r.duplicateDescription)).toEqual([0, 0]);
  });
});

describe('B85 consistency pin with the crawl columns', () => {
  const pages = [
    ['Купить кофе в Москве — доставка за час', 'Свежеобжаренный кофе из лучших зерен. Доставка по Москве за час.'],
    ['WIDE WORDS MMMM WWWW title for the wide test', 'Descriptions in the same spirit, with Many Wide Words.'],
    ['Home', ''],
    ['Launch 🚀 day: “quotes”, dashes – and more', 'Emoji 🚀 and CJK 日本語 in the description text.'],
    ['A title with   extra   spaces', 'Fifth page description.'],
  ];
  it.each(pages)('widths equal the crawl widths for %s', (title, description) => {
    const html = `<!doctype html><html><head><title>${title}</title>${
      description ? `<meta name="description" content="${description}">` : ''
    }</head><body><p>x</p></body></html>`;
    const parsed = parseHtml(html, 'https://example.com/p');
    // The crawl stores exactly these two expressions (crawler.ts, titlePixelWidth / metaPixelWidth).
    const crawlTitlePx = estimatePixelWidth(parsed.title ?? '');
    const crawlMetaPx = estimatePixelWidth(parsed.metaDescription ?? '', META_DESCRIPTION_FONT_PX);
    const [r] = checkSerpRows([row(parsed.title ?? '', parsed.metaDescription ?? '')]);
    expect(r!.titlePx).toBe(crawlTitlePx);
    expect(r!.descPx).toBe(crawlMetaPx);
  });
});

describe('B85 parseSerpInput', () => {
  it('CSV with quotes, an embedded comma, a doubled quote and CRLF', () => {
    const text =
      'url,title,description\r\n' +
      'https://a.test/1,"Hello, ""world""","Line one\r\nline two"\r\n' +
      'https://a.test/2,Plain,Desc\r\n';
    expect(parseSerpInput(text)).toEqual([
      { url: 'https://a.test/1', title: 'Hello, "world"', description: 'Line one\r\nline two' },
      { url: 'https://a.test/2', title: 'Plain', description: 'Desc' },
    ]);
  });

  it('TSV with a header, any column order, case-insensitive names', () => {
    const text = 'Description\tTitle\tURL\nD1\tT1\thttps://a.test/\n';
    expect(parseSerpInput(text)).toEqual([{ url: 'https://a.test/', title: 'T1', description: 'D1' }]);
  });

  it('Russian headers and a BOM', () => {
    const text = '﻿адрес,заголовок,описание\nhttps://a.test/,Заголовок,Описание\n';
    expect(parseSerpInput(text)).toEqual([
      { url: 'https://a.test/', title: 'Заголовок', description: 'Описание' },
    ]);
  });

  it('pasted lines: title TAB description; a line without a tab is a title only; blank lines skipped', () => {
    const text = 'First, with comma\tIts description\n\nOnly title\r\nThird\t\n';
    expect(parseSerpInput(text)).toEqual([
      { title: 'First, with comma', description: 'Its description' },
      { title: 'Only title', description: '' },
      { title: 'Third', description: '' },
    ]);
  });

  it('a header with neither title nor description is not a header (the line is a title)', () => {
    expect(parseSerpInput('url,other\n')).toEqual([{ title: 'url,other', description: '' }]);
  });

  it('empty input gives no rows', () => {
    expect(parseSerpInput('')).toEqual([]);
    expect(parseSerpInput('﻿\n')).toEqual([]);
  });
});

describe('B85 serpRowsToCsv', () => {
  const HEADER =
    'url,title,title_chars,title_px,title_status,title_too_short,title_too_long,title_px_short,title_px_long,description,description_chars,description_px,description_status,desc_too_short,desc_too_long,desc_px_short,desc_px_long,duplicate_title,duplicate_description';

  it('exact header list, rows in input order (not sorted), flags 0/1', () => {
    const rows = [row('Zeta', 'zz', 'https://a.test/z'), row('Alpha', 'aa', 'https://a.test/a')];
    const lines = serpRowsToCsv(checkSerpRows(rows)).trimEnd().split('\n');
    expect(SERP_CSV_COLUMNS.join(',')).toBe(HEADER);
    expect(lines[0]).toBe(HEADER);
    expect(lines.slice(1).map((l) => l.split(',')[0])).toEqual(['https://a.test/z', 'https://a.test/a']);
    const cells = lines[1]!.split(',');
    expect(cells[4]).toBe('too-short');
    expect(cells.slice(5, 9)).toEqual(['1', '0', '1', '0']);
  });

  it('formula guard: a title that starts with = is written with the guard prefix', () => {
    const csv = serpRowsToCsv(checkSerpRows([row('=HYPERLINK("http://x","y")', '+cmd')]));
    expect(csv).toContain(`"'=HYPERLINK(""http://x"",""y"")"`);
    expect(csv).toContain("'+cmd");
  });
});
