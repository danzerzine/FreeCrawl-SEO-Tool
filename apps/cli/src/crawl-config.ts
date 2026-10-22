import { DEFAULT_CRAWL_CONFIG, type CrawlConfig } from '@freecrawl/shared-types';

/** Where the crawl starts, from the command line: a positional URL or a `--list` file. */
export interface CommandLineStart {
  url?: string;
  listUrls?: string[];
}

export type MergedCrawlConfig =
  | { kind: 'ok'; config: CrawlConfig; listMode: boolean; notes: string[] }
  /** Bad input: print the message, exit 2. */
  | { kind: 'error'; message: string }
  /** No start URL or list anywhere: print the help, exit 1. */
  | { kind: 'usage' };

/** Key-value maps a layer replaces whole: `--header` replaces the file's headers. */
const REPLACED_WHOLE = new Set<string>(['customHeaders']);

/**
 * Layered crawl config: defaults ← `--config` file ← command-line flags.
 * Plain objects merge key by key (a file that sets `formLogin.enabled`
 * keeps the other login fields); arrays, scalars and the maps in
 * `REPLACED_WHOLE` replace. The file's start URL or list is used when the
 * command line gives neither.
 */
export function mergeCrawlConfig(
  fileConfig: Record<string, unknown>,
  flags: Partial<CrawlConfig>,
  start: CommandLineStart,
): MergedCrawlConfig {
  const notes = Object.keys(fileConfig)
    .filter((key) => !(key in DEFAULT_CRAWL_CONFIG))
    .map((key) => `unknown key in --config: ${key}`);
  const config = mergeLayer(
    mergeLayer(DEFAULT_CRAWL_CONFIG as unknown as Record<string, unknown>, fileConfig),
    flags as Record<string, unknown>,
  ) as unknown as CrawlConfig;

  // An active profile wins over `proxyUrl` in the crawler, so `--proxy`
  // would do nothing against a settings file that selected one.
  if (flags.proxyUrl !== undefined && config.proxyProfileActive.trim()) {
    notes.push(`--proxy replaces the proxy profile "${config.proxyProfileActive}" from --config.`);
    config.proxyProfileActive = '';
  }

  let listUrls: string[];
  if (start.listUrls !== undefined) listUrls = start.listUrls;
  else if (start.url !== undefined) listUrls = [];
  else if (fileConfig['mode'] === 'list') {
    listUrls = Array.isArray(fileConfig['urlList'])
      ? fileConfig['urlList'].filter((u): u is string => typeof u === 'string' && u.trim() !== '')
      : [];
    if (listUrls.length === 0)
      return {
        kind: 'error',
        message: 'The --config file is in list mode but its urlList holds no URLs.',
      };
  } else if (typeof fileConfig['startUrl'] === 'string' && fileConfig['startUrl'].trim()) {
    return {
      kind: 'ok',
      config: { ...config, mode: 'spider', urlList: [] },
      listMode: false,
      notes,
    };
  } else return { kind: 'usage' };

  const listMode = start.url === undefined;
  return {
    kind: 'ok',
    config: {
      ...config,
      mode: listMode ? 'list' : 'spider',
      urlList: listUrls,
      // In list mode the first URL doubles as `startUrl` for progress labels.
      startUrl: listMode ? (listUrls[0] ?? '') : start.url!,
    },
    listMode,
    notes,
  };
}

function mergeLayer(
  base: Record<string, unknown>,
  over: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(over)) {
    if (value === undefined) continue;
    const current = out[key];
    out[key] =
      isPlainObject(current) && isPlainObject(value) && !REPLACED_WHOLE.has(key)
        ? mergeLayer(current, value)
        : value;
  }
  return out;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
