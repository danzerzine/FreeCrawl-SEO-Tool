/**
 * GA4 pull, shared by the desktop's `ga4:fetch` IPC handler and the bridge's `ga4-fetch` action
 * so the two cannot drift. Everything outside (database, Google, clock, settings) comes in through
 * the arguments, which is also what the tests use. It still loads `electron` indirectly (`./ga4.js` →
 * `google-oauth.js`, for the default Google deps), so a test mocks `electron`; a Node-only caller cannot load it.
 *
 * The five fixed metrics are one report as before. The custom fields the user chose follow:
 * all chosen metrics in one request, then one request per dimension, each with `sessions`.
 * A pull that Google's quota cuts short keeps what it has finished (project_meta
 * `ga4CustomRun:<account>`); the next pull of the same property and date range sends only the rest.
 */
import {
  GA4_MAX_CUSTOM_DIMENSIONS,
  GA4_MAX_CUSTOM_METRICS,
  googleMetaKey,
  type Ga4CustomFieldStatus,
  type Ga4FetchInput,
  type Ga4FetchMeta,
  type Ga4FetchResult,
  type Ga4IntegrationSettings,
} from '@freecrawl/shared-types';
import type { ProjectDb } from '@freecrawl/db';
import {
  Ga4BadRequestError,
  getMetadata,
  runCustomReport,
  runReportWithQuota,
  type Ga4Quota,
} from './ga4.js';
import {
  GoogleAuthError,
  GooglePermissionError,
  GoogleQuotaError,
  type GoogleDeps,
} from './google-retry.js';
import * as logger from './logger.js';

/** Stop asking when any of Google's token buckets is below this. */
const LOW_QUOTA = 5000;

export { googleMetaKey };

export interface Ga4PullInput {
  property: string;
  propertyName: string;
  startDate: string;
  endDate: string;
  accountId: string;
  customMetrics: string[];
  customDimensions: string[];
}

export interface Ga4PullDeps {
  db: ProjectDb;
  /** Absent: the real Google client. */
  google?: GoogleDeps;
  now: () => Date;
}

interface RunRecord {
  property: string;
  startDate: string;
  endDate: string;
  done: string[];
  /** The account's older custom rows are already gone (first answer of this pull came in). */
  wiped: boolean;
}

const lowQuota = (q: Ga4Quota): boolean =>
  [q.tokensPerDay, q.tokensPerHour, q.tokensPerProjectPerHour].some(
    (v) => typeof v === 'number' && v < LOW_QUOTA,
  );

function readRecord(db: ProjectDb, key: string, input: Ga4PullInput): RunRecord | null {
  const raw = db.getMeta(key);
  if (!raw) return null;
  try {
    const r = JSON.parse(raw) as RunRecord;
    if (
      r.property === input.property &&
      r.startDate === input.startDate &&
      r.endDate === input.endDate
    ) {
      return { ...r, done: Array.isArray(r.done) ? r.done : [], wiped: r.wiped === true };
    }
  } catch {
    /* unreadable record: start again */
  }
  return null;
}

