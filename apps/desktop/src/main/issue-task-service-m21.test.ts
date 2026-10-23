import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_SEO_THRESHOLDS } from '@freecrawl/shared-types';
import {
  GOOD_BASECAMP_TOKEN,
  GOOD_GITHUB_TOKEN,
  startBasecampStub,
  startGithubStub,
  type TrackerStub,
} from '../../../../packages/core/src/issue-task-stubs.test-support.js';
import { createIssueTaskService, type IssueTaskDeps } from './issue-task-service.js';
import { TRACKER_TEST_ENV } from './tracker-constants.js';

const stubs: TrackerStub[] = [];
afterEach(async () => {
  await Promise.all(stubs.splice(0).map((s) => s.close()));
});

const CATEGORY = 'issues:title-missing' as const;
const SOURCE = {
  counts: { issues: { titleMissing: 3 }, thresholds: DEFAULT_SEO_THRESHOLDS },
  total: 3,
  siteUrl: 'https://shop.example.test/',
  crawledAt: '2026-10-20T10:00:00.000Z',
  rows: [
    { url: 'https://shop.example.test/a', title: null, titleLength: 0, statusCode: 200 },
    { url: 'https://shop.example.test/b', title: '', titleLength: 0, statusCode: 200 },
    { url: 'https://shop.example.test/c', title: null, titleLength: 0, statusCode: 200 },
  ],
};

function deps(over: Partial<IssueTaskDeps> & { creds?: Record<string, Record<string, string>> } = {}): IssueTaskDeps {
  const { creds = {}, ...rest } = over;
  return {
    credentials: (id) => creds[id] ?? {},
    fetch: (url, init) => fetch(url, init),
    env: { [TRACKER_TEST_ENV]: '1' },
    loadSource: async () => SOURCE as never,
    pickSavePath: async () => null,
    ...rest,
  };
}

async function github() {
  const s = await startGithubStub('o', 'r');
  stubs.push(s);
  return {
    s,
    creds: { 'github-tasks': { token: GOOD_GITHUB_TOKEN, owner: 'o', repo: 'r', apiBase: s.base } },
  };
}

async function previewId(
  svc: ReturnType<typeof createIssueTaskService>,
  input: Parameters<ReturnType<typeof createIssueTaskService>['preview']>[0] = { category: CATEGORY },
) {
  const p = await svc.preview(input);
  if (!p.ok) throw new Error(p.message);
  return p.previewId;
}

describe('issue task service: preview', () => {
  it('shows the exact text, makes no request and says where each target would go', async () => {
    const { s, creds } = await github();
    const svc = createIssueTaskService(deps({ creds }));
    const p = await svc.preview({ category: CATEGORY });
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    expect(p.title).toContain('shop.example.test');
    expect(p.markdown).toContain('https://shop.example.test/a');
    expect(p.basecampHtml).toContain('<table');
    expect(p.targets.github).toEqual({ configured: true, where: 'o/r', alreadySent: false });
    expect(p.targets.basecamp.configured).toBe(false);
    expect(s.requests).toHaveLength(0);
  });

  it('applies the edited title and note to both texts', async () => {
    const svc = createIssueTaskService(deps());
    const p = await svc.preview({ category: CATEGORY, title: 'My title', note: 'Please do this first.' });
    if (!p.ok) throw new Error(p.message);
    expect(p.title).toBe('My title');
    expect(p.markdown).toContain('Please do this first.');
    expect(p.basecampHtml).toContain('Please do this first.');
  });

  it('refuses a category that is not an issue check', async () => {
    const svc = createIssueTaskService(deps());
    const p = await svc.preview({ category: 'internal:all' });
    expect(p.ok).toBe(false);
  });
});

