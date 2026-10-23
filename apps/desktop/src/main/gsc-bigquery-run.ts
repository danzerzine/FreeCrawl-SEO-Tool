/**
 * Plan and run a pull from the Search Console bulk export in BigQuery (B91).
 *
 * `buildBqPlan` shows what a pull would do (parts, days covered and missing, bytes the dry runs
 * report, the cap) without running anything billed beyond the small ExportLog query.
 * `runGscBigQuery` runs the planned parts one by one: the part is the unit of "saved on arrival" -
 * its rows are merged into the `'bq'` rows of `gsc_results` and its range is appended to the run
 * ledger (meta `gscBqRun`) in ONE transaction. A restart reads the ledger, skips done ranges and
 * first looks up the job that was in flight (written to the ledger BEFORE `jobs.insert`).
 *
 * Electron-free; the client, the db, the clock and the cancel flag are injected, like gsc-inspect-run.
 */
import type { ProjectDb } from '@freecrawl/db';
import { GSC_BQ_ACCOUNT, type GscFetchMeta, type GscIntegrationSettings, type GscSearchType } from '@freecrawl/shared-types';
import {
  MIN_BILLED_BYTES,
  bqSourceKey,
  bytesCeiling,
  daysOf,
  describeBqError,
  emptyLedger,
  planParts,
  resolveBqRange,
  BqError,
  type BqUrlRow,
  type DoneRange,
  type GscBqLedger,
  type JobStatus,
  type Part,
} from './gsc-bigquery.js';

export const BQ_LEDGER_META_KEY = 'gscBqRun';
export const BQ_FETCH_META_KEY = `gscFetchMeta:${GSC_BQ_ACCOUNT}`;
const FREE_TIER_BYTES = 1024 ** 4;

/** What the runner needs from the BigQuery client (the real one, or a fake in tests). */
export interface BqRunClient {
  estimate(part: { start: string; end: string }): Promise<number>;
  runPart(part: { start: string; end: string }, opts: { jobId: string; maxBytesBilled: number }): Promise<{ rows: BqUrlRow[]; bytesBilled: number }>;
  finishPart(jobId: string): Promise<{ rows: BqUrlRow[]; bytesBilled: number }>;
  jobStatus(jobId: string): Promise<JobStatus>;
  diagnose(
    part: { start: string; end: string },
    opts: { jobId: string; maxBytesBilled: number },
  ): Promise<{ siteUrls: string[]; searchTypes: string[]; bytesBilled: number }>;
  preflight(): Promise<{ location: string }>;
  setLocation(location: string): void;
  exportCoverage(location?: string): Promise<Map<string, number>>;
}

export interface PlannedPart extends Part {
  /** Bytes the dry run says the part reads. */
  estimate: number;
}

export interface PullPlan {
  sourceKey: string;
  location: string;
  siteUrl: string;
  searchType: GscSearchType;
  range: { start: string; end: string } | null;
  parts: PlannedPart[];
  coveredDays: number;
  missingDays: number;
  revisedDays: string[];
  firstCovered: string | null;
  lastCovered: string | null;
  totalEstimate: number;
  /** Share of the free 1 TB a month per project that the estimate uses. */
  freeTierShare: number;
  capBytes: number;
  /** Bytes billed since the last reset (the ledger's total): shown, never compared with the cap. */
  billedSoFar: number;
  overCap: boolean;
  /** The saved data came from another property, dataset or search type: reset before pulling. */
  needsReset: boolean;
  canRun: boolean;
  /** `epoch_version` per covered day, kept for the ledger. */
  coverage: Map<string, number>;
}

export function readLedger(db: ProjectDb): GscBqLedger | null {
  const raw = db.getMeta(BQ_LEDGER_META_KEY);
  if (!raw) return null;
  try {
    const l = JSON.parse(raw) as GscBqLedger;
    return l && l.v === 1 && Array.isArray(l.doneRanges) ? l : null;
  } catch {
    return null;
  }
}

