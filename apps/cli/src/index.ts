#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { basename, resolve } from 'node:path';
import { existsSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { mergeCrawlConfig } from './crawl-config.js';
import { readListSource } from './list-source.js';
import {
  COMPARE_CATEGORIES,
  DEFAULT_CRAWL_CONFIG,
  type CrawlConfig,
  type CrawlProgress,
  type CrawlSnapshot,
  type ExportSet,
  type LogIngestInput,
  type MetricaFetchMeta,
} from '@freecrawl/shared-types';
import {
  Crawler,
  compareChangesText,
  compareCrawls,
  compareToFiles,
  compareWithoutMmap,
  openCompareProject,
  type CompareProject,
  type CompareSummary,
  assertMetric,
  historyRows,
  latestAndPrevious,
  parseRules,
  evaluateRules,
  gateFails,
  sendSlack,
  sendTelegram,
  sendWebhook,
  sendEmail,
  MONITOR_RULES_META_KEY,
  TELEGRAM_API_BASE,
  type AlertRuleResult,
  type SendResult,
  exportUrlsToCsv,
  exportUrlsToJson,
  testUrlAgainstRobots,
  fetchSitemaps,
  validateFetchedSitemaps,
  analyzeLogFile,
  normalizeUrl,
  compileUrlRegexRewrites,
  listMetricaCounters,
  fetchMetricaPageMetrics,
  MetricaError,
  MetricaCancelledError,
  parseExportWhat,
  runExportItems,
  runExportSet,
  listExportSets,
  saveExportSet,
  findExportSet,
  removePartialExportFiles,
  invalidUrlPatterns,
  type ExportItem,
  type ExportOutcome,
  type LogAnalysisResult,
  type StartDecision,
} from '@freecrawl/core';
import {
  ProjectDb,
  detectProjectFormat,
  lockProject,
  openProject,
  readIfExists,
  type OpenedProject,
} from '@freecrawl/db';

function help(): void {
  console.log(`freecrawl — headless SEO crawler

Usage:
  freecrawl <url> [options]                       Spider mode (default)
  freecrawl --list <file> [options]               List mode (one URL per line)
  freecrawl validate-sitemap <sitemap-url>        Fetch + validate a sitemap.xml
  freecrawl audit-robots <url> [--user-agent UA]  Test if a URL is allowed by robots.txt
  freecrawl compare <before.seoproject> <after.seoproject> [--json] [--out <dir>]
                                                  Cross-project diff, before = the older crawl (${COMPARE_CATEGORIES.join(' / ')}).
                                                  --json: the summary with issueChanges and notComparable; --out: compare-summary.json
                                                  and a compare-<kind>.csv (url, before, after) per kind with every row.
                                                  Exit 0 nothing changed, 1 changes, 2 a project would not open.
  freecrawl history --project <file> --metrics <a,b,…> [--limit N] [--start-url <url>] [--json]
                                                  Print the project's crawl history, oldest first, one column per metric
                                                  (CSV with a finishedAt column; --json: {ok, runs: [...]}, not computed = null).
                                                  Metrics: indexable, status.404, status.4xx, issues:<key>, … (a wrong name lists them)
  freecrawl check --project <file> [--rules <file>] [--baseline <project|snapshot.json>] [--write-snapshot <file>]
                  [--notify slack,telegram,webhook,email] [--json]
                                                  Release gate: judge the project's newest crawl against a rule file
                                                  (without --rules: the rules saved in the project). Baseline = the crawl
                                                  before it (same start URL) unless --baseline. Exit 0 pass (a warn rule
                                                  may fire), 1 a fail rule fired or could not be computed, 2 bad arguments,
                                                  rules, project or no crawl history, 130 interrupted.
                                                  --notify posts the fired rules, only when one fired, and never changes the
                                                  exit code. Channels read FREECRAWL_SLACK_WEBHOOK_URL,
                                                  FREECRAWL_TELEGRAM_BOT_TOKEN + FREECRAWL_TELEGRAM_CHAT_ID,
                                                  FREECRAWL_WEBHOOK_URL, FREECRAWL_SMTP_URL + FREECRAWL_ALERT_EMAIL_TO.
                                                  --json: {ok, startUrl, finishedAt, baseline, results: [...], notified: [...]}.
                                                  In CI run the crawl first, then check.
  freecrawl analyze-logs <access.log> [more.log …] [--project file]
                                                  Parse one or more server access logs (Apache / Nginx / IIS / custom), detect bots,
                                                  and merge the aggregates into a project for crawl × log analysis
  freecrawl metrica-counters [--json]             List the Yandex Metrica counters the token can read
  freecrawl metrica-fetch --counter <id> [--days 7|28|90] [--project file] [--config file]
                                                  Pull per-page Yandex Metrica data (pageviews, visits, users,
                                                  search visits) into a project, as the desktop app does
  freecrawl export --project <file> --out <dir> [--what <list> | --set <name>] [--urls <file>] [--raw-headers] [--json]
                                                  Write reports and bulk exports of a project without the desktop app;
                                                  --save-set <name> / --list-sets keep named --what lists in the project

Options:
  --depth <n>         Max crawl depth (default: ${DEFAULT_CRAWL_CONFIG.maxDepth})
  --max <n>           Max URLs (default: ${DEFAULT_CRAWL_CONFIG.maxUrls})
  --max-per-host <n>  Max pages per host name, each subdomain its own count; images and
                        external pages do not count (default: no limit)
  --concurrency <n>   Max parallel requests (default: ${DEFAULT_CRAWL_CONFIG.maxConcurrency})
  --rps <n>           Max requests per second (default: ${DEFAULT_CRAWL_CONFIG.maxRps})
  --user-agent <str>  Custom User-Agent string
  --no-robots         Ignore robots.txt (it is still read once for its Sitemap: lines while sitemap
                        discovery is on); --robots turns it back on over a --config file
  --respect-crawl-delay
                      Honour a robots.txt Crawl-delay directive as a global rate limit
                        (one request every N seconds). Off by default — the directive is
                        not part of RFC 9309 and published values are often crippling.
  --external          Crawl external pages too (follow their links onward)
  --no-check-external Do not status-check external link targets (sends no request to hosts outside
                        the crawl scope; CDN hosts and subdomains in scope still count as the site;
                        the links are still stored, just without a status)
  --image-variants    Also fetch and measure srcset / <picture> image variants (off by default;
                        a WordPress blog can go from ~2k to ~40k image requests with this on)
  --adaptive-speed    Slow down on server trouble, then recover: HTTP 429/503 and Retry-After,
                        5xx errors or timeouts on many URLs, answers growing slow (off by default;
                        the fixed --rps / --concurrency hold otherwise)
  --night-rps <n>     Max requests per second at night (default window 0-7 local time)
  --night <from>-<to> Night hours for --night-rps, 0-23, local time; the window may wrap
                        midnight (e.g. --night 22-6)
  --header <K: V>     Extra request header; repeatable (e.g. --header "Authorization: Bearer X");
                        replaces the headers of a --config file
  --sitemap <url>     Read this sitemap and crawl its URLs too; repeatable
  --no-sitemap-discovery
                      Do not look for sitemaps (robots.txt Sitemap: lines, /sitemap.xml)
  --proxy <url>       Send every request through this proxy (http://user:pass@host:port or
                        socks5://…); replaces a proxy profile chosen in a --config file
  --include <regex>   Only crawl URLs matching this regex; repeatable
  --exclude <regex>   Skip URLs matching this regex; repeatable
  --list <source>     List-mode crawl: fetch every URL in <source>, no link follow. <source> is a
                        file (one URL per line, or the first column of a .csv), - for standard
                        input, or an http(s) link to a list or a CSV; a Google Sheets link reads
                        the sheet it names (shared as "anyone with the link")
  --config <file>     Load CrawlConfig from a JSON file (matches Settings → Export Settings format).
                        Per-flag overrides on the command line still win — useful for CI
                        ("scheduled config + per-run --max"). Nested settings merge field by
                        field. Without a URL or --list, the file's startUrl or list is crawled.
                        A form login (formLogin) is set only here. On/off flags also take a
                        --no- form (--no-external, --no-adaptive-speed, …) to override the file.
  --db <file>         SQLite project file (default: ./crawl.seoproject)
  --resume            Continue the crawl in --db where it stopped: pages already fetched are not
                        fetched again. Without it, a crawl into a --db holding the same site fetches
                        every page again (a refresh) and one holding another site replaces it.
                        Spider: the URL must be the project's site; list: pass the same --list.
  --stop-file <file>  Stop the crawl softly when <file> appears (checked every second), as Ctrl-C
                        does; the file is deleted then. For Windows, where a wrapper cannot send
                        Ctrl-C. Must not exist at start.
  --pid-file <file>   Write the crawler's process id to <file> while it runs (removed at exit). On
                        Windows with Volta the process you see is a launcher; this is the real one.
  --out <file>        Export results after crawl. Format auto-detected by extension:
                        *.json → full JSON dump (every captured field)
                        any other → CSV (subset of common columns, with the grid's column names)
  --raw-headers       With --out CSV and export (bulk files): write the internal keys (statusCode, …) as
                        the header row and skip the CSV formula guard (raw data for scripts).
  --json              Print a machine-readable JSON summary to stdout (instead of human progress).
                        Useful for CI/CD pipelines. While the crawl runs, stderr gets one JSON line per
                        event: {"type":"progress",…} every 10 s, and warn / error (info with --verbose).
  --verbose           Also print the crawler's info messages on stderr ([info] …)
  --export-dir <dir>  After the crawl, write the exports named by --export into <dir> (see export)
  --export <list>     What --export-dir writes; same list as export --what (default: bulk)
  --compare-with <project>  After the crawl, compare with that saved project (before) the way
                        compare does: counts printed (--json: "compare"); with --export-dir the
                        compare-*.csv files go there too. Changes do not change the exit code.
                        A crawl into an existing --db refreshes or replaces it (see --resume);
                        crawl into a new file to compare a fresh crawl.
  Crawl exit codes: 0 finished, no URL answered 4xx/5xx; 1 finished with such URLs or an
                        [error] line, or --out / --export-dir / --compare-with failed; 2 bad
                        arguments or a crash; 4 the crawl did not finish (start URL unreachable or
                        4xx/5xx, memory limit, no URLs, bad pattern, nothing fetched), --json
                        "complete": false and "incomplete" says why; 130 stopped by Ctrl-C,
                        SIGTERM or --stop-file. stderr: [warn] lines always (per-URL ones after
                        the first 20 only with --verbose), [info] with --verbose; --json: one
                        JSON line each, and a progress line every 10 s.
  Ctrl-C during a crawl stops it softly: what is still queued is saved for --resume, issues are
                        recounted, the summary prints ("interrupted": true; --out, --export-dir
                        and --compare-with are skipped). A second Ctrl-C quits at once.

analyze-logs options:
  --project <file>    Project to merge log aggregates into (default: ./crawl.seoproject)
  --format <fmt>      auto | apache-combined | apache-common | nginx | iis-w3c | custom (default: auto)
  --regex <pattern>   Named-group regex for --format custom (groups: ip ts method path status bytes ua referer)
  --verify-bots       Reverse-DNS verify a sample of bot IPs (slower; catches spoofed user-agents)
  -h, --help          Show this help

metrica-counters / metrica-fetch options:
  The token comes from the YANDEX_METRICA_TOKEN environment variable
  (a personal OAuth token with the metrika:read scope).
  --counter <id>      Counter to pull (see metrica-counters)
  --days <n>          7 | 28 | 90 full days ending yesterday (default: 28)
  --project <file>    Existing project to store the data in (default: ./crawl.seoproject)
  --config <file>     Crawl config whose URL rewrite options map Metrica URLs onto crawled
                        URLs (default: the crawl config the desktop app saved in the project,
                        else the defaults; a CLI crawl does not save one, so pass the same
                        --config file it used)
  --json              Print the result, or the error, as JSON on stdout

export options:
  --project <file>    Project to export (default: ./crawl.seoproject)
  --out <dir>         Output directory; created if missing. Files of the same name are overwritten,
                        nothing else in it is touched. Each file is written as <name>.part and renamed
                        when complete, so Ctrl-C (exit 130) leaves no half-written file.
                        Written last: manifest.json, every file of the run (path, label, rows), what was
                        asked, start and end time, tool version, project.
  --what <list>       Comma-separated (default: bulk):
                        bulk        one CSV per tab / issue check with rows, plus links-internal/external.csv
                        seo-audit   Screaming Frog-style SEO Audit files in <dir>/seo-audit
                        html        single-file HTML report (report.html)
                        issues      issues-summary.csv: check key, label, group, severity, URLs, items,
                                    previous crawl's count, change since
                        tab:<key> / issues:<key>
                                    one category CSV, e.g. tab:redirects, issues:title-missing
                        dataset:<key>
                                    one table as a file named after the key: issues-long, sitemap-urls,
                                    sitemap-files, crawl-queue, broken-links, broken-links-by-target,
                                    response-headers, images, pagespeed, crux, spelling, ai:<provider>,
                                    seo:<provider>
                                    (CSV), page-html and page-text (JSON Lines, .jsonl: page bodies
                                    exceed the CSV cell limit). issue-inlinks writes every issue into
                                    the issue-inlinks/ subfolder (not in bulk: every link into every
                                    flagged page, tens of GB on a large site: prefer issue-inlinks:<check>). Nothing stored: no file, reason in
                                    errors and on stderr (exit 1). Not offered: selected-* (use
                                    --urls) and search-console, analytics, metrica (need an account).
                        issue-inlinks:<check>
                                    every link into the pages of one check, e.g. issue-inlinks:h1-missing,
                                    into issue-inlinks/inlinks-<check>.csv; other checks' files stay
                        redirects-to-error, error-inlinks, non-indexable-inlinks, redirect-inlinks
                                    the Internal Links reports, one row per link target; the redirect
                                    reports need the redirect-chain pass of the crawl ("not computed" else)
                      Checks turned off in Settings → Issues are skipped, as in the desktop app.
                      Issue lists computed by an older version of the checks are recomputed first
                        when the run reads them (bulk, seo-audit, html, issues, issues:<key>,
                        dataset:issues-long / issue-inlinks): in place in a CLI crawl database (the
                        same derived data a crawl writes), in the working copy of a desktop-saved one.
  --urls <file>       URLs to export the links of, one per line, as stored in the project. Writes
                        selected-inlinks.csv and selected-outlinks.csv (every link into / out of those
                        pages, columns of the Inlinks / Outlinks tabs). Without --what, only these two
                        files are written; with it, they are added. URLs not in the project are listed
                        in errors and on stderr (exit 1); exit 2 when none is in the project.
  --save-set <name>   Save --what (and --raw-headers) in the project as a named export set, replacing
                        one of the same name; writes no files. The desktop scheduler can run it too.
  --set <name>        Run a saved export set instead of --what (exit 2 if the project has none of that name)
  --list-sets         List the project's saved export sets (--json: {ok, sets: [{name, what, rawHeaders}]})
  --json              Print {ok, files: [{path, label, rows}], errors: [...], skipped: [{label, reason}]}
                        on stdout, also on errors. skipped: a link report or dataset with no rows in
                        this crawl (no file written; not an error)
  Exit codes: 0 done, 1 some exports failed (the others are written), 2 bad arguments or project,
  130 interrupted (--json: ok false, error "interrupted", files: the items finished before Ctrl-C).

Projects:
  compare, analyze-logs, metrica-fetch and export open projects saved by the desktop app as well
  as CLI crawl databases. While analyze-logs or metrica-fetch writes to a desktop-saved project,
  it holds <project>.lock, and a second such command on the same file is refused (export
  takes the lock too, so it never reads a project another command is updating). The desktop
  app does not check that lock: if it has the same project open, its next Save overwrites what
  the CLI wrote (the app works on its own copy of the file).
`);
}

/** On/off flags that also take a `--no-` form; any other `--no-` form is refused. */
const NEGATABLE = new Set([
  'robots',
  'respect-crawl-delay',
  'external',
  'check-external',
  'image-variants',
  'adaptive-speed',
  'sitemap-discovery',
]);

/** The command line, strict: an unknown option or a missing value throws. */
function parseCliArgs() {
  const parsed = parseArgs({
    allowPositionals: true,
    allowNegative: true,
    tokens: true,
    options: {
      depth: { type: 'string' },
      max: { type: 'string' },
      'max-per-host': { type: 'string' },
      concurrency: { type: 'string' },
      rps: { type: 'string' },
      'night-rps': { type: 'string' },
      night: { type: 'string' },
      'user-agent': { type: 'string' },
      robots: { type: 'boolean' },
      'respect-crawl-delay': { type: 'boolean' },
      external: { type: 'boolean' },
      'check-external': { type: 'boolean' },
      'sitemap-discovery': { type: 'boolean' },
      sitemap: { type: 'string', multiple: true },
      proxy: { type: 'string' },
      'image-variants': { type: 'boolean' },
      'adaptive-speed': { type: 'boolean' },
      header: { type: 'string', multiple: true },
      include: { type: 'string', multiple: true },
      exclude: { type: 'string', multiple: true },
      list: { type: 'string' },
      config: { type: 'string' },
      db: { type: 'string' },
      out: { type: 'string' },
      'raw-headers': { type: 'boolean' },
      json: { type: 'boolean' },
      project: { type: 'string' },
      format: { type: 'string' },
      regex: { type: 'string' },
      'verify-bots': { type: 'boolean' },
      counter: { type: 'string' },
      days: { type: 'string' },
      metrics: { type: 'string' },
      limit: { type: 'string' },
      'start-url': { type: 'string' },
      rules: { type: 'string' },
      baseline: { type: 'string' },
      'write-snapshot': { type: 'string' },
      notify: { type: 'string' },
      what: { type: 'string' },
      urls: { type: 'string' },
      set: { type: 'string' },
      'save-set': { type: 'string' },
      'list-sets': { type: 'boolean' },
      'export-dir': { type: 'string' },
      'compare-with': { type: 'string' },
      export: { type: 'string' },
      'pid-file': { type: 'string' },
      resume: { type: 'boolean' },
      'stop-file': { type: 'string' },
      verbose: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  for (const token of parsed.tokens) {
    if (
      token.kind === 'option' &&
      token.rawName.startsWith('--no-') &&
      !NEGATABLE.has(token.name)
    ) {
      throw new Error(`Unknown option '${token.rawName}'`);
    }
  }
  return parsed;
}

async function main(): Promise<void> {
  let parsed: ReturnType<typeof parseCliArgs>;
  try {
    parsed = parseCliArgs();
  } catch (err) {
    // A typo in an option is a bad argument (exit 2), not a crash: the
    // message without a stack, as JSON when --json was asked for.
    const error = (err as Error).message;
    if (process.argv.includes('--json')) {
      process.stdout.write(JSON.stringify({ ok: false, error }, null, 2) + '\n');
    } else {
      console.error(`${error}\nRun freecrawl --help for the options.`);
    }
    process.exit(2);
  }
  const { values, positionals } = parsed;

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
      process.exit(
        usageFail(
          Boolean(values.json),
          'Usage: freecrawl compare <before.seoproject> <after.seoproject> [--json] [--out <dir>]',
          'Two project files are required.',
        ),
      );
    }
    exitOnInterrupt();
    const exitCode = await runCompare(resolve(positionals[1]), resolve(positionals[2]), {
      json: Boolean(values.json),
      outDir: values.out === undefined ? undefined : resolve(values.out),
    });
    process.exit(exitCode);
  }
  if (positionals[0] === 'history') {
    const exitCode = await runHistory({
      projectPath: values.project === undefined ? undefined : resolve(values.project),
      metrics: values.metrics,
      limit: values.limit,
      startUrl: values['start-url'],
      json: Boolean(values.json),
    });
    process.exit(exitCode);
  }
  if (positionals[0] === 'check') {
    exitOnInterrupt();
    const exitCode = await runCheck({
      projectPath: values.project === undefined ? undefined : resolve(values.project),
      rules: values.rules === undefined ? undefined : resolve(values.rules),
      baseline: values.baseline === undefined ? undefined : resolve(values.baseline),
      writeSnapshot: values['write-snapshot'] === undefined ? undefined : resolve(values['write-snapshot']),
      notify: values.notify,
      json: Boolean(values.json),
    });
    process.exit(exitCode);
  }
  if (positionals[0] === 'analyze-logs') {
    if (!positionals[1]) {
      console.error('Usage: freecrawl analyze-logs <access.log> [more.log …] [--project file] [--format f] [--regex p] [--verify-bots]');
      process.exit(2);
    }
    exitOnInterrupt();
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
  if (positionals[0] === 'export') {
    const exitCode = await runExport({
      projectPath: resolve(values.project ?? values.db ?? 'crawl.seoproject'),
      out: values.out,
      what: values.what,
      urls: values.urls,
      set: values.set,
      saveSet: values['save-set'],
      listSets: Boolean(values['list-sets']),
      rawHeaders: Boolean(values['raw-headers']),
      json: Boolean(values.json),
    });
    process.exit(exitCode);
  }

  // List mode is selected by `--list`; otherwise we need a positional URL.
  const listFile = values.list;
  if (values.help || (!listFile && positionals.length === 0 && !values.config)) {
    help();
    process.exit(values.help ? 0 : 1);
  }

  const dbPath = resolve(values.db ?? 'crawl.seoproject');

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
  const flagConfig: Partial<CrawlConfig> = {
    ...(values.depth !== undefined
      ? { maxDepth: parseNumeric('depth', values.depth, DEFAULT_CRAWL_CONFIG.maxDepth) }
      : {}),
    ...(values.max !== undefined
      ? { maxUrls: parseNumeric('max', values.max, DEFAULT_CRAWL_CONFIG.maxUrls) }
      : {}),
    ...(values['max-per-host'] !== undefined
      ? { maxUrlsPerHost: parsePositiveInt('max-per-host', values['max-per-host']) }
      : {}),
    ...(values.concurrency !== undefined
      ? { maxConcurrency: parseNumeric('concurrency', values.concurrency, DEFAULT_CRAWL_CONFIG.maxConcurrency) }
      : {}),
    ...(values.rps !== undefined
      ? { maxRps: parseNumeric('rps', values.rps, DEFAULT_CRAWL_CONFIG.maxRps, { integer: false }) }
      : {}),
    ...(values['night-rps'] !== undefined
      ? {
          nightMaxRps: parseNumeric('night-rps', values['night-rps'], 0, { integer: false }),
        }
      : {}),
    ...(values.night !== undefined ? parseNightWindow(values.night) : {}),
    ...(values['user-agent'] !== undefined ? { userAgent: values['user-agent'] } : {}),
    // On/off flags in either direction (`--robots` / `--no-robots`);
    // absent, the file value (or default) stands.
    respectRobotsTxt: values.robots,
    respectCrawlDelay: values['respect-crawl-delay'],
    crawlExternal: values.external,
    checkExternalLinks: values['check-external'],
    crawlImageVariants: values['image-variants'],
    adaptiveSpeed: values['adaptive-speed'],
    discoverSitemaps: values['sitemap-discovery'],
    ...(values.sitemap !== undefined ? { seedSitemapUrls: values.sitemap } : {}),
    ...(values.proxy !== undefined ? { proxyUrl: values.proxy } : {}),
    ...(values.header !== undefined ? { customHeaders: parseHeaders(values.header) } : {}),
    ...(values.include !== undefined ? { includePatterns: values.include } : {}),
    ...(values.exclude !== undefined ? { excludePatterns: values.exclude } : {}),
  };
  // Read after the config file so a link is fetched with the crawl's user agent.
  let listUrls: string[] = [];
  if (listFile) {
    const userAgent =
      values['user-agent'] ??
      (typeof fileConfig.userAgent === 'string'
        ? fileConfig.userAgent
        : DEFAULT_CRAWL_CONFIG.userAgent);
    try {
      listUrls = await readListSource(listFile, { userAgent });
    } catch (err) {
      console.error(`Cannot read --list ${listFile}: ${(err as Error).message}`);
      process.exit(2);
    }
    if (listUrls.length === 0) {
      console.error(`--list ${listFile} contains no URLs.`);
      process.exit(2);
    }
  }
  const merged = mergeCrawlConfig(
    fileConfig,
    flagConfig,
    listFile ? { listUrls } : positionals.length > 0 ? { url: positionals[0]! } : {},
  );
  if (merged.kind === 'usage') {
    help();
    process.exit(1);
  }
  if (merged.kind === 'error') {
    console.error(merged.message);
    process.exit(2);
  }
  const { config, listMode } = merged;
  const startUrl = config.startUrl;
  if (values.night !== undefined && !(config.nightMaxRps > 0)) {
    console.error('--night needs --night-rps <n> (or nightMaxRps in --config).');
    process.exit(2);
  }
  if (config.nightMaxRps > 0 && config.nightFromHour === config.nightToHour) {
    merged.notes.push(
      `The night window starts and ends at ${config.nightFromHour}:00, so the night rate is never used.`,
    );
  }
  for (const message of merged.notes) {
    process.stderr.write(
      values.json
        ? JSON.stringify({ type: 'warn', time: new Date().toISOString(), message }) + '\n'
        : `[warn] ${message}\n`,
    );
  }

  // `--export-dir` exports right after the crawl; checked up front so a
  // typo fails before a long crawl instead of after it.
  let postCrawlExport: { dir: string; items: ExportItem[] } | null = null;
  if (values['export-dir'] !== undefined) {
    try {
      const dir = resolve(values['export-dir']);
      checkExportDir(dir);
      postCrawlExport = { dir, items: parseExportWhat(values.export) };
    } catch (err) {
      console.error((err as Error).message);
      process.exit(2);
    }
  } else if (values.export !== undefined) {
    console.error('--export needs --export-dir <dir>.');
    process.exit(2);
  }
  const compareWith = values['compare-with'] !== undefined ? resolve(values['compare-with']) : null;
  if (compareWith === dbPath) {
    console.error('--compare-with needs another project than --db: the crawl rewrites its own.');
    process.exit(2);
  }
  if (compareWith !== null && !existsSync(compareWith)) {
    console.error(`Project not found: ${compareWith}`);
    process.exit(2);
  }

  // A pattern that is not a regular expression would leave the crawl
  // unscoped; refuse before the project file exists.
  const badPattern = invalidUrlPatterns(config)[0];
  if (badPattern !== undefined) {
    if (values.json)
      process.stdout.write(JSON.stringify({ ok: false, error: badPattern }, null, 2) + '\n');
    else console.error(badPattern);
    process.exit(2);
  }

  const stopFile = values['stop-file'] === undefined ? null : resolve(values['stop-file']);
  if (stopFile !== null && existsSync(stopFile)) {
    console.error(`Stop file ${stopFile} already exists; remove it first.`);
    process.exit(2);
  }
  if (values['pid-file'] !== undefined) writePidFile(resolve(values['pid-file']));

  // A crawl writes the SQLite file in place; a project the desktop app
  // saved (a packed container) or another file would fail mid-open. An
  // empty file is a new project, as a missing one is.
  if (existsSync(dbPath) && statSync(dbPath).size > 0) {
    const format = detectProjectFormat(dbPath);
    if (format !== 'sqlite') {
      console.error(
        format === 'archive'
          ? `${dbPath} was saved by the desktop app; crawl into a new --db path.`
          : `${dbPath} is not a FreeCrawl project.`,
      );
      process.exit(2);
    }
  }

  // One crawl per project file; a lock left by a killed process is taken over.
  try {
    pendingCleanups.add(lockProject(dbPath));
  } catch (err) {
    console.error((err as Error).message);
    process.exit(2);
  }
  const resume = values.resume
    ? resumeTarget(dbPath, listMode, startUrl, Boolean(values.json))
    : null;
  if (resume !== null) config.startUrl = resume;

  // Opened only after every flag validated, so a bad argument leaves no
  // empty project file behind.
  const db = new ProjectDb(dbPath);
  const crawler = new Crawler(config, db, {
    toolVersion: cliVersion(),
    resumeOnly: resume !== null,
  });
  // URLs that were queued or in flight when the crawl stopped; the ones
  // fetched after the last checkpoint write are left out.
  if (resume !== null) crawler.enqueueCheckpointed(db.loadUnfetchedQueueCheckpoint());
  const jsonMode = Boolean(values.json);

  // Events while the crawl runs go to stderr, so stdout keeps only the
  // progress line or, with --json, the one summary document.
  const report = (
    type: 'progress' | 'error' | 'warn' | 'info' | 'export',
    fields: Record<string, unknown>,
  ) => {
    if (jsonMode) {
      process.stderr.write(
        JSON.stringify({ type, time: new Date().toISOString(), ...fields }) + '\n',
      );
    } else {
      // Own line: the \r progress line on stdout would overwrite it.
      process.stderr.write(`\n[${type}] ${String(fields.message)}\n`);
    }
  };
  let lastProgress: CrawlProgress | null = null;
  let progressTimer: ReturnType<typeof setInterval> | null = null;
  if (jsonMode) {
    crawler.on('progress', (p) => (lastProgress = p));
    progressTimer = setInterval(() => {
      if (!lastProgress) return;
      const { crawled, discovered, pending, failed, urlsPerSecond, elapsedMs } = lastProgress;
      report('progress', { crawled, discovered, pending, failed, urlsPerSecond, elapsedMs });
    }, 10_000);
  } else {
    crawler.on('progress', (p) => {
      process.stdout.write(
        `\r[${p.crawled}/${p.discovered}] pending=${p.pending} failed=${p.failed} @ ${p.urlsPerSecond.toFixed(1)} URL/s  avg=${p.avgResponseTimeMs}ms  t=${Math.round(p.elapsedMs / 1000)}s   `,
      );
    });
  }
  let crawlError: string | null = null;
  crawler.on('error', (msg) => {
    // The first error goes into --json `error` and makes the exit code 1;
    // whether the crawl finished at all is `crawler.incomplete`.
    if (crawlError === null) crawlError = String(msg);
    report('error', { message: String(msg) });
  });
  // One warning per broken URL would bury the rest on a big site: the
  // first ones print, the others only with --verbose.
  let perUrlWarnings = 0;
  crawler.on('warn', (msg) => {
    const message = String(msg);
    if (!values.verbose && /^(HTTP \d{3} on |Fetch failed )/.test(message)) {
      perUrlWarnings++;
      if (perUrlWarnings > PER_URL_WARNINGS_SHOWN) {
        if (perUrlWarnings === PER_URL_WARNINGS_SHOWN + 1) {
          report('warn', { message: 'more per-URL warnings not shown; --verbose shows all' });
        }
        return;
      }
    }
    report('warn', { message });
  });
  // Adaptive speed changing the rate is shown always: it explains a slow crawl.
  crawler.on('info', (msg) => {
    const message = String(msg);
    if (values.verbose || message.startsWith('Adaptive speed:')) report('info', { message });
  });
  let refreshing = false;
  crawler.on('start-decision', (d: StartDecision) => {
    refreshing = d.kind === 'refresh';
    if (d.kind === 'refresh') {
      report('warn', {
        message: `${d.knownPages} pages already in ${dbPath}; all of them are fetched again. To continue an interrupted crawl, add --resume.`,
      });
    } else if (d.kind === 'replace') {
      report('warn', {
        message: `${dbPath} held a crawl of ${d.previousStartUrl}; it is replaced by this one.`,
      });
    }
  });

  // Soft stop: the first signal saves the queue for --resume and stops the
  // crawler, which still recounts issues. The handlers go at once, so a
  // second signal gets the default action and kills the process even
  // while a long synchronous recount holds the event loop.
  let interrupted = false;
  let stoppedByFile = false;
  const signals = ['SIGINT', 'SIGTERM', 'SIGBREAK'] as const;
  const dropSignalHandlers = () => {
    for (const s of signals) process.off(s, softStop);
  };
  const softStop = () => {
    dropSignalHandlers();
    if (stopFileTimer) clearInterval(stopFileTimer);
    if (crawler.finishingRun) {
      // Stopping now would only lose the history entry of a finished crawl.
      report('warn', {
        message: 'The crawl has finished; recounting issues. Press Ctrl-C again to quit at once.',
      });
      return;
    }
    interrupted = true;
    report('warn', {
      message:
        'Stopping: finishing writes and recounting issues. Press Ctrl-C again to quit at once.',
    });
    if (refreshing) {
      report('warn', {
        message:
          'This was a refresh: --resume finishes only new pages; run without --resume to fetch every page again.',
      });
    }
    void crawler.saveQueueCheckpoint().finally(() => crawler.stop());
  };
  for (const s of signals) process.on(s, softStop);
  const stopFileTimer =
    stopFile === null
      ? null
      : setInterval(() => {
          if (!existsSync(stopFile)) return;
          stoppedByFile = true;
          softStop();
        }, 1000);

  // A crawl that finished on its own while a stop was on its way is
  // complete: 'done' fires only for a crawl that was not stopped first.
  let finished = false;
  crawler.on('done', () => (finished = true));
  await crawler.start();
  if (finished) interrupted = false;
  if (progressTimer) clearInterval(progressTimer);
  if (stopFileTimer) clearInterval(stopFileTimer);
  dropSignalHandlers();
  if (stoppedByFile) rmSync(stopFile!, { force: true });
  if (perUrlWarnings > PER_URL_WARNINGS_SHOWN) {
    report('warn', {
      message: `${perUrlWarnings} per-URL warnings in all, ${PER_URL_WARNINGS_SHOWN} of them shown`,
    });
  }
  if (interrupted && (values.out || postCrawlExport || compareWith !== null)) {
    report('warn', { message: 'export and compare skipped: the crawl was stopped' });
  }
  if (!jsonMode) process.stdout.write('\n');

  const summary = db.getSummary();
  let exportedTo: string | null = null;
  let rowsWritten = 0;
  if (values.out && !interrupted) {
    const outPath = resolve(values.out);
    // Auto-detect format from extension. `.json` -> full JSON dump, anything
    // else -> CSV (existing behaviour).
    const isJson = outPath.toLowerCase().endsWith('.json');
    const r = isJson
      ? await exportUrlsToJson(db, outPath, { pretty: true })
      : await exportUrlsToCsv(db, outPath, {
          headers: values['raw-headers'] ? 'keys' : 'labels',
        });
    rowsWritten = r.rowsWritten;
    exportedTo = outPath;
  }

  let exported: ExportOutcome | null = null;
  if (postCrawlExport && !interrupted) {
    // Ctrl-C from here on exits at once; the exit hook drops any
    // half-written `.part` file.
    exitOnInterrupt();
    pendingCleanups.add(removePartialExportFiles);
    exported = await runExportItems(db, postCrawlExport.dir, postCrawlExport.items, {
      rawHeaders: Boolean(values['raw-headers']),
      projectFile: dbPath,
      toolVersion: cliVersion(),
      onProgress: jsonMode ? (line) => report('export', { message: line }) : progressLine,
    });
  }

  let compared: CompareSummary | null = null;
  let compareError: string | null = null;
  if (compareWith !== null && !interrupted) {
    try {
      const previous = await openCompareProject(compareWith);
      try {
        compared = await compareWithoutMmap(previous.db, db, () =>
          postCrawlExport
            ? compareToFiles(previous.db, db, postCrawlExport.dir)
            : compareCrawls(previous.db, db),
        );
      } finally {
        previous.dispose();
      }
    } catch (err) {
      compareError = (err as Error).message;
    }
  }

  const overview = db.getOverviewCounts();
  const issues = overview.issues;
  const soft404Probe = overview.site?.soft404Probe ?? null;
  const botBlocked = overview.site?.botBlocked ?? null;
  const siteWide = overview.site?.siteWide ?? null;
  const sitemapFindings = overview.site?.sitemapFindings ?? null;
  const crawlStoppedAtLimit = overview.site?.crawlStoppedAtLimit ?? null;
  // Not complete: stopped, ended early for a reason the crawler names, or
  // not a single page answered (everything filtered or unreachable).
  const incomplete = crawler.incomplete;
  const complete = !interrupted && incomplete === null && db.countCrawledUrls() > 0;
  const hasErrors =
    !complete ||
    crawlError !== null ||
    Object.keys(summary.byStatus).some((k) => {
      const n = Number.parseInt(k, 10);
      return Number.isFinite(n) && n >= 400;
    });

  if (jsonMode) {
    process.stdout.write(
      JSON.stringify(
        {
          ok: !hasErrors,
          complete,
          interrupted,
          incomplete,
          error: crawlError,
          startUrl,
          dbPath,
          summary,
          issues,
          site: {
            soft404Probe,
            botBlocked,
            siteWide,
            crawlStoppedAtLimit,
            hostLimitSkipped: crawler.hostLimitSkipped,
          },
          sitemapFindings,
          exportedTo,
          rowsExported: exportedTo ? rowsWritten : null,
          ...(exported ? { exports: { ok: exported.errors.length === 0, ...exported } } : {}),
          ...(compareWith !== null
            ? {
                compare: compared
                  ? {
                      with: compareWith,
                      totalBefore: compared.totalA,
                      totalAfter: compared.totalB,
                      counts: compared.counts,
                      issueChanges: compared.issueChanges,
                      notComparable: compared.notComparable,
                      mapped: compared.mapped,
                    }
                  : { with: compareWith, error: compareError },
              }
            : {}),
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
    if (exported) {
      console.log(`Exported ${exported.files.length} file(s) -> ${postCrawlExport!.dir}`);
      for (const e of exported.errors) console.error(`Export failed: ${e.label}: ${e.error}`);
      for (const k of exported.skipped) console.error(`Export skipped: ${k.label}: ${k.reason}`);
    }
    if (compared) console.log(compareChangesText(compared));
    if (compareError !== null) console.error(`Compare with ${compareWith} failed: ${compareError}`);
    if (botBlocked) {
      console.log(
        `Warning: bot protection blocked ${botBlocked.count} URL(s)` +
          (botBlocked.sample ? ` (${botBlocked.sample})` : '') +
          ' — not crawled; lower --rps or allowlist the crawler and re-run',
      );
    }
    if (soft404Probe) {
      console.log(
        `Warning: missing pages return ${soft404Probe.status} (soft 404) — ${soft404Probe.url}` +
          (soft404Probe.finalUrl ? ` -> ${soft404Probe.finalUrl}` : ''),
      );
    }
    if (crawlStoppedAtLimit) console.log(`Stopped at the page limit (${crawlStoppedAtLimit}).`);
    for (const f of sitemapFindings?.overUrls ?? []) {
      console.log(`Warning: sitemap over 50,000 URLs — ${f.url}`);
    }
    for (const f of sitemapFindings?.overSize ?? []) {
      console.log(`Warning: sitemap over 50 MB — ${f.url}`);
    }
    for (const f of sitemapFindings?.duplicateEntries ?? []) {
      console.log(`Warning: sitemap lists ${f.duplicateEntries} URL(s) twice — ${f.url}`);
    }
    if (sitemapFindings?.inSeveral.count) {
      console.log(`Note: ${sitemapFindings.inSeveral.count} URL(s) in several sitemap files`);
    }
    if (issues.sitemapNotCrawled) {
      console.log(
        `Note: ${issues.sitemapNotCrawled} sitemap URL(s) not crawled` +
          (crawlStoppedAtLimit
            ? ` (the crawl stopped at its limit of ${crawlStoppedAtLimit} pages)`
            : ''),
      );
    }
  }

  db.close();
  // 4: the crawl itself did not finish, so its numbers are not a verdict;
  // 1: it finished and found broken URLs, or a step after it failed.
  process.exit(
    interrupted
      ? 130
      : !complete
        ? 4
        : hasErrors || (exported !== null && exported.errors.length > 0) || compareError !== null
          ? 1
          : 0,
  );
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

/**
 * Parse a non-negative numeric flag. A bad value exits 2 instead of falling
 * back: `parseInt('0.5')` used to turn `--rps 0.5` into 0, which means
 * "no rate limit" — the opposite of what the user asked for.
 */
function parseNumeric(
  flag: string,
  value: string | undefined,
  fallback: number,
  { integer = true }: { integer?: boolean } = {},
): number {
  if (value === undefined) return fallback;
  const n = Number(value.trim());
  if (value.trim() === '' || !Number.isFinite(n) || n < 0 || (integer && !Number.isInteger(n))) {
    console.error(
      `Invalid --${flag}: ${value} (expected a non-negative ${integer ? 'whole number' : 'number'}).`,
    );
    process.exit(2);
  }
  return n;
}

function parsePositiveInt(flag: string, value: string): number {
  const n = Number(value.trim());
  if (value.trim() === '' || !Number.isInteger(n) || n <= 0) {
    console.error(`Invalid --${flag}: ${value} (expected a positive whole number).`);
    process.exit(2);
  }
  return n;
}

/** `--night 22-6`: whole hours 0-23, local time. */
function parseNightWindow(value: string): Pick<CrawlConfig, 'nightFromHour' | 'nightToHour'> {
  const m = /^(\d{1,2})-(\d{1,2})$/.exec(value.trim());
  const from = m ? Number(m[1]) : NaN;
  const to = m ? Number(m[2]) : NaN;
  if (!(from <= 23 && to <= 23)) {
    console.error(`Invalid --night: ${value} (expected <from>-<to>, hours 0-23, e.g. 22-6).`);
    process.exit(2);
  }
  return { nightFromHour: from, nightToHour: to };
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
    const validation = validateFetchedSitemaps(result);
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

/** Cleanups still due; the exit hook runs them after Ctrl-C or a crash, so
 *  no working copy is left in the temp directory. */
const pendingCleanups = new Set<() => void>();
process.on('exit', () => {
  for (const cleanup of pendingCleanups) cleanup();
});

/** `--pid-file`: this process's id, removed at exit while it is still ours. */
function writePidFile(path: string): void {
  const pid = String(process.pid);
  writeFileSync(path, pid + '\n');
  pendingCleanups.add(() => {
    if (readIfExists(path)?.trim() === pid) rmSync(path, { force: true });
  });
}

/** Ctrl-C for a command with no cancel of its own: exit through
 *  `process.exit`, so the exit hook still removes working copies.
 *  `report` runs first, e.g. to print a `--json` summary. */
function exitOnInterrupt(report?: () => void): void {
  // `on`, not `once`: a second Ctrl-C while the exit hook runs must not
  // fall back to the default kill and cut the cleanup short.
  process.on('SIGINT', () => {
    process.stderr.write('\nInterrupted.\n');
    try {
      report?.();
    } finally {
      process.exit(130);
    }
  });
}

/**
 * Cross-project diff. Opens two `.seoproject` files (`openCompareProject`:
 * only a file whose stored checks predate this build is written, once, with
 * them rebuilt), runs the same `compareCrawls` engine the desktop
 * Compare dialog uses, and prints the counts per kind (--json: the whole
 * summary with samples, issueChanges and notComparable). With `--out <dir>`
 * it also writes `compare-summary.json` and one CSV per kind with every row.
 *
 * Exit code: 0 when both projects load and nothing changed; 1 when at least
 * one kind or check had a change (useful for CI gates that want to fail on
 * regressions); 2 on fatal load error.
 */
async function runCompare(
  beforePath: string,
  afterPath: string,
  opts: { json: boolean; outDir?: string },
): Promise<number> {
  const usage = 'Usage: freecrawl compare <before.seoproject> <after.seoproject> [--json] [--out <dir>]';
  const opened: CompareProject[] = [];
  const disposeAll = (): void => {
    for (const p of opened) p.dispose();
  };
  pendingCleanups.add(disposeAll);
  try {
    for (const [label, path] of [['before', beforePath], ['after', afterPath]] as const) {
      try {
        const project = await openCompareProject(path);
        opened.push(project);
        if (project.rebuiltSaved) {
          process.stderr.write(`Checks of the ${label} project were brought up to date and saved in ${path}.\n`);
        }
      } catch (err) {
        return usageFail(opts.json, usage, `Cannot open ${label} project: ${(err as Error).message}`);
      }
    }
    const [before, after] = opened as [CompareProject, CompareProject];
    const summary = await compareWithoutMmap(before.db, after.db, () =>
      opts.outDir ? compareToFiles(before.db, after.db, opts.outDir) : compareCrawls(before.db, after.db),
    );
    if (opts.json) {
      // Awaited: the caller exits right after, which would cut a long pipe write short.
      await new Promise<void>((done) =>
        process.stdout.write(JSON.stringify({ ok: true, before: beforePath, after: afterPath, ...summary }, null, 2) + '\n', () => done()),
      );
    } else {
      console.log(`Compare: ${beforePath} → ${afterPath}`);
      console.log(`  Total before: ${summary.totalA}`);
      console.log(`  Total after:  ${summary.totalB}`);
      if (summary.mapped.count > 0) {
        console.log(`  ${summary.mapped.count} URLs paired across scheme/www changes`);
      }
      console.log(`  Diff:`);
      for (const [cat, count] of Object.entries(summary.counts)) {
        console.log(`    ${cat.padEnd(15)} ${count}`);
      }
      for (const [kind, n] of Object.entries(summary.notComparable)) {
        console.log(`  Not comparable: ${kind} (${n.urls} pages): ${n.reason}`);
      }
      if (opts.outDir) console.log(`  Written to ${opts.outDir}`);
    }
    const changed =
      Object.values(summary.counts).some((n) => n > 0) || Object.keys(summary.issueChanges).length > 0;
    return changed ? 1 : 0;
  } finally {
    pendingCleanups.delete(disposeAll);
    disposeAll();
  }
}

/** Print a usage error (JSON on stdout with --json, else the usage line and
 *  the message on stderr) and return exit code 2. */
function usageFail(json: boolean, usage: string, message: string): number {
  if (json) process.stdout.write(JSON.stringify({ ok: false, error: message }, null, 2) + '\n');
  else {
    console.error(usage);
    console.error(message);
  }
  return 2;
}

/**
 * Crawl history of one start URL (the project's own unless `--start-url`),
 * oldest first, one column per metric. Read-only. Exit 0 also for a project
 * with no crawls yet (an empty list); 2 on bad arguments or project.
 */
async function runHistory(opts: {
  projectPath: string | undefined;
  metrics: string | undefined;
  limit: string | undefined;
  startUrl: string | undefined;
  json: boolean;
}): Promise<number> {
  const fail = (message: string): number =>
    usageFail(
      opts.json,
      'Usage: freecrawl history --project <file> --metrics <a,b,…> [--limit N] [--start-url <url>] [--json]',
      message,
    );
  if (!opts.projectPath) return fail('--project <file> is required.');
  if (!opts.metrics) return fail('--metrics <a,b,…> is required.');
  const metrics = opts.metrics.split(',').map((m) => m.trim()).filter((m) => m.length > 0);
  try {
    for (const m of metrics) assertMetric(m);
  } catch (err) {
    return fail((err as Error).message);
  }
  let limit: number | undefined;
  if (opts.limit !== undefined) {
    limit = Number(opts.limit);
    if (!Number.isInteger(limit) || limit < 1) return fail('--limit must be a whole number, 1 or more.');
  }
  let project: OpenedProject;
  try {
    project = await openProject(opts.projectPath, { cleanups: pendingCleanups });
  } catch (err) {
    return fail(`Cannot open project ${opts.projectPath}: ${(err as Error).message}`);
  }
  try {
    // Default: the site of the newest crawl, as stored in its history row.
    const history = historyRows(project.db, metrics, { startUrl: opts.startUrl, limit });
    if (opts.json) {
      const runs = history.rows.map((row) => ({ finishedAt: row.finishedAt, ...row.values }));
      process.stdout.write(JSON.stringify({ ok: true, startUrl: history.startUrl ?? '', runs }, null, 2) + '\n');
    } else {
      console.log(['finishedAt', ...metrics].join(','));
      for (const row of history.rows) {
        console.log([row.finishedAt, ...metrics.map((m) => String(row.values[m] ?? ''))].join(','));
      }
    }
    return 0;
  } finally {
    project.dispose();
  }
}

/**
 * Alert channels of `check --notify`: the variables each reads and its
 * sender. `title` names the site, so alerts of several projects in one
 * channel can be told apart.
 */
const NOTIFY_CHANNELS: Record<
  string,
  { env: string[]; send: (v: string[], results: AlertRuleResult[], title: string) => Promise<SendResult> }
> = {
  slack: { env: ['FREECRAWL_SLACK_WEBHOOK_URL'], send: ([url = ''], r, title) => sendSlack(url, r, { title }) },
  telegram: {
    env: ['FREECRAWL_TELEGRAM_BOT_TOKEN', 'FREECRAWL_TELEGRAM_CHAT_ID'],
    send: ([token = '', chatId = ''], r, title) =>
      sendTelegram({ apiBase: TELEGRAM_API_BASE, token, chatId }, r, { title }),
  },
  webhook: { env: ['FREECRAWL_WEBHOOK_URL'], send: ([url = ''], r, title) => sendWebhook(url, r, { title }) },
  email: {
    env: ['FREECRAWL_SMTP_URL', 'FREECRAWL_ALERT_EMAIL_TO'],
    send: ([smtp = '', to = ''], r, title) => sendEmail(smtp, to, r, { title }),
  },
};

/**
 * Release gate: the project's newest crawl against a rule file, compared with
 * the crawl before it (same start URL), a baseline project or a snapshot
 * file. Read-only. Exit 0 pass, 1 a fail rule fired or could not be computed,
 * 2 bad arguments, rules, project or no history. Delivery to `--notify`
 * channels is best effort and never changes the exit code.
 */
async function runCheck(opts: {
  projectPath: string | undefined;
  rules: string | undefined;
  baseline: string | undefined;
  writeSnapshot: string | undefined;
  notify: string | undefined;
  json: boolean;
}): Promise<number> {
  const fail = (message: string): number =>
    usageFail(
      opts.json,
      'Usage: freecrawl check --project <file> [--rules <file>] [--baseline <project|snapshot.json>] [--write-snapshot <file>] [--notify slack,telegram,webhook,email] [--json]',
      message,
    );
  if (!opts.projectPath) return fail('--project <file> is required.');
  // Channels are checked before any work, naming the variable, never its value.
  const channels = (opts.notify ?? '').split(',').map((c) => c.trim()).filter((c) => c.length > 0);
  if (opts.notify !== undefined && channels.length === 0) return fail('--notify needs at least one channel.');
  const secrets = new Map<string, string[]>();
  for (const c of channels) {
    const channel = NOTIFY_CHANNELS[c];
    if (!channel) return fail(`Unknown channel: ${c}. Valid channels: ${Object.keys(NOTIFY_CHANNELS).join(', ')}`);
    const missing = channel.env.find((name) => !process.env[name]);
    if (missing) return fail(`--notify ${c} needs the environment variable ${missing}.`);
    secrets.set(c, channel.env.map((name) => process.env[name] as string));
  }
  let project: OpenedProject;
  try {
    project = await openProject(opts.projectPath, { cleanups: pendingCleanups });
  } catch (err) {
    return fail(`Cannot open project ${opts.projectPath}: ${(err as Error).message}`);
  }
  try {
    let rules;
    try {
      const text = opts.rules !== undefined ? readFileSync(opts.rules, 'utf8') : project.db.getMeta(MONITOR_RULES_META_KEY);
      if (text === null) return fail('No rules: pass --rules <file>, or save rules in the project.');
      rules = parseRules(JSON.parse(text));
    } catch (err) {
      return fail(`Cannot read rules${opts.rules ? ` ${opts.rules}` : ''}: ${(err as Error).message}`);
    }
    // An empty list would pass every release: all rules deleted is not a green gate.
    if (rules.length === 0) {
      return fail(
        opts.rules !== undefined
          ? `No rules in ${opts.rules}: the "rules" list is empty.`
          : "No rules: the project's saved rule list is empty; pass --rules <file>, or add rules in the project.",
      );
    }
    const latest = latestAndPrevious(project.db);
    if (!latest) return fail('The project has no crawl history (no crawl has finished in it).');
    const { current } = latest;
    let previous: CrawlSnapshot | null = latest.previous?.snapshot ?? null;
    let baselineSource: string | null = latest.previous?.finishedAt ?? null;
    if (opts.baseline !== undefined) {
      try {
        if (!existsSync(opts.baseline)) throw new Error('file not found');
        if (detectProjectFormat(opts.baseline) === 'unknown') {
          const snap = JSON.parse(readFileSync(opts.baseline, 'utf8')) as CrawlSnapshot;
          if (snap?.version !== 1 || !snap.summary || !snap.counts) throw new Error('not a snapshot (version 1)');
          // Without a start URL the file could be any site's counts.
          if (snap.startUrl === undefined) {
            throw new Error('it does not name its site; write it again with --write-snapshot');
          }
          if (snap.startUrl !== current.startUrl) {
            throw new Error(`it is a snapshot of ${snap.startUrl}, not of ${current.startUrl}`);
          }
          previous = snap;
        } else {
          const base = await openProject(opts.baseline, { cleanups: pendingCleanups });
          try {
            const row = base.db.listCrawlRuns(current.startUrl, 1)[0];
            if (!row) {
              // Comparing another site's counts would gate on nonsense.
              const other = base.db.latestCrawlRunStartUrl();
              throw new Error(
                other === null ? 'the project has no crawl history' : `no crawl of ${current.startUrl} in it (its last crawl is ${other})`,
              );
            }
            previous = row.snapshot;
          } finally {
            base.dispose();
          }
        }
        baselineSource = opts.baseline;
      } catch (err) {
        return fail(`Cannot use baseline ${opts.baseline}: ${(err as Error).message}`);
      }
    }
    if (opts.writeSnapshot !== undefined) {
      try {
        const snapshot: CrawlSnapshot = { ...current.snapshot, startUrl: current.startUrl };
        writeFileSync(opts.writeSnapshot, JSON.stringify(snapshot, null, 2) + '\n');
      } catch (err) {
        return fail(`Cannot write snapshot ${opts.writeSnapshot}: ${(err as Error).message}`);
      }
    }
    const results = evaluateRules(rules, current.snapshot, previous);
    const failed = gateFails(results);
    const notified: Array<{ channel: string; ok: boolean; detail: string }> = [];
    if (results.some((r) => r.status === 'fired')) {
      for (const c of channels) {
        const sent = await NOTIFY_CHANNELS[c]!.send(secrets.get(c) ?? [], results, `FreeCrawl alert for ${current.startUrl}`);
        notified.push({ channel: c, ...sent });
      }
    }
    if (opts.json) {
      process.stdout.write(
        JSON.stringify(
          { ok: !failed, startUrl: current.startUrl, finishedAt: current.finishedAt, baseline: baselineSource, results, notified },
          null,
          2,
        ) + '\n',
      );
    } else {
      console.log(`${current.startUrl} (crawl ${current.finishedAt}, baseline ${baselineSource ?? 'none'})`);
      for (const r of results) {
        console.log(`${r.status.toUpperCase()} [${r.level}] ${r.name}: ${r.metric} ${r.previous ?? 'n/a'} -> ${r.current ?? 'n/a'}`);
      }
      for (const n of notified) console.log(`notify ${n.channel}: ${n.ok ? 'sent' : 'failed'} (${n.detail})`);
      console.log(failed ? 'GATE FAILED' : 'GATE PASSED');
    }
    return failed ? 1 : 0;
  } finally {
    project.dispose();
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
  let project: OpenedProject;
  try {
    // A missing project is created, so logs can be analysed without a crawl.
    project = await openProject(opts.projectPath, {
      createIfMissing: true,
      forWrite: true,
      cleanups: pendingCleanups,
    });
  } catch (err) {
    const error = `Cannot open project ${opts.projectPath}: ${(err as Error).message}`;
    if (opts.json) {
      process.stdout.write(JSON.stringify({ ok: false, error, imported: [], errors: [] }, null, 2) + '\n');
    } else {
      console.error(error);
    }
    return 2;
  }
  const { db } = project;
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
    await project.save();

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
    project.dispose();
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
 * given, else the project's `lastCrawlConfig` (only the desktop app saves
 * one: the `{config, secretsEnc}` envelope or a bare config; secrets are
 * irrelevant here), else defaults.
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
 * Ctrl-C during the pull cancels and writes nothing; once the write has
 * started it exits at once, leaving the project either untouched or fully
 * updated. Exit 0 on success, 1 on an API or write failure, 2 on bad
 * arguments or a locked project, 130 when cancelled or interrupted.
 */
async function runMetricaFetch(opts: {
  counter: string | undefined;
  days: string | undefined;
  projectPath: string;
  configPath: string | undefined;
  json: boolean;
}): Promise<number> {
  // Bad arguments fail like API errors: JSON on stdout with --json.
  const fail = (message: string): number => metricaFail(opts.json, new Error(message), 2);
  const counterId = (opts.counter ?? '').trim();
  if (!/^\d+$/.test(counterId)) {
    if (!opts.json) {
      console.error(
        'Usage: freecrawl metrica-fetch --counter <id> [--days 7|28|90] [--project file] [--config file] [--json]',
      );
    }
    return fail(
      opts.counter === undefined
        ? '--counter is required.'
        : `Invalid --counter: ${opts.counter} (expected a numeric counter id).`,
    );
  }
  const days = opts.days === undefined ? 28 : Number(opts.days);
  if (days !== 7 && days !== 28 && days !== 90) {
    return fail(`Invalid --days: ${opts.days} (expected 7, 28 or 90).`);
  }
  // ProjectDb creates a missing file; a pull into an empty project would
  // join onto nothing, so a typo in --project must fail instead.
  if (!existsSync(opts.projectPath)) {
    return fail(`Project not found: ${opts.projectPath} (crawl it first, or pass --project).`);
  }
  let token: string;
  try {
    token = metricaToken();
  } catch (err) {
    return metricaFail(opts.json, err, 2);
  }

  // Installed before the project opens, so Ctrl-C while a desktop-saved
  // project unpacks also cancels. Once the write has started, or on a
  // second Ctrl-C, it exits at once instead: the exit hook drops a
  // half-written pack, and the original is only replaced by its final
  // rename, so the project is either untouched or completely updated.
  const abort = new AbortController();
  let writing = false;
  const onSigint = (): void => {
    if (writing || abort.signal.aborted) {
      process.stderr.write('\nInterrupted.\n');
      process.exit(130);
    }
    process.stderr.write('\nCancelling the Yandex Metrica fetch…\n');
    abort.abort();
  };
  process.on('SIGINT', onSigint);
  let project: OpenedProject;
  try {
    project = await openProject(opts.projectPath, { forWrite: true, cleanups: pendingCleanups });
  } catch (err) {
    process.off('SIGINT', onSigint);
    return fail(`Cannot open project ${opts.projectPath}: ${(err as Error).message}`);
  }
  const { db } = project;
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
      return fail(`Cannot read --config file ${opts.configPath}: ${(err as Error).message}`);
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
    // A cancel acknowledged during the pull writes nothing. The check and
    // the flag sit in the same tick as the (synchronous) DB write.
    if (abort.signal.aborted) throw new MetricaCancelledError();
    writing = true;
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
    await project.save();

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
    // Cleanup first: without a listener, Ctrl-C kills the process at once
    // and would leave the working copy behind.
    project.dispose();
    process.off('SIGINT', onSigint);
  }
}

/** The CLI's own version, from its package.json (recorded in bulk manifests). */
function cliVersion(): string {
  try {
    const pkg = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    ) as { version?: string };
    return pkg.version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * `--resume`: the start URL to continue from (the list's first line in list
 * mode), or null for a new crawl when the project is missing or empty.
 * Exits 2 when the project holds another site or another kind of crawl.
 * Read-only, so a refused resume leaves the file as it was.
 */
function resumeTarget(
  dbPath: string,
  listMode: boolean,
  startUrl: string,
  json: boolean,
): string | null {
  let stored: string | null = null;
  let rows = 0;
  if (existsSync(dbPath)) {
    const p = new ProjectDb(dbPath, { readOnly: true });
    try {
      stored = p.getMeta('startUrl');
      rows = p.countUrls();
    } finally {
      p.close();
    }
  }
  if (stored === null || rows === 0) {
    const message = `Nothing to resume in ${dbPath}; starting a new crawl.`;
    process.stderr.write(
      json
        ? JSON.stringify({ type: 'warn', time: new Date().toISOString(), message }) + '\n'
        : `[warn] ${message}\n`,
    );
    return null;
  }
  const storedIsList = !/^https?:\/\//.test(stored);
  if (listMode !== storedIsList) {
    console.error(
      storedIsList
        ? `${dbPath} holds a list crawl; continue it with --resume --list <file>.`
        : `${dbPath} holds a crawl of ${stored}; --resume --list cannot continue it.`,
    );
    process.exit(2);
  }
  if (listMode) return startUrl;
  const site = (u: string) =>
    new URL(/^https?:\/\//i.test(u) ? u : `https://${u}`).hostname
      .toLowerCase()
      .replace(/^www\./, '');
  if (site(startUrl) !== site(stored)) {
    console.error(
      `${dbPath} holds a crawl of ${stored}; --resume continues it: pass that URL or another --db.`,
    );
    process.exit(2);
  }
  return stored;
}

/** Per-URL crawl warnings printed before the rest are held back. */
const PER_URL_WARNINGS_SHOWN = 20;

/** Export progress: one line on stderr, so `--json` stdout stays clean. */
function progressLine(line: string): void {
  process.stderr.write(`${line}\n`);
}

/** `--out` must be a directory or not exist yet (it is created). */
function checkExportDir(out: string): void {
  if (existsSync(out) && !statSync(out).isDirectory()) {
    throw new Error(`--out ${out} exists and is not a directory.`);
  }
}

/**
 * `freecrawl export`: write reports and bulk exports of an existing project
 * without the desktop app. Leaves the crawl data as it is (a desktop-saved
 * project is unpacked to a working copy that is never packed back), with
 * two exceptions: `--save-set` stores a named `--what` list in it, and
 * issue lists materialised by older checks are recomputed when the run
 * reads them, in place for a bare project (derived data, written as a
 * crawl writes it). Hence the write lock. `--set` runs a saved list;
 * `--list-sets` prints them.
 */
async function runExport(opts: {
  projectPath: string;
  out: string | undefined;
  what: string | undefined;
  urls: string | undefined;
  set: string | undefined;
  saveSet: string | undefined;
  listSets: boolean;
  rawHeaders: boolean;
  json: boolean;
}): Promise<number> {
  const print = (outcome: ExportOutcome, error: string | null): void => {
    const ok = error === null && outcome.errors.length === 0;
    if (opts.json) {
      process.stdout.write(
        JSON.stringify(
          {
            ok,
            ...(error === null ? {} : { error }),
            ...outcome,
            // Write times stay in manifest.json; stdout keeps its shape.
            files: outcome.files.map(({ ms: _ms, peakRssMb: _mb, sharedPass: _sp, ...f }) => f),
          },
          null,
          2,
        ) + '\n',
      );
      return;
    }
    if (error !== null) console.error(error);
    for (const f of outcome.files) {
      console.log(`${f.rows === null ? '' : `${f.rows} rows  `}${f.path}`);
    }
    for (const e of outcome.errors) console.error(`Failed: ${e.label}: ${e.error}`);
    for (const k of outcome.skipped) console.error(`Skipped: ${k.label}: ${k.reason}`);
  };
  const fail = (message: string): number => {
    if (!opts.json) {
      console.error(
        'Usage: freecrawl export --project <file> --out <dir> [--what <list> | --set <name>] [--urls <file>] [--raw-headers] [--json]\n' +
          '       freecrawl export --project <file> --save-set <name> --what <list> [--raw-headers] [--json]\n' +
          '       freecrawl export --project <file> --list-sets [--json]',
      );
    }
    print({ files: [], errors: [], skipped: [] }, message);
    return 2;
  };
  if (opts.listSets || opts.saveSet !== undefined) return runExportSetCommand(opts, fail);
  if (opts.set !== undefined && opts.what !== undefined) {
    return fail('--set runs a saved --what list; give one of --set and --what, not both.');
  }
  if (!opts.out) return fail('--out <dir> is required.');
  const outDir = resolve(opts.out);
  let items: ExportItem[];
  let selectedUrls: string[] = [];
  try {
    // `--urls` alone means just the selected links; `--what` adds to them.
    // A `--set` is looked up once the project is open.
    items =
      opts.set !== undefined || (opts.urls !== undefined && opts.what === undefined)
        ? []
        : parseExportWhat(opts.what);
    if (opts.urls !== undefined) {
      selectedUrls = [
        ...new Set(
          readFileSync(resolve(opts.urls), 'utf8')
            .split(/\r?\n/)
            .map((l) => l.trim())
            .filter(Boolean),
        ),
      ];
      if (selectedUrls.length === 0) throw new Error(`--urls ${opts.urls} has no URLs.`);
    }
    checkExportDir(outDir);
  } catch (err) {
    return fail((err as Error).message);
  }
  if (!existsSync(opts.projectPath)) return fail(`Project not found: ${opts.projectPath}`);

  // Ctrl-C exits at once; the exit hooks drop the half-written `.part`
  // files and the working copy, so no truncated export is left behind.
  // Under --json the summary still comes out, with the files done so far
  // (written synchronously: process.exit would cut an async pipe write).
  const outcome: ExportOutcome = { files: [], errors: [], skipped: [] };
  exitOnInterrupt(() => {
    if (opts.json) {
      writeSync(1, JSON.stringify({ ok: false, error: 'interrupted', ...outcome }, null, 2) + '\n');
    }
  });
  pendingCleanups.add(removePartialExportFiles);
  let project: OpenedProject;
  try {
    // Locked like a writer: a desktop-saved project another CLI command is
    // updating is refused (with its pid) instead of exported half-way.
    project = await openProject(opts.projectPath, { forWrite: true, cleanups: pendingCleanups });
  } catch (err) {
    return fail(`Cannot open project ${opts.projectPath}: ${(err as Error).message}`);
  }
  try {
    let set: ExportSet | null = null;
    if (opts.set !== undefined) {
      try {
        set = findExportSet(project.db, opts.set);
      } catch (err) {
        return fail((err as Error).message);
      }
    }
    const missing: string[] = [];
    if (opts.urls !== undefined) {
      const known: string[] = [];
      for (const u of selectedUrls) {
        (project.db.getUrlIdByUrl(u) !== null ? known : missing).push(u);
      }
      if (known.length === 0) {
        print({ files: [], errors: [], skipped: [] }, `None of the ${selectedUrls.length} URLs in ${opts.urls} is in the project.`);
        return 2;
      }
      items.push({ kind: 'selected', name: 'selected-links', urls: known });
    }
    const runOptions = {
      rawHeaders: opts.rawHeaders,
      projectFile: resolve(opts.projectPath),
      toolVersion: cliVersion(),
      onProgress: progressLine,
      outcome,
    };
    // Before the run, so the folder's manifest.json lists it too.
    if (missing.length > 0) {
      const error = `${missing.length} URL(s) not in the project, skipped: ${missing.join(' ')}`;
      if (opts.json) process.stderr.write(`${error}\n`);
      outcome.errors.push({ label: 'URLs not in the project', error });
    }
    if (set) {
      try {
        // `items` holds only the --urls links here; the set brings the rest.
        await runExportSet(project.db, outDir, set, { ...runOptions, extraItems: items });
      } catch (err) {
        // A stored token this version no longer knows: nothing was written.
        return fail(`Export set "${set.name}": ${(err as Error).message}`);
      }
    } else {
      await runExportItems(project.db, outDir, items, runOptions);
    }
    print(outcome, null);
    return outcome.errors.length === 0 ? 0 : 1;
  } finally {
    project.dispose();
  }
}

/** `export --list-sets` and `export --save-set <name> --what <list>`. */
async function runExportSetCommand(
  opts: {
    projectPath: string;
    what: string | undefined;
    saveSet: string | undefined;
    listSets: boolean;
    rawHeaders: boolean;
    json: boolean;
  },
  fail: (message: string) => number,
): Promise<number> {
  const saving = opts.saveSet !== undefined;
  if (saving && opts.listSets) return fail('Give one of --save-set and --list-sets, not both.');
  if (saving) {
    if (opts.what === undefined) return fail('--save-set <name> needs --what <list>.');
    try {
      // Same check as a run: a bad entry exits 2 before the project is touched.
      parseExportWhat(opts.what);
    } catch (err) {
      return fail((err as Error).message);
    }
  }
  if (!existsSync(opts.projectPath)) return fail(`Project not found: ${opts.projectPath}`);
  let project: OpenedProject;
  try {
    project = await openProject(opts.projectPath, { forWrite: saving, cleanups: pendingCleanups });
  } catch (err) {
    return fail(`Cannot open project ${opts.projectPath}: ${(err as Error).message}`);
  }
  try {
    if (saving) {
      let set: ExportSet;
      try {
        set = saveExportSet(project.db, {
          name: opts.saveSet ?? '',
          what: (opts.what ?? '').split(','),
          rawHeaders: opts.rawHeaders,
        });
      } catch (err) {
        return fail((err as Error).message);
      }
      try {
        await project.save();
      } catch (err) {
        return fail(`Cannot save project ${opts.projectPath}: ${(err as Error).message}`);
      }
      if (opts.json) process.stdout.write(JSON.stringify({ ok: true, set }, null, 2) + '\n');
      else console.log(`Saved export set "${set.name}": ${set.what.join(',')}`);
      return 0;
    }
    const sets = listExportSets(project.db);
    if (opts.json) {
      process.stdout.write(JSON.stringify({ ok: true, sets }, null, 2) + '\n');
    } else if (sets.length === 0) {
      console.log('No export sets saved in this project.');
    } else {
      for (const s of sets) console.log(`${s.name}  ${s.what.join(',')}${s.rawHeaders ? '  (raw headers)' : ''}`);
    }
    return 0;
  } finally {
    project.dispose();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.stack : err);
  process.exit(2);
});
