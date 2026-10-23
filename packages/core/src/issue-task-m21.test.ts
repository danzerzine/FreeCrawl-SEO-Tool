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
