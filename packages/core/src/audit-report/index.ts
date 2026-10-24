/**
 * The audit report (`--what audit`): a one-file HTML crawl audit with a
 * plain-language summary, the fixes in order and a 0-100 health score.
 */

import { writeFile } from 'node:fs/promises';
import type { ProjectDb } from '@freecrawl/db';
import type { CrawlConfig, ReportBranding } from '@freecrawl/shared-types';
import { writeExportFile } from '../export-file.js';
import { buildAuditData } from './data.js';
import { renderAuditReport } from './render.js';
import type { AuditLang } from './texts.js';

export {
  buildAuditData,
  sectionOf,
  type AuditData,
  type AuditIssue,
  type AuditDataOptions,
} from './data.js';
export { renderAuditReport, type AuditRenderOptions } from './render.js';
export type { AuditLang } from './texts.js';

export interface AuditReportOptions {
  lang?: AuditLang;
  branding?: ReportBranding;
  /** The crawl's config, when known: adds the page limit, robots.txt and user agent to the method notes. */
  crawlConfig?: Partial<CrawlConfig>;
}

export async function exportAuditReport(
  db: ProjectDb,
  filePath: string,
  options: AuditReportOptions = {},
): Promise<{ bytes: number }> {
  const data = buildAuditData(db, options.crawlConfig ? { crawlConfig: options.crawlConfig } : {});
  const html = renderAuditReport(data, {
    ...(options.lang ? { lang: options.lang } : {}),
    ...(options.branding ? { branding: options.branding } : {}),
  });
  return writeExportFile(filePath, async (partPath) => {
    await writeFile(partPath, html, 'utf8');
    return { bytes: Buffer.byteLength(html) };
  });
}
