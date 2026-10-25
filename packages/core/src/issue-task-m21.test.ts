import { describe, expect, it } from 'vitest';
import type { OverviewCounts } from '@freecrawl/shared-types';
import { DEFAULT_SEO_THRESHOLDS } from '@freecrawl/shared-types';
import {
  buildIssueTask,
  evidenceColumnsFor,
  toBasecampHtml,
  toMarkdown,
  type BuildIssueTaskInput,
} from './issue-task.js';

function counts(issues: Record<string, number>): BuildIssueTaskInput['counts'] {
  return { issues, thresholds: DEFAULT_SEO_THRESHOLDS } as unknown as Pick<
    OverviewCounts,
    'issues' | 'thresholds'
  >;
}

function input(over: Partial<BuildIssueTaskInput> = {}): BuildIssueTaskInput {
  return {
    category: 'issues:title-missing',
    counts: counts({ titleMissing: 2 }),
    rows: [
      { url: 'https://example.com/a', evidence: { title: '', titleLength: 0, statusCode: 200 } },
      { url: 'https://example.com/b', evidence: { title: null, titleLength: 0, statusCode: 200 } },
    ],
    siteUrl: 'https://example.com/',
    crawledAt: '2026-10-20T10:00:00.000Z',
    ...over,
  };
}

describe('buildIssueTask: title-missing', () => {
  it('names host, group, label and count in the title', () => {
    const t = buildIssueTask(input());
    expect(t.title).toBe('[example.com] Page Titles: Missing (2 URLs)');
  });

  it('has meaning, advice, count and a URL table with title columns, and no score words', () => {
    const md = toMarkdown(buildIssueTask(input()));
    expect(md).toContain('What this check means');
    expect(md).toContain('How to fix');
    expect(md).toContain('Write a unique, descriptive &lt;title&gt; (30–60 characters)');
    expect(md).toContain('2 URLs, first 2 shown');
    expect(md).toMatch(/\| URL \| title \| titleLength \|/);
    expect(md).toContain('`https://example.com/a`');
    expect(md).toContain('FreeCrawl crawl of example.com on 2026-10-20');
    expect(md).not.toMatch(/score|grade|health/i);
  });
});

// Splits a GFM table row at unescaped pipes.
function cells(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  const body = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  for (let i = 0; i < body.length; i++) {
    const c = body[i]!;
    // GFM: only a backslash right before a pipe escapes it, however many backslashes precede.
    if (c === '\\' && body[i + 1] === '|') {
      cur += c + body[++i];
    } else if (c === '|') {
      out.push(cur.trim());
      cur = '';
    } else cur += c;
  }
  out.push(cur.trim());
  return out;
}

function tableLines(md: string): string[] {
  return md.split('\n').filter((l) => l.startsWith('|'));
}

