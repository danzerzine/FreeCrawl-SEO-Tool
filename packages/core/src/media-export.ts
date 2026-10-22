/**
 * Files a crawl pointed at but the project does not hold: the screenshot
 * PNGs of the desktop render hook (sidecar folder beside the project) and
 * the PDF documents, fetched again at export time. `--what screenshots` /
 * `--what pdfs`.
 */

import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { copyFile, mkdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable, Transform, type TransformCallback } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream } from 'node:stream/web';
import type { ProjectDb } from '@freecrawl/db';
import { DEFAULT_CRAWL_CONFIG, type CrawlConfig } from '@freecrawl/shared-types';
import { fetch as undiciFetch } from 'undici';
import { writeExportFile } from './export-file.js';
import { defaultRequestHeaders, formatFetchError } from './http-client.js';
import { locateScreenshot, screenshotDirFor } from './screenshot-paths.js';
import { escapeCsv } from './spreadsheet.js';

/** What one media export did; the caller turns `errors` into the run's errors. */
export interface MediaExportResult {
  /** Rows of the CSV (the files written); 0 means no CSV was written. */
  rows: number;
  /** Path of the CSV, or null when none was written. */
  csvPath: string | null;
  /** Failures, one per file or run-wide problem (the run exits 1). */
  errors: string[];
  /** Files left out on purpose (a size cap), not failures. */
  skipped: string[];
}

/** `<last path segment without extension, or the host>`, safe as a file name. */
function urlStem(url: string): string {
  let raw = url;
  try {
    const u = new URL(url);
    const seg = u.pathname.split('/').filter(Boolean).pop();
    raw = seg ? decodeURIComponent(seg) : u.hostname;
  } catch {
    /* keep the whole string */
  }
  const noExt = raw.replace(/\.[A-Za-z0-9]{1,5}$/, '');
  const stem =
    noExt
      .replace(/[^A-Za-z0-9._-]+/g, '-')
      .replace(/^[-.]+|[-.]+$/g, '')
      .slice(0, 80) || 'page';
  // Windows cannot create a file called CON, NUL, COM1 ... whatever its extension.
  return /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(stem) ? `${stem}_` : stem;
}

/** A short hash of the URL, appended to a name another URL already took. */
const shortHash = (url: string): string => createHash('sha1').update(url).digest('hex').slice(0, 8);

/**
 * `<stem><suffix><ext>`; the URL's short hash goes after the stem when another
 * URL took the name. Names are compared lower-cased: macOS and Windows file
 * systems treat `Guide.pdf` and `guide.pdf` as one file.
 */
function uniqueName(taken: Set<string>, url: string, suffix: string, ext: string): string {
  const stem = urlStem(url);
  let name = `${stem}${suffix}${ext}`;
  if (taken.has(name.toLowerCase())) name = `${stem}-${shortHash(url)}${suffix}${ext}`;
  taken.add(name.toLowerCase());
  return name;
}

/** Writes `rows` as `<outDir>/<name>` (BOM, header, one line per row). */
async function writeSmallCsv(path: string, header: string[], rows: unknown[][]): Promise<void> {
  const cell = { formulaGuard: true };
  const text =
    '﻿' +
    [header, ...rows].map((r) => r.map((c) => escapeCsv(c, cell)).join(',')).join('\n') +
    '\n';
  await writeExportFile(path, (partPath) => writeFile(partPath, text, 'utf8'));
}

export interface ScreenshotExportOptions {
  /**
   * The project file as it is now. Only PNGs inside its `<name>.screenshots/`
   * folder are copied (the rule of the desktop's screenshot viewer); none
   * given means no folder, so every stored path counts as outside.
   */
  projectFile?: string;
}

const OUTSIDE_STATUS = 'outside project';

/**
 * Copy the stored screenshot PNGs into `<outDir>/screenshots/` as
 * `<stem>-<fullpage|fold|mobile>.png` and list them in `screenshots.csv`
 * (url, kind, file, bytes, status). Only a `.png` inside the project's
 * sidecar folder is copied; a path from the sidecar of the project's old
 * place or name is found by file name in the current one. Any other path is
 * a row with status "outside project" and an error entry; a file that is
 * gone is an error entry. The others are still written.
 */