/** Rebuild: drops the `'bq'` rows and the ledger; other accounts' rows stay. */
export function resetBigQuery(db: ProjectDb): void {
  db.deleteGscResults(GSC_BQ_ACCOUNT, [BQ_LEDGER_META_KEY, BQ_FETCH_META_KEY]);
}

export function capBytesOf(settings: Pick<GscIntegrationSettings, 'bqMaxGiB'>): number {
  return Math.floor(settings.bqMaxGiB * 1024 ** 3);
}

/** Preflight, coverage, plan and one dry run per part. */
export async function buildBqPlan(args: {
  client: BqRunClient;
  db: ProjectDb;
  settings: GscIntegrationSettings;
  /** The data project in effect (the setting, or the BigQuery integration's project). */
  dataProject: string;
}): Promise<PullPlan> {
  const { client, db, settings } = args;
  if (!settings.property) throw new BqError('other', 'No Search Console property is set: type the exact site_url (sc-domain:example.com or the URL prefix).');
  const { location } = await client.preflight();
  const coverage = await client.exportCoverage(location);
  const sourceKey = bqSourceKey(args.dataProject, settings.bqDataset, settings.property, settings.searchType);
  const ledger = readLedger(db);
  // Nothing recorded under another key (an empty run with a wrong type) changes key freely.
  const needsReset = ledger !== null && ledger.sourceKey !== sourceKey && ledger.doneRanges.length > 0;
  const range = resolveBqRange(settings, coverage);
  const found = range
    ? planParts(range, needsReset ? null : ledger, coverage)
    : { parts: [], coveredDays: 0, missingDays: 0, revisedDays: [], firstCovered: null, lastCovered: null };
  const parts: PlannedPart[] = [];
  for (const p of found.parts) parts.push({ ...p, estimate: await client.estimate(p) });
  const totalEstimate = parts.reduce((a, p) => a + p.estimate, 0);
  const capBytes = capBytesOf(settings);
  const billedSoFar = ledger?.totalBilled ?? 0;
  // The cap is for one pull (the setting says so): earlier pulls' bytes do not count against it.
  const overCap = totalEstimate > capBytes;
  return {
    sourceKey,
    location,
    siteUrl: settings.property,
    searchType: settings.searchType,
    range,
    parts,
    coveredDays: found.coveredDays,
    missingDays: found.missingDays,
    revisedDays: found.revisedDays,
    firstCovered: found.firstCovered,
    lastCovered: found.lastCovered,
    totalEstimate,
    freeTierShare: totalEstimate / FREE_TIER_BYTES,
    capBytes,
    billedSoFar,
    overCap,
    needsReset,
    canRun: !needsReset && !overCap && parts.length > 0,
    coverage,
  };
}

export interface RunDeps {
  client: BqRunClient;
  db: ProjectDb;
  now: () => Date;
  isCancelled: () => boolean;
  random?: () => number;
  onProgress?: (p: { done: number; total: number; part: Part | null }) => void;
}

export type StopReason = 'cap' | 'cancelled' | 'error' | 'empty' | 'source-changed';
export interface RunResult {
  partsDone: number;
  partsSkipped: number;
  stopped: null | { reason: StopReason; message: string };
  totalBilled: number;
}

function fetchMeta(ledger: GscBqLedger, siteUrl: string, rowCount: number, fetchedAt: string): GscFetchMeta {
  const ranges = [...ledger.doneRanges].sort((a, b) => (a.start < b.start ? -1 : 1));
  const start = ranges[0]?.start ?? '';
  const end = ranges.reduce((m, r) => (r.end > m ? r.end : m), '');
  const done = new Set(ranges.flatMap((r) => daysOf(r.start, r.end)));
  const gapDays = start && end ? daysOf(start, end).filter((d) => !done.has(d)).length : 0;
  return { property: siteUrl, startDate: start, endDate: end, fetchedAt, rowCount, source: 'bigquery', bytesBilled: ledger.totalBilled, gapDays };
}

