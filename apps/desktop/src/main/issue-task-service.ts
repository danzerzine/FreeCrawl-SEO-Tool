import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import {
  buildIssueTask,
  evidenceColumnsFor,
  sendBasecampTodo,
  sendGithubIssue,
  toBasecampHtml,
  toMarkdown,
  type IssueTask,
  type IssueTaskTargetRow,
  type TrackerFetch,
} from '@freecrawl/core';
import {
  ISSUE_GROUPS,
  type CrawlUrlRow,
  type IssueTaskPreviewInput,
  type IssueTaskPreviewResult,
  type IssueTaskSaveResult,
  type IssueTaskSendInput,
  type IssueTaskSendResult,
  type IssueTaskTarget,
  type LinkTargetReportKind,
  type LinkTargetRow,
  type IssueTaskTargetState,
  type OverviewCounts,
} from '@freecrawl/shared-types';
import { resolveTrackerConfig } from './tracker-config.js';

/** Catalog ids of the two integrations. */
const INTEGRATION_ID: Record<IssueTaskTarget, string> = {
  github: 'github-tasks',
  basecamp: 'basecamp-tasks',
};

/** What the project DB gives the builder: the check's counters and its first flagged rows. */
export interface IssueTaskSource {
  counts: Pick<OverviewCounts, 'issues' | 'thresholds'>;
  rows: CrawlUrlRow[];
  /** By-target report rows of a link check that has one; absent when not computed. */
  targets?: { rows: IssueTaskTargetRow[] };
  /** Flagged URLs in total. */
  total: number;
  siteUrl: string;
  crawledAt: string;
}

export interface IssueTaskDeps {
  /** Decrypted fields of an integration; main process only. */
  credentials(id: string): Record<string, string>;
  fetch: TrackerFetch;
  env: Record<string, string | undefined>;
  loadSource(category: IssueTaskPreviewInput['category']): Promise<IssueTaskSource>;
  /** Save dialog; null when the user cancels. */
  pickSavePath(defaultName: string): Promise<string | null>;
}

/** Broken Links (All / External) have no by-target report: no task for them. */
const OUT_OF_SCOPE = new Set<string>(['issues:broken-links-all', 'issues:broken-links-external']);
const ISSUE_CATEGORIES = new Set<string>(
  ISSUE_GROUPS.flatMap((g) => g.items.map((i) => i.category)).filter((c) => !OUT_OF_SCOPE.has(c)),
);

/** The by-target report of a link check, when it has one. */
export function targetReportOf(category: string): LinkTargetReportKind | undefined {
  return ISSUE_GROUPS.flatMap((g) => g.items).find((i) => i.category === category)?.byTarget
    ?.report;
}

export function toTargetRow(r: LinkTargetRow): IssueTaskTargetRow {
  return {
    targetUrl: r.targetUrl,
    statusCode: r.statusCode,
    finalUrl: r.finalUrl,
    sourcePages: r.sourcePages,
    sampleSourceUrl: r.sampleSourceUrl,
  };
}

/** Error text without any token of the two integrations. */
function scrubbed(e: unknown, secrets: string[]): string {
  let out = e instanceof Error ? e.message : String(e);
  for (const s of secrets) {
    if (s.length < 6) continue;
    for (const form of new Set([s, encodeURIComponent(s)])) out = out.split(form).join('***');
  }
  return out;
}

function whereOf(target: IssueTaskTarget, creds: Record<string, string>): string {
  return target === 'github'
    ? `${creds['owner'] ?? ''}/${creds['repo'] ?? ''}`
    : `account ${creds['accountId'] ?? ''} / to-do list ${creds['todolistId'] ?? ''}`;
}

/**
 * Issue to tracker task, desktop side. Reads the issue's rows, builds the
 * task with core, and sends only when `send` is called. Holds the session's
 * "already sent" memory and the in-flight guard (nothing is stored on disk).
 */