export async function exportScreenshots(
  db: ProjectDb,
  outDir: string,
  options: ScreenshotExportOptions = {},
): Promise<MediaExportResult> {
  const errors: string[] = [];
  const rows: unknown[][] = [];
  const taken = new Set<string>();
  const roots = options.projectFile ? [screenshotDirFor(options.projectFile)] : [];
  let stored = 0;
  for (const shot of db.iterateScreenshotPaths()) {
    stored++;
    const source = locateScreenshot(shot.path, roots);
    if (!source) {
      errors.push(`${shot.url} (${shot.kind}): ${OUTSIDE_STATUS}: ${shot.path}`);
      rows.push([shot.url, shot.kind, '', null, OUTSIDE_STATUS]);
      continue;
    }
    let bytes: number;
    try {
      bytes = (await stat(source)).size;
    } catch {
      errors.push(`${shot.url} (${shot.kind}): file not found: ${shot.path}`);
      continue;
    }
    const name = uniqueName(taken, shot.url, `-${shot.kind}`, '.png');
    try {
      await mkdir(join(outDir, 'screenshots'), { recursive: true });
      await writeExportFile(join(outDir, 'screenshots', name), (partPath) =>
        copyFile(source, partPath),
      );
    } catch (err) {
      errors.push(`${shot.url} (${shot.kind}): ${(err as Error).message}`);
      continue;
    }
    rows.push([shot.url, shot.kind, `screenshots/${name}`, bytes, 'copied']);
  }
  if (stored === 0) {
    return {
      rows: 0,
      csvPath: null,
      errors: ['no screenshots stored in this project'],
      skipped: [],
    };
  }
  if (rows.length === 0) return { rows: 0, csvPath: null, errors, skipped: [] };
  const csvPath = join(outDir, 'screenshots.csv');
  await writeSmallCsv(csvPath, ['url', 'kind', 'file', 'bytes', 'status'], rows);
  return { rows: rows.length, csvPath, errors, skipped: [] };
}

/** The crawl config a PDF request is built from, and whether the desktop encrypted secrets beside it. */
export interface PdfCrawlConfig {
  config: Partial<CrawlConfig>;
  /** The saved config was a `{config, secretsEnc}` envelope with encrypted secrets. */
  secretsEnc: boolean;
}

/**
 * Unwrap a saved crawl config: the desktop's `{config, secretsEnc?}`
 * envelope, or the bare config the CLI saves. Anything else is no config.
 */
export function unwrapCrawlConfig(parsed: unknown): PdfCrawlConfig {
  if (!parsed || typeof parsed !== 'object') return { config: {}, secretsEnc: false };
  const env = parsed as Record<string, unknown>;
  const inner = env['config'];
  if (inner && typeof inner === 'object') {
    return {
      config: inner as Partial<CrawlConfig>,
      secretsEnc: typeof env['secretsEnc'] === 'string' && env['secretsEnc'] !== '',
    };
  }
  return { config: env as Partial<CrawlConfig>, secretsEnc: false };
}

/**
 * Whether the requests need a secret the CLI cannot decrypt: the desktop
 * kept `secretsEnc` and the clean config shows an AUTH secret blanked
 * (config-secrets.ts: `auth.password`, `auth.token`,
 * `formLogin.browser.passwordValue`). A `secretsEnc` that only holds the
 * proxy or webhook URL does not count.
 */
export function authSecretsEncrypted({ config, secretsEnc }: PdfCrawlConfig): boolean {
  if (!secretsEnc) return false;
  const auth = config.auth;
  if ((auth?.type === 'basic' || auth?.type === 'digest') && !auth.password) return true;
  if (auth?.type === 'bearer' && !auth.token) return true;
  const login = config.formLogin;
  return login?.enabled === true && login.browser?.passwordValue === '';
}

const PDF_MAGIC = Buffer.from('%PDF-');
const PDF_MAX_FILE_BYTES = 50 * 1024 * 1024;
export const PDF_MAX_RUN_BYTES = 2 * 1024 * 1024 * 1024;
const PDF_REQUEST_GAP_MS = 500;
const PDF_REQUEST_TIMEOUT_MS = 120_000;
const AUTH_SKIP_STATUS = 'skipped: auth secrets are encrypted by the desktop app';

