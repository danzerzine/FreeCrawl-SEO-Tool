/**
 * The three entries behind the `gscBqPlan` / `gscBqRun` / `gscBqCancel` IPC calls (B91).
 *
 * Electron-free (index.ts only wires them): a run starts only from a plan that was shown in the same
 * dialog session (`planId`), only when that plan fits the cap, one at a time, and never from the
 * CLI, the bridge or a schedule. Every failure comes back as one line that says what to fix.
 */
import type { ProjectDb } from '@freecrawl/db';
import type {
  GscBqCheckResult,
  GscBqPlanInput,
  GscBqPlanResult,
  GscBqPlanView,
  GscBqProgress,
  GscBqRunInput,
  GscBqRunResult,
  GscIntegrationSettings,
} from '@freecrawl/shared-types';
import { describeBqError, type BqTarget } from './gsc-bigquery.js';
import { buildBqPlan, resetBigQuery, runGscBigQuery, type BqRunClient, type PullPlan } from './gsc-bigquery-run.js';

/**
 * Per-window state of the BigQuery pull. Per window is enough (B182): each
 * window opens a project as its own working copy, also when two windows open
 * the same file, so no two windows' pulls write one database, and the overlap
 * guard in `runGscBigQuery`, which reads its run's ledger, sees every merge
 * into that copy (pinned by gsc-bq-window-b182.test.ts).
 */
export interface BqSlot {
  plan: PullPlan | null;
  planId: string;
  active: boolean;
  cancelRequested: boolean;
}

export function newBqSlot(): BqSlot {
  return { plan: null, planId: '', active: false, cancelRequested: false };
}

export interface BqEntryEnv {
  db: ProjectDb;
  settings: GscIntegrationSettings;
  /** Project of the BigQuery integration (the billing project); '' when it is not set up. */
  projectId: string;
  makeClient: (target: BqTarget) => BqRunClient;
  slot: BqSlot;
  now: () => Date;
  newPlanId: () => string;
  onProgress: (p: GscBqProgress) => void;
  onChanged: () => void;
}

const fail = (error: string): GscBqPlanResult => ({ ok: false, error, plan: null });

function view(plan: PullPlan, planId: string): GscBqPlanView {
  return {
    planId,
    location: plan.location,
    siteUrl: plan.siteUrl,
    searchType: plan.searchType,
    range: plan.range,
    parts: plan.parts.map((p) => ({ start: p.start, end: p.end, days: p.days, estimate: p.estimate })),
    coveredDays: plan.coveredDays,
    missingDays: plan.missingDays,
    revisedDays: plan.revisedDays,
    firstCovered: plan.firstCovered,
    lastCovered: plan.lastCovered,
    totalEstimate: plan.totalEstimate,
    freeTierShare: plan.freeTierShare,
    capBytes: plan.capBytes,
    billedSoFar: plan.billedSoFar,
    overCap: plan.overCap,
    needsReset: plan.needsReset,
    rebuild: plan.rebuild,
    canRun: plan.canRun,
  };
}

function checkSettings(env: BqEntryEnv): string | null {
  if (env.settings.source !== 'bigquery') return 'The Search Console source is not BigQuery: switch it in Settings → Integrations → Search Console.';
  if (!env.projectId) return 'No BigQuery project: set up the BigQuery integration (service-account key and project ID) in Settings → Integrations.';
  if (!env.settings.property) return 'No Search Console property: type the exact site_url (sc-domain:example.com or the URL prefix).';
  return null;
}

/** A client for the plan's own target: settings changed after the plan was shown never reach the run. */
function clientFor(env: BqEntryEnv, target?: Pick<PullPlan, 'dataProject' | 'dataset' | 'siteUrl' | 'searchType'>): BqRunClient {
  return env.makeClient({
    billingProject: env.projectId,
    dataProject: target?.dataProject ?? (env.settings.bqDataProject || env.projectId),
    dataset: target?.dataset ?? env.settings.bqDataset,
    siteUrl: target?.siteUrl ?? env.settings.property,
    searchType: target?.searchType ?? env.settings.searchType,
  });
}

/**
 * Whether the source can be read (B181): the settings, then the dataset and its
 * export table. Reads metadata only: no query runs, nothing is billed.
 */
export async function gscBqCheckEntry(env: BqEntryEnv): Promise<GscBqCheckResult> {
  const problem = checkSettings(env);
  if (problem) return { ok: false, error: problem };
  try {
    await clientFor(env).preflight();
    return { ok: true, error: null };
  } catch (err) {
    return { ok: false, error: describeBqError(err) };
  }
}

/** What a pull would read and cost; writes nothing (a rebuild drops the saved data only in the run, see `dryReset`). */
export async function gscBqPlanEntry(env: BqEntryEnv, input: GscBqPlanInput): Promise<GscBqPlanResult> {
  const problem = checkSettings(env);
  if (problem) return fail(problem);
  if (env.slot.active) return fail('A BigQuery pull is running.');
  try {
    const plan = await buildBqPlan({
      client: clientFor(env),
      db: env.db,
      settings: env.settings,
      dataProject: env.settings.bqDataProject || env.projectId,
      ignoreLedger: input.dryReset === true,
    });
    env.slot.plan = plan;
    env.slot.planId = env.newPlanId();
    return { ok: true, error: null, plan: view(plan, env.slot.planId) };
  } catch (err) {
    env.slot.plan = null;
    return fail(describeBqError(err));
  }
}

/** Run the plan on screen. The plan is single-use: a new run needs a new plan. */
export async function gscBqRunEntry(env: BqEntryEnv, input: GscBqRunInput): Promise<GscBqRunResult> {
  const none = (error: string): GscBqRunResult => ({ ok: false, error, partsDone: 0, partsSkipped: 0, stopped: null, totalBilled: 0 });
  const problem = checkSettings(env);
  if (problem) return none(problem);
  const { slot } = env;
  if (slot.active) return none('A BigQuery pull is already running.');
  const plan = slot.plan;
  if (!plan || !input.planId || input.planId !== slot.planId) {
    return none('No plan on screen: open the BigQuery plan again before running.');
  }
  if (plan.needsReset) return none('The saved BigQuery data is for another property, dataset or search type: reset it first.');
  if (plan.overCap) return none('The estimate is above the byte cap: raise the cap or shorten the range.');
  if (plan.parts.length === 0) return none('Nothing to pull: every exported day in the range is already saved.');
  slot.plan = null;
  // A rebuild drops the saved data only here, with the cost known and inside the cap (checked above).
  if (plan.rebuild) {
    resetBigQuery(env.db);
    env.onChanged();
  }
  slot.active = true;
  slot.cancelRequested = false;
  const total = plan.parts.length;
  env.onProgress({ done: 0, total, running: true });
  try {
    const res = await runGscBigQuery(
      {
        client: clientFor(env, plan),
        db: env.db,
        now: env.now,
        isCancelled: () => slot.cancelRequested,
        onProgress: (p) => env.onProgress({ done: p.done, total, running: true }),
      },
      plan,
      { recordEmpty: input.recordEmpty === true },
    );
    return { ok: true, error: null, partsDone: res.partsDone, partsSkipped: res.partsSkipped, stopped: res.stopped, totalBilled: res.totalBilled };
  } catch (err) {
    return none(describeBqError(err));
  } finally {
    slot.active = false;
    slot.cancelRequested = false;
    env.onProgress({ done: 0, total, running: false });
    env.onChanged();
  }
}

export function gscBqCancelEntry(slot: BqSlot): void {
  if (slot.active) slot.cancelRequested = true;
}
