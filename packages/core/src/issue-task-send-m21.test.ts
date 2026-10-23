import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_SEO_THRESHOLDS } from '@freecrawl/shared-types';
import { buildIssueTask, toBasecampHtml, toMarkdown, type IssueTask } from './issue-task.js';
import { sendBasecampTodo, sendGithubIssue } from './issue-task-send.js';
import {
  BASECAMP_CREATED,
  GOOD_BASECAMP_TOKEN,
  startBasecampStub,
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

describe('sendGithubIssue errors', () => {
  const cfg = (base: string) => ({
    apiBase: base,
    token: GOOD_GITHUB_TOKEN,
    owner: 'octo',
    repo: 'repo',
    userAgent: UA,
  });

  it.each([
    [401, { message: 'Bad credentials' }, /token/i],
    [410, { message: 'Issues are disabled for this repo' }, /issues are disabled in this repository/i],
    [422, { message: 'Validation Failed', errors: [{ field: 'title' }] }, /Validation Failed/],
    [403, { message: 'API rate limit exceeded' }, /rate limit/],
    [500, { message: 'boom' }, /may have been created/],
  ])('maps %i to ok:false, no token in the text, exactly one request', async (status, body, re) => {
    stub = await startGithubStub('octo', 'repo');
    // the API echoes the secret back in its detail: it must not reach the dialog
    stub.force({ status, body: { ...body, message: `${body.message} ${GOOD_GITHUB_TOKEN}` } });
    const res = await sendGithubIssue(cfg(stub.base), task, deps);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.status).toBe(status);
    expect(res.message).toMatch(re);
    expect(res.message).not.toContain(GOOD_GITHUB_TOKEN);
    expect(stub.requests).toHaveLength(1);
  });

  it('a wrong token is a 401 from the stub', async () => {
    stub = await startGithubStub('octo', 'repo');
    const res = await sendGithubIssue({ ...cfg(stub.base), token: 'nope' }, task, deps);
    expect(res).toMatchObject({ ok: false, status: 401 });
  });

  it('the stub itself enforces User-Agent and Content-Type', async () => {
    stub = await startGithubStub('octo', 'repo');
    const url = `${stub.base}/repos/octo/repo/issues`;
    const noUa = await fetch(url, { method: 'POST', headers: { 'user-agent': '' }, body: '{}' });
    expect(noUa.status).toBe(403);
    const noCt = await fetch(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${GOOD_GITHUB_TOKEN}`, 'content-type': 'text/plain' },
      body: '{}',
    });
    expect(noCt.status).toBe(415);
  });

  it('refuses a non-https, non-loopback apiBase without any request', async () => {
    let called = 0;
    const res = await sendGithubIssue(cfg('http://tracker.example.test'), task, {
      fetch: async () => {
        called++;
        return { status: 201, text: async () => '{}' };
      },
    });
    expect(res.ok).toBe(false);
    expect(called).toBe(0);
  });

  it('a timeout says the task may have been created, and is not retried', async () => {
    let calls = 0;
    const res = await sendGithubIssue(cfg('https://tracker.example.test'), task, {
      timeoutMs: 20,
      fetch: (_u, init) => {
        calls++;
        return new Promise((_ok, fail) => {
          init.signal?.addEventListener('abort', () => fail(new Error('This operation was aborted')));
        });
      },
    });
    expect(res).toMatchObject({ ok: false, mayHaveBeenCreated: true });
    if (!res.ok) expect(res.message).toMatch(/may have been created/);
    expect(calls).toBe(1);
  });
});

describe('sendBasecampTodo', () => {
  const cfg = (base: string, accessToken = GOOD_BASECAMP_TOKEN) => ({
    apiBase: base,
    accessToken,
    accountId: '195539477',
    todolistId: '777',
    userAgent: UA,
  });

  it('posts content and HTML description to the flat to-do route and returns app_url', async () => {
    stub = await startBasecampStub('195539477', '777');
    const res = await sendBasecampTodo(cfg(stub.base), task, deps);
    expect(res).toEqual({ ok: true, url: BASECAMP_CREATED.app_url });
    expect(stub.requests).toHaveLength(1);
    const r = stub.requests[0]!;
    expect(r.path).toBe('/195539477/todolists/777/todos.json');
    expect(r.headers.authorization).toBe(`Bearer ${GOOD_BASECAMP_TOKEN}`);
    expect(r.headers['user-agent']).toBe(UA);
    expect(r.headers['content-type']).toBe('application/json; charset=utf-8');
    const sent = JSON.parse(r.body) as { content: string; description: string };
    expect(sent.content).toBe(task.title);
    expect(sent.description).toBe(toBasecampHtml(task));
  });

  it('the stub itself answers 400 without a UA of the form Name (contact), 415 without JSON', async () => {
    stub = await startBasecampStub('195539477', '777');
    const url = `${stub.base}/195539477/todolists/777/todos.json`;
    const auth = { authorization: `Bearer ${GOOD_BASECAMP_TOKEN}` };
    expect((await fetch(url, { method: 'POST', headers: { ...auth, 'user-agent': 'plain' }, body: '{}' })).status).toBe(400);
    expect(
      (await fetch(url, { method: 'POST', headers: { ...auth, 'user-agent': UA, 'content-type': 'text/plain' }, body: '{}' })).status,
    ).toBe(415);
  });

  it('turns a 401 into the token-expired message, without the token', async () => {
    stub = await startBasecampStub('195539477', '777');
    const res = await sendBasecampTodo(cfg(stub.base, 'old-token-xyz'), task, deps);
    expect(res).toMatchObject({ ok: false, status: 401 });
    if (res.ok) return;
    expect(res.message).toBe(
      'Basecamp token expired or revoked; paste a new one in Settings → Integrations',
    );
    expect(stub.requests).toHaveLength(1);
  });

  it('says the to-do may exist after a 5xx, no retry, no token in the text', async () => {
    stub = await startBasecampStub('195539477', '777');
    stub.force({ status: 503, body: { error: `down ${GOOD_BASECAMP_TOKEN}` } });
    const res = await sendBasecampTodo(cfg(stub.base), task, deps);
    expect(res).toMatchObject({ ok: false, status: 503, mayHaveBeenCreated: true });
    if (!res.ok) {
      expect(res.message).toMatch(/may have been created/);
      expect(res.message).not.toContain(GOOD_BASECAMP_TOKEN);
    }
    expect(stub.requests).toHaveLength(1);
  });

  it('refuses a non-https, non-loopback apiBase', async () => {
    const res = await sendBasecampTodo(cfg('http://tracker.example.test'), task, {
      fetch: async () => {
        throw new Error('must not be called');
      },
    });
    expect(res.ok).toBe(false);
  });
});
