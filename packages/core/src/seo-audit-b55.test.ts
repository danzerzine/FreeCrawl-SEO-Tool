import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { ProjectDb } from '@freecrawl/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runSeoAuditExport } from './seo-audit-export.js';

// Header rows copied verbatim from Screaming Frog 24's SEO Audit export, BOM stripped.
export const SF_HEADERS: Record<string, string> = {
  "amp_all.csv": "\"Address\",\"Content Type\",\"Status Code\",\"Status\",\"Indexability\",\"Indexability Status\",\"Title 1\",\"Title 1 Length\",\"Title 1 Pixel Width\",\"H1-1\",\"H1-1 Length\",\"Canonical Link Element 1\",\"Size (Bytes)\",\"Word Count\",\"Text Ratio\",\"Crawl Depth\",\"Link Score\",\"Response Time\"",
  "canonicals_all.csv": "\"Address\",\"Occurrences\",\"Indexability\",\"Indexability Status\",\"Canonical Link Element 1\",\"HTTP Canonical\",\"Meta Robots 1\",\"X-Robots-Tag 1\",\"rel=\"\"next\"\" 1\",\"rel=\"\"prev\"\" 1\",\"HTTP rel=\"\"next\"\" 1\",\"HTTP rel=\"\"prev\"\" 1\"",
  "directives_all.csv": "\"Address\",\"Occurrences\",\"Meta Robots 1\",\"X-Robots-Tag 1\",\"Meta Refresh 1\",\"Canonical Link Element 1\",\"HTTP Canonical\",\"Indexability\",\"Indexability Status\"",
  "external_all.csv": "\"Address\",\"Content Type\",\"Status Code\",\"Status\",\"Crawl Depth\",\"Inlinks\"",
  "h1_all.csv": "\"Address\",\"Occurrences\",\"H1-1\",\"H1-1 Length\",\"Indexability\",\"Indexability Status\"",
  "h1_missing.csv": "\"Address\",\"Occurrences\",\"H1-1\",\"H1-1 Length\",\"Indexability\",\"Indexability Status\"",
  "hreflang_all.csv": "\"Address\",\"Title 1\",\"Occurrences\",\"HTML hreflang 1\",\"HTML hreflang 1 URL\",\"HTTP hreflang 1\",\"HTTP hreflang 1 URL\",\"Sitemap hreflang 1\",\"Sitemap hreflang 1 URL\",\"Indexability\",\"Indexability Status\"",
  "internal_all.csv": "\"Address\",\"Content Type\",\"Status Code\",\"Status\",\"Indexability\",\"Indexability Status\",\"Title 1\",\"Title 1 Length\",\"Title 1 Pixel Width\",\"Meta Description 1\",\"Meta Description 1 Length\",\"Meta Description 1 Pixel Width\",\"Meta Keywords 1\",\"Meta Keywords 1 Length\",\"H1-1\",\"H1-1 Length\",\"H2-1\",\"H2-1 Length\",\"H2-2\",\"H2-2 Length\",\"Meta Robots 1\",\"X-Robots-Tag 1\",\"Meta Refresh 1\",\"Canonical Link Element 1\",\"rel=\"\"next\"\" 1\",\"rel=\"\"prev\"\" 1\",\"HTTP rel=\"\"next\"\" 1\",\"HTTP rel=\"\"prev\"\" 1\",\"amphtml Link Element\",\"Size (Bytes)\",\"Transferred (Bytes)\",\"Total Transferred (Bytes)\",\"CO2 (mg)\",\"Carbon Rating\",\"Word Count\",\"Sentence Count\",\"Average Words Per Sentence\",\"Flesch Reading Ease Score\",\"Readability\",\"Text Ratio\",\"Crawl Depth\",\"Folder Depth\",\"Link Score\",\"Inlinks\",\"Unique Inlinks\",\"Unique JS Inlinks\",\"% of Total\",\"Outlinks\",\"Unique Outlinks\",\"Unique JS Outlinks\",\"External Outlinks\",\"Unique External Outlinks\",\"Unique External JS Outlinks\",\"Closest Near Duplicate Match\",\"No. Near Duplicates\",\"Spelling Errors\",\"Grammar Errors\",\"Hash\",\"Response Time\",\"Last Modified\",\"Redirect URL\",\"Redirect Type\",\"Cookies\",\"Language\",\"HTTP Version\",\"Mobile Alternate Link\",\"Closest Semantically Similar Address\",\"Semantic Similarity Score\",\"No. Semantically Similar\",\"Semantic Relevance Score\",\"URL Encoded Address\",\"Crawl Timestamp\"",
  "internal_html.csv": "\"Address\",\"Content Type\",\"Status Code\",\"Status\",\"Indexability\",\"Indexability Status\",\"Title 1\",\"Title 1 Length\",\"Title 1 Pixel Width\",\"Meta Description 1\",\"Meta Description 1 Length\",\"Meta Description 1 Pixel Width\",\"Meta Keywords 1\",\"Meta Keywords 1 Length\",\"H1-1\",\"H1-1 Length\",\"H2-1\",\"H2-1 Length\",\"H2-2\",\"H2-2 Length\",\"Meta Robots 1\",\"X-Robots-Tag 1\",\"Meta Refresh 1\",\"Canonical Link Element 1\",\"rel=\"\"next\"\" 1\",\"rel=\"\"prev\"\" 1\",\"HTTP rel=\"\"next\"\" 1\",\"HTTP rel=\"\"prev\"\" 1\",\"amphtml Link Element\",\"Size (Bytes)\",\"Transferred (Bytes)\",\"Total Transferred (Bytes)\",\"CO2 (mg)\",\"Carbon Rating\",\"Word Count\",\"Sentence Count\",\"Average Words Per Sentence\",\"Flesch Reading Ease Score\",\"Readability\",\"Text Ratio\",\"Crawl Depth\",\"Folder Depth\",\"Link Score\",\"Inlinks\",\"Unique Inlinks\",\"Unique JS Inlinks\",\"% of Total\",\"Outlinks\",\"Unique Outlinks\",\"Unique JS Outlinks\",\"External Outlinks\",\"Unique External Outlinks\",\"Unique External JS Outlinks\",\"Closest Near Duplicate Match\",\"No. Near Duplicates\",\"Spelling Errors\",\"Grammar Errors\",\"Hash\",\"Response Time\",\"Last Modified\",\"Redirect URL\",\"Redirect Type\",\"Cookies\",\"Language\",\"HTTP Version\",\"Mobile Alternate Link\",\"Closest Semantically Similar Address\",\"Semantic Similarity Score\",\"No. Semantically Similar\",\"Semantic Relevance Score\",\"URL Encoded Address\",\"Crawl Timestamp\"",
  "meta_description_all.csv": "\"Address\",\"Occurrences\",\"Meta Description 1\",\"Meta Description 1 Length\",\"Meta Description 1 Pixel Width\",\"Indexability\",\"Indexability Status\"",
  "meta_description_duplicate.csv": "\"Address\",\"Occurrences\",\"Meta Description 1\",\"Meta Description 1 Length\",\"Meta Description 1 Pixel Width\",\"Indexability\",\"Indexability Status\"",
  "meta_description_missing.csv": "\"Address\",\"Occurrences\",\"Meta Description 1\",\"Meta Description 1 Length\",\"Meta Description 1 Pixel Width\",\"Indexability\",\"Indexability Status\"",
  "page_titles_all.csv": "\"Address\",\"Occurrences\",\"Title 1\",\"Title 1 Length\",\"Title 1 Pixel Width\",\"Indexability\",\"Indexability Status\"",
  "page_titles_duplicate.csv": "\"Address\",\"Occurrences\",\"Title 1\",\"Title 1 Length\",\"Title 1 Pixel Width\",\"Indexability\",\"Indexability Status\"",
  "page_titles_missing.csv": "\"Address\",\"Occurrences\",\"Title 1\",\"Title 1 Length\",\"Title 1 Pixel Width\",\"Indexability\",\"Indexability Status\"",
  "pagination_all.csv": "\"Address\",\"Indexability\",\"Indexability Status\",\"rel=\"\"next\"\" 1\",\"HTTP rel=\"\"next\"\" 1\",\"rel=\"\"prev\"\" 1\",\"HTTP rel=\"\"prev\"\" 1\",\"Canonical Link Element 1\",\"HTTP Canonical\",\"Meta Robots 1\",\"X-Robots-Tag 1\"",
  "response_codes_all.csv": "\"Address\",\"Content Type\",\"Status Code\",\"Status\",\"Indexability\",\"Indexability Status\",\"Inlinks\",\"Response Time\",\"Redirect URL\",\"Redirect Type\"",
  "response_codes_client_error_(4xx).csv": "\"Address\",\"Content Type\",\"Status Code\",\"Status\",\"Indexability\",\"Indexability Status\",\"Inlinks\",\"Response Time\",\"Redirect URL\",\"Redirect Type\"",
  "response_codes_redirection_(3xx).csv": "\"Address\",\"Content Type\",\"Status Code\",\"Status\",\"Indexability\",\"Indexability Status\",\"Inlinks\",\"Response Time\",\"Redirect URL\",\"Redirect Type\"",
  "response_codes_server_error_(5xx).csv": "\"Address\",\"Content Type\",\"Status Code\",\"Status\",\"Indexability\",\"Indexability Status\",\"Inlinks\",\"Response Time\",\"Redirect URL\",\"Redirect Type\"",
  "security_all.csv": "\"Address\",\"Content Type\",\"Status Code\",\"Status\",\"HTTP Version\",\"Indexability\",\"Indexability Status\",\"Canonical Link Element 1\",\"Meta Robots 1\",\"X-Robots-Tag 1\"",
  "structured_data_all.csv": "\"Address\",\"Errors\",\"Warnings\",\"Rich Result Errors\",\"Rich Result Warnings\",\"Rich Result Features\",\"Feature-1\",\"Total Types\",\"Unique Types\",\"Type-1\",\"Indexability\",\"Indexability Status\"",
};

