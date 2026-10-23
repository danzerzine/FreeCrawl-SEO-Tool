import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ProjectDb } from '@freecrawl/db';
import { EXPORT_DATASET_COLUMNS, type LinkSuggestionInput } from '@freecrawl/shared-types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { linkSuggestions } from './link-suggestions.js';
import { CLI_EXPORT_DATASETS, parseExportWhat, runExportItems, type ExportOutcome } from './export-items.js';

let dir: string;
let file: string;
let out: string;

const HEADER = [
  'Target URL',
  'Target Title',
  'Target Inlinks',
  'Target Content Inlinks',
  'Target Link Score',
  'Rank',
  'Source URL',
  'Source Title',
  'Closeness %',
  'Source Link Score',
  'Source Outlinks',
  'Same Section',
  'Suggested Anchor',
];

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'fc-b93d-'));
  file = path.join(dir, 'p.seoproject');
  out = path.join(dir, 'out');
  fs.mkdirSync(out);
  new ProjectDb(file).close();
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

function seed(opts: { inlinks?: boolean; redirect?: boolean } = {}): void {
  const raw = new DatabaseSync(file);
  if (opts.inlinks !== false) raw.exec("INSERT INTO project_meta (key, value) VALUES ('inlinksComputed', '1')");
  raw.exec(`
    INSERT INTO urls (id, url, is_external, content_kind, status_code, indexability, title, h1, outlinks) VALUES
      (1, 'https://ex.test/news/a', 0, 'html', 200, 'indexable', 'Espresso machine guide', 'Espresso guide', 200),
      (2, 'https://ex.test/news/b', 0, 'html', 200, 'indexable', 'Espresso machine care', NULL, 10),
      (3, 'https://ex.test/zebra', 0, 'html', 200, 'indexable', 'Zebra migration patterns', NULL, 200);
  `);
  if (opts.redirect) {
    raw.exec(`
      INSERT INTO urls (id, url, is_external, content_kind, status_code, indexability, redirect_target) VALUES
        (4, 'https://ex.test/old', 0, 'html', 301, 'indexable', 'https://ex.test/news/a');
      INSERT INTO links (from_url_id, to_url, is_internal) VALUES (2, 'https://ex.test/old', 1);
    `);
  }
  raw.close();
}

async function run(options: Record<string, unknown> = {}): Promise<{ outcome: ExportOutcome; lines: string[] }> {
  const outcome: ExportOutcome = { files: [], errors: [], skipped: [] };
  const db = new ProjectDb(file);
  await runExportItems(db, out, parseExportWhat('dataset:link-suggestions'), { outcome, ...options } as never);
  db.close();
  const csv = path.join(out, 'link-suggestions.csv');
  const lines = fs.existsSync(csv)
    ? fs.readFileSync(csv, 'utf8').replace(/^﻿/, '').trimEnd().split('\n')
    : [];
  return { outcome, lines };
}

describe('B93 dataset:link-suggestions', () => {
  it('is a CLI dataset with the exact column list', () => {
    expect(CLI_EXPORT_DATASETS).toContain('link-suggestions');
    expect(EXPORT_DATASET_COLUMNS['link-suggestions'].map((c) => c.header)).toEqual(HEADER);
  });

  it('writes one row per suggestion and one rank 0 row for a target with none', async () => {
    seed();
    const { outcome, lines } = await run({ linkSuggestions: {} });
    expect(outcome.errors).toEqual([]);
    expect(lines[0]).toBe(HEADER.join(','));
    const body = lines.slice(1);
    const a = body.find((l) => l.startsWith('https://ex.test/news/a,'))!;
    expect(a).toContain(',1,https://ex.test/news/b,Espresso machine care,');
    expect(a).toContain(',yes,Espresso guide');
    const zebra = body.find((l) => l.startsWith('https://ex.test/zebra,'))!;
    expect(zebra).toMatch(/,0,,,,,,,$/);
    expect(outcome.files).toHaveLength(1);
    expect(outcome.files[0]!.rows).toBe(body.length);
    expect(outcome.files[0]!.warnings ?? []).toEqual([]);
  });

  it('a project without the inlink pass is an error with its own text and writes no file', async () => {
    seed({ inlinks: false });
    const { outcome, lines } = await run({ linkSuggestions: {} });
    expect(lines).toEqual([]);
    expect(outcome.files).toEqual([]);
    expect(outcome.errors).toEqual([
      {
        label: expect.any(String),
        error: 'Link suggestions: the crawl did not compute inlinks (run a crawl with link analysis on)',
      },
    ]);
  });

  it('records truncated and the one-hop redirect fold as warnings, also in manifest.json', async () => {
    seed({ redirect: true });
    const { outcome } = await run({
      linkSuggestionsRunner: async (input: LinkSuggestionInput) => {
        const own = new ProjectDb(file);
        try {
          const r = linkSuggestions(own, input);
          return r && { ...r, truncated: true };
        } finally {
          own.close();
        }
      },
    });
    expect(outcome.files[0]!.warnings).toEqual(expect.arrayContaining(['truncated', 'redirectsFolded: one-hop']));
    const manifest = JSON.parse(fs.readFileSync(path.join(out, 'manifest.json'), 'utf8')) as {
      files: { path: string; warnings?: string[] }[];
    };
    expect(manifest.files.find((f) => f.path === 'link-suggestions.csv')!.warnings).toEqual(
      expect.arrayContaining(['truncated', 'redirectsFolded: one-hop']),
    );
  });

  it('computes through the given runner and never in this thread when one is passed', async () => {
    seed();
    const seen: unknown[] = [];
    const canned = {
      rows: [
        {
          targetUrl: 'https://ex.test/zebra',
          targetTitle: 'Zebra',
          targetInlinks: 0,
          targetContentInlinks: 0,
          targetLinkScore: null,
          rank: 0,
          sourceUrl: null,
          sourceTitle: null,
          closeness: null,
          sourceLinkScore: null,
          sourceOutlinks: null,
          sameSection: null,
          suggestedAnchor: null,
        },
      ],
      targets: 1,
      withoutSuggestion: 1,
      truncated: false,
      degraded: false,
    };
    const { outcome, lines } = await run({
      linkSuggestions: { perTarget: 2 },
      linkSuggestionsRunner: async (input: unknown) => {
        seen.push(input);
        return canned;
      },
    });
    expect(seen).toEqual([{ perTarget: 2 }]);
    expect(outcome.errors).toEqual([]);
    // only the runner's row: the in-thread computation would also have listed the espresso pages
    expect(lines.length).toBe(2);
    expect(lines[1]).toContain('https://ex.test/zebra');
  });

  it('reports not computed when the runner answers null', async () => {
    seed();
    const { outcome, lines } = await run({ linkSuggestionsRunner: async () => null });
    expect(lines).toEqual([]);
    expect(outcome.errors.length).toBe(1);
  });
});
