#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { basename, resolve } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import {
  DEFAULT_CRAWL_CONFIG,
  type CrawlConfig,
  type LogIngestInput,
  type MetricaFetchMeta,
} from '@freecrawl/shared-types';
import {
  Crawler,
  compareCrawls,
  exportUrlsToCsv,
  exportUrlsToJson,
  testUrlAgainstRobots,
  fetchSitemaps,
  validateSitemap,
  analyzeLogFile,
  normalizeUrl,
  compileUrlRegexRewrites,
  listMetricaCounters,
  fetchMetricaPageMetrics,
  MetricaError,
  MetricaCancelledError,
  type LogAnalysisResult,
} from '@freecrawl/core';
import { ProjectDb } from '@freecrawl/db';

function help(): void {
  console.log(`freecrawl — headless SEO crawler

Usage:
  freecrawl <url> [options]                       Spider mode (default)
  freecrawl --list <file> [options]               List mode (one URL per line)
  freecrawl validate-sitemap <sitemap-url>        Fetch + validate a sitemap.xml
  freecrawl audit-robots <url> [--user-agent UA]  Test if a URL is allowed by robots.txt
  freecrawl compare <before.seoproject> <after.seoproject>
                                                  Cross-project diff (added / removed / status / title / meta / h1 / canonical / indexability / response_time)
  freecrawl analyze-logs <access.log> [more.log …] [--project file]
                                                  Parse one or more server access logs (Apache / Nginx / IIS / custom), detect bots,
                                                  and merge the aggregates into a project for crawl × log analysis
  freecrawl metrica-counters [--json]             List the Yandex Metrica counters the token can read
  freecrawl metrica-fetch --counter <id> [--days 7|28|90] [--project file] [--config file]
                                                  Pull per-page Yandex Metrica data (pageviews, visits, users,
                                                  search visits) into a project, as the desktop app does

Options:
  --depth <n>         Max crawl depth (default: ${DEFAULT_CRAWL_CONFIG.maxDepth})
  --max <n>           Max URLs (default: ${DEFAULT_CRAWL_CONFIG.maxUrls})
  --concurrency <n>   Max parallel requests (default: ${DEFAULT_CRAWL_CONFIG.maxConcurrency})
  --rps <n>           Max requests per second (default: ${DEFAULT_CRAWL_CONFIG.maxRps})
  --user-agent <str>  Custom User-Agent string
  --no-robots         Ignore robots.txt
  --respect-crawl-delay
                      Honour a robots.txt Crawl-delay directive as a global rate limit
                        (one request every N seconds). Off by default — the directive is
                        not part of RFC 9309 and published values are often crippling.
  --external          Follow external links
  --header <K: V>     Extra request header; repeatable (e.g. --header "Authorization: Bearer X")
  --include <regex>   Only crawl URLs matching this regex; repeatable
  --exclude <regex>   Skip URLs matching this regex; repeatable
  --list <file>       List-mode crawl: fetch every URL in <file> (one per line), no link follow
  --config <file>     Load CrawlConfig from a JSON file (matches Settings → Export Settings format).
                        Per-flag overrides on the command line still win — useful for CI
                        ("scheduled config + per-run --max").
  --db <file>         SQLite project file (default: ./crawl.seoproject)
  --out <file>        Export results after crawl. Format auto-detected by extension:
                        *.json → full JSON dump (every captured field)
                        any other → CSV (subset of common columns)
  --json              Print a machine-readable JSON summary to stdout (instead of human progress).
                        Useful for CI/CD pipelines.

analyze-logs options:
  --project <file>    Project to merge log aggregates into (default: ./crawl.seoproject)
  --format <fmt>      auto | apache-combined | apache-common | nginx | iis-w3c | custom (default: auto)
  --regex <pattern>   Named-group regex for --format custom (groups: ip ts method path status bytes ua referer)
  --verify-bots       Reverse-DNS verify a sample of bot IPs (slower; catches spoofed user-agents)

metrica-counters / metrica-fetch options:
  The token comes from the YANDEX_METRICA_TOKEN environment variable
  (a personal OAuth token with the metrika:read scope).
  --counter <id>      Counter to pull (see metrica-counters)
  --days <n>          7 | 28 | 90 full days ending yesterday (default: 28)
  --project <file>    Existing project to store the data in (default: ./crawl.seoproject)
  --config <file>     Crawl config whose URL rewrite options map Metrica URLs onto crawled
                        URLs (default: the config the project was crawled with)
  -h, --help          Show this help
`);
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      depth: { type: 'string' },
      max: { type: 'string' },
      concurrency: { type: 'string' },
      rps: { type: 'string' },
      'user-agent': { type: 'string' },
      'no-robots': { type: 'boolean' },
      'respect-crawl-delay': { type: 'boolean' },
      external: { type: 'boolean' },
      header: { type: 'string', multiple: true },
      include: { type: 'string', multiple: true },
      exclude: { type: 'string', multiple: true },
      list: { type: 'string' },
      config: { type: 'string' },
      db: { type: 'string' },
      out: { type: 'string' },
      json: { type: 'boolean' },
      project: { type: 'string' },
      format: { type: 'string' },
      regex: { type: 'string' },
      'verify-bots': { type: 'boolean' },
      counter: { type: 'string' },
      days: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  });

  // Subcommands: `validate-sitemap <url>` and `audit-robots <url>` short-
  // circuit the crawl path — they're standalone diagnostics that don't
  // touch the project DB.
  if (positionals[0] === 'validate-sitemap') {
    if (!positionals[1]) {
      console.error('Usage: freecrawl validate-sitemap <sitemap-url>');
      process.exit(2);
    }
    const exitCode = await runValidateSitemap(
      positionals[1],
      values['user-agent'] ?? DEFAULT_CRAWL_CONFIG.userAgent,
    );
    process.exit(exitCode);
  }
  if (positionals[0] === 'audit-robots') {
    if (!positionals[1]) {
      console.error('Usage: freecrawl audit-robots <url> [--user-agent UA]');
      process.exit(2);
    }
    const exitCode = await runAuditRobots(
      positionals[1],
      values['user-agent'] ?? DEFAULT_CRAWL_CONFIG.userAgent,
    );
    process.exit(exitCode);
  }
  if (positionals[0] === 'compare') {
    if (!positionals[1] || !positionals[2]) {
      console.error(
        'Usage: freecrawl compare <before.seoproject> <after.seoproject>',
      );
      process.exit(2);
    }
    const exitCode = runCompare(
      resolve(positionals[1]),
      resolve(positionals[2]),
    );
    process.exit(exitCode);
  }
  if (positionals[0] === 'analyze-logs') {
    if (!positionals[1]) {
      console.error('Usage: freecrawl analyze-logs <access.log> [more.log …] [--project file] [--format f] [--regex p] [--verify-bots]');
      process.exit(2);
    }
    const exitCode = await runAnalyzeLogs(
      positionals.slice(1).map((p) => resolve(p)),
      {
        projectPath: resolve(values.project ?? values.db ?? 'crawl.seoproject'),
        format: (values.format as LogIngestInput['file']['format'] | 'auto' | undefined) ?? 'auto',
        regex: values.regex,
        verifyBots: Boolean(values['verify-bots']),
        json: Boolean(values.json),
      },
    );
    process.exit(exitCode);
  }
  if (positionals[0] === 'metrica-counters') {
    process.exit(await runMetricaCounters(Boolean(values.json)));
  }
  if (positionals[0] === 'metrica-fetch') {
    const exitCode = await runMetricaFetch({
      counter: values.counter,
      days: values.days,
      projectPath: resolve(values.project ?? values.db ?? 'crawl.seoproject'),
      configPath: values.config,
      json: Boolean(values.json),
    });
    process.exit(exitCode);
  }

  // List mode is selected by `--list`; otherwise we need a positional URL.
  const listFile = values.list;
  if (values.help || (!listFile && positionals.length === 0)) {
    help();
    process.exit(values.help ? 0 : 1);
  }

  let listUrls: string[] = [];
  if (listFile) {
    try {
      listUrls = readFileSync(resolve(listFile), 'utf8')
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter((s) => s.length > 0 && !s.startsWith('#'));
    } catch (err) {
      console.error(`Cannot read --list file ${listFile}: ${(err as Error).message}`);
      process.exit(2);
    }
    if (listUrls.length === 0) {
      console.error(`--list file ${listFile} contains no URLs.`);
      process.exit(2);
    }
  }

  // In list mode the first listed URL doubles as `startUrl` for progress
  // labels; in spider mode the positional argument is the start URL.
  const startUrl = listFile ? (listUrls[0] ?? '') : positionals[0]!;
  const dbPath = resolve(values.db ?? 'crawl.seoproject');
  const db = new ProjectDb(dbPath);

  // Layered config: defaults → file (if `--config`) → command-line flags.
  // The file format matches the Settings → Export Settings envelope
  // (`{format, version, exportedAt, config}`); a bare `CrawlConfig`
  // fragment is also accepted so users can hand-author a JSON file.
  let fileConfig: Record<string, unknown> = {};
  if (values.config) {
    try {
      fileConfig = readConfigFile(values.config);
    } catch (err) {
      console.error(
        `Cannot read --config file ${values.config}: ${(err as Error).message}`,
      );
      process.exit(2);
    }
  }

  // Per-flag overrides win ONLY when the flag is actually present. Applying
  // them unconditionally would let a `parseNumeric(undefined, DEFAULT)` /
  // `?? DEFAULT` fallback silently overwrite a value the user set in the
  // --config file (the help text promises "the command line still win[s]",
  // not "defaults clobber the file").
  const config = {
    ...DEFAULT_CRAWL_CONFIG,
    ...fileConfig,
    mode: listFile ? ('list' as const) : ('spider' as const),
    urlList: listUrls,
    startUrl,
    ...(values.depth !== undefined
      ? { maxDepth: parseNumeric(values.depth, DEFAULT_CRAWL_CONFIG.maxDepth) }
      : {}),
    ...(values.max !== undefined
      ? { maxUrls: parseNumeric(values.max, DEFAULT_CRAWL_CONFIG.maxUrls) }
      : {}),
    ...(values.concurrency !== undefined
      ? { maxConcurrency: parseNumeric(values.concurrency, DEFAULT_CRAWL_CONFIG.maxConcurrency) }
      : {}),
    ...(values.rps !== undefined
      ? { maxRps: parseNumeric(values.rps, DEFAULT_CRAWL_CONFIG.maxRps) }
      : {}),
    ...(values['user-agent'] !== undefined ? { userAgent: values['user-agent'] } : {}),
    // `--no-robots` / `--external` only flip the flag ON in their direction;
    // absent, the file value (or default) stands.
    ...(values['no-robots'] ? { respectRobotsTxt: false } : {}),
    ...(values['respect-crawl-delay'] ? { respectCrawlDelay: true } : {}),
    ...(values.external ? { crawlExternal: true } : {}),
    ...(values.header !== undefined ? { customHeaders: parseHeaders(values.header) } : {}),
    ...(values.include !== undefined ? { includePatterns: values.include } : {}),
    ...(values.exclude !== undefined ? { excludePatterns: values.exclude } : {}),
  };

  const crawler = new Crawler(config, db);
  const jsonMode = Boolean(values.json);

  if (!jsonMode) {
    crawler.on('progress', (p) => {
      process.stdout.write(
        `\r[${p.crawled}/${p.discovered}] pending=${p.pending} failed=${p.failed} @ ${p.urlsPerSecond.toFixed(1)} URL/s  avg=${p.avgResponseTimeMs}ms  t=${Math.round(p.elapsedMs / 1000)}s   `,
      );
    });
  }
  let crawlError: string | null = null;
  crawler.on('error', (msg) => {
    // Record the first fatal error (invalid/unreachable start URL, seed
    // failure, bad pattern) so the exit code and --json `ok` reflect it —
    // otherwise an unreachable seed produces an empty DB with no 4xx/5xx
    // rows and the CLI misreports success to a CI pipeline.
    if (crawlError === null) crawlError = String(msg);
    process.stderr.write(`\n[error] ${msg}\n`);
  });

  await crawler.start();
  if (!jsonMode) process.stdout.write('\n');

  const summary = db.getSummary();
  let exportedTo: string | null = null;
  let rowsWritten = 0;
  if (values.out) {
    const outPath = resolve(values.out);
    // Auto-detect format from extension. `.json` -> full JSON dump, anything
    // else -> CSV (existing behaviour).
    const isJson = outPath.toLowerCase().endsWith('.json');
    const r = isJson
      ? await exportUrlsToJson(db, outPath, { pretty: true })
      : await exportUrlsToCsv(db, outPath);
    rowsWritten = r.rowsWritten;
    exportedTo = outPath;
  }

  const issues = db.getOverviewCounts().issues;
  // A crawl that fetched nothing (unreachable seed, everything filtered) is a
  // failure for CI purposes — a successful spider always fetches ≥1 page.
  const hasErrors =
    crawlError !== null ||
    summary.total === 0 ||
    Object.keys(summary.byStatus).some((k) => {
      const n = Number.parseInt(k, 10);
      return Number.isFinite(n) && n >= 400;
    });

  if (jsonMode) {
    process.stdout.write(
      JSON.stringify(
        {
          ok: !hasErrors,
          error: crawlError,
          startUrl,
          dbPath,
          summary,
          issues,
          exportedTo,
          rowsExported: exportedTo ? rowsWritten : null,
        },
        null,
        2,
      ) + '\n',
    );
  } else {
    console.log(
      `Done. Total=${summary.total}  Bytes=${summary.totalBytes}  AvgResp=${summary.avgResponseTimeMs}ms`,
    );
    if (exportedTo) {
      console.log(`Wrote ${rowsWritten} rows -> ${exportedTo}`);
    }
  }

  db.close();
  process.exit(hasErrors ? 1 : 0);
}

