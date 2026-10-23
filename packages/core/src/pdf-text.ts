/**
 * The text and the links inside one PDF (B42 / B155 text part), read with
 * `unpdf` (MIT; a serverless build of pdf.js). Export-only: the crawl never
 * keeps PDF bodies, so `--what pdf-text` downloads them again and reads each.
 */

import type { getDocumentProxy as GetDocumentProxy } from 'unpdf';

/** Characters of text kept per PDF. */
export const PDF_TEXT_MAX_CHARS = 5_000_000;
/** Links kept per PDF. */
export const PDF_TEXT_MAX_LINKS = 10_000;
/** Pages read per PDF; the rest are skipped. */
export const PDF_TEXT_MAX_PAGES = 500;
/** Wall time per PDF, ms. */
export const PDF_TEXT_TIMEOUT_MS = 60_000;

export interface PdfTextLimits {
  maxChars?: number;
  maxLinks?: number;
  maxPages?: number;
  timeoutMs?: number;
}

export interface PdfTextResult {
  /** Pages in the file (also when only the first {@link PDF_TEXT_MAX_PAGES} were read). */
  pages: number;
  /** Text of each page read, joined by a form feed (`\f`). */
  text: string;
  /** URI links in page order, then annotation order. */
  links: { url: string; page: number }[];
  /** A cap (characters, links or pages) cut the result. */
  truncated: boolean;
  /** Why nothing could be read: `encrypted`, or the reader's message. */
  error?: string;
}

class Timeout extends Error {}

/**
 * Read `bytes` one page at a time. Never throws: a corrupt or encrypted file
 * comes back with `error` set. One page is held at a time; there is no
 * parallelism. On a timeout the work is abandoned (the race cannot cancel
 * a pdf.js tick already running) and the document is destroyed.
 */
export async function extractPdf(
  bytes: Uint8Array,
  limits: PdfTextLimits = {},
): Promise<PdfTextResult> {
  const maxChars = limits.maxChars ?? PDF_TEXT_MAX_CHARS;
  const maxLinks = limits.maxLinks ?? PDF_TEXT_MAX_LINKS;
  const maxPages = limits.maxPages ?? PDF_TEXT_MAX_PAGES;
  const timeoutMs = limits.timeoutMs ?? PDF_TEXT_TIMEOUT_MS;
  const result: PdfTextResult = { pages: 0, text: '', links: [], truncated: false };
  const parts: string[] = [];
  let chars = 0;
  let abandoned = false;
  let doc: Awaited<ReturnType<typeof GetDocumentProxy>> | undefined;
  let timer: NodeJS.Timeout | undefined;
  const read = async (): Promise<void> => {
    // Loaded on first use, so the desktop (which does not run pdf-text) never loads unpdf at start-up.
    const { getDocumentProxy } = await import('unpdf');
    doc = await getDocumentProxy(bytes, { verbosity: 0 });
    result.pages = doc.numPages;
    const last = Math.min(doc.numPages, maxPages);
    if (doc.numPages > last) result.truncated = true;
    for (let n = 1; n <= last && !abandoned; n++) {
      const page = await doc.getPage(n);
      const content = await page.getTextContent();
      let text = content.items
        .map((item) => ('str' in item ? item.str + (item.hasEOL ? '\n' : '') : ''))
        .join('');
      const room = maxChars - chars - (parts.length > 0 ? 1 : 0); // the form feed counts
      if (text.length > room) {
        text = text.slice(0, Math.max(0, room));
        result.truncated = true;
      }
      parts.push(text);
      chars += text.length + (parts.length > 1 ? 1 : 0);
      for (const a of await page.getAnnotations()) {
        if (a.subtype !== 'Link' || typeof a.url !== 'string' || a.url === '') continue;
        if (result.links.length >= maxLinks) {
          result.truncated = true;
          break;
        }
        result.links.push({ url: a.url, page: n });
      }
      page.cleanup();
      if (chars >= maxChars) {
        if (n < last) result.truncated = true;
        break;
      }
    }
  };
  try {
    await Promise.race([
      read(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Timeout(`timed out after ${timeoutMs} ms`)), timeoutMs);
      }),
    ]);
  } catch (err) {
    abandoned = true;
    result.error =
      err instanceof Timeout
        ? err.message
        : (err as { name?: string }).name === 'PasswordException'
          ? 'encrypted'
          : ((err as Error).message ?? String(err)).split('\n')[0]!.slice(0, 200);
    result.text = '';
    result.links = [];
    parts.length = 0;
    return result;
  } finally {
    clearTimeout(timer);
    void doc?.loadingTask.destroy().catch(() => undefined);
  }
  result.text = parts.join('\f');
  return result;
}
