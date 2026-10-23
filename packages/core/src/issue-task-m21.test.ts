import { describe, expect, it } from 'vitest';
import type { OverviewCounts } from '@freecrawl/shared-types';
import { DEFAULT_SEO_THRESHOLDS } from '@freecrawl/shared-types';
import { buildIssueTask, toMarkdown, type BuildIssueTaskInput } from './issue-task.js';

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

// Splits a GFM table row at unescaped pipes (a backslash escapes the next char).
function cells(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  const body = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  for (let i = 0; i < body.length; i++) {
    const c = body[i]!;
    if (c === '\\' && i + 1 < body.length) {
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
    expect(md).toContain('`a\\\\\\|b`');
    expect(md).toContain('````has ``` run````');
    // no @ or # outside code spans in the table
    for (const l of tableLines(md).slice(2)) {
      const outside = l.replace(/(`+)[^]*?\1/g, '');
      expect(outside).not.toMatch(/[@#]/);
    }
  });

  it('writes an empty value as an empty cell', () => {
    const line = tableLines(toMarkdown(task())).find((l) => l.includes('/p7`'))!;
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
