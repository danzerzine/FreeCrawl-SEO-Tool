import { describe, expect, it } from 'vitest';
import { compileUrlRegexRewrites, isPrivateHost, normalizeUrl } from './url-utils.js';

describe('normalizeUrl', () => {
  it('strips credentials so they never reach stored URLs', () => {
    expect(normalizeUrl('https://user:pass@example.com/a')).toBe('https://example.com/a');
  });

  it('decodes &amp; in the query so it splits on the real ampersand', () => {
    expect(normalizeUrl('https://example.com/p?a=1&amp;b=2')).toBe('https://example.com/p?a=1&b=2');
    expect(normalizeUrl('https://example.com/p?a=1&#38;b=2')).toBe('https://example.com/p?a=1&b=2');
  });

  it('drops the fragment', () => {
    expect(normalizeUrl('https://example.com/a#section')).toBe('https://example.com/a');
  });

  it('keeps a router fragment only when keepHashRoutes is on', () => {
    expect(normalizeUrl('https://example.com/#/cart')).toBe('https://example.com/');
    expect(normalizeUrl('https://example.com/#/cart', undefined, { keepHashRoutes: true })).toBe(
      'https://example.com/#/cart',
    );
    expect(normalizeUrl('https://example.com/#top', undefined, { keepHashRoutes: true })).toBe(
      'https://example.com/',
    );
  });

  it('resolves a relative href against the base', () => {
    expect(normalizeUrl('../x?y=1', 'https://example.com/a/b/c')).toBe('https://example.com/a/x?y=1');
  });

  it('returns null for input that is not a URL', () => {
    expect(normalizeUrl('not a url')).toBeNull();
    expect(normalizeUrl('')).toBeNull();
  });

  it('removes default ports and adds the root path', () => {
    expect(normalizeUrl('http://example.com:80')).toBe('http://example.com/');
    expect(normalizeUrl('https://example.com:443/a')).toBe('https://example.com/a');
    expect(normalizeUrl('https://example.com:8443/a')).toBe('https://example.com:8443/a');
  });

  it('uppercases percent-escape hex so %2f and %2F are one URL', () => {
    expect(normalizeUrl('https://example.com/a%2fb?q=%c3%a9')).toBe(
      'https://example.com/a%2Fb?q=%C3%A9',
    );
  });

  describe('rewrite options', () => {
    it('stripWww removes a leading www only', () => {
      expect(normalizeUrl('https://www.example.com/a', undefined, { stripWww: true })).toBe(
        'https://example.com/a',
      );
      expect(normalizeUrl('https://www.example.com/a')).toBe('https://www.example.com/a');
      expect(normalizeUrl('https://awww.example.com/', undefined, { stripWww: true })).toBe(
        'https://awww.example.com/',
      );
    });

    it('forceHttps upgrades http but leaves https alone', () => {
      expect(normalizeUrl('http://example.com/a', undefined, { forceHttps: true })).toBe(
        'https://example.com/a',
      );
      expect(normalizeUrl('http://example.com:80/a', undefined, { forceHttps: true })).toBe(
        'https://example.com/a',
      );
    });

    it('lowercasePath lowercases the path but not the query', () => {
      expect(normalizeUrl('https://example.com/Foo/BAR?Q=A', undefined, { lowercasePath: true })).toBe(
        'https://example.com/foo/bar?Q=A',
      );
    });

    it('trailingSlash strip removes the slash but keeps the root', () => {
      const o = { trailingSlash: 'strip' } as const;
      expect(normalizeUrl('https://example.com/a/', undefined, o)).toBe('https://example.com/a');
      expect(normalizeUrl('https://example.com/', undefined, o)).toBe('https://example.com/');
    });

    it('trailingSlash add appends a slash to directories but not to file-like paths', () => {
      const o = { trailingSlash: 'add' } as const;
      expect(normalizeUrl('https://example.com/a', undefined, o)).toBe('https://example.com/a/');
      expect(normalizeUrl('https://example.com/a/file.html', undefined, o)).toBe(
        'https://example.com/a/file.html',
      );
    });

    it('trailingSlash leave keeps both forms as written', () => {
      const o = { trailingSlash: 'leave' } as const;
      expect(normalizeUrl('https://example.com/a/', undefined, o)).toBe('https://example.com/a/');
      expect(normalizeUrl('https://example.com/a', undefined, o)).toBe('https://example.com/a');
    });

    it('collapseDuplicateSlashes merges runs of slashes in the path', () => {
      expect(
        normalizeUrl('https://example.com/a//b///c', undefined, { collapseDuplicateSlashes: true }),
      ).toBe('https://example.com/a/b/c');
      expect(normalizeUrl('https://example.com/a//b')).toBe('https://example.com/a//b');
    });

    it('collapses slashes before the strip policy so /a// ends as /a', () => {
      expect(
        normalizeUrl('https://example.com/a//', undefined, {
          collapseDuplicateSlashes: true,
          trailingSlash: 'strip',
        }),
      ).toBe('https://example.com/a');
    });

    it('strips default tracking params but keeps other params', () => {
      expect(normalizeUrl('https://example.com/a?utm_source=x&gclid=1&id=7')).toBe(
        'https://example.com/a?id=7',
      );
    });

    it('keepQueryParams drops everything not listed, case-insensitively', () => {
      expect(
        normalizeUrl('https://example.com/a?ID=1&utm_source=x&sort=asc', undefined, {
          keepQueryParams: ['id'],
        }),
      ).toBe('https://example.com/a?ID=1');
    });

    it('sortQueryParams orders params by name and keeps repeated keys in order', () => {
      expect(
        normalizeUrl('https://example.com/a?b=2&tag=y&a=1&tag=x', undefined, {
          sortQueryParams: true,
        }),
      ).toBe('https://example.com/a?a=1&b=2&tag=y&tag=x');
    });

    it('applies compiled regex rewrites in order to the final URL', () => {
      const regexRewrites = compileUrlRegexRewrites([
        { pattern: '/old/', replacement: '/new/' },
        { pattern: '\\?session=[^&]*', replacement: '' },
      ]);
      expect(normalizeUrl('https://example.com/old/page?session=abc', undefined, { regexRewrites })).toBe(
        'https://example.com/new/page',
      );
    });

    it('returns null when a regex rewrite leaves something that is not a URL', () => {
      const regexRewrites = compileUrlRegexRewrites([{ pattern: '^https://', replacement: '' }]);
      expect(normalizeUrl('https://example.com/a', undefined, { regexRewrites })).toBeNull();
    });
  });
});

