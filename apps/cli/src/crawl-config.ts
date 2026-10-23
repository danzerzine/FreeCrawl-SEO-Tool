import {
  DEFAULT_CRAWL_CONFIG,
  hasPageScript,
  PAGE_SCRIPT_MAX_CHARS,
  type CrawlConfig,
} from '@freecrawl/shared-types';

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

  // The page script (B34): bounded, and only meaningful when pages are rendered.
  const script = config.jsRender.pageScript;
  if (script.length > PAGE_SCRIPT_MAX_CHARS) {
    return {
      kind: 'error',
      message: `The page script is ${script.length} characters; the limit is ${PAGE_SCRIPT_MAX_CHARS.toLocaleString('en-US').replace(/,/g, ' ')}.`,
    };
  }
  if (hasPageScript(script) && config.renderingMode !== 'js') {
    return {
      kind: 'error',
      message: 'A page script needs JavaScript rendering: add --render or set renderingMode "js".',
    };
  }

  // The cookie list (B43) is read from a rendered page, coverage (B44) is measured in the browser:
  // without rendering there is nothing to list or measure. A typed flag is an error; the same
  // option in a --config file (the desktop saves it whatever the mode) is a note and switched off.
  const typed = (flags.jsRender ?? {}) as Partial<CrawlConfig['jsRender']>;
  for (const [key, flag] of [
    ['cookieList', '--cookie-list'],
    ['coverage', '--coverage'],
  ] as const) {
    if (!config.jsRender[key] || config.renderingMode === 'js') continue;
    if (typed[key]) return { kind: 'error', message: `${flag} needs --render` };
    notes.push(
      `${flag} needs JavaScript rendering (add --render or set renderingMode "js"): it is switched off.`,
    );
    config.jsRender[key] = false;
  }

  // axe-core (B40) audits rendered pages only: without rendering it does nothing.
  if (config.jsRender.axeAudit && config.renderingMode !== 'js') {
    notes.push(
      '--axe needs JavaScript rendering (add --render or set renderingMode "js"): no accessibility audit runs.',
    );
    config.jsRender.axeAudit = false;
  }

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
