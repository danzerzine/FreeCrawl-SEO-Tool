#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { basename, join, resolve } from 'node:path';
import {
  closeSync,
  existsSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import {
  DEFAULT_CRAWL_CONFIG,
  type CrawlConfig,
  type CrawlSnapshot,
  type ExportSet,
  type LogIngestInput,
  type MetricaFetchMeta,
} from '@freecrawl/shared-types';
import {
  Crawler,
  compareCrawls,
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
  validateSitemap,
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
  type ExportItem,
  type ExportOutcome,
  type LogAnalysisResult,
} from '@freecrawl/core';
import {
  ProjectDb,
  detectProjectFormat,
  packProject,
  unpackProject,
} from '@freecrawl/db';

function help(): void {
  console.log(`freecrawl — headless SEO crawler

Usage:
  freecrawl <url> [options]                       Spider mode (default)
  freecrawl --list <file> [options]               List mode (one URL per line)
  freecrawl validate-sitemap <sitemap-url>        Fetch + validate a sitemap.xml
  freecrawl audit-robots <url> [--user-agent UA]  Test if a URL is allowed by robots.txt
  freecrawl compare <before.seoproject> <after.seoproject>
                                                  Cross-project diff (added / removed / status / title / meta / h1 / canonical / indexability / response_time)
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
  --concurrency <n>   Max parallel requests (default: ${DEFAULT_CRAWL_CONFIG.maxConcurrency})
  --rps <n>           Max requests per second (default: ${DEFAULT_CRAWL_CONFIG.maxRps})
  --user-agent <str>  Custom User-Agent string
  --no-robots         Ignore robots.txt
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
  --adaptive-speed    Back off automatically on HTTP 429/503 and Retry-After, then recover
                        (off by default; the fixed --rps / --concurrency hold otherwise)
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
                        any other → CSV (subset of common columns, with the grid's column names)
  --raw-headers       With --out CSV and export (bulk files): write the internal keys (statusCode, …) as
                        the header row and skip the CSV formula guard (raw data for scripts).
  --json              Print a machine-readable JSON summary to stdout (instead of human progress).
                        Useful for CI/CD pipelines.
  --export-dir <dir>  After the crawl, write the exports named by --export into <dir> (see export)
  --export <list>     What --export-dir writes; same list as export --what (default: bulk)

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
                        issues      issues-summary.csv: check key, label, group, severity, URL count
                        tab:<key> / issues:<key>
                                    one category CSV, e.g. tab:redirects, issues:title-missing
                        dataset:<key>
                                    one table as a file named after the key: issues-long, sitemap-urls,
                                    crawl-queue, broken-links, broken-links-by-target, response-headers,
                                    images, pagespeed, crux, spelling, ai:<provider>, seo:<provider>
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

/** The command line, strict: an unknown option or a missing value throws. */
function parseCliArgs() {
  return parseArgs({
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
      'no-check-external': { type: 'boolean' },
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
      export: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  });
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
      console.error(
        'Usage: freecrawl compare <before.seoproject> <after.seoproject>',
      );
      process.exit(2);
    }
    exitOnInterrupt();
    const exitCode = await runCompare(
      resolve(positionals[1]),
      resolve(positionals[2]),
    );
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
      ? { maxDepth: parseNumeric('depth', values.depth, DEFAULT_CRAWL_CONFIG.maxDepth) }
      : {}),
    ...(values.max !== undefined
      ? { maxUrls: parseNumeric('max', values.max, DEFAULT_CRAWL_CONFIG.maxUrls) }
      : {}),
    ...(values.concurrency !== undefined
      ? { maxConcurrency: parseNumeric('concurrency', values.concurrency, DEFAULT_CRAWL_CONFIG.maxConcurrency) }
      : {}),
    ...(values.rps !== undefined
      ? { maxRps: parseNumeric('rps', values.rps, DEFAULT_CRAWL_CONFIG.maxRps, { integer: false }) }
      : {}),
    ...(values['user-agent'] !== undefined ? { userAgent: values['user-agent'] } : {}),
    // `--no-robots` / `--external` only flip the flag ON in their direction;
    // absent, the file value (or default) stands.
    ...(values['no-robots'] ? { respectRobotsTxt: false } : {}),
    ...(values['respect-crawl-delay'] ? { respectCrawlDelay: true } : {}),
    ...(values.external ? { crawlExternal: true } : {}),
    ...(values['no-check-external'] ? { checkExternalLinks: false } : {}),
    ...(values['image-variants'] ? { crawlImageVariants: true } : {}),
    ...(values['adaptive-speed'] ? { adaptiveSpeed: true } : {}),
    ...(values.header !== undefined ? { customHeaders: parseHeaders(values.header) } : {}),
    ...(values.include !== undefined ? { includePatterns: values.include } : {}),
    ...(values.exclude !== undefined ? { excludePatterns: values.exclude } : {}),
  };

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

  // Opened only after every flag validated, so a bad argument leaves no
  // empty project file behind.
  const db = new ProjectDb(dbPath);
  const crawler = new Crawler(config, db, { toolVersion: cliVersion() });
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
      : await exportUrlsToCsv(db, outPath, {
          headers: values['raw-headers'] ? 'keys' : 'labels',
        });
    rowsWritten = r.rowsWritten;
    exportedTo = outPath;
  }

  let exported: ExportOutcome | null = null;
  if (postCrawlExport) {
    // Ctrl-C from here on exits at once; the exit hook drops any
    // half-written `.part` file.
    exitOnInterrupt();
    pendingCleanups.add(removePartialExportFiles);
    exported = await runExportItems(db, postCrawlExport.dir, postCrawlExport.items, {
      rawHeaders: Boolean(values['raw-headers']),
      projectFile: dbPath,
      toolVersion: cliVersion(),
      onProgress: progressLine,
    });
  }

  const overview = db.getOverviewCounts();
  const issues = overview.issues;
  const soft404Probe = overview.site?.soft404Probe ?? null;
  const botBlocked = overview.site?.botBlocked ?? null;
  const siteWide = overview.site?.siteWide ?? null;
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
          site: { soft404Probe, botBlocked, siteWide },
          exportedTo,
          rowsExported: exportedTo ? rowsWritten : null,
          ...(exported ? { exports: { ok: exported.errors.length === 0, ...exported } } : {}),
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
  }

  db.close();
  process.exit(hasErrors || (exported !== null && exported.errors.length > 0) ? 1 : 0);
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

/** An existing project a command reads or updates. */
interface OpenedProject {
  db: ProjectDb;
  /** Close the database and, for a desktop-saved project, pack the working
   *  copy back onto the original file. Call only after a successful write. */
  save(): Promise<void>;
  /** Close the database if still open and delete any working copy. Runs
   *  on every exit path; never repacks. */
  dispose(): void;
}

/** Cleanups still due; the exit hook runs them after Ctrl-C or a crash, so
 *  no working copy is left in the temp directory. */
const pendingCleanups = new Set<() => void>();
process.on('exit', () => {
  for (const cleanup of pendingCleanups) cleanup();
});

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
 * Take `<project>.lock` for a write to a desktop-saved project, so two CLI
 * commands can't each repack the archive and drop the other's data. A lock
 * whose process is gone (killed, crashed) is taken over. Returns the
 * release function, which deletes the lock only while it is still ours;
 * throws a user-facing message when the lock is held.
 */
function lockProject(path: string): () => void {
  const lockPath = `${path}.lock`;
  const inUse = (holder: number | string): Error =>
    new Error(
      `The project is in use by another FreeCrawl CLI command (pid ${holder}). ` +
        `Wait for it to finish, or delete ${lockPath} if no such command is running.`,
    );
  for (let attempt = 0; attempt < 3; attempt++) {
    const mine = createExclusive(lockPath);
    if (mine !== null) return () => removeIfUnchanged(lockPath, mine);
    const seen = readIfExists(lockPath);
    if (seen === null) continue; // released meanwhile
    const holder = lockHolder(lockPath, seen);
    if (holder !== null) throw inUse(holder);
    removeStale(lockPath, seen, inUse);
  }
  throw inUse('unknown');
}

/**
 * Delete the stale `file`, which held `content`, so that only one process
 * ever does it. A plain check-then-delete would let a slow process delete
 * the fresh lock a faster one had just created. Instead the delete happens
 * only under an exclusive guard named after `content`: every lock and guard
 * is written with unique content, which never reappears once deleted, so
 * the guard holder knows the file it re-reads is the same stale one (a
 * half-written file has no id, so for it the age is checked again). A
 * guard left by a crashed process is cleared the same way, one level up.
 */
function removeStale(
  file: string,
  content: string,
  inUse: (holder: number | string) => Error,
  depth = 0,
): void {
  const guardPath = `${file.replace(/\.takeover-[0-9a-f]+$/, '')}.takeover-${createHash('sha256')
    .update(content)
    .digest('hex')
    .slice(0, 16)}`;
  let guard = createExclusive(guardPath);
  if (guard === null) {
    const guardSeen = readIfExists(guardPath);
    if (guardSeen !== null) {
      const holder = lockHolder(guardPath, guardSeen);
      if (holder !== null) throw inUse(holder);
      if (depth >= 3) throw inUse('unknown');
      removeStale(guardPath, guardSeen, inUse, depth + 1);
    }
    guard = createExclusive(guardPath);
    if (guard === null) throw inUse('unknown');
  }
  try {
    const now = readIfExists(file);
    if (now === content && lockHolder(file, now) === null) rmSync(file, { force: true });
  } finally {
    removeIfUnchanged(guardPath, guard);
  }
}

/** Create `file` exclusively with this process's pid, start time and a
 *  unique id; returns what was written, or null when it already exists. */
function createExclusive(file: string): string | null {
  let fd: number;
  try {
    fd = openSync(file, 'wx');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return null;
    throw err;
  }
  const content = JSON.stringify({
    pid: process.pid,
    startedAt: new Date().toISOString(),
    id: randomUUID(),
  });
  try {
    writeSync(fd, content);
  } finally {
    closeSync(fd);
  }
  return content;
}

function readIfExists(file: string): string | null {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

/** Delete `file` only if it still holds `content`. */
function removeIfUnchanged(file: string, content: string): void {
  if (readIfExists(file) === content) rmSync(file, { force: true });
}

/** The pid of a live holder of the lock `file`, which holds `content`, or
 *  null when the lock is stale. */
function lockHolder(file: string, content: string): number | string | null {
  let pid: unknown;
  try {
    pid = (JSON.parse(content) as { pid?: unknown }).pid;
  } catch {
    // Unreadable or half-written: its owner may be writing it right now,
    // so only an old one counts as stale.
    try {
      return Date.now() - statSync(file).mtimeMs < 10_000 ? 'unknown' : null;
    } catch {
      return null;
    }
  }
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return null;
  try {
    process.kill(pid, 0);
    return pid;
  } catch (err) {
    // EPERM: the process exists but belongs to someone else.
    return (err as NodeJS.ErrnoException).code === 'EPERM' ? pid : null;
  }
}

const WORKING_COPY_PREFIX = 'freecrawl-cli-';
/** Owner file in each working copy directory, written like a lock. */
const WORKING_COPY_OWNER = 'owner.lock';

/**
 * Remove the working copies that commands killed outright (a hard kill,
 * a crash, a shutdown) left in the temp directory: no exit hook runs then,
 * and each copy is the size of the unpacked project. A copy is orphaned
 * when the process in its owner file is gone, or, with no owner file, when
 * it is over an hour old. Best effort: anything still in use stays.
 */
function removeOrphanedWorkingCopies(): void {
  let entries;
  try {
    entries = readdirSync(tmpdir(), { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(WORKING_COPY_PREFIX)) continue;
    const dir = join(tmpdir(), entry.name);
    try {
      const ownerPath = join(dir, WORKING_COPY_OWNER);
      const owner = readIfExists(ownerPath);
      const orphaned =
        owner === null
          ? Date.now() - statSync(dir).mtimeMs > 3_600_000
          : lockHolder(ownerPath, owner) === null;
      if (orphaned) rmSync(dir, { recursive: true, force: true });
    } catch {
      /* in use or not ours to remove; tried again on the next run */
    }
  }
}

/**
 * Open an existing project file. The desktop app saves projects as a
 * compressed container (`packProject`), which is unpacked into a fresh temp
 * directory and opened there; `save()` packs it back. A bare SQLite project
 * (a CLI crawl, or a desktop save from before the container) opens in place,
 * as it always has. With `createIfMissing`, a missing path becomes a new
 * bare project. With `forWrite`, a desktop-saved project is locked (see
 * `lockProject`) until `dispose()`; bare SQLite relies on SQLite's own
 * locking. Throws with a user-facing message on a missing, unrecognised or
 * locked file.
 *
 * The desktop app works on its own working copy, so if it has the same
 * project open, its next Save overwrites whatever the CLI wrote.
 */
async function openProject(
  path: string,
  opts: { createIfMissing?: boolean; forWrite?: boolean } = {},
): Promise<OpenedProject> {
  let dir: string | null = null;
  let workingPath: string | null = null;
  let unlock: (() => void) | null = null;
  if (!existsSync(path)) {
    if (!opts.createIfMissing) throw new Error(`Project not found: ${path}`);
  } else {
    const format = detectProjectFormat(path);
    if (format === 'unknown') {
      throw new Error(
        'This file is not a FreeCrawl project (unrecognised format). It may be corrupt or a different file type.',
      );
    }
    if (format === 'archive') {
      removeOrphanedWorkingCopies();
      if (opts.forWrite) unlock = lockProject(path);
      // Created synchronously and registered below before anything awaits,
      // so an exit at any later point still removes it (and the lock).
      try {
        dir = mkdtempSync(join(tmpdir(), WORKING_COPY_PREFIX));
        try {
          if (createExclusive(join(dir, WORKING_COPY_OWNER)) === null) {
            throw new Error(`Could not create the working copy in ${dir}`);
          }
        } catch (err) {
          rmSync(dir, { recursive: true, force: true });
          throw err;
        }
      } catch (err) {
        unlock?.();
        throw err;
      }
      workingPath = join(dir, basename(path));
    }
  }

  let db: ProjectDb | undefined;
  let packing = false;
  const close = (): void => {
    const open = db;
    db = undefined;
    open?.close();
  };
  const dispose = (): void => {
    pendingCleanups.delete(dispose);
    try {
      close();
    } catch {
      /* already gone — the files are removed regardless */
    }
    // Separate steps, so one busy file (Windows refuses files an
    // interrupted pack still holds open) doesn't stop the others.
    if (packing) {
      // Interrupted mid-pack: drop the half-written file; the original
      // project is only replaced by the final rename.
      try {
        rmSync(`${path}.part`, { force: true });
      } catch {
        /* left beside the project; the next save overwrites it */
      }
    }
    if (dir) {
      try {
        // The SQLite sidecars (-wal / -shm) live in the same directory.
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* left in the temp directory */
      }
    }
    if (unlock) {
      try {
        unlock();
      } catch {
        /* a stale lock is taken over by the next command */
      }
    }
  };
  pendingCleanups.add(dispose);

  try {
    if (workingPath) await unpackProject(path, workingPath);
    db = new ProjectDb(workingPath ?? path);
  } catch (err) {
    dispose();
    throw err;
  }
  return {
    db,
    async save() {
      close();
      if (!workingPath) return;
      packing = true;
      await packProject(workingPath, path);
      packing = false;
    },
    dispose,
  };
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
async function runCompare(beforePath: string, afterPath: string): Promise<number> {
  let before: OpenedProject;
  let after: OpenedProject;
  try {
    before = await openProject(beforePath);
  } catch (err) {
    console.error(`Cannot open before project: ${(err as Error).message}`);
    return 2;
  }
  try {
    after = await openProject(afterPath);
  } catch (err) {
    before.dispose();
    console.error(`Cannot open after project: ${(err as Error).message}`);
    return 2;
  }
  try {
    const summary = compareCrawls(before.db, after.db);
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
    before.dispose();
    after.dispose();
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
    project = await openProject(opts.projectPath);
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
    project = await openProject(opts.projectPath);
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
          const base = await openProject(opts.baseline);
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
    project = await openProject(opts.projectPath, { createIfMissing: true, forWrite: true });
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
    project = await openProject(opts.projectPath, { forWrite: true });
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
        JSON.stringify({ ok, ...(error === null ? {} : { error }), ...outcome }, null, 2) + '\n',
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
    project = await openProject(opts.projectPath, { forWrite: true });
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
    project = await openProject(opts.projectPath, { forWrite: saving });
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