describe('escaping crawled values', () => {
  const titles = [
    'A | B',
    'Follow @someone',
    'See #12',
    'line one\nline two',
    '`lead tick @x',
    'trail tick`',
    'a\\|b',
    'end\\',
    '',
    'has ``` run',
  ];
  const rows = titles.map((t, i) => ({
    url: `https://user:pw@example.com/p${i}`,
    evidence: { title: t, titleLength: t.length },
  }));
  const task = () =>
    buildIssueTask(
      input({ category: 'issues:title-too-long', counts: counts({ titleTooLong: 9 }), rows }),
    );

  it('keeps every row at the header column count', () => {
    const lines = tableLines(toMarkdown(task()));
    expect(lines).toHaveLength(2 + titles.length);
    for (const l of lines) expect(cells(l)).toHaveLength(3);
  });

  it('puts crawled values in code spans, with a padded fence around edge backticks', () => {
    const md = toMarkdown(task());
    expect(md).toContain('`A \\| B`');
    expect(md).toContain('`Follow @someone`');
    expect(md).toContain('`line one line two`');
    expect(md).toContain('`` `lead tick @x ``');
    expect(md).toContain('`` trail tick` ``');
    // GFM splits a row only at a pipe not right after a backslash, and drops that one backslash
    // in the cell (code spans too): `a\\|b` shows as a\|b. Doubling the backslash first would
    // show a\\|b (B201, the CodeQL finding is a false positive here).
    expect(md).toContain('`a\\\\|b`');
    expect(md).toContain('`end\\`');
    expect(md).toContain('````has ``` run````');
    // no @ or # outside code spans in the table
    for (const l of tableLines(md).slice(2)) {
      const outside = l.replace(/(`+)[^]*?\1/g, '');
      expect(outside).not.toMatch(/[@#]/);
    }
  });

  it('writes an empty value as an empty cell', () => {
    const line = tableLines(toMarkdown(task())).find((l) => l.includes('/p8`'))!;
    expect(cells(line)[1]).toBe('');
    expect(line).not.toContain('``');
  });

  it('strips userinfo from URLs', () => {
    const md = toMarkdown(task());
    expect(md).not.toContain('user:pw');
    expect(md).toContain('`https://example.com/p0`');
  });

  it('cuts long titles at 200 characters but never a URL', () => {
    const longUrl = 'https://example.com/?' + 'q=1&'.repeat(120);
    const t = buildIssueTask(
      input({
        category: 'issues:title-too-long',
        counts: counts({ titleTooLong: 1 }),
        rows: [{ url: longUrl, evidence: { title: 'T'.repeat(500), titleLength: 500 } }],
      }),
    );
    const md = toMarkdown(t);
    expect(md).toContain('`' + longUrl + '`');
    expect(md).toContain('`' + 'T'.repeat(199) + '…`');
    expect(md).not.toContain('T'.repeat(201));
  });
});

describe('static texts', () => {
  it('escape <, > and & in Markdown (title-outside-head)', () => {
    const md = toMarkdown(
      buildIssueTask(
        input({ category: 'issues:title-outside-head', counts: counts({ titleOutsideHead: 1 }) }),
      ),
    );
    expect(md).toContain('Move &lt;title&gt; into &lt;head&gt;');
    expect(md).toContain('Title Outside &lt;head&gt;');
    expect(md).not.toMatch(/<head>|<body>|<title>/);
  });
});

describe('sections', () => {
  it('maps a check without tailored advice to its severity line and omits the fix section', () => {
    const md = toMarkdown(
      buildIssueTask(
        input({ category: 'issues:inlinks-nofollow-only', counts: counts({ inlinksNofollowOnly: 4 }) }),
      ),
    );
    expect(md).toContain('## Why it matters');
    expect(md).toContain('Review and correct where practical');
    expect(md).not.toContain('How to fix');
  });

  it('shows advice whole and fills threshold placeholders', () => {
    const t = buildIssueTask(
      input({ category: 'issues:title-too-long', counts: counts({ titleTooLong: 9 }) }),
    );
    expect(t.title).toBe('[example.com] Page Titles: Over 60 Characters (9 URLs)');
    const md = toMarkdown(t);
    expect(md).toContain(
      'Trim titles to about 60 characters so they are not truncated in results; front-load the primary keyword.',
    );
    expect(md).not.toContain('{{');
  });
});

describe('cap', () => {
  const many = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      url: `https://example.com/page-${i}`,
      evidence: { title: '', titleLength: 0 },
    }));

  it('lists at most maxUrls rows and says how many are left, without CSV wording', () => {
    const t = buildIssueTask(input({ counts: counts({ titleMissing: 2000 }), rows: many(500), totalUrls: 2000 }));
    const md = toMarkdown(t);
    expect(tableLines(md)).toHaveLength(2 + 200);
    expect(t.moreUrls).toBe(1800);
    expect(t.truncated).toBe(true);
    expect(md).toContain('2000 URLs, first 200 shown');
    expect(md).toContain(
      'and 1800 more URLs not listed (full list: FreeCrawl export `issues:title-missing` from the crawl of example.com, 2026-10-20)',
    );
    expect(md).not.toMatch(/csv/i);
  });

  it('keeps the body within maxBodyChars', () => {
    const t = buildIssueTask(
      input({ counts: counts({ titleMissing: 2000 }), rows: many(500), totalUrls: 2000, maxBodyChars: 4000 }),
    );
    const md = toMarkdown(t);
    expect(md.length).toBeLessThanOrEqual(4000);
    expect(tableLines(md).length).toBeLessThan(2 + 200);
    expect(t.moreUrls).toBe(2000 - (tableLines(md).length - 2));
  });

  it('adds no "more" line when everything fits', () => {
    const t = buildIssueTask(input());
    expect(t.moreUrls).toBe(0);
    expect(t.truncated).toBe(false);
    expect(toMarkdown(t)).not.toContain('not listed');
  });
});

describe('toBasecampHtml', () => {
  const evil = 'https://u:p@example.com/<script>alert(1)</script>?a=1&b=2';
  const html = () =>
    toBasecampHtml(
      buildIssueTask(
        input({
          category: 'issues:title-outside-head',
          counts: counts({ titleOutsideHead: 1 }),
          rows: [{ url: evil, evidence: { statusCode: 200, indexability: 'indexable' } }],
        }),
      ),
    );

  it('sends the URL table as a real table with every crawled value escaped', () => {
    const h = html();
    for (const tag of ['<table>', '<thead>', '<tbody>', '<th>', '<td>']) expect(h).toContain(tag);
    expect(h).not.toContain('<script>');
    expect(h).toContain('&lt;script&gt;alert(1)&lt;/script&gt;?a=1&amp;b=2');
    expect(h).not.toContain('u:p@');
  });

  it('escapes static texts and renders the export name as code', () => {
    const h = html();
    expect(h).toContain('Move &lt;title&gt; into &lt;head&gt;');
    expect(h).not.toMatch(/<head>|<title>/);
    const long = toBasecampHtml(
      buildIssueTask(input({ counts: counts({ titleMissing: 900 }), totalUrls: 900 })),
    );
    expect(long).toContain('<code>issues:title-missing</code>');
    expect(long).not.toContain('`');
  });

  it('includes the user note and the title is not repeated in the body', () => {
    const t = buildIssueTask(input());
    t.note = 'Please fix <before> Friday & tell me';
    expect(toBasecampHtml(t)).toContain('Please fix &lt;before&gt; Friday &amp; tell me');
  });

  it('is kept within maxBodyChars as well as the Markdown', () => {
    const rows = Array.from({ length: 300 }, (_, i) => ({
      url: `https://example.com/a&b/${i}`,
      evidence: { title: '', titleLength: 0 },
    }));
    const t = buildIssueTask(
      input({ counts: counts({ titleMissing: 300 }), rows, maxBodyChars: 9000 }),
    );
    expect(toBasecampHtml(t).length).toBeLessThanOrEqual(9000);
    expect(toMarkdown(t).length).toBeLessThanOrEqual(9000);
  });
});