const PAGE = 'https://ex.com/page';
const OLD = 'https://ex.com/old';
const NOPE = 'https://ex.com/nope.html';
const CSS = 'https://ex.com/s.css';
const BODY = [
  '<html lang="en"><head><title>Page</title>',
  '<meta name="description" content="  ">',
  '<meta name="robots" content="NOARCHIVE,NOCACHE">',
  '</head><body><h1>A</h1><h1>B</h1><h2>First h2</h2><h2>Second</h2></body></html>',
].join('\n');

let dir: string;
let file: string;
let out: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-b55-'));
  file = path.join(dir, 'p.seoproject');
  out = path.join(dir, 'seo-audit');
  new ProjectDb(file).close();
  const raw = new DatabaseSync(file);
  const len = Buffer.byteLength(BODY);
  raw.exec(`
    INSERT INTO urls (id, url, content_kind, status_code, status_text, indexability, indexability_reason,
                      title, title_length, title_count, h1, h1_length, h1_count, h2_count, headings,
                      meta_robots, content_type, content_length, http_protocol, word_count, sentence_count,
                      flesch_reading_ease, lang)
    VALUES (1, '${PAGE}', 'html', 200, NULL, 'indexable', NULL,
            'Page', 4, 1, 'A', 1, 2, 2,
            '[{"level":1,"text":"A"},{"level":1,"text":"B"},{"level":2,"text":"First h2"},{"level":2,"text":"Second"}]',
            'noarchive,nocache', 'text/html; charset=utf-8', ${len}, 'h2', 30, 10, 75.5, 'en');
    INSERT INTO urls (id, url, content_kind, status_code, status_text, indexability, indexability_reason,
                      content_type, redirect_target, http_protocol)
    VALUES (2, '${OLD}', 'html', 301, NULL, 'non-indexable:redirect', 'Redirects to ${PAGE}',
            'text/html', '${PAGE}', 'h2');
    INSERT INTO urls (id, url, content_kind, status_code, status_text, indexability, indexability_reason, content_type)
    VALUES (3, '${NOPE}', 'html', 404, NULL, 'non-indexable:client-error', 'HTTP 404', 'text/html');
    INSERT INTO urls (id, url, content_kind, status_code, indexability, content_type, content_length)
    VALUES (4, '${CSS}', 'css', 200, 'indexable', 'text/css', 120);
    INSERT INTO links (from_url_id, to_url, is_internal) VALUES
      (1, 'https://other.org/a', 0), (1, 'https://other.org/a', 0), (1, 'https://other.org/b', 0), (1, '${CSS}', 1);
  `);
  raw.close();
  const db = new ProjectDb(file);
  db.setUrlSource(1, BODY);
  db.setUrlHeaders(1, [['Last-Modified', 'Wed, 08 Feb 2023 21:02:32 GMT']]);
  db.setUrlHeaders(4, [['Last-Modified', 'Wed, 08 Feb 2023 21:02:33 GMT']]);
  db.close();
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

