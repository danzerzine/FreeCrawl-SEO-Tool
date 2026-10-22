/**
 * Rows of a non-`urls` dataset for the Sheets and BigQuery exports: the
 * dataset's own columns, each cell the raw value read by the dotted column
 * key. No CSV escaping and no formula guard: both targets take the value as
 * data (Sheets with `valueInputOption: RAW`, BigQuery as a STRING).
 */
import type { ProjectDb } from '@freecrawl/db';
import { datasetRows, readCell } from '@freecrawl/core';
import {
  EXPORT_DATASET_COLUMNS,
  type ExportDatasetKey,
  type GoogleExportDataset,
} from '@freecrawl/shared-types';

export type { GoogleExportDataset };
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
  // The key comes over IPC: an unknown one is a clear error, not a TypeError.
  const columns = Object.hasOwn(EXPORT_DATASET_COLUMNS, dataset) ? EXPORT_DATASET_COLUMNS[dataset] : undefined;
  if (!columns) throw new Error(`Unknown table to export: ${String(dataset)}`);
  const source = datasetRows(db, dataset);
  return {
    headers: columns.map((c) => c.header),
    rows: (function* () {
      for (const row of source) yield columns.map((c) => rawCell(readCell(row, c.key)));
    })(),
  };
}
