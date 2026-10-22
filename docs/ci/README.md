# CI/CD Integration

Run FreeCrawl's headless CLI as a quality gate in your pipeline — crawl a
deploy, fail the build on broken links, validate the sitemap, and catch SEO
regressions between releases.

Two ready-to-adapt templates live next to this file:

| File                                                         | Platform       |
| ------------------------------------------------------------ | -------------- |
| [`github-actions-example.yml`](./github-actions-example.yml) | GitHub Actions |
| [`gitlab-ci-example.yml`](./gitlab-ci-example.yml)           | GitLab CI/CD   |

Both crawl `TARGET_URL` into a project, gate it with `check` against the rule
file `freecrawl-rules.json` (see below), validate the sitemap (advisory), and
upload the crawl as an artifact.

## How the CLI is built in CI

The runner clones the source and builds only the CLI and the packages it
imports:

```bash
npm ci --ignore-scripts        # skip the Playwright download — undici crawl needs no Chromium
npx tsc -b apps/cli            # builds shared-types → db → core → cli via project references
node apps/cli/dist/bin.js <url> [options]
```

> `npm run build:cli` compiles **only** `apps/cli` and does **not** build the
> workspace packages the CLI imports, so the crawl would fail to resolve
> `@freecrawl/core` at runtime. Use `npx tsc -b apps/cli`, which follows the
> project references and builds the dependency graph in order — while skipping
> the heavy Electron desktop build. Drop `--ignore-scripts` only if you enable
> JS rendering via a `--config` file (that path needs Chromium).

## Exit-code contract

Every command returns a CI-friendly exit code, so most gates need no scripting:

| Command                    | `0`                | `1`                                                                   | `2`                      |
| -------------------------- | ------------------ | --------------------------------------------------------------------- | ------------------------ |
| `<url>` (crawl)            | clean — no 4xx/5xx | a 4xx/5xx was found, the seed was unreachable, or nothing was fetched | —                        |
| `compare <before> <after>` | no differences     | at least one diff category is non-zero                                | a project failed to open |
| `validate-sitemap <url>`   | valid              | validation warnings                                                   | fetch failure            |
| `audit-robots <url>`       | URL allowed        | URL disallowed                                                        | invalid URL              |
| `check --project <file>`   | gate passed        | a `fail` rule fired                                                   | bad rules, project, or no crawl history |

## Gate variants

**Zero-tolerance (no script).** Let the crawl's own exit code fail the step —
any 4xx/5xx fails the build:

```yaml
- run: node apps/cli/dist/bin.js "$TARGET_URL" --max 5000
```

**Rules (what the templates do).** `crawl` writes the project and records the
crawl in its history; `check` then judges the newest crawl against a rule file.
`crawl` exits 1 on any 4xx/5xx, so let `check` decide (append `|| true` to the
crawl step) unless you want zero tolerance:

```bash
node apps/cli/dist/bin.js "$TARGET_URL" --max 5000 --db site.seoproject || true
node apps/cli/dist/bin.js check --project site.seoproject --rules freecrawl-rules.json
# exit 0 pass (a warn rule may have fired), 1 a fail rule fired, 2 bad rules or project
```

`freecrawl-rules.json` (metrics as in `history`: `indexable`, `status.404`,
`status.4xx`, `issues:<key>`, …):

```json
{
  "version": 1,
  "rules": [
    { "name": "Broken pages", "metric": "status.4xx", "op": ">", "value": 10 },
    { "name": "Indexable pages dropped", "metric": "indexable", "vs": "previous",
      "change": "percent", "op": "<=", "value": -10 },
    { "name": "New 5xx", "metric": "status.5xx", "op": ">", "value": 0, "level": "warn" }
  ]
}
```

`vs: "previous"` compares with the crawl before it of the same start URL, or with
`--baseline <project or snapshot.json>`; a fresh runner has no earlier crawl, so
keep a snapshot between runs: `check ... --write-snapshot snapshot.json` saves
the current counts (store it as an artifact or cache) and the next run passes it
back with `--baseline snapshot.json`. Rules that need a baseline are skipped
without one. A `fail` rule that fires, or whose check is switched off, fails the
gate; `warn` rules only report. `--json` lists every rule with its status.

`--notify slack,telegram,webhook,email` posts the fired rules when at least one
fired. Each channel reads its settings from the environment
(`FREECRAWL_SLACK_WEBHOOK_URL`, `FREECRAWL_TELEGRAM_BOT_TOKEN` +
`FREECRAWL_TELEGRAM_CHAT_ID`, `FREECRAWL_WEBHOOK_URL`, `FREECRAWL_SMTP_URL` +
`FREECRAWL_ALERT_EMAIL_TO`): put them in your CI secrets. A missing variable
exits 2; a failed delivery is reported in `notified` and never changes the gate.

## Regression gating with `compare`

Fail a deploy when SEO metrics regress against a known-good baseline. Keep a
baseline `.seoproject` (from a previous green run, restored from cache or an
artifact store), crawl the new deploy into a fresh project, then diff:

```bash
node apps/cli/dist/bin.js "$TARGET_URL" --max 5000 --db new.seoproject
node apps/cli/dist/bin.js compare baseline.seoproject new.seoproject
# exit 1 → a page changed status / title / meta / h1 / canonical / indexability
```

`compare` runs the same engine as the desktop Compare dialog and exits `1` on
any non-zero diff category, so it drops straight into a pipeline gate. Promote
`new.seoproject` to the new baseline when the pipeline passes.

## Audit files without the desktop app

`export` writes the desktop's bulk export (one CSV per tab and issue check, plus
the link lists), the SEO Audit folder, the HTML report, an issue summary and the
Internal Links reports from a saved project, so a scheduled job can publish the
whole audit as artifacts:

```bash
node apps/cli/dist/bin.js "$TARGET_URL" --max 5000 --db site.seoproject
node apps/cli/dist/bin.js export --project site.seoproject --out audit/ \
  --what bulk,seo-audit,html,issues,error-inlinks,dataset:issues-long --json > export.json
# exit 1 → some files failed (the others are written); 2 → bad arguments
```

Or in one step, right after the crawl: `--export-dir audit/ --export bulk,html`.
Each file is written as `<name>.part` and renamed when complete, so an
interrupted job never leaves a truncated CSV behind.

## Reproducible config

Export your settings once from the desktop app (Settings → Export Settings) and
commit the JSON, then feed it to every run so CI crawls exactly like your
desktop audits:

```bash
node apps/cli/dist/bin.js "$TARGET_URL" --config freecrawl.config.json --max 5000
```

Per-flag overrides still win over the file, so `--max` can differ per run while
the shared config stays fixed.