export async function pullGa4(
  input: Ga4PullInput,
  deps: Ga4PullDeps,
): Promise<{ rowCount: number; meta: Ga4FetchMeta }> {
  const { db, google } = deps;
  const account = input.accountId;
  const metrics = input.customMetrics.slice(0, GA4_MAX_CUSTOM_METRICS);
  const dimensions = input.customDimensions.slice(0, GA4_MAX_CUSTOM_DIMENSIONS);
  const chosen = [...metrics, ...dimensions];

  const first = await runReportWithQuota(input.property, input.startDate, input.endDate, account, google);
  const rows = first.rows;
  const fetchedAt = deps.now().toISOString();
  db.replaceGa4Results(rows, fetchedAt, account);

  const runKey = googleMetaKey('ga4CustomRun', account);
  const record: RunRecord = readRecord(db, runKey, input) ?? {
    property: input.property,
    startDate: input.startDate,
    endDate: input.endDate,
    done: [],
    wiped: false,
  };
  record.done = record.done.filter((f) => chosen.includes(f));
  db.deleteGa4CustomFieldsExcept(account, chosen);

  const failed = new Map<string, string>();
  // The five-metric report already says how much quota is left: the first optional request is guarded too.
  let quota: Ga4Quota = first.quota;
  let stopped: string | null = null;
  let stopKind: 'quota' | 'error' | null = null;
  let fatal: Error | null = null;

  const store = (
    fieldsOfRequest: string[],
    list: { url: string; field: string; value: string; sessions: number | null }[],
  ): void => {
    db.storeGa4CustomValues({
      accountId: account,
      property: input.property,
      fetchedAt,
      fields: fieldsOfRequest,
      rows: list,
      wipeAll: !record.wiped,
    });
    record.wiped = true;
    for (const f of fieldsOfRequest) if (!record.done.includes(f)) record.done.push(f);
    db.setMeta(runKey, JSON.stringify(record));
  };
  const guard = (): boolean => {
    if (lowQuota(quota)) {
      stopped = "Google's quota for this property is nearly used up";
      stopKind = 'quota';
      return false;
    }
    return true;
  };

  const pending = (list: string[]): string[] => list.filter((f) => !record.done.includes(f));

  const pullMetrics = async (list: string[]): Promise<boolean> => {
    if (!guard()) return false;
    const res = await runCustomReport(
      input.property,
      {
        startDate: input.startDate,
        endDate: input.endDate,
        dimensions: ['pageLocation'],
        metrics: list,
      },
      account,
      google,
    );
    quota = res.quota;
    store(
      list,
      res.rows.flatMap((r) =>
        list.map((field, i) => ({
          url: r.dims[0]!,
          field,
          value: r.metrics[i] ?? '',
          sessions: null,
        })),
      ),
    );
    return true;
  };

  const pullMetricsEach = async (list: string[]): Promise<void> => {
    for (const m of list) {
      try {
        if (!(await pullMetrics([m]))) return;
      } catch (err) {
        if (!(err instanceof Ga4BadRequestError)) throw err;
        failed.set(m, err.message);
      }
    }
  };

  const customPhase = async (): Promise<void> => {
    const todoMetrics = pending(metrics);
    if (todoMetrics.length > 0) {
      try {
        await pullMetrics(todoMetrics);
      } catch (err) {
        if (!(err instanceof Ga4BadRequestError)) throw err;
        // A field may have been removed from the property: ask again, drop what is gone.
        let known: Set<string> | null = null;
        try {
          known = new Set(
            (await getMetadata(input.property, account, google, { refresh: true })).map(
              (f) => f.apiName,
            ),
          );
        } catch (e2) {
          if (
            e2 instanceof GoogleAuthError ||
            e2 instanceof GooglePermissionError ||
            e2 instanceof GoogleQuotaError
          )
            throw e2;
        }
        const gone = known ? todoMetrics.filter((m) => !known.has(m)) : [];
        for (const m of gone) failed.set(m, `${m} not found in the property`);
        const rest = todoMetrics.filter((m) => !gone.includes(m));
        if (gone.length > 0 && rest.length > 0) {
          try {
            await pullMetrics(rest);
          } catch (e3) {
            if (!(e3 instanceof Ga4BadRequestError)) throw e3;
            await pullMetricsEach(rest);
          }
        } else if (rest.length > 0) {
          // Metadata dropped nothing: an identical request would fail the same way.
          await pullMetricsEach(rest);
        }
      }
    }
    for (const d of pending(dimensions)) {
      if (stopped) break;
      if (!guard()) break;
      try {
        const res = await runCustomReport(
          input.property,
          {
            startDate: input.startDate,
            endDate: input.endDate,
            dimensions: ['pageLocation', d],
            metrics: ['sessions'],
          },
          account,
          google,
        );
        quota = res.quota;
        store(
          [d],
          res.rows
            .filter((r) => r.dims[1])
            .map((r) => ({
              url: r.dims[0]!,
              field: d,
              value: r.dims[1]!,
              sessions: Number(r.metrics[0]) || 0,
            })),
        );
      } catch (err) {
        if (!(err instanceof Ga4BadRequestError)) throw err;
        failed.set(d, err.message);
      }
    }
  };

  let errorText: string | null = null;
  if (chosen.length > 0) {
    try {
      await customPhase();
    } catch (err) {
      if (err instanceof GoogleQuotaError) {
        stopped = "Google's quota for this property is used up";
        stopKind = 'quota';
      } else if (err instanceof GoogleAuthError || err instanceof GooglePermissionError) {
        fatal = err;
        errorText = err.message;
      } else {
        stopped = 'a request failed';
        errorText = err instanceof Error ? err.message : String(err);
      }
    }
  }

  const stoppedEarly = stopped !== null || fatal !== null;
  if (!record.wiped && !stoppedEarly) {
    // Nothing came back for any field (all refused): older values must not stay next to the new range.
    db.wipeGa4CustomValues(account);
    record.wiped = true;
  }
  const counts = db.ga4CustomFieldRowCounts(account);
  const notPulled = chosen.filter((f) => !record.done.includes(f) && !failed.has(f));
  const customFields = chosen.map((field): Ga4CustomFieldStatus => {
    const kind = metrics.includes(field) ? 'metric' : 'dimension';
    if (record.done.includes(field)) return { field, kind, rows: counts[field] ?? 0, ok: true };
    return {
      field,
      kind,
      rows: 0,
      ok: false,
      error: failed.get(field) ?? `not pulled: ${errorText ?? stopped ?? 'stopped early'}`,
    };
  });
  let customMessage: string | null = null;
  if (notPulled.length > 0) {
    customMessage =
      `${stopped ?? errorText ?? 'The pull stopped'}, so these fields were not pulled: ${notPulled.join(', ')}. ` +
      'Fetch again later today to pull only these; from tomorrow the date range moves and the pull starts again.';
  }
  if (chosen.length === 0 || (!stoppedEarly && notPulled.length === 0)) db.setMeta(runKey, '');
  else db.setMeta(runKey, JSON.stringify(record));

  const meta: Ga4FetchMeta = {
    property: input.property,
    propertyName: input.propertyName || input.property,
    startDate: input.startDate,
    endDate: input.endDate,
    fetchedAt,
    rowCount: rows.length,
    customFields,
    customMessage,
    customNotPulled: notPulled,
    customStop: notPulled.length === 0 ? null : (stopKind ?? 'error'),
    customStopDetail: notPulled.length === 0 ? null : errorText,
    unmatchedUrls: db.ga4UnmatchedUrlCount(account, input.property),
  };
  db.setMeta(googleMetaKey('ga4FetchMeta', account), JSON.stringify(meta));
  if (fatal) throw fatal;
  logger.log(
    'info',
    'ga4',
    `GA4 pull stored: ${rows.length} page row(s), ${customFields.filter((f) => f.ok).length}/${chosen.length} custom field(s)`,
  );
  return { rowCount: rows.length, meta };
}