describe('issue task service: send', () => {
  it('sends the previewed text to GitHub once and remembers it for the session', async () => {
    const { s, creds } = await github();
    const svc = createIssueTaskService(deps({ creds }));
    const p = await svc.preview({ category: CATEGORY });
    if (!p.ok) throw new Error(p.message);
    const r = await svc.send({ category: CATEGORY, target: 'github', previewId: p.previewId });
    expect(r.ok).toBe(true);
    expect(s.requests).toHaveLength(1);
    const sent = JSON.parse(s.requests[0]!.body) as { title: string; body: string };
    expect(sent.title).toBe(p.title);
    expect(sent.body).toBe(p.markdown);
    const again = await svc.preview({ category: CATEGORY });
    if (!again.ok) throw new Error(again.message);
    expect(again.targets.github.alreadySent).toBe(true);
  });

  it('two clicks at once make one request', async () => {
    const { s, creds } = await github();
    const svc = createIssueTaskService(deps({ creds }));
    const id = await previewId(svc);
    const [a, b] = await Promise.all([
      svc.send({ category: CATEGORY, target: 'github', previewId: id }),
      svc.send({ category: CATEGORY, target: 'github', previewId: id }),
    ]);
    expect(s.requests).toHaveLength(1);
    expect([a.ok, b.ok].sort()).toEqual([false, true]);
  });

  it('sends the edited title and note', async () => {
    const { s, creds } = await github();
    const svc = createIssueTaskService(deps({ creds }));
    const id = await previewId(svc, { category: CATEGORY, title: 'Edited', note: 'Note here' });
    await svc.send({ category: CATEGORY, target: 'github', previewId: id });
    const sent = JSON.parse(s.requests[0]!.body) as { title: string; body: string };
    expect(sent.title).toBe('Edited');
    expect(sent.body).toContain('Note here');
  });

  it('sends to Basecamp with the flat route and returns the app link', async () => {
    const s = await startBasecampStub('7', '9');
    stubs.push(s);
    const svc = createIssueTaskService(
      deps({
        creds: { 'basecamp-tasks': { accessToken: GOOD_BASECAMP_TOKEN, accountId: '7', todolistId: '9', apiBase: s.base } },
      }),
    );
    const r = await svc.send({ category: CATEGORY, target: 'basecamp', previewId: await previewId(svc) });
    expect(r.ok).toBe(true);
    expect(s.requests).toHaveLength(1);
    expect(s.requests[0]!.path).toBe('/7/todolists/9/todos.json');
  });

  it('shows the token-expired text on a Basecamp 401', async () => {
    const s = await startBasecampStub('7', '9');
    stubs.push(s);
    const svc = createIssueTaskService(
      deps({ creds: { 'basecamp-tasks': { accessToken: 'stale', accountId: '7', todolistId: '9', apiBase: s.base } } }),
    );
    const r = await svc.send({ category: CATEGORY, target: 'basecamp', previewId: await previewId(svc) });
    expect(r).toMatchObject({ ok: false });
    if (!r.ok) expect(r.message).toMatch(/expired or revoked/);
  });

  it('says plainly when the integration is not set up and sends nothing', async () => {
    const svc = createIssueTaskService(deps());
    const r = await svc.send({ category: CATEGORY, target: 'github', previewId: await previewId(svc) });
    expect(r).toMatchObject({ ok: false });
    if (!r.ok) expect(r.message).toMatch(/not set up/);
  });

  it('test mode: an empty apiBase is refused and nothing is sent', async () => {
    let calls = 0;
    const svc = createIssueTaskService(
      deps({
        creds: { 'github-tasks': { token: 't', owner: 'o', repo: 'r', apiBase: '' } },
        fetch: async () => {
          calls++;
          return { status: 201, text: async () => '{}' };
        },
      }),
    );
    const r = await svc.send({ category: CATEGORY, target: 'github', previewId: await previewId(svc) });
    expect(r.ok).toBe(false);
    expect(calls).toBe(0);
  });

  it('a failed send is not remembered as sent', async () => {
    const { s, creds } = await github();
    s.force({ status: 422, body: { message: 'Validation Failed' } });
    const svc = createIssueTaskService(deps({ creds }));
    const r = await svc.send({ category: CATEGORY, target: 'github', previewId: await previewId(svc) });
    expect(r.ok).toBe(false);
    const p = await svc.preview({ category: CATEGORY });
    if (p.ok) expect(p.targets.github.alreadySent).toBe(false);
  });
});

describe('issue task service: save', () => {
  it('writes the markdown where the user picked, with no integration set up', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'm21-save-'));
    const file = join(dir, 'task.md');
    const svc = createIssueTaskService(deps({ pickSavePath: async () => file }));
    const r = await svc.save({ category: CATEGORY, note: 'N' });
    expect(r).toEqual({ ok: true, filePath: file });
    expect(readFileSync(file, 'utf8')).toContain('N');
  });

  it('writes nothing when the user cancels', async () => {
    const svc = createIssueTaskService(deps());
    expect(await svc.save({ category: CATEGORY })).toMatchObject({ ok: false, cancelled: true });
  });
});

