/**
 * URL Inspection runner (B38). Electron-free: the IPC handler in index.ts only wires
 * `inspect`, the project database and the cancel flag into it.
 *
 * Quota is 2 000 calls a day and 600 a minute per property. A page inspected in the last
 * 24 hours (same account, `ok`, B38 data stored) is skipped unless `force`; a quota,
 * sign-in or access error stops the run instead of writing an error row per remaining URL.
 */
import type { GscInspectionResult, GscInspectProgress, GscInspectRunResult } from '@freecrawl/shared-types';
import { GoogleAuthError, GooglePermissionError, GoogleQuotaError } from './google-retry.js';
import type { GscInspectionRaw } from './gsc.js';

const FRESH_MS = 24 * 3_600_000;

export interface InspectionState {
  status: 'ok' | 'error';
  fetchedAt: string;
  sitemapsStored: boolean;
}

export interface InspectRunDb {
  gscInspectionStates(urls: string[], accountId: string): Map<string, InspectionState>;
  upsertGscInspection(url: string, result: GscInspectionResult, accountId: string): void;
}

/** The one rule for «inspected recently enough»: the runner and the confirm dialog both use it. */
export function isInspectionFresh(state: InspectionState | undefined, nowMs: number): boolean {
  if (!state || state.status !== 'ok' || !state.sitemapsStored) return false;
  const at = Date.parse(state.fetchedAt);
  return !Number.isNaN(at) && nowMs - at < FRESH_MS;
}

export function planInspection(
  db: Pick<InspectRunDb, 'gscInspectionStates'>,
  urls: string[],
  accountId: string,
  force: boolean,
  nowMs: number,
): { toInspect: string[]; skipped: string[] } {
  if (force) return { toInspect: urls, skipped: [] };
  const states = db.gscInspectionStates(urls, accountId);
  const toInspect: string[] = [];
  const skipped: string[] = [];
  for (const url of urls) (isInspectionFresh(states.get(url), nowMs) ? skipped : toInspect).push(url);
  return { toInspect, skipped };
}

/** The distinct non-empty URL strings of an IPC input. */
export function uniqueInspectUrls(urls: unknown): string[] {
  return Array.from(
    new Set((Array.isArray(urls) ? urls : []).filter((u): u is string => typeof u === 'string' && u.length > 0)),
  );
}

export interface InspectRunDeps {
  inspect: (property: string, url: string, accountId: string) => Promise<GscInspectionRaw>;
  db: InspectRunDb;
  now: () => number;
  isCancelled: () => boolean;
  onProgress?: (p: GscInspectProgress) => void;
}

export async function runGscInspection(
  input: { property: string; urls: string[]; accountId: string; force?: boolean },
  deps: InspectRunDeps,
): Promise<GscInspectRunResult> {
  const { toInspect, skipped } = planInspection(
    deps.db,
    input.urls,
    input.accountId,
    input.force === true,
    deps.now(),
  );
  let completed = 0;
  let failed = 0;
  let done = 0;
  let quotaExhausted = false;
  let stopMessage: string | null = null;
  let cancelled = false;
  deps.onProgress?.({ done: 0, total: toInspect.length, currentUrl: null, running: true });
  for (const url of toInspect) {
    if (deps.isCancelled()) {
      cancelled = true;
      break;
    }
    deps.onProgress?.({ done, total: toInspect.length, currentUrl: url, running: true });
    const fetchedAt = new Date(deps.now()).toISOString();
    try {
      const raw = await deps.inspect(input.property, url, input.accountId);
      deps.db.upsertGscInspection(url, { ...raw, status: 'ok', error: null, fetchedAt }, input.accountId);
      completed++;
    } catch (err) {
      if (err instanceof GoogleQuotaError) {
        quotaExhausted = true;
        break;
      }
      if (err instanceof GoogleAuthError || err instanceof GooglePermissionError) {
        stopMessage = err.message;
        break;
      }
      deps.db.upsertGscInspection(
        url,
        {
          verdict: null,
          coverageState: null,
          robotsTxtState: null,
          indexingState: null,
          lastCrawlTime: null,
          googleCanonical: null,
          userCanonical: null,
          mobileVerdict: null,
          ampVerdict: null,
          richResultsVerdict: null,
          pageFetchState: null,
          crawledAs: null,
          sitemaps: null,
          referringUrls: null,
          referringCount: null,
          richResults: null,
          status: 'error',
          error: err instanceof Error ? err.message : String(err),
          fetchedAt,
        },
        input.accountId,
      );
      failed++;
    }
    done++;
  }
  deps.onProgress?.({ done, total: toInspect.length, currentUrl: null, running: false });
  return {
    completed,
    failed,
    cancelled,
    inspected: completed + failed,
    skipped: skipped.length,
    remaining: toInspect.length - done,
    quotaExhausted,
    stopMessage,
  };
}