/** What the two entry points need from the app around them. */
export interface Ga4EntryEnv {
  db: ProjectDb;
  google?: GoogleDeps;
  now: () => Date;
  resolveAccount: (requested?: string) => string;
  readSettings: () => Ga4IntegrationSettings;
  writeSettings: (patch: Partial<Ga4IntegrationSettings>) => void;
  onChanged: () => void;
}

async function runEntry(
  input: Ga4FetchInput,
  days: number,
  env: Ga4EntryEnv,
  save: boolean,
): Promise<Ga4FetchResult> {
  // GA4 data is near-realtime: the range ends at today.
  const isoDate = (d: Date): string => d.toISOString().slice(0, 10);
  const end = env.now();
  const start = new Date(end.getTime() - (days - 1) * 86_400_000);
  const accountId = env.resolveAccount(input.accountId);
  if (save) {
    env.writeSettings({
      accountId,
      property: input.property,
      propertyName: input.propertyName || input.property,
      days: input.days,
    });
  }
  const settings = env.readSettings();
  try {
    const r = await pullGa4(
      {
        property: input.property,
        propertyName: input.propertyName,
        startDate: isoDate(start),
        endDate: isoDate(end),
        accountId,
        customMetrics: settings.customMetrics,
        customDimensions: settings.customDimensions,
      },
      { db: env.db, google: env.google, now: env.now },
    );
    env.onChanged();
    return { ok: true, error: null, rowCount: r.rowCount, meta: r.meta };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      rowCount: 0,
      meta: null,
    };
  }
}

/** The desktop's `ga4:fetch` handler. */
export function ga4FetchFromDesktop(
  input: Ga4FetchInput,
  env: Ga4EntryEnv,
): Promise<Ga4FetchResult> {
  if (!input.property) {
    return Promise.resolve({
      ok: false,
      error: 'No GA4 property selected.',
      rowCount: 0,
      meta: null,
    });
  }
  return runEntry(input, input.days, env, true);
}

/** The bridge's `ga4-fetch` action: days default to 28, nothing is saved to the settings. */
export function ga4FetchFromBridge(
  input: Ga4FetchInput,
  env: Ga4EntryEnv,
): Promise<Ga4FetchResult> {
  if (!input.property) {
    return Promise.resolve({
      ok: false,
      error: 'property is required (e.g. "properties/123456").',
      rowCount: 0,
      meta: null,
    });
  }
  return runEntry(input, input.days ?? 28, env, false);
}
