import { readFileSync, writeFileSync } from 'node:fs';
import { checkSerpRows, parseSerpInput, serpRowsToCsv, type SerpRowResult } from '@freecrawl/core';
import { DEFAULT_SEO_THRESHOLDS, type SeoThresholds } from '@freecrawl/shared-types';

export interface SerpOptions {
  /** Path of the list, or '-' for stdin. */
  file: string | undefined;
  out: string | undefined;
  json: boolean;
  limits: string | undefined;
}

function fail(message: string): number {
  console.error(`freecrawl serp: ${message}`);
  return 2;
}

/** Counts of each status per text, for `--json`. */
function countStatuses(rows: readonly SerpRowResult[]) {
  const title: Record<string, number> = {};
  const description: Record<string, number> = {};
  for (const r of rows) {
    title[r.titleStatus] = (title[r.titleStatus] ?? 0) + 1;
    description[r.descStatus] = (description[r.descStatus] ?? 0) + 1;
  }
  return {
    rows: rows.length,
    title,
    description,
    duplicateTitles: rows.filter((r) => r.duplicateTitle > 0).length,
    duplicateDescriptions: rows.filter((r) => r.duplicateDescription > 0).length,
  };
}

/**
 * `freecrawl serp <file|-> [--out <csv>] [--json] [--limits <json>]`: a
 * report on pasted titles and descriptions. Nothing is fetched and nothing
 * is stored; exit 0 even when rows break the limits, 2 on bad input.
 */
export function runSerp(opts: SerpOptions): number {
  if (!opts.file) {
    return fail('Usage: freecrawl serp <file|-> [--out <csv>] [--json] [--limits <json>]');
  }
  let limits: Partial<SeoThresholds> | undefined;
  if (opts.limits !== undefined) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(opts.limits, 'utf8'));
    } catch (err) {
      return fail(`cannot read --limits ${opts.limits}: ${(err as Error).message}`);
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return fail('--limits must be a JSON object such as {"titleMaxChars": 60}');
    }
    const unknown = Object.keys(parsed).filter((k) => !(k in DEFAULT_SEO_THRESHOLDS));
    if (unknown.length > 0) {
      return fail(
        `unknown --limits key ${unknown.join(', ')}; known: ${Object.keys(DEFAULT_SEO_THRESHOLDS).join(', ')}`,
      );
    }
    limits = parsed as Partial<SeoThresholds>;
  }
  let text: string;
  try {
    text = readFileSync(opts.file === '-' ? 0 : opts.file, 'utf8');
  } catch (err) {
    return fail(`cannot read ${opts.file}: ${(err as Error).message}`);
  }
  let rows: SerpRowResult[];
  try {
    rows = checkSerpRows(parseSerpInput(text), limits);
  } catch (err) {
    return fail((err as Error).message);
  }
  const csv = serpRowsToCsv(rows);
  if (opts.out !== undefined) {
    try {
      writeFileSync(opts.out, csv);
    } catch (err) {
      return fail(`cannot write ${opts.out}: ${(err as Error).message}`);
    }
  }
  if (opts.json) {
    console.log(JSON.stringify({ ok: true, counts: countStatuses(rows), rows }));
  } else if (opts.out === undefined) {
    process.stdout.write(csv);
  }
  return 0;
}
