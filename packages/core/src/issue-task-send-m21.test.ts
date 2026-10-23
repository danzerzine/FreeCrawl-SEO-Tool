import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_SEO_THRESHOLDS } from '@freecrawl/shared-types';
import { buildIssueTask, toMarkdown, type IssueTask } from './issue-task.js';
import { sendGithubIssue } from './issue-task-send.js';
import {
  GITHUB_CREATED,
  GOOD_GITHUB_TOKEN,
  startGithubStub,
  type TrackerStub,
} from './issue-task-stubs.test-support.js';

const UA = 'FreeCrawl (https://example.invalid/fork)';
const task: IssueTask = buildIssueTask({
  category: 'issues:title-missing',
  counts: { issues: { titleMissing: 1 }, thresholds: DEFAULT_SEO_THRESHOLDS } as never,
  rows: [{ url: 'https://example.com/a', evidence: { title: '', titleLength: 0 } }],
  siteUrl: 'https://example.com/',
  crawledAt: '2026-10-20T10:00:00.000Z',
});
const deps = { fetch: (u: string, i: RequestInit) => fetch(u, i) };

let stub: TrackerStub | undefined;
afterEach(async () => {
  await stub?.close();
  stub = undefined;
});

describe('sendGithubIssue', () => {
  const cfg = (base: string, token = GOOD_GITHUB_TOKEN) => ({
    apiBase: base,
    token,
    owner: 'octo',
    repo: 'repo',
    userAgent: UA,
  });

  it('posts title and Markdown body to the repo issues path and returns html_url', async () => {
    stub = await startGithubStub('octo', 'repo');
    const res = await sendGithubIssue(cfg(stub.base), task, deps);
    expect(res).toEqual({ ok: true, url: GITHUB_CREATED.html_url });
    expect(stub.requests).toHaveLength(1);
    const r = stub.requests[0]!;
    expect(r.method).toBe('POST');
    expect(r.path).toBe('/repos/octo/repo/issues');
    expect(r.headers.authorization).toBe(`Bearer ${GOOD_GITHUB_TOKEN}`);
    expect(r.headers['x-github-api-version']).toBe('2022-11-28');
    expect(r.headers.accept).toBe('application/vnd.github+json');
    expect(r.headers['user-agent']).toBe(UA);
    expect(r.headers['content-type']).toBe('application/json; charset=utf-8');
    expect(JSON.parse(r.body)).toEqual({ title: task.title, body: toMarkdown(task) });
  });
});