/** Minimal RFC 4180 reader: quoted fields, doubled quotes, CRLF rows. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\r') continue;
    else if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += ch;
  }
  if (cell !== '' || row.length > 0) { row.push(cell); rows.push(row); }
  return rows;
}

async function exportAll(): Promise<Record<string, string>> {
  const db = new ProjectDb(file);
  const res = await runSeoAuditExport(db, out);
  db.close();
  expect(res.errors).toEqual([]);
  const files: Record<string, string> = {};
  for (const name of fs.readdirSync(out)) files[name] = fs.readFileSync(path.join(out, name), 'utf8');
  return files;
}

function table(text: string): Record<string, string>[] {
  const [head, ...rows] = parseCsv(text.replace(/^﻿/, ''));
  return rows.map((r) => Object.fromEntries(head!.map((h, i) => [h, r[i] ?? ''])));
}

const byUrl = (rows: Record<string, string>[], url: string): Record<string, string> => {
  const r = rows.find((x) => x['Address'] === url);
  if (!r) throw new Error(`no row ${url}`);
  return r;
};

describe('B55: SEO Audit export in Screaming Frog layout', () => {
  it('writes every SF file name, header-only when empty, each header verbatim', async () => {
    const files = await exportAll();
    expect(Object.keys(files).sort()).toEqual(Object.keys(SF_HEADERS).sort());
    for (const [name, header] of Object.entries(SF_HEADERS)) {
      expect(files[name]!.startsWith('﻿' + header + '\r\n'), name).toBe(true);
    }
    for (const empty of ['meta_description_duplicate.csv', 'response_codes_server_error_(5xx).csv', 'amp_all.csv', 'external_all.csv']) {
      expect(files[empty]).toBe('﻿' + SF_HEADERS[empty] + '\r\n');
    }
  });

  it('Status is the reason phrase and Indexability Status is the SF wording', async () => {
    const rc = table((await exportAll())['response_codes_all.csv']!);
    expect(byUrl(rc, PAGE)['Status']).toBe('OK');
    expect(byUrl(rc, OLD)['Status']).toBe('Moved Permanently');
    expect(byUrl(rc, NOPE)['Status']).toBe('Not Found');
    expect(byUrl(rc, OLD)['Indexability Status']).toBe('Redirected');
    expect(byUrl(rc, NOPE)['Indexability Status']).toBe('Client Error');
    expect(byUrl(rc, PAGE)['Indexability Status']).toBe('');
    expect(byUrl(rc, OLD)['Redirect URL']).toBe(PAGE);
  });

  it('row membership per file', async () => {
    const files = await exportAll();
    const keys = (name: string): string[] => table(files[name]!).map((r) => r['Address']!).sort();
    for (const f of ['page_titles_all.csv', 'meta_description_all.csv', 'h1_all.csv', 'canonicals_all.csv', 'pagination_all.csv', 'hreflang_all.csv', 'structured_data_all.csv']) {
      expect(keys(f), f).toEqual([PAGE]);
    }
    expect(keys('directives_all.csv')).toEqual([CSS, PAGE].sort());
    expect(keys('security_all.csv')).toEqual([CSS, NOPE, OLD, PAGE].sort());
    expect(keys('internal_all.csv')).toEqual([CSS, NOPE, OLD, PAGE].sort());
    expect(keys('internal_html.csv')).toEqual([NOPE, OLD, PAGE].sort());
    expect(keys('response_codes_redirection_(3xx).csv')).toEqual([OLD]);
    expect(keys('response_codes_client_error_(4xx).csv')).toEqual([NOPE]);
    expect(keys('meta_description_missing.csv')).toEqual([PAGE]);
  });

  it('Occurrences counts the elements on the page', async () => {
    const files = await exportAll();
    expect(byUrl(table(files['h1_all.csv']!), PAGE)['Occurrences']).toBe('2');
    expect(byUrl(table(files['page_titles_all.csv']!), PAGE)['Occurrences']).toBe('1');
    // An empty <meta name="description"> is still one occurrence.
    expect(byUrl(table(files['meta_description_missing.csv']!), PAGE)['Occurrences']).toBe('1');
    const dir = table(files['directives_all.csv']!);
    expect(byUrl(dir, PAGE)['Occurrences']).toBe('1');
    expect(byUrl(dir, CSS)['Occurrences']).toBe('0');
  });

  it('internal columns: zeros, raw meta robots, H2s, hash, headers, versions', async () => {
    const files = await exportAll();
    const rows = table(files['internal_all.csv']!);
    const page = byUrl(rows, PAGE);
    const css = byUrl(rows, CSS);
    const old = byUrl(rows, OLD);
    expect(page['Meta Description 1 Length']).toBe('0');
    expect(css['H1-1 Length']).toBe('0');
    expect(css['Title 1 Length']).toBe('0');
    expect(css['Meta Keywords 1 Length']).toBe('0');
    expect(css['Word Count']).toBe('0');
    expect(css['Sentence Count']).toBe('');
    expect(page['Meta Robots 1']).toBe('NOARCHIVE,NOCACHE');
    expect(byUrl(table(files['directives_all.csv']!), PAGE)['Meta Robots 1']).toBe('NOARCHIVE,NOCACHE');
    expect(page['H2-1']).toBe('First h2');
    expect(page['H2-1 Length']).toBe('8');
    expect(page['H2-2']).toBe('Second');
    expect(css['H2-1 Length']).toBe('0');
    const md5 = createHash('md5').update(BODY).digest('hex').replace(/^0+/, '');
    expect(page['Hash']).toBe(md5);
    expect(css['Hash']).toBe('');
    expect(page['Last Modified']).toBe('Wed, 08 Feb 2023 21:02:32 GMT');
    expect(css['Last Modified']).toBe('Wed, 08 Feb 2023 21:02:33 GMT');
    expect(page['HTTP Version']).toBe('2');
    expect(page['External Outlinks']).toBe('3');
    expect(page['Unique External Outlinks']).toBe('2');
    expect(css['External Outlinks']).toBe('0');
    expect(page['Size (Bytes)']).toBe(String(Buffer.byteLength(BODY)));
    expect(page['Transferred (Bytes)']).toBe(String(Buffer.byteLength(BODY)));
    expect(page['Sentence Count']).toBe('10');
    expect(page['Average Words Per Sentence']).toBe('3');
    expect(page['Readability']).toBe('Fairly Easy');
    expect(page['URL Encoded Address']).toBe(PAGE);
    // SF counts folders, not path segments: /page sits at depth 0.
    expect(page['Folder Depth']).toBe('0');
    expect(css['Folder Depth']).toBe('0');
    expect(old['Indexability Status']).toBe('Redirected');
    expect(byUrl(table(files['security_all.csv']!), PAGE)['HTTP Version']).toBe('2');
  });
});
