/**
 * Rows of a non-`urls` dataset for the Sheets and BigQuery exports: the
 * dataset's own columns (or the link list's, B156), each cell the raw value read by the dotted column
 * key. No CSV escaping and no formula guard: both targets take the value as
 * data (Sheets with `valueInputOption: RAW`, BigQuery as a STRING).
 */
import type { ProjectDb } from '@freecrawl/db';
import { datasetRows, readCell } from '@freecrawl/core';
import { EXPORT_DATASET_COLUMNS, type GoogleExportDataset } from '@freecrawl/shared-types';

export type { GoogleExportDataset };
export type RawCell = string | number | boolean | null;

function rawCell(value: unknown): RawCell {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  return JSON.stringify(value);
}

/**
 * B156: every stored link edge, internal then external, in the column order
 * of the Bulk Export "Links" CSV files, plus which of the two it is.
 */
function linksTable(db: ProjectDb): { headers: string[]; rows: Iterable<RawCell[]> } {
  return {
    headers: [
      'Source',
      'Destination',
      'Status Code',
      'Anchor',
      'Rel',
      'Type',
      'Target',
      'Alt Text',
      'Link Position',
      'Link Path',
      'Link Origin',
      'Scope',
    ],
    rows: (function* () {
      for (const scope of ['internal', 'external'] as const) {
        for (const l of db.iterateLinks(scope)) {
          yield [
            l.from_url,
            l.to_url,
            l.to_status,
            l.anchor,
            l.rel,
            l.type,
            l.target,
            l.alt_text,
            l.link_position,
            l.link_path,
            l.link_origin,
            scope,
          ];
        }
      }
    })(),
  };
}

export function datasetTable(
  db: ProjectDb,
  dataset: Exclude<GoogleExportDataset, 'urls'>,
): { headers: string[]; rows: Iterable<RawCell[]> } {
  if (dataset === 'links') return linksTable(db);
  // The key comes over IPC: an unknown one is a clear error, not a TypeError.
  const columns = Object.hasOwn(EXPORT_DATASET_COLUMNS, dataset)
    ? EXPORT_DATASET_COLUMNS[dataset]
    : undefined;
  if (!columns) throw new Error(`Unknown table to export: ${String(dataset)}`);
  const source = datasetRows(db, dataset);
  return {
    headers: columns.map((c) => c.header),
    rows: (function* () {
      for (const row of source) yield columns.map((c) => rawCell(readCell(row, c.key)));
    })(),
  };
}