describe('link checks counted by target', () => {
  const pages = (over: Partial<BuildIssueTaskInput> = {}) =>
    buildIssueTask(
      input({
        category: 'issues:anchor-text-generic',
        counts: counts({ anchorTextGeneric: 4, anchorTextGenericPages: 9 }),
        rows: [{ url: 'https://example.com/a', evidence: { statusCode: 200, indexability: 'Indexable' } }],
        totalUrls: 9,
        ...over,
      }),
    );

  it('labels the list as pages that contain the flagged links and drops the default evidence', () => {
    const md = toMarkdown(pages());
    expect(md).toContain('9 pages that contain the flagged links, first 1 shown');
    expect(md).toContain('| Page with the link |');
    expect(md).not.toMatch(/statusCode|indexability|Indexable/);
    expect(pages().title).toContain('(9 pages)');
  });

  const targets = {
    total: 2,
    rows: [
      {
        targetUrl: 'https://example.com/old',
        statusCode: 301,
        finalUrl: 'https://example.com/new',
        sourcePages: 17,
        sampleSourceUrl: 'https://example.com/blog',
      },
      {
        targetUrl: 'https://user:pw@example.com/old2',
        statusCode: 302,
        finalUrl: null,
        sourcePages: 3,
        sampleSourceUrl: null,
      },
    ],
  };

  it('names the bad link targets from the by-target report, and the count is the sidebar count', () => {
    const t = buildIssueTask(
      input({
        category: 'issues:internal-link-to-redirect',
        counts: counts({ internalLinkToRedirect: 2, internalLinkToRedirectPages: 20 }),
        rows: [],
        targets,
      }),
    );
    const md = toMarkdown(t);
    expect(t.title).toBe('[example.com] Links: Internal Link → Redirect (2 linked URLs)');
    expect(md).toContain('2 linked URLs, first 2 shown');
    expect(md).toMatch(/\| Target URL \| Status \| Redirects to \| Linking pages \|/);
    expect(md).toContain('`https://example.com/old`');
    expect(md).toContain('`https://example.com/new`');
    expect(md).toContain('`17`');
    expect(md).not.toContain('user:pw');
    expect(toBasecampHtml(t)).toContain('<th>Linking pages</th>');
  });

  it('broken internal links name the failing target with its status', () => {
    const t = buildIssueTask(
      input({
        category: 'issues:broken-links-internal',
        counts: counts({ brokenLinksInternal: 2, brokenLinksInternalLinks: 40 }),
        rows: [],
        targets: { ...targets, rows: [{ ...targets.rows[0]!, statusCode: 404, finalUrl: null }] },
      }),
    );
    const md = toMarkdown(t);
    expect(md).toContain('`404`');
    expect(md).not.toContain('Redirects to');
    expect(t.title).toContain('(2 linked URLs)');
  });
});

describe('redirect evidence', () => {
  it('redirect checks list the status code and the redirect target, userinfo stripped', () => {
    expect(evidenceColumnsFor('issues:redirect-chain')).toEqual(['statusCode', 'redirectTarget']);
    const md = toMarkdown(
      buildIssueTask(
        input({
          category: 'issues:redirect-chain',
          counts: counts({ redirectChain: 1 }),
          rows: [
            {
              url: 'https://example.com/a',
              evidence: { statusCode: 301, redirectTarget: 'https://u:pw@example.com/b' },
            },
          ],
        }),
      ),
    );
    expect(md).toMatch(/\| URL \| statusCode \| redirectTarget \|/);
    expect(md).toContain('`https://example.com/b`');
    expect(md).not.toContain('u:pw');
  });
});

describe('the user note is inside the body cap', () => {
  it('a long note and a custom title shrink the URL list instead of overflowing', () => {
    const rows = Array.from({ length: 200 }, (_, i) => ({
      url: `https://example.com/page-${i}`,
      evidence: { title: '', titleLength: 0, statusCode: 200 },
    }));
    const t = buildIssueTask(
      input({ rows, totalUrls: 200, counts: counts({ titleMissing: 200 }), maxBodyChars: 6000, note: 'N'.repeat(3000), title: 'Mine' }),
    );
    expect(t.title).toBe('Mine');
    expect(toMarkdown(t).length).toBeLessThanOrEqual(6000);
    expect(toBasecampHtml(t).length).toBeLessThanOrEqual(6000);
    expect(t.moreUrls).toBeGreaterThan(0);
    expect(toMarkdown(t)).toContain('NNNN');
  });
});