/**
 * What in a readable config the PDF fetch cannot do: it sends plain headers
 * (basic, bearer, custom) and nothing else. Digest needs a challenge round
 * trip and a form login needs the crawler's session, so those PDFs would
 * come back as 401 or as the login page. Null when nothing blocks.
 */
export function unsupportedPdfAuth(config: Partial<CrawlConfig>): string | null {
  if (config.auth?.type === 'digest') return 'digest authentication';
  const login = config.formLogin;
  if (login?.enabled === true && (login.mode === 'browser' || (login.steps?.length ?? 0) > 0)) {
    return 'form login';
  }
  return null;
}

export interface PdfExportOptions {
  /** From `--config` or the project's `lastCrawlConfig`; none: defaults. */
  crawlConfig?: PdfCrawlConfig;
  /** Whole-run cap in bytes (`--max-bytes`). */
  maxBytes?: number;
  /** One line per notice (the CLI sends it to stderr). */
  onProgress?: (line: string) => void;
  /** Pause between two requests, ms (default 500: 2 per second); tests pass 0. */
  requestGapMs?: number;
}

/** Thrown for a file left out on purpose; the message is its reason. */
class PdfSkip extends Error {}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Download the crawl's PDF documents into `<outDir>/pdfs/` and list them in
 * `pdfs.csv` (url, file, bytes, status, title, author, pages). Requests use
 * the saved config's user agent and custom headers, send
 * `Accept-Encoding: identity` (so Content-Length is the file size), run at
 * 2 per second, and stop at 50 MB per file and `maxBytes` per run. A file
 * already there is not fetched again. When the config needs secrets only the
 * desktop can decrypt, nothing is requested.
 */
