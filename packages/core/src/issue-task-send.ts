import { trimTrailingSlashes } from '@freecrawl/shared-types';
import { toBasecampHtml, toMarkdown, type IssueTask } from './issue-task.js';

/** Minimal fetch shape: the desktop passes its `apiFetch`, tests pass global `fetch`. */
export type TrackerFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal },
) => Promise<{ status: number; text(): Promise<string> }>;

export interface TrackerDeps {
  fetch: TrackerFetch;
  /** Default 30 000 ms. */
  timeoutMs?: number;
}

export type TaskSendResult =
  | { ok: true; url: string }
  | {
      ok: false;
      status?: number;
      /** Plain text for the dialog; never holds the token. */
      message: string;
      /** True when the request may have reached the tracker (timeout, 5xx). */
      mayHaveBeenCreated?: boolean;
    };

export interface GithubTaskConfig {
  /** Required, no default in core: a test that forgets it cannot reach a real host. */
  apiBase: string;
  token: string;
  owner: string;
  repo: string;
  userAgent: string;
}

const MAY_EXIST = 'the task may have been created; check the tracker before resending';
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

/** https only, except loopback, so a token never travels in clear. Returns the base without a trailing slash. */
function checkBase(apiBase: string): { base: string } | { error: string } {
  let u: URL;
  try {
    u = new URL(apiBase);
  } catch {
    return { error: 'The tracker API address is not a valid URL.' };
  }
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && LOOPBACK.has(u.hostname))) {
    return {
      error: 'The tracker API address must use https (http is allowed only for localhost).',
    };
  }
  return { base: trimTrailingSlashes(apiBase) };
}

function scrub(text: string, secrets: string[]): string {
  let out = text;
  for (const s of secrets) {
    if (!s) continue;
    for (const form of new Set([s, encodeURIComponent(s)])) out = out.split(form).join('***');
  }
  return out;
}

/** Error text of a JSON or plain body, cut short and scrubbed. */
function detailOf(body: string, secrets: string[]): string {
  let text = body;
  try {
    const j = JSON.parse(body) as { message?: unknown; error?: unknown; errors?: unknown };
    const msg =
      typeof j.message === 'string' ? j.message : typeof j.error === 'string' ? j.error : '';
    const errs = Array.isArray(j.errors) ? ` ${JSON.stringify(j.errors)}` : '';
    if (msg) text = msg + errs;
  } catch {
    /* not JSON: use the raw text */
  }
  return scrub(text.replace(/\s+/g, ' ').trim().slice(0, 400), secrets);
}

async function post(
  url: string,
  headers: Record<string, string>,
  payload: unknown,
  secrets: string[],
  deps: TrackerDeps,
): Promise<{ status: number; body: string } | { fail: TaskSendResult }> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), deps.timeoutMs ?? 30_000);
  try {
    const res = await deps.fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: ctl.signal,
    });
    return { status: res.status, body: await res.text() };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      fail: {
        ok: false,
        message: `The tracker did not answer (${scrub(msg, secrets)}); ${MAY_EXIST}.`,
        mayHaveBeenCreated: true,
      },
    };
  } finally {
    clearTimeout(timer);
  }
}

function pickUrl(body: string, field: string): string | undefined {
  try {
    const v = (JSON.parse(body) as Record<string, unknown>)[field];
    return typeof v === 'string' ? v : undefined;
  } catch {
    return undefined;
  }
}

/** Creates a GitHub issue; never retried (a retry could create a duplicate). */
export async function sendGithubIssue(
  cfg: GithubTaskConfig,
  task: IssueTask,
  deps: TrackerDeps,
): Promise<TaskSendResult> {
  const b = checkBase(cfg.apiBase);
  if ('error' in b) return { ok: false, message: b.error };
  const url = `${b.base}/repos/${encodeURIComponent(cfg.owner)}/${encodeURIComponent(cfg.repo)}/issues`;
  const res = await post(
    url,
    {
      Authorization: `Bearer ${cfg.token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json; charset=utf-8',
      'User-Agent': cfg.userAgent,
    },
    { title: task.title, body: toMarkdown(task) },
    [cfg.token],
    deps,
  );
  if ('fail' in res) return res.fail;
  const { status } = res;
  if (status === 201) {
    const html = pickUrl(res.body, 'html_url');
    return html
      ? { ok: true, url: html }
      : {
          ok: false,
          status,
          message: 'GitHub created the issue but sent no link; check the repository.',
          mayHaveBeenCreated: true,
        };
  }
  const detail = detailOf(res.body, [cfg.token]);
  if (status === 401)
    return {
      ok: false,
      status,
      message: 'GitHub rejected the token (401); paste a valid one in Settings → Integrations.',
    };
  if (status === 410)
    return { ok: false, status, message: 'Issues are disabled in this repository.' };
  if (status >= 500)
    return {
      ok: false,
      status,
      message: `GitHub error ${status}: ${detail}; ${MAY_EXIST}.`,
      mayHaveBeenCreated: true,
    };
  return { ok: false, status, message: `GitHub answered ${status}: ${detail}` };
}

export interface BasecampTaskConfig {
  /** Required, no default in core. */
  apiBase: string;
  accessToken: string;
  accountId: string;
  todolistId: string;
  userAgent: string;
}

export const BASECAMP_TOKEN_EXPIRED =
  'Basecamp token expired or revoked; paste a new one in Settings → Integrations';

/** Creates a Basecamp to-do on the flat route; never retried. */
export async function sendBasecampTodo(
  cfg: BasecampTaskConfig,
  task: IssueTask,
  deps: TrackerDeps,
): Promise<TaskSendResult> {
  const b = checkBase(cfg.apiBase);
  if ('error' in b) return { ok: false, message: b.error };
  const url = `${b.base}/${encodeURIComponent(cfg.accountId)}/todolists/${encodeURIComponent(cfg.todolistId)}/todos.json`;
  const res = await post(
    url,
    {
      Authorization: `Bearer ${cfg.accessToken}`,
      'Content-Type': 'application/json; charset=utf-8',
      'User-Agent': cfg.userAgent,
    },
    { content: task.title, description: toBasecampHtml(task) },
    [cfg.accessToken],
    deps,
  );
  if ('fail' in res) return res.fail;
  const { status } = res;
  if (status === 201) {
    const app = pickUrl(res.body, 'app_url');
    return app
      ? { ok: true, url: app }
      : {
          ok: false,
          status,
          message: 'Basecamp created the to-do but sent no link; check the to-do list.',
          mayHaveBeenCreated: true,
        };
  }
  if (status === 401) return { ok: false, status, message: BASECAMP_TOKEN_EXPIRED };
  const detail = detailOf(res.body, [cfg.accessToken]);
  if (status >= 500)
    return {
      ok: false,
      status,
      message: `Basecamp error ${status}: ${detail}; ${MAY_EXIST}.`,
      mayHaveBeenCreated: true,
    };
  return { ok: false, status, message: `Basecamp answered ${status}: ${detail}` };
}