/**
 * Read a `--config` file: the Settings → Export Settings envelope
 * (`{format, version, exportedAt, config}`) or a bare `CrawlConfig`
 * fragment. Throws on a missing or malformed file.
 */
function readConfigFile(file: string): Record<string, unknown> {
  const raw = readFileSync(resolve(file), 'utf8');
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  if (parsed && typeof parsed === 'object' && 'config' in parsed) {
    return (parsed['config'] as Record<string, unknown>) ?? {};
  }
  return parsed;
}

function parseNumeric(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Parse `--header "Key: Value"` repeated flags into a map. Values beyond
 * the first `:` are kept as-is (so `X: bearer token with: colon` works).
 */
function parseHeaders(values: string[] | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!values) return out;
  for (const raw of values) {
    const idx = raw.indexOf(':');
    if (idx <= 0) continue;
    const key = raw.slice(0, idx).trim();
    const value = raw.slice(idx + 1).trim();
    if (key) out[key] = value;
  }
  return out;
}

/**
 * Fetch a sitemap (or sitemap-index) URL, walk it, and report URL count +
 * lastmod sample validity. Exit 0 = clean, 1 = warnings, 2 = fetch failure.
 */
async function runValidateSitemap(rawUrl: string, userAgent: string): Promise<number> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    console.error(`Invalid URL: ${rawUrl}`);
    return 2;
  }
  const ac = new AbortController();
  const timeout = setTimeout(() => ac.abort(), 30_000);
  try {
    // Walk the sitemap (and any nested indexes) up to a reasonable cap so
    // pathological sites can't hang the CLI.
    const result = await fetchSitemaps([parsed.toString()], {
      userAgent,
      signal: ac.signal,
      timeoutMs: 30_000,
      maxUrls: 100_000,
      maxDepth: 3,
    });
    if (result.errors.length > 0 && result.entries.length === 0) {
      console.error(`Sitemap fetch failed:`);
      for (const e of result.errors) console.error(`  ${e.sitemap}: ${e.error}`);
      return 2;
    }
    const lastmodSamples = result.entries
      .slice(0, 50)
      .map((e) => e.lastmod ?? '')
      .filter(Boolean)
      .slice(0, 10);
    const validation = validateSitemap({
      urlCount: result.entries.length,
      fileBytes: 0, // Unknown without a head request; size cap is best-effort here.
      lastmodSamples,
    });
    console.log(`Sitemap: ${rawUrl}`);
    console.log(`  Sitemaps tried: ${result.sitemapsTried.length}`);
    console.log(`  Sitemaps parsed: ${result.sitemapsParsed.length}`);
    console.log(`  URL entries: ${result.entries.length}${result.truncated ? ' (truncated)' : ''}`);
    if (result.errors.length > 0) {
      console.log(`  Errors:`);
      for (const e of result.errors) console.log(`    ${e.sitemap}: ${e.error}`);
    }
    if (validation.findings.length > 0) {
      console.log(`  Findings:`);
      for (const f of validation.findings) console.log(`    - ${f}`);
      return 1;
    }
    console.log('  OK');
    return 0;
  } catch (err) {
    console.error(`Validation error: ${(err as Error).message}`);
    return 2;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Run the configured robots.txt against a single URL — print whether it's
 * allowed, the matched user-agent's crawl-delay, and any declared sitemaps.
 */
async function runAuditRobots(rawUrl: string, userAgent: string): Promise<number> {
  try {
    new URL(rawUrl);
  } catch {
    console.error(`Invalid URL: ${rawUrl}`);
    return 2;
  }
  const result = await testUrlAgainstRobots(rawUrl, userAgent);
  console.log(`URL:        ${result.url}`);
  console.log(`robots.txt: ${result.robotsUrl}`);
  if (result.error) {
    console.log(`Status:     fetch error — ${result.error}`);
    console.log('Verdict:    ALLOWED (default-allow when robots.txt is unreachable)');
    return 0;
  }
  console.log(`Status:     HTTP ${result.status ?? '—'}`);
  console.log(`User-Agent: ${userAgent}`);
  console.log(`Crawl-Delay: ${result.crawlDelay ?? '—'}`);
  if (result.sitemaps.length > 0) {
    console.log(`Sitemaps:`);
    for (const s of result.sitemaps) console.log(`  - ${s}`);
  }
  console.log(`Verdict:    ${result.allowed ? 'ALLOWED' : 'DISALLOWED'}`);
  return result.allowed ? 0 : 1;
}

/**
 * Cross-project diff. Opens two `.seoproject` files (read-only — never
 * mutates), runs the same `compareCrawls` engine the desktop Compare
 * dialog uses, and prints a category-grouped count + samples to stdout.
 *
 * Exit code: 0 when both projects load and diff completes; 1 when at
 * least one diff category had non-zero results (useful for CI gates that
 * want to fail on regressions); 2 on fatal load error.
 */
function runCompare(beforePath: string, afterPath: string): number {
  let before: ProjectDb;
  let after: ProjectDb;
  try {
    before = new ProjectDb(beforePath);
  } catch (err) {
    console.error(`Cannot open before project: ${(err as Error).message}`);
    return 2;
  }
  try {
    after = new ProjectDb(afterPath);
  } catch (err) {
    before.close();
    console.error(`Cannot open after project: ${(err as Error).message}`);
    return 2;
  }
  try {
    const summary = compareCrawls(before, after);
    console.log(`Compare: ${beforePath} → ${afterPath}`);
    console.log(`  Total before: ${summary.totalA}`);
    console.log(`  Total after:  ${summary.totalB}`);
    console.log(`  Diff:`);
    for (const [cat, count] of Object.entries(summary.counts)) {
      console.log(`    ${cat.padEnd(15)} ${count}`);
    }
    const totalDiff = Object.values(summary.counts).reduce(
      (a, b) => a + b,
      0,
    );
    return totalDiff > 0 ? 1 : 0;
  } finally {
    before.close();
    after.close();
  }
}

/**
 * V2 Faz 2 — flatten the core analyzer's Map aggregates into the plain
 * arrays `ProjectDb.ingestLogAnalysis` expects (mirrors the desktop's
 * `ingestLogResult`). Kept in the CLI so headless log ingestion needs no
 * Electron / desktop process.
 */
function flattenLogResult(filePath: string, result: LogAnalysisResult): LogIngestInput {
  return {
    file: {
      filePath,
      fileName: basename(filePath),
      format: result.format,
      totalLines: result.totalLines,
      parsedLines: result.parsedLines,
      skippedLines: result.skippedLines,
      minTs: result.minTs,
      maxTs: result.maxTs,
    },
    urlStats: Array.from(result.urlStats.values()).map((u) => ({
      path: u.path,
      totalHits: u.totalHits,
      botHits: u.botHits,
      googlebotHits: u.googlebotHits,
      bingbotHits: u.bingbotHits,
      yandexbotHits: u.yandexbotHits,
      otherBotHits: u.otherBotHits,
      lastStatus: u.lastStatus,
      firstTs: u.firstTs,
      lastTs: u.lastTs,
    })),
    daily: Array.from(result.daily.entries()).map(([key, hits]) => {
      // Key is `${day}\t${bucket}` (tab-separated in log-analyzer.ts).
      const sp = key.indexOf('\t');
      return { day: key.slice(0, sp), bucket: key.slice(sp + 1), hits };
    }),
    status: Array.from(result.status.entries()).map(([status, v]) => ({
      status,
      count: v.count,
      botCount: v.botCount,
    })),
    bots: Array.from(result.bots.entries()).map(([bot, agg]) => ({
      bot,
      family: agg.family,
      hits: agg.hits,
      totalIps: agg.ips.size,
      verifiedIps: agg.verifiedIps,
      verifiable: agg.verifiable,
    })),
    urlBots: Array.from(result.urlStats.values()).flatMap((u) =>
      Array.from(u.botCounts.entries()).map(([bot, hits]) => ({ path: u.path, bot, hits })),
    ),
    threats: result.threats,
    threatsDropped: result.threatsDropped,
  };
}

/**
 * Parse one or more access logs, detect bots, and merge every file's
 * aggregates into the same project DB. Prints a per-file line plus a combined
 * summary (or JSON). Exit 0 when at least one file ingested, 2 on error.
 */
async function runAnalyzeLogs(
  logPaths: string[],
  opts: {
    projectPath: string;
    format: 'auto' | 'apache-combined' | 'apache-common' | 'nginx' | 'iis-w3c' | 'custom';
    regex: string | undefined;
    verifyBots: boolean;
    json: boolean;
  },
): Promise<number> {
  let db: ProjectDb;
  try {
    db = new ProjectDb(opts.projectPath);
  } catch (err) {
    console.error(`Cannot open project ${opts.projectPath}: ${(err as Error).message}`);
    return 2;
  }
  try {
    const imported: ReturnType<ProjectDb['ingestLogAnalysis']>[] = [];
    const failures: Array<{ file: string; error: string }> = [];
    for (const logPath of logPaths) {
      try {
        const result = await analyzeLogFile(logPath, {
          format: opts.format,
          customRegex: opts.regex,
          verifyBots: opts.verifyBots,
        });
        const summary = db.ingestLogAnalysis(flattenLogResult(logPath, result));
        imported.push(summary);
        if (!opts.json) {
          console.log(`Log: ${summary.fileName} (${summary.format})`);
          console.log(`  Lines:  ${summary.parsedLines}/${summary.totalLines} parsed, ${summary.skippedLines} skipped`);
        }
      } catch (err) {
        const error = (err as Error).message;
        failures.push({ file: logPath, error });
        if (!opts.json) console.error(`  Skipped ${logPath}: ${error}`);
      }
    }

    if (imported.length === 0) {
      if (opts.json) {
        process.stdout.write(JSON.stringify({ ok: false, imported: [], errors: failures }, null, 2) + '\n');
      } else {
        console.error('analyze-logs failed: no files could be ingested.');
      }
      return 2;
    }

    const overview = db.getLogOverview();
    const bots = db.getLogBots().slice(0, 10);
    const topUrls = db
      .queryLogUrlStats({ limit: 10, offset: 0, sortBy: 'botHits', filter: 'bots' })
      .rows;

    if (opts.json) {
      process.stdout.write(
        JSON.stringify(
          { ok: true, imported, errors: failures, overview, topBots: bots, topBotUrls: topUrls },
          null,
          2,
        ) + '\n',
      );
    } else {
      if (imported.length > 1) console.log(`Ingested ${imported.length} files.`);
      console.log(`  Hits:   ${overview.totalHits} total · ${overview.botHits} bot · ${overview.humanHits} human`);
      if (overview.minTs) {
        const d = (ms: number): string => new Date(ms).toISOString().slice(0, 16).replace('T', ' ');
        console.log(`  Range:  ${d(overview.minTs)} → ${overview.maxTs ? d(overview.maxTs) : '?'}`);
      }
      if (bots.length > 0) {
        console.log('  Top bots:');
        for (const b of bots) {
          const v = b.verifiable ? ` (${b.verifiedIps}/${b.totalIps} IPs verified)` : '';
          console.log(`    ${b.bot.padEnd(28)} ${String(b.hits).padStart(8)}${v}`);
        }
      }
      if (topUrls.length > 0) {
        console.log('  Top bot-hit URLs:');
        for (const u of topUrls) {
          console.log(`    ${String(u.botHits).padStart(8)}  ${u.path}${u.inCrawl ? '' : '  [orphan]'}`);
        }
      }
    }
    return 0;
  } catch (err) {
    console.error(`analyze-logs failed: ${(err as Error).message}`);
    return 2;
  } finally {
    db.close();
  }
}

/**
 * Yandex Metrica token from `YANDEX_METRICA_TOKEN` — the CLI has no
 * credential store. Never echoed: the messages name the variable only.
 */
function metricaToken(): string {
  const token = process.env['YANDEX_METRICA_TOKEN']?.trim() ?? '';
  if (!token) {
    throw new MetricaError(
      'YANDEX_METRICA_TOKEN is not set — export a Yandex Metrica OAuth token with the metrika:read scope.',
      'not-connected',
    );
  }
  // Same check as the desktop app: a value with spaces or line breaks would
  // otherwise reach undici, whose header error quotes the value.
  if (!/^[A-Za-z0-9._~+/=-]+$/.test(token)) {
    throw new MetricaError(
      'YANDEX_METRICA_TOKEN has an unexpected format — it must be a single OAuth token without spaces or line breaks.',
      'token-format',
    );
  }
  return token;
}

/** Print a Metrica failure (JSON on stdout with --json, else stderr) and
 *  return the exit code. */
function metricaFail(json: boolean, err: unknown, exitCode: number): number {
  const error = err instanceof Error ? err.message : String(err);
  const errorCode = err instanceof MetricaError ? err.code : null;
  const cancelled = err instanceof MetricaCancelledError;
  if (json) {
    process.stdout.write(
      JSON.stringify({ ok: false, error, errorCode, cancelled }, null, 2) + '\n',
    );
  } else {
    console.error(error);
    if (errorCode === 'token-rejected') {
      console.error('Check the token in YANDEX_METRICA_TOKEN (scope metrika:read).');
    }
  }
  return exitCode;
}

/**
 * List the counters the token can read. Exit 0 on success, 1 on an API
 * failure, 2 when the token is missing or malformed.
 */
async function runMetricaCounters(json: boolean): Promise<number> {
  let token: string;
  try {
    token = metricaToken();
  } catch (err) {
    return metricaFail(json, err, 2);
  }
  try {
    const counters = await listMetricaCounters(token);
    if (json) {
      process.stdout.write(JSON.stringify({ ok: true, counters }, null, 2) + '\n');
      return 0;
    }
    if (counters.length === 0) {
      console.log('No Yandex Metrica counters are readable with this token.');
      return 0;
    }
    const idWidth = Math.max(...counters.map((c) => c.counterId.length));
    for (const c of counters) {
      console.log(
        `${c.counterId.padEnd(idWidth)}  ${c.name}${c.site && c.site !== c.name ? `  (${c.site})` : ''}`,
      );
    }
    return 0;
  } catch (err) {
    return metricaFail(json, err, 1);
  }
}

/**
 * URL normaliser for Metrica rows, mirroring the desktop's
 * `crawlUrlNormalizer`: the rewrite options of the crawl config, so the
 * stored rows join onto `urls.url`. The config is the `--config` file if
 * given, else the project's `lastCrawlConfig` (the `{config, secretsEnc}`
 * envelope or a bare config; secrets are irrelevant here), else defaults.
 */
function metricaUrlNormalizer(
  db: ProjectDb,
  configPath: string | undefined,
): (url: string) => string | null {
  let fragment: Record<string, unknown> = {};
  if (configPath) {
    fragment = readConfigFile(configPath);
  } else {
    const raw = db.getMeta('lastCrawlConfig');
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        if (parsed && typeof parsed === 'object') {
          const env = parsed['config'];
          fragment = env && typeof env === 'object' ? (env as Record<string, unknown>) : parsed;
        }
      } catch {
        /* corrupt meta — fall back to the default rewrites */
      }
    }
  }
  const c = { ...DEFAULT_CRAWL_CONFIG, ...fragment } as CrawlConfig;
  const rewrites = {
    stripWww: c.stripWww,
    forceHttps: c.forceHttps,
    lowercasePath: c.lowercasePath,
    trailingSlash: c.trailingSlash,
    keepQueryParams: c.keepQueryParams,
    sortQueryParams: c.sortQueryParams,
    collapseDuplicateSlashes: c.collapseDuplicateSlashes,
    keepHashRoutes: c.renderingMode === 'js' && c.jsRender?.spaRouting === true,
    regexRewrites: compileUrlRegexRewrites(c.urlRegexRewrites),
  };
  return (url) => normalizeUrl(url, undefined, rewrites);
}