describe('issue task service: what was previewed is what is sent', () => {
  it('sends the previewed rows even when the project changed after the preview', async () => {
    const { s, creds } = await github();
    let calls = 0;
    const svc = createIssueTaskService(
      deps({
        creds,
        loadSource: async () => {
          calls++;
          return (calls === 1
            ? SOURCE
            : { ...SOURCE, total: 99, rows: [{ url: 'https://shop.example.test/NEW', statusCode: 200 }] }) as never;
        },
      }),
    );
    const p = await svc.preview({ category: CATEGORY });
    if (!p.ok) throw new Error(p.message);
    await svc.send({ category: CATEGORY, target: 'github', previewId: p.previewId });
    const sent = JSON.parse(s.requests[0]!.body) as { title: string; body: string };
    expect(sent.body).toBe(p.markdown);
    expect(sent.body).not.toContain('/NEW');
    expect(calls).toBe(1);
  });

  it('refuses a stale preview id and a send without any preview, and sends nothing', async () => {
    const { s, creds } = await github();
    const svc = createIssueTaskService(deps({ creds }));
    expect((await svc.send({ category: CATEGORY, target: 'github', previewId: 'nope' })).ok).toBe(false);
    const first = await previewId(svc);
    await previewId(svc, { category: CATEGORY, title: 'Edited later' });
    const r = await svc.send({ category: CATEGORY, target: 'github', previewId: first });
    expect(r).toMatchObject({ ok: false });
    if (!r.ok) expect(r.message).toMatch(/changed/);
    expect(s.requests).toHaveLength(0);
  });
});

describe('issue task service: errors come back as results', () => {
  it('a throwing source gives {ok:false} for preview and save, with the token scrubbed', async () => {
    const { creds } = await github();
    const boom = async (): Promise<never> => {
      throw new Error(`disk full ${GOOD_GITHUB_TOKEN}`);
    };
    const svc = createIssueTaskService(deps({ creds, loadSource: boom }));
    for (const r of [
      await svc.preview({ category: CATEGORY }),
      await svc.save({ category: CATEGORY }),
    ]) {
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.message).toContain('disk full');
        expect(r.message).not.toContain(GOOD_GITHUB_TOKEN);
      }
    }
  });

  it('a failing file write on save is a result, not a rejection', async () => {
    const svc = createIssueTaskService(
      deps({ pickSavePath: async () => join(mkdtempSync(join(tmpdir(), 'm21-w-')), 'no', 'such', 'dir.md') }),
    );
    const r = await svc.save({ category: CATEGORY });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.cancelled).toBeUndefined();
  });

  it('a fetch that throws on send is a result', async () => {
    const { creds } = await github();
    const svc = createIssueTaskService(
      deps({ creds, fetch: async () => { throw new Error('socket'); } }),
    );
    const r = await svc.send({ category: CATEGORY, target: 'github', previewId: await previewId(svc) });
    expect(r.ok).toBe(false);
  });
});

describe('issue task service: scope and link checks', () => {
  it('Broken Links (All / External) make no task', async () => {
    const svc = createIssueTaskService(deps());
    for (const c of ['issues:broken-links-all', 'issues:broken-links-external'] as const)
      expect((await svc.preview({ category: c })).ok).toBe(false);
  });

  it('a link check passes the by-target rows to the task', async () => {
    const svc = createIssueTaskService(
      deps({
        loadSource: async () =>
          ({
            ...SOURCE,
            counts: { issues: { internalLinkToRedirect: 1 }, thresholds: DEFAULT_SEO_THRESHOLDS },
            targets: {
              rows: [{ targetUrl: 'https://shop.example.test/old', statusCode: 301, finalUrl: 'https://shop.example.test/new', sourcePages: 5, sampleSourceUrl: null }],
            },
          }) as never,
      }),
    );
    const p = await svc.preview({ category: 'issues:internal-link-to-redirect' });
    if (!p.ok) throw new Error(p.message);
    expect(p.markdown).toContain('`https://shop.example.test/old`');
    expect(p.markdown).toContain('Linking pages');
  });
});