describe('compileUrlRegexRewrites', () => {
  it('skips invalid patterns and reports them once through onError', () => {
    const errors: string[] = [];
    const out = compileUrlRegexRewrites(
      [
        { pattern: '(', replacement: 'x' },
        { pattern: 'a', replacement: 'b' },
      ],
      (pattern) => errors.push(pattern),
    );
    expect(out).toHaveLength(1);
    expect(errors).toEqual(['(']);
  });

  it('ignores empty patterns, defaults to the global flag and a missing list yields nothing', () => {
    expect(compileUrlRegexRewrites(undefined)).toEqual([]);
    expect(compileUrlRegexRewrites([{ pattern: '', replacement: 'x' }])).toEqual([]);
    const [r] = compileUrlRegexRewrites([{ pattern: 'a', replacement: 'b' }]);
    expect(r?.re.flags).toBe('g');
  });
});

describe('isPrivateHost', () => {
  it.each([
    'http://127.0.0.1/',
    'http://127.5.5.5:8080/x',
    'http://[::1]/',
    'http://10.1.2.3/',
    'http://192.168.1.1/admin',
    'http://172.16.0.1/',
    'http://169.254.169.254/latest/meta-data',
    'http://localhost:3000/',
    'http://printer.local/',
  ])('treats %s as private', (url) => {
    expect(isPrivateHost(url)).toBe(true);
  });

  it.each([
    'https://example.com/',
    'http://8.8.8.8/',
    'http://172.32.0.1/',
    'http://192.169.0.1/',
  ])('treats %s as public', (url) => {
    expect(isPrivateHost(url)).toBe(false);
  });

  it('returns false for an unparsable URL', () => {
    expect(isPrivateHost('not a url')).toBe(false);
  });
});
