import { writeFile } from 'node:fs/promises';
import {
  buildIssueTask,
  evidenceColumnsFor,
  sendBasecampTodo,
  sendGithubIssue,
  toBasecampHtml,
  toMarkdown,
  type IssueTask,
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

const ISSUE_CATEGORIES = new Set<string>(
  ISSUE_GROUPS.flatMap((g) => g.items.map((i) => i.category)),
);

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
    const title = input.title?.trim();
    const note = input.note?.trim();
    return {
      task: { ...task, ...(title ? { title } : {}), ...(note ? { note } : {}) },
      total: src.total,
    };
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
      const built = await build(input);
      if (typeof built === 'string') return { ok: false, message: built };
      return {
        ok: true,
        title: built.task.title,
        markdown: toMarkdown(built.task),
        basecampHtml: toBasecampHtml(built.task),
        totalUrls: built.total,
        targets: {
          github: targetState('github', input.category),
          basecamp: targetState('basecamp', input.category),
        },
      };
    },

    async send(input: IssueTaskSendInput): Promise<IssueTaskSendResult> {
      const k = key(input.target, input.category);
      if (inFlight.has(k)) return { ok: false, message: 'This task is already being sent.' };
      inFlight.add(k);
      try {
        const creds = deps.credentials(INTEGRATION_ID[input.target]);
        const built = await build(input);
        if (typeof built === 'string') return { ok: false, message: built };
        const sendDeps = { fetch: deps.fetch };
        let res;
        if (input.target === 'github') {
          const cfg = resolveTrackerConfig('github', creds, deps.env);
          if (!cfg.ok) return cfg;
          res = await sendGithubIssue(cfg.cfg, built.task, sendDeps);
        } else {
          const cfg = resolveTrackerConfig('basecamp', creds, deps.env);
          if (!cfg.ok) return cfg;
          res = await sendBasecampTodo(cfg.cfg, built.task, sendDeps);
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
      } finally {
        inFlight.delete(k);
      }
    },

    async save(input: IssueTaskPreviewInput): Promise<IssueTaskSaveResult> {
      const built = await build(input);
      if (typeof built === 'string') return { ok: false, message: built };
      const file = await deps.pickSavePath(`${input.category.replace(/[^a-z0-9-]+/gi, '-')}.md`);
      if (!file) return { ok: false, message: 'Cancelled.' };
      await writeFile(file, toMarkdown(built.task), 'utf8');
      return { ok: true, filePath: file };
    },
  };
}
