/**
 * Yandex Metrica API client, bound to the desktop app. The client itself
 * lives in packages/core `metrica.ts` (shared with the CLI); this binding
 * sends its requests through the integration dispatcher (`api-fetch.ts`)
 * and its diagnostics to the app log.
 */
import type { MetricaCounter } from '@freecrawl/shared-types';
import {
  listMetricaCounters,
  fetchMetricaPageMetrics,
  type MetricaDeps,
  type MetricaFetchOptions,
  type MetricaPageMetrics,
} from '@freecrawl/core';
import { apiFetch } from './api-fetch.js';
import * as logger from './logger.js';

export {
  MetricaError,
  MetricaCancelledError,
  type MetricaPageRow,
  type MetricaFetchProgress,
  type MetricaFetchOptions,
  type MetricaPageMetrics,
} from '@freecrawl/core';

const deps: Required<MetricaDeps> = {
  fetch: apiFetch,
  log: (level, message) => logger.log(level, 'metrica', message),
};

/** Every counter the token can read. */
export function listCounters(token: string): Promise<MetricaCounter[]> {
  return listMetricaCounters(token, deps);
}

/** Per-page metrics for the `days` full days ending yesterday; see core. */
export function fetchPageMetrics(
  token: string,
  counterId: string,
  days: number,
  normalize: (url: string) => string | null,
  opts: Pick<MetricaFetchOptions, 'signal' | 'onProgress'> = {},
): Promise<MetricaPageMetrics> {
  return fetchMetricaPageMetrics(token, counterId, days, normalize, { ...opts, ...deps });
}