export function createIssueTaskService(deps: IssueTaskDeps) {
  const sent = new Set<string>();
  const inFlight = new Set<string>();
  /** The task of the newest preview: what Send sends. */
  let last: { id: string; category: string; task: IssueTask } | null = null;
  const secrets = () =>
    (['github', 'basecamp'] as const).flatMap((t) => {
      const c = deps.credentials(INTEGRATION_ID[t]);
      return [c['token'] ?? '', c['accessToken'] ?? ''];
    });
  const fail = (e: unknown) => ({ ok: false as const, message: scrubbed(e, secrets()) });
  const key = (target: IssueTaskTarget, category: string) => `${target}|${category}`;

  async function build(
    input: IssueTaskPreviewInput,
  ): Promise<{ task: IssueTask; total: number } | string> {
    if (!ISSUE_CATEGORIES.has(input.category))
      return 'Pick one of the Issues checks to make a task.';
    const src = await deps.loadSource(input.category);
    const cols = evidenceColumnsFor(input.category);
    const task = buildIssueTask({
      category: input.category,
      ...(input.title?.trim() ? { title: input.title } : {}),
      ...(input.note?.trim() ? { note: input.note } : {}),
      ...(src.targets ? { targets: src.targets } : {}),
      counts: src.counts,
      totalUrls: src.total,
      siteUrl: src.siteUrl,
      crawledAt: src.crawledAt,
      rows: src.rows.map((r) => ({
        url: r.url,
        evidence: Object.fromEntries(
          cols.map((c) => {
            const v = (r as unknown as Record<string, unknown>)[c];
            return [c, typeof v === 'string' || typeof v === 'number' ? v : null];
          }),
        ),
      })),
    });
    return { task, total: src.total };
  }

  function targetState(target: IssueTaskTarget, category: string): IssueTaskTargetState {
    const creds = deps.credentials(INTEGRATION_ID[target]);
    const resolved = resolveTrackerConfig(target as 'github', creds, {});
    return {
      configured: resolved.ok,
      where: resolved.ok ? whereOf(target, creds) : '',
      alreadySent: sent.has(key(target, category)),
    };
  }

  return {
    async preview(input: IssueTaskPreviewInput): Promise<IssueTaskPreviewResult> {
      try {
        const built = await build(input);
        if (typeof built === 'string') return { ok: false, message: built };
        const markdown = toMarkdown(built.task);
        const basecampHtml = toBasecampHtml(built.task);
        const previewId = createHash('sha256')
          .update(JSON.stringify([built.task.title, markdown, basecampHtml]))
          .digest('hex')
          .slice(0, 16);
        last = { id: previewId, category: input.category, task: built.task };
        return {
          ok: true,
          title: built.task.title,
          markdown,
          basecampHtml,
          totalUrls: built.total,
          previewId,
          targets: {
            github: targetState('github', input.category),
            basecamp: targetState('basecamp', input.category),
          },
        };
      } catch (e) {
        return fail(e);
      }
    },

    async send(input: IssueTaskSendInput): Promise<IssueTaskSendResult> {
      const k = key(input.target, input.category);
      if (inFlight.has(k)) return { ok: false, message: 'This task is already being sent.' };
      inFlight.add(k);
      try {
        if (!last || last.id !== input.previewId || last.category !== input.category) {
          return { ok: false, message: 'The text changed since you read it. Review the new preview, then send.' };
        }
        const creds = deps.credentials(INTEGRATION_ID[input.target]);
        const task = last.task;
        const sendDeps = { fetch: deps.fetch };
        let res;
        if (input.target === 'github') {
          const cfg = resolveTrackerConfig('github', creds, deps.env);
          if (!cfg.ok) return cfg;
          res = await sendGithubIssue(cfg.cfg, task, sendDeps);
        } else {
          const cfg = resolveTrackerConfig('basecamp', creds, deps.env);
          if (!cfg.ok) return cfg;
          res = await sendBasecampTodo(cfg.cfg, task, sendDeps);
        }
        if (res.ok) {
          sent.add(k);
          return { ok: true, url: res.url };
        }
        return {
          ok: false,
          message: res.message,
          ...(res.mayHaveBeenCreated ? { mayHaveBeenCreated: true } : {}),
        };
      } catch (e) {
        return fail(e);
      } finally {
        inFlight.delete(k);
      }
    },

    async save(input: IssueTaskPreviewInput): Promise<IssueTaskSaveResult> {
      try {
        const built = await build(input);
        if (typeof built === 'string') return { ok: false, message: built };
        const file = await deps.pickSavePath(`${input.category.replace(/[^a-z0-9-]+/gi, '-')}.md`);
        if (!file) return { ok: false, message: 'Cancelled.', cancelled: true };
        await writeFile(file, toMarkdown(built.task), 'utf8');
        return { ok: true, filePath: file };
      } catch (e) {
        return fail(e);
      }
    },
  };
}
