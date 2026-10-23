/**
 * Which Search Console rows the project reads (B91).
 *
 * With `source = 'bigquery'` the rows live under the account `'bq'` in `gsc_results`, whether or not
 * a Google OAuth account is linked; with `source = 'api'` the account is the linked OAuth account as
 * before. `gscReadAccount` is the ONLY way a gsc reader picks its account (a source-text test fails
 * when `resolveGoogleAccount('gsc'` shows up elsewhere, except at the named API-only sites in index.ts).
 *
 * Electron-free: the OAuth resolution comes in as a function, so the readers run under test.
 */
import type { ProjectDb } from '@freecrawl/db';
import { googleMetaKey } from './ga4-pull.js';
import {
  GSC_BQ_ACCOUNT,
  type GscFetchMeta,
  type GscIntegrationSettings,
  type GscQueryInput,
  type GscQueryResult,
} from '@freecrawl/shared-types';

export interface GscReadEnv {
  settings: GscIntegrationSettings;
  /** The OAuth-account resolution of the app (`resolveGoogleAccount`). */
  resolveGoogleAccount: (integrationId: 'gsc', requested?: string) => string;
}

/** The account whose `gsc_results` rows every reader shows. */
export function gscReadAccount(env: GscReadEnv, requested?: string): string {
  if (env.settings.source === 'bigquery') return GSC_BQ_ACCOUNT;
  return env.resolveGoogleAccount('gsc', requested);
}


/** The Search Console tab's `gscQuery`: rows joined to the crawl, plus the context line's meta. */
export async function gscTabQuery(
  env: GscReadEnv & {
    queryGsc: (params: {
      limit: number;
      offset: number;
      search?: string;
      filter?: GscQueryInput['filter'];
      accountId: string;
      matchSlash: boolean;
      matchCase: boolean;
    }) => Promise<{ rows: GscQueryResult['rows']; total: number }>;
    getMeta: (key: string) => string | null;
  },
  input: GscQueryInput,
): Promise<GscQueryResult> {
  const accountId = gscReadAccount(env, input.accountId);
  const result = await env.queryGsc({
    limit: input.limit,
    offset: input.offset,
    search: input.search,
    filter: input.filter,
    accountId,
    matchSlash: env.settings.matchSlash,
    matchCase: env.settings.matchCase,
  });
  let meta: GscFetchMeta | null = null;
  try {
    const raw = env.getMeta(googleMetaKey('gscFetchMeta', accountId));
    if (raw) meta = JSON.parse(raw) as GscFetchMeta;
  } catch {
    /* no / corrupt meta: render without the context line */
  }
  return { rows: result.rows, total: result.total, meta };
}

/** The Search Console part of the dataset-export context. */
export function gscExportContext(env: GscReadEnv): {
  gscAccountId: string;
  gscMatchSlash: boolean;
  gscMatchCase: boolean;
} {
  return {
    gscAccountId: gscReadAccount(env),
    gscMatchSlash: env.settings.matchSlash,
    gscMatchCase: env.settings.matchCase,
  };
}

/** Pulled GSC URLs the crawl has not seen: the candidates of «Crawl New URLs Discovered In Google Search Console». */
export function gscCrawlNewUrlCandidates(env: GscReadEnv, db: ProjectDb): string[] {
  return db.gscOrphanUrls({
    matchSlash: env.settings.matchSlash,
    matchCase: env.settings.matchCase,
    accountId: gscReadAccount(env),
  });
}
