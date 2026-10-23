/**
 * `--what pdf-text` (B42 / B155 text part): the text of every PDF of the
 * crawl in `pdf-text.jsonl` and the links inside them in `pdf-links.csv`.
 * The PDFs come through {@link forEachPdf}, so the request rules are those
 * of `--what pdfs` and the files stay in `pdfs/`. Nothing is stored in the
 * project (B42b keeps that open).
 */

import { open, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ProjectDb } from '@freecrawl/db';
import { DEFAULT_CRAWL_CONFIG } from '@freecrawl/shared-types';
import { writeExportFile } from './export-file.js';
import { forEachPdf, type MediaExportResult, type PdfExportOptions } from './media-export.js';
import { extractPdf } from './pdf-text.js';
import { escapeCsv } from './spreadsheet.js';
import { isSameHost } from './url-utils.js';

export interface PdfTextExportOptions extends PdfExportOptions {
  /** The crawl's start URL: a link is internal when it is on that host (the crawl's own rule). */
  startUrl?: string;
}

export interface PdfTextExportResult extends MediaExportResult {
  /** Rows of `pdf-links.csv` (0: only the header; the file is written whenever `pdf-text.jsonl` is). */
  linkRows: number;
  linksCsvPath: string | null;
}

export const PDF_LINKS_HEADER = ['pdf_url', 'page', 'link_url', 'is_internal'];

/**
 * One line per PDF in `pdf-text.jsonl`: `{url, file, pages, chars, truncated,
 * status, text}`, `status` being `ok`, `skipped: <reason>` or `error:
 * <reason>`; and one row per link in `pdf-links.csv` in PDF order, then page,
 * then annotation order. One PDF is in memory at a time and each line is
 * written as soon as it is read.
 */
export async function exportPdfText(
  db: ProjectDb,
  outDir: string,
  options: PdfTextExportOptions = {},
): Promise<PdfTextExportResult> {
  const config = { ...DEFAULT_CRAWL_CONFIG, ...options.crawlConfig?.config };
  const sameHost = {
    includeSubdomains: config.scope === 'all-subdomains',
    cdnHosts: config.cdnHosts,
  };
  const jsonlPath = join(outDir, 'pdf-text.jsonl');
  const linksPath = join(outDir, 'pdf-links.csv');
  let linkRows = 0;
  const cell = { formulaGuard: true };
  const pass = await writeExportFile(
    linksPath,
    (linksPart) =>
      writeExportFile(
        jsonlPath,
        async (jsonlPart) => {
          const jsonl = await open(jsonlPart, 'w');
          const links = await open(linksPart, 'w');
          try {
            await links.write('\uFEFF' + PDF_LINKS_HEADER.join(',') + '\n');
            let lines = 0;
            const scan = await forEachPdf(db, outDir, options, async (f, got) => {
              let status = 'ok';
              let pages: number | null = null;
              let text = '';
              let truncated = false;
              if (got.path === null) {
                status = got.status.startsWith('failed: ')
                  ? `error: ${got.status.slice('failed: '.length)}`
                  : got.status;
              } else {
                const r = await extractPdf(new Uint8Array(await readFile(got.path)));
                if (r.error) {
                  status = `error: ${r.error}`;
                } else {
                  pages = r.pages;
                  text = r.text;
                  truncated = r.truncated;
                  const start = options.startUrl || f.url;
                  const rows = r.links.map(
                    (l) =>
                      [f.url, l.page, l.url, isSameHost(start, l.url, sameHost)]
                        .map((c) => escapeCsv(c, cell))
                        .join(',') + '\n',
                  );
                  if (rows.length > 0) await links.write(rows.join(''));
                  linkRows += rows.length;
                }
              }
              await jsonl.write(
                JSON.stringify({
                  url: f.url,
                  file: got.file ?? '',
                  pages,
                  chars: pages === null ? null : text.length,
                  truncated,
                  status,
                  text,
                }) + '\n',
              );
              lines++;
            });
            return { ...scan, lines };
          } finally {
            await jsonl.close();
            await links.close();
          }
        },
        (r) => r.listed > 0,
      ),
    // Both files stand or fall together: with PDFs listed, pdf-links.csv exists (header only when none had a link).
    (r) => r.listed > 0,
  );
  const wrote = pass.listed > 0;
  return {
    rows: wrote ? pass.lines : 0,
    csvPath: wrote ? jsonlPath : null,
    errors: pass.errors,
    skipped: pass.skipped,
    linkRows,
    linksCsvPath: wrote ? linksPath : null,
  };
}
