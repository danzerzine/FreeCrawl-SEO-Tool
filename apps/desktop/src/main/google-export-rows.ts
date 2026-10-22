/**
 * Rows of a non-`urls` dataset for the Sheets and BigQuery exports: the
 * dataset's own columns, each cell the raw value read by the dotted column
 * key. No CSV escaping and no formula guard: both targets take the value as
 * data (Sheets with `valueInputOption: RAW`, BigQuery as a STRING).
 */
import type { ProjectDb } from '@freecrawl/db';
import { datasetRows, readCell } from '@freecrawl/core';
import { EXPORT_DATASET_COLUMNS, type ExportDatasetKey } from '@freecrawl/shared-types';

export type GoogleExportDataset = 'urls' | ExportDatasetKey;
export type RawCell = string | number | boolean | null;

function rawCell(value: unknown): RawCell {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  return JSON.stringify(value);
}

export function datasetTable(
  db: ProjectDb,
  dataset: ExportDatasetKey,
): { headers: string[]; rows: Iterable<RawCell[]> } {
  const columns = EXPORT_DATASET_COLUMNS[dataset];
  const source = datasetRows(db, dataset);
  return {
    headers: columns.map((c) => c.header),
    rows: (function* () {
      for (const row of source) yield columns.map((c) => rawCell(readCell(row, c.key)));
    })(),
  };
}
