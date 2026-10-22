import { describe, expect, it } from 'vitest';
import { parseListText, readListSource, sheetCsvUrl } from './list-source.js';

describe('sheetCsvUrl (B83)', () => {
  it('reads the sheet id and the gid from #gid=', () => {
    expect(sheetCsvUrl('https://docs.google.com/spreadsheets/d/abc_123-X/edit#gid=456')).toBe(
      'https://docs.google.com/spreadsheets/d/abc_123-X/export?format=csv&gid=456',
    );
  });

  it('reads the gid from ?gid=', () => {
    expect(sheetCsvUrl('https://docs.google.com/spreadsheets/d/abc/edit?usp=sharing&gid=7')).toBe(
      'https://docs.google.com/spreadsheets/d/abc/export?format=csv&gid=7',
    );
  });

  it('takes the first sheet when the link names none', () => {
    expect(sheetCsvUrl('https://docs.google.com/spreadsheets/d/abc/edit?usp=sharing')).toBe(
      'https://docs.google.com/spreadsheets/d/abc/export?format=csv&gid=0',
    );
  });

  it('leaves other links alone', () => {
    expect(sheetCsvUrl('https://docs.google.com/document/d/abc/edit')).toBeNull();
    expect(sheetCsvUrl('https://example.com/spreadsheets/d/abc/edit')).toBeNull();
  });
});

describe('parseListText (B83)', () => {
  it('takes the first CSV column, quoted fields included, and skips a header row', () => {
    const csv = [
      'URL,Note',
      '"https://ex.com/a,b","one, two"',
      'https://ex.com/c,"a ""quoted""',
      'line break inside"',
      '"https://ex.com/d"',
      '',
    ].join('\r\n');
    expect(parseListText(csv, true)).toEqual([
      'https://ex.com/a,b',
      'https://ex.com/c',
      'https://ex.com/d',
    ]);
  });

  it('keeps a first CSV row that is a URL', () => {
    expect(parseListText('https://ex.com/a,x\nhttps://ex.com/b,y\n', true)).toEqual([
      'https://ex.com/a',
      'https://ex.com/b',
    ]);
  });

  it('reads plain text one URL per line, skipping empty and # lines', () => {
    expect(parseListText('https://ex.com/a\n\n# note\n  https://ex.com/b,c  \n', false)).toEqual([
      'https://ex.com/a',
      'https://ex.com/b,c',
    ]);
  });
});

describe('readListSource (B83)', () => {
  const html = () =>
    Promise.resolve(
      new Response('<!DOCTYPE html><html><body>Sign in</body></html>', {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      }),
    );

  it('refuses an HTML answer to a sheet link: the sheet is not public', async () => {
    await expect(
      readListSource('https://docs.google.com/spreadsheets/d/abc/edit#gid=0', {
        userAgent: 'ua',
        fetch: html,
      }),
    ).rejects.toThrow('the sheet is not public (share it as "anyone with the link")');
  });

  it('asks for the CSV export of a sheet with the crawl user agent', async () => {
    const seen: { url: string; ua: string | null }[] = [];
    const urls = await readListSource('https://docs.google.com/spreadsheets/d/abc/edit#gid=9', {
      userAgent: 'TestBot/1',
      fetch: (input, init) => {
        seen.push({ url: String(input), ua: new Headers(init?.headers).get('user-agent') });
        return Promise.resolve(
          new Response('url\n"https://ex.com/a"\n', { headers: { 'content-type': 'text/csv' } }),
        );
      },
    });
    expect(urls).toEqual(['https://ex.com/a']);
    expect(seen).toEqual([
      { url: 'https://docs.google.com/spreadsheets/d/abc/export?format=csv&gid=9', ua: 'TestBot/1' },
    ]);
  });
});