const ids = (random: () => number) => Math.floor(random() * 36 ** 6).toString(36).padStart(6, '0');

export async function runGscBigQuery(deps: RunDeps, plan: PullPlan, opts: { recordEmpty?: boolean }): Promise<RunResult> {
  const { client, db } = deps;
  const random = deps.random ?? Math.random;
  client.setLocation(plan.location);
  let ledger = readLedger(db) ?? emptyLedger(plan.sourceKey, plan.location);
  const result: RunResult = { partsDone: 0, partsSkipped: 0, stopped: null, totalBilled: ledger.totalBilled };
  /** Bytes billed by THIS run: what the cap is compared with (the ledger total is for display). */
  let runBilled = 0;
  const stop = (reason: StopReason, message: string): RunResult => {
    result.stopped = { reason, message };
    result.totalBilled = ledger.totalBilled;
    return result;
  };

  /** The ledger held no data under the old key: the new key is taken over, but a job in flight belongs to the old one. */
  let adopting = false;
  if (ledger.sourceKey !== plan.sourceKey) {
    if (ledger.doneRanges.length > 0) {
      return stop('source-changed', 'The saved BigQuery data is for another property, dataset or search type: reset it before pulling.');
    }
    adopting = true;
    ledger = { ...ledger, sourceKey: plan.sourceKey, location: plan.location };
  }
  ledger = { ...ledger, location: plan.location };
  const save = (l: GscBqLedger) => {
    ledger = l;
    db.setMeta(BQ_LEDGER_META_KEY, JSON.stringify(l));
  };

  /** Merge one finished part with its ledger entry in one transaction. */
  const record = (part: Part, rows: BqUrlRow[], billed: number): void => {
    const at = deps.now().toISOString();
    const range: DoneRange = {
      start: part.start,
      end: part.end,
      rows: rows.length,
      bytesBilled: billed,
      epochs: daysOf(part.start, part.end).map((d) => plan.coverage.get(d) ?? 0),
      at,
    };
    const have = new Set(ledger.doneRanges.flatMap((r) => daysOf(r.start, r.end)));
    if (daysOf(part.start, part.end).some((d) => have.has(d))) {
      throw new BqError('other', `The range ${part.start}..${part.end} overlaps days already in the ledger: not merged twice.`);
    }
    runBilled += billed;
    const next: GscBqLedger = { ...ledger, doneRanges: [...ledger.doneRanges, range], totalBilled: ledger.totalBilled + billed, inFlight: null };
    db.mergeGscResultsPart(GSC_BQ_ACCOUNT, rows, at, (count) => ({
      [BQ_LEDGER_META_KEY]: JSON.stringify(next),
      [BQ_FETCH_META_KEY]: JSON.stringify(fetchMeta(next, plan.siteUrl, count, at)),
    }));
    ledger = next;
    result.partsDone++;
    deps.onProgress?.({ done: result.partsDone, total: plan.parts.length, part });
  };

  /** An empty answer for days the export lists: stop and say what the export holds, unless the user ticked it. */
  const emptyStop = async (part: PlannedPart, billed: number): Promise<RunResult> => {
    runBilled += billed;
    ledger = { ...ledger, totalBilled: ledger.totalBilled + billed, inFlight: null };
    save(ledger);
    const jobId = `fcgsc-${plan.sourceKey.slice(0, 8)}-diag-${part.start}-${part.end}-${ids(random)}`;
    const max = bytesCeiling(part.estimate, plan.capBytes, runBilled);
    let what = '';
    if (max !== null) {
      try {
        const d = await client.diagnose(part, { jobId, maxBytesBilled: max });
        runBilled += d.bytesBilled;
        save({ ...ledger, totalBilled: ledger.totalBilled + d.bytesBilled });
        what = ` the export has: ${d.siteUrls.join(', ') || '(nothing)'} / ${d.searchTypes.join(', ') || '(nothing)'}.`;
      } catch (err) {
        what = ` (could not list what the export holds: ${describeBqError(err)})`;
      }
    }
    return stop(
      'empty',
      `No rows for this property and search type;${what} Fix the property or the search type, or tick "record empty months".`,
    );
  };

  // 1. A job left in flight by a run that ended before it could merge: look it up by id first.
  if (ledger.inFlight) {
    const fl = ledger.inFlight;
    try {
      const st = await client.jobStatus(fl.jobId);
      if (st.state === 'gone') {
        save({ ...ledger, inFlight: null });
      } else if (st.state === 'failed') {
        runBilled += st.billed;
        save({ ...ledger, totalBilled: ledger.totalBilled + st.billed, inFlight: null });
      } else {
        const out = await client.finishPart(fl.jobId);
        const part: PlannedPart = { start: fl.start, end: fl.end, days: daysOf(fl.start, fl.end).length, estimate: 0 };
        const covered = new Set(ledger.doneRanges.flatMap((r) => daysOf(r.start, r.end)));
        if (adopting || daysOf(fl.start, fl.end).some((d) => covered.has(d))) {
          // Billed either way; the rows are not stored (another source's data, or days already merged).
          runBilled += out.bytesBilled;
          save({ ...ledger, totalBilled: ledger.totalBilled + out.bytesBilled, inFlight: null });
        } else if (out.rows.length === 0 && !opts.recordEmpty) {
          return await emptyStop(part, out.bytesBilled);
        } else {
          record(part, out.rows, out.bytesBilled);
        }
      }
    } catch (err) {
      return stop('error', describeBqError(err));
    }
  }

  // 2. The planned parts, in order, each cut to the days not in the ledger (the in-flight job above, or an
  //    earlier run, may have taken some) and re-estimated when it shrank.
  const done = new Set(ledger.doneRanges.flatMap((r) => daysOf(r.start, r.end)));
  const todo: PlannedPart[] = [];
  try {
    for (const part of plan.parts) {
      const left = daysOf(part.start, part.end).filter((d) => !done.has(d));
      if (left.length === 0) {
        result.partsSkipped++;
        continue;
      }
      if (left.length === part.days) {
        todo.push(part);
        continue;
      }
      let from = 0;
      for (let i = 1; i <= left.length; i++) {
        const contiguous = i < left.length && Date.parse(left[i]!) - Date.parse(left[i - 1]!) === 86_400_000;
        if (contiguous) continue;
        const piece = { start: left[from]!, end: left[i - 1]!, days: i - from };
        todo.push({ ...piece, estimate: await client.estimate(piece) });
        from = i;
      }
    }
  } catch (err) {
    return stop('error', describeBqError(err));
  }
  for (const part of todo) {
    if (deps.isCancelled()) return stop('cancelled', 'Cancelled; the finished parts stay saved.');
    const max = bytesCeiling(part.estimate, plan.capBytes, runBilled);
    if (max === null) {
      return stop('cap', 'Stopped before the next part: it would pass the byte cap. Raise the cap or shorten the range.');
    }
    const jobId = `fcgsc-${plan.sourceKey.slice(0, 8)}-${part.start}-${part.end}-${ids(random)}`;
    save({ ...ledger, inFlight: { jobId, start: part.start, end: part.end, at: deps.now().toISOString() } });
    let out: { rows: BqUrlRow[]; bytesBilled: number };
    try {
      out = await client.runPart(part, { jobId, maxBytesBilled: Math.max(max, MIN_BILLED_BYTES) });
    } catch (err) {
      // The job failed before it read anything (limit hit: not billed) or its fate is unknown;
      // only the first is certain enough to forget. Otherwise inFlight stays for the next start.
      if (err instanceof BqError && err.kind === 'bytes-limit') save({ ...ledger, inFlight: null });
      return stop('error', describeBqError(err));
    }
    if (out.rows.length === 0 && !opts.recordEmpty) {
      return await emptyStop(part, out.bytesBilled);
    }
    record(part, out.rows, out.bytesBilled);
  }
  result.totalBilled = ledger.totalBilled;
  return result;
}