export async function exportPdfs(
  db: ProjectDb,
  outDir: string,
  options: PdfExportOptions = {},
): Promise<MediaExportResult> {
  const crawl = options.crawlConfig ?? { config: {}, secretsEnc: false };
  const progress = options.onProgress ?? (() => {});
  const files = [...db.iteratePdfFiles()];
  if (files.length === 0) {
    return { rows: 0, csvPath: null, errors: ['no PDF files in this crawl'], skipped: [] };
  }
  const errors: string[] = [];
  const skipped: string[] = [];
  const unsupported = authSecretsEncrypted(crawl) ? null : unsupportedPdfAuth(crawl.config);
  const authSkipStatus = authSecretsEncrypted(crawl)
    ? AUTH_SKIP_STATUS
    : unsupported
      ? `skipped: ${unsupported} is not supported for PDF files`
      : null;
  if (authSkipStatus) {
    errors.push(
      `${files.length} PDF(s) not requested: ${authSkipStatus.replace(/^skipped: /, '')}`,
    );
  } else if (crawl.secretsEnc) {
    progress(
      'PDFs: the saved crawl config has a proxy that the CLI cannot read; it is not applied.',
    );
  }
  const config = { ...DEFAULT_CRAWL_CONFIG, ...crawl.config };
  const headers = defaultRequestHeaders(
    config.userAgent,
    config.acceptLanguage,
    config.customHeaders,
    config.auth,
  );
  for (const key of Object.keys(headers)) {
    if (['accept', 'accept-encoding'].includes(key.toLowerCase())) delete headers[key];
  }
  headers['accept'] = 'application/pdf,*/*;q=0.8';
  headers['accept-encoding'] = 'identity';
  const runCap = options.maxBytes ?? PDF_MAX_RUN_BYTES;
  const taken = new Set<string>();
  const rows: unknown[][] = [];
  let total = 0;
  let lastRequest = 0;
  const gapMs = options.requestGapMs ?? PDF_REQUEST_GAP_MS;
  const request = async (method: 'GET' | 'HEAD', url: string) => {
    const wait = lastRequest + gapMs - Date.now();
    if (wait > 0) await sleep(wait);
    lastRequest = Date.now();
    return undiciFetch(url, {
      method,
      headers,
      redirect: 'follow',
      signal: AbortSignal.timeout(PDF_REQUEST_TIMEOUT_MS),
    });
  };
  for (const f of files) {
    const name = uniqueName(taken, f.url, '', '.pdf');
    const dest = join(outDir, 'pdfs', name);
    const meta = [f.title, f.author, f.pages];
    const row = (status: string, bytes: number | null): unknown[] => [
      f.url,
      bytes === null ? '' : `pdfs/${name}`,
      bytes,
      status,
      ...meta,
    ];
    if (authSkipStatus) {
      rows.push(row(authSkipStatus, null));
      continue;
    }
    try {
      const have = await stat(dest).then(
        (s) => s.size,
        () => 0,
      );
      let present = have > 0 && f.contentLength !== null && have === f.contentLength;
      if (!present && have > 0 && f.contentLength === null) {
        // Chunked when crawled: the size is unknown, so the server's own HEAD answer decides.
        const head = await request('HEAD', f.url);
        await head.body?.cancel();
        present = head.ok && Number(head.headers.get('content-length')) === have;
      }
      if (present) {
        rows.push(row('already present', have));
        continue;
      }
      if (total >= runCap) throw new PdfSkip(`skipped: run cap of ${runCap} bytes reached`);
      const res = await request('GET', f.url);
      if (!res.ok || !res.body) {
        await res.body?.cancel();
        throw new Error(`HTTP ${res.status}`);
      }
      const declared = Number(res.headers.get('content-length'));
      const room = Math.min(PDF_MAX_FILE_BYTES, runCap - total);
      if (declared > PDF_MAX_FILE_BYTES) {
        await res.body.cancel();
        throw new PdfSkip(
          `skipped: larger than the ${PDF_MAX_FILE_BYTES / 1024 / 1024} MB per-file cap`,
        );
      }
      if (declared > room) {
        await res.body.cancel();
        throw new PdfSkip(`skipped: would pass the run cap of ${runCap} bytes`);
      }
      const type = res.headers.get('content-type') ?? '';
      let bytes = 0;
      // The magic check needs 5 bytes: a shorter first chunk waits for the next one.
      let head: Buffer | null = Buffer.alloc(0);
      const accept = (chunk: Buffer, cb: TransformCallback): void => {
        bytes += chunk.length;
        cb(
          bytes > room
            ? new PdfSkip(
                bytes > PDF_MAX_FILE_BYTES
                  ? `skipped: larger than the ${PDF_MAX_FILE_BYTES / 1024 / 1024} MB per-file cap`
                  : `skipped: would pass the run cap of ${runCap} bytes`,
              )
            : null,
          chunk,
        );
      };
      const notPdf = (): Error =>
        new Error(`not a PDF (got ${type.split(';')[0]!.trim() || 'no content type'})`);
      await writeExportFile(dest, (partPath) =>
        pipeline(
          Readable.fromWeb(res.body as ReadableStream),
          new Transform({
            transform(chunk: Buffer, _enc, cb) {
              if (head === null) return accept(chunk, cb);
              head = Buffer.concat([head, chunk]);
              if (head.length < 5 && !/application\/pdf/i.test(type)) return cb(); // wait for 5 bytes
              // Servers answer a login page or an error page with 200: only a PDF is kept.
              if (!/application\/pdf/i.test(type) && !head.subarray(0, 5).equals(PDF_MAGIC)) {
                return cb(notPdf());
              }
              const all = head;
              head = null;
              accept(all, cb);
            },
            flush(cb) {
              if (bytes === 0 && (head === null || head.length === 0))
                return cb(new Error('empty body'));
              if (head === null) return cb();
              cb(notPdf()); // the whole body is under 5 bytes and no PDF content type
            },
          }),
          createWriteStream(partPath),
        ),
      );
      total += bytes;
      rows.push(row('downloaded', bytes));
    } catch (err) {
      const msg = err instanceof PdfSkip ? err.message : formatFetchError(err);
      if (err instanceof PdfSkip) skipped.push(`${f.url}: ${msg}`);
      else errors.push(`${f.url}: ${msg}`);
      rows.push(row(err instanceof PdfSkip ? msg : `failed: ${msg}`, null));
    }
  }
  const csvPath = join(outDir, 'pdfs.csv');
  await writeSmallCsv(
    csvPath,
    ['url', 'file', 'bytes', 'status', 'title', 'author', 'pages'],
    rows,
  );
  return { rows: rows.length, csvPath, errors, skipped };
}
