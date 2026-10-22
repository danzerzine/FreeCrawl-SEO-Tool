import { describe, expect, it } from 'vitest';
import { acceptedLastModified, parseSitemapLastmod } from './sitemap-lastmod.js';

describe('B61 parseSitemapLastmod', () => {
  it.each([
    ['2026-03-04', '2026-03-04', Date.UTC(2026, 2, 4)],
    ['  2026-03-04  ', '2026-03-04', Date.UTC(2026, 2, 4)],
    ['2026-03-04T10:20Z', '2026-03-04', Date.UTC(2026, 2, 4, 10, 20)],
    ['2026-03-04T10:20:30Z', '2026-03-04', Date.UTC(2026, 2, 4, 10, 20, 30)],
    ['2026-03-04T10:20:30.123Z', '2026-03-04', Date.UTC(2026, 2, 4, 10, 20, 30, 123)],
    // +03:00 at 01:30 local is 22:30 UTC the day before.
    ['2026-03-04T01:30:00+03:00', '2026-03-03', Date.UTC(2026, 2, 3, 22, 30)],
    // -05:00 at 22:00 local is 03:00 UTC the next day.
    ['2026-03-04T22:00:00-05:00', '2026-03-05', Date.UTC(2026, 2, 5, 3)],
  ])('%s -> UTC day %s', (text, day, ms) => {
    expect(parseSitemapLastmod(text)).toEqual({ day, ms });
  });

  it.each([
    ['year only', '2026'],
    ['year-month', '2026-03'],
    ['free text', 'yesterday'],
    ['empty', ''],
    ['zero date', '0000-00-00'],
    ['month 13', '2026-13-01'],
    ['day 31 of April', '2026-04-31'],
    ['hour 25', '2026-03-04T25:00:00Z'],
    ['time without zone', '2026-03-04T10:20:30'],
    ['offset 99:00', '2026-03-04T10:00:00+99:00'],
  ])('%s is no value', (_name, text) => {
    expect(parseSitemapLastmod(text)).toBeNull();
  });
});

describe('B61 acceptedLastModified', () => {
  const NOW = Date.UTC(2026, 9, 22, 12, 0, 0);
  const http = (ms: number) => new Date(ms).toUTCString();
  const crawledAt = new Date(Date.UTC(2026, 9, 22, 11, 0, 0)).toISOString();
  const date = http(Date.UTC(2026, 9, 22, 11, 0, 0));

  it('accepts an older Last-Modified and gives its UTC day', () => {
    const lm = http(Date.UTC(2026, 8, 1, 8, 30, 0));
    expect(acceptedLastModified({ 'last-modified': lm, date }, crawledAt, NOW)).toEqual({
      day: '2026-09-01',
      ms: Date.UTC(2026, 8, 1, 8, 30, 0),
    });
  });

  it.each([
    ['missing', undefined],
    ['unparsable', 'sometime last week'],
  ])('rejects a %s header', (_n, lm) => {
    expect(acceptedLastModified({ 'last-modified': lm, date }, crawledAt, NOW)).toBeNull();
  });

  it('rejects a value later than the export time', () => {
    const lm = http(NOW + 3600_000);
    expect(acceptedLastModified({ 'last-modified': lm }, '', NOW)).toBeNull();
  });

  it('rejects a value within 60 s of the response Date, either side', () => {
    const at = Date.UTC(2026, 9, 22, 11, 0, 0);
    expect(acceptedLastModified({ 'last-modified': http(at - 60_000), date }, crawledAt, NOW)).toBeNull();
    expect(acceptedLastModified({ 'last-modified': http(at + 30_000), date }, crawledAt, NOW)).toBeNull();
    expect(acceptedLastModified({ 'last-modified': http(at - 61_000), date }, crawledAt, NOW)).not.toBeNull();
  });

  it('rejects a value later than the response Date (RFC 9110 8.8.2), accepts one days older', () => {
    const at = Date.UTC(2026, 9, 22, 11, 0, 0);
    // bis.org: Last-Modified 25 min after its own Date, still before the export time.
    const later = acceptedLastModified({ 'last-modified': http(at + 25 * 60_000), date }, crawledAt, at + 3600_000);
    expect(later).toBeNull();
    expect(acceptedLastModified({ 'last-modified': http(at - 30_000), date }, crawledAt, NOW)).toBeNull();
    expect(acceptedLastModified({ 'last-modified': http(at - 2 * 86400_000), date }, crawledAt, NOW)).not.toBeNull();
    // No Date header: the same rule against crawled_at.
    expect(acceptedLastModified({ 'last-modified': http(at + 25 * 60_000) }, crawledAt, at + 3600_000)).toBeNull();
  });

  it('falls back to crawled_at when there is no Date header or it does not parse', () => {
    const at = Date.UTC(2026, 9, 22, 11, 0, 0);
    expect(acceptedLastModified({ 'last-modified': http(at - 5_000) }, crawledAt, NOW)).toBeNull();
    expect(acceptedLastModified({ 'last-modified': http(at - 5_000), date: 'garbage' }, crawledAt, NOW)).toBeNull();
    expect(acceptedLastModified({ 'last-modified': http(at - 3600_000) }, crawledAt, NOW)).not.toBeNull();
  });

  describe('page cache (Age)', () => {
    const at = Date.UTC(2026, 9, 22, 11, 0, 0);
    it('hours old, same day, no Age: accepted', () => {
      const lm = http(at - 2 * 3600_000);
      expect(acceptedLastModified({ 'last-modified': lm, date }, crawledAt, NOW)).not.toBeNull();
    });
    it('same day, Age present and Date minus Age within 60 s of the value: rejected', () => {
      // Cached copy generated 2 h ago, stamped with its generation time.
      const lm = http(at - 2 * 3600_000);
      expect(acceptedLastModified({ 'last-modified': lm, date, age: '7200' }, crawledAt, NOW)).toBeNull();
      expect(acceptedLastModified({ 'last-modified': lm, date, age: '7230' }, crawledAt, NOW)).toBeNull();
    });
    it('same day, Age present but the value is older than Date minus Age: accepted', () => {
      const lm = http(at - 5 * 3600_000);
      expect(acceptedLastModified({ 'last-modified': lm, date, age: '7200' }, crawledAt, NOW)).not.toBeNull();
    });
    it('another day with Age: the Age rule does not apply', () => {
      const lm = http(at - 30 * 3600_000);
      expect(acceptedLastModified({ 'last-modified': lm, date, age: String(30 * 3600) }, crawledAt, NOW)).not.toBeNull();
    });
  });
});