/**
 * Pull one counter's per-page data into an existing project, writing what
 * the desktop pull writes (rows + fetch meta, and the counter in
 * `integrationSettings:metrica`), so the desktop app shows the same data.
 * Ctrl-C cancels; nothing is written then. Exit 0 on success, 1 on an API
 * or write failure, 2 on bad arguments, 130 when cancelled.
 */
async function runMetricaFetch(opts: {
  counter: string | undefined;
  days: string | undefined;
  projectPath: string;
  configPath: string | undefined;
  json: boolean;
}): Promise<number> {
  const counterId = (opts.counter ?? '').trim();
  if (!/^\d+$/.test(counterId)) {
    console.error(
      'Usage: freecrawl metrica-fetch --counter <id> [--days 7|28|90] [--project file] [--config file] [--json]',
    );
    console.error(
      opts.counter === undefined
        ? '--counter is required.'
        : `Invalid --counter: ${opts.counter} (expected a numeric counter id).`,
    );
    return 2;
  }
  const days = opts.days === undefined ? 28 : Number(opts.days);
  if (days !== 7 && days !== 28 && days !== 90) {
    console.error(`Invalid --days: ${opts.days} (expected 7, 28 or 90).`);
    return 2;
  }
  // ProjectDb creates a missing file; a pull into an empty project would
  // join onto nothing, so a typo in --project must fail instead.
  if (!existsSync(opts.projectPath)) {
    console.error(`Project not found: ${opts.projectPath} (crawl it first, or pass --project).`);
    return 2;
  }
  let token: string;
  try {
    token = metricaToken();
  } catch (err) {
    return metricaFail(opts.json, err, 2);
  }

  let db: ProjectDb;
  try {
    db = new ProjectDb(opts.projectPath);
  } catch (err) {
    console.error(`Cannot open project ${opts.projectPath}: ${(err as Error).message}`);
    return 2;
  }
  const abort = new AbortController();
  const onSigint = (): void => {
    process.stderr.write('\nCancelling the Yandex Metrica fetch…\n');
    abort.abort();
  };
  process.once('SIGINT', onSigint);
  const tty = process.stderr.isTTY === true;
  let progressOpen = false;
  const endProgress = (): void => {
    if (progressOpen) process.stderr.write('\n');
    progressOpen = false;
  };
  const log = (level: 'info' | 'warn' | 'error', message: string): void => {
    if (level === 'info') return;
    endProgress();
    process.stderr.write(`[${level}] ${message}\n`);
  };
  try {
    let normalize: (url: string) => string | null;
    try {
      normalize = metricaUrlNormalizer(db, opts.configPath);
    } catch (err) {
      console.error(`Cannot read --config file ${opts.configPath}: ${(err as Error).message}`);
      return 2;
    }
    // Best effort, for the name the desktop shows; the pull itself reports
    // any real access problem.
    let counterName = counterId;
    try {
      const counters = await listMetricaCounters(token, { signal: abort.signal, log });
      const found = counters.find((c) => c.counterId === counterId);
      if (found) counterName = found.name;
    } catch (err) {
      if (err instanceof MetricaCancelledError) throw err;
      /* keep the id as the name */
    }
    const result = await fetchMetricaPageMetrics(token, counterId, days, normalize, {
      signal: abort.signal,
      onProgress: (p) => {
        if (opts.json) return;
        const line = `${p.report} report ${p.reportIndex}/${p.reportCount}: ${p.rows} rows`;
        if (tty) {
          process.stderr.write(`\r${line}   `);
          progressOpen = true;
        } else {
          process.stderr.write(`${line}\n`);
        }
      },
      log,
    });
    endProgress();
    const fetchedAt = new Date().toISOString();
    const meta: MetricaFetchMeta = {
      counterId,
      counterName,
      startDate: result.startDate,
      endDate: result.endDate,
      fetchedAt,
      rowCount: result.rows.length,
      truncated: result.truncated,
      sampled: result.sampled,
      totals: result.totals,
    };
    db.replaceMetricaResults(result.rows, fetchedAt, counterId, JSON.stringify(meta));
    // Merge into the per-project settings blob, as the desktop does, so the
    // Metrica tab opens on this counter and range.
    let settings: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(db.getMeta('integrationSettings:metrica') ?? '{}') as unknown;
      if (parsed && typeof parsed === 'object') settings = parsed as Record<string, unknown>;
    } catch {
      /* corrupt blob — overwrite it */
    }
    db.setMeta(
      'integrationSettings:metrica',
      JSON.stringify({ ...settings, counterId, counterName, days }),
    );

    if (opts.json) {
      process.stdout.write(
        JSON.stringify(
          { ok: true, projectPath: opts.projectPath, days, dropped: result.dropped, ...meta },
          null,
          2,
        ) + '\n',
      );
    } else {
      const t = result.totals;
      console.log(
        `Metrica: counter ${counterId}${counterName !== counterId ? ` (${counterName})` : ''}`,
      );
      console.log(`  Range:   ${result.startDate} → ${result.endDate} (${days} days)`);
      console.log(`  Pages:   ${result.rows.length} stored in ${opts.projectPath}`);
      console.log(
        `  Totals:  ${t.pageviews} pageviews · ${t.visits} visits · ${t.users} users · ${t.searchVisits} search visits`,
      );
      if (result.dropped > 0) {
        console.log(`  Dropped: ${result.dropped} raw rows whose URL did not normalise`);
      }
      if (result.truncated) {
        console.log('  Warning: a report hit the row cap, so low-traffic URLs are missing.');
      }
      if (result.sampled) {
        console.log(
          '  Warning: Yandex Metrica returned sampled data; per-page numbers are estimates.',
        );
      }
    }
    return 0;
  } catch (err) {
    endProgress();
    return metricaFail(opts.json, err, err instanceof MetricaCancelledError ? 130 : 1);
  } finally {
    process.off('SIGINT', onSigint);
    db.close();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.stack : err);
  process.exit(2);
});
