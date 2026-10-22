import { parentPort } from 'node:worker_threads';
import { extractProseText, parseHtml } from './html-parser.js';

/**
 * HTML-parser worker thread, run by {@link ParserPool}.
 *
 * Cheerio + the link/image/structured-data extractor is the hottest CPU
 * path in `fetchAndProcess`; a heavy listing page can take 10-25 s of pure
 * JS. Here the parse runs off the main thread, which only waits for the
 * result. Imports the parser module alone, not all of core, to keep each
 * worker small.
 *
 * Protocol:
 *   worker → main on start: `{ ready: true }`
 *   main → worker:  `{ requestId, html, pageUrl, opts, mode }`
 *   worker → main:  `{ requestId, ok: true, result }`
 *                or `{ requestId, ok: false, error }`
 */

if (!parentPort) {
  throw new Error('parse-worker: must be loaded via worker_threads');
}

interface ParseRequest {
  requestId: number;
  html: string;
  pageUrl: string;
  opts: Parameters<typeof parseHtml>[2];
  /** `prose` — return the main-content text instead of the full parse. */
  mode?: 'parse' | 'prose';
}

parentPort.on('message', (msg: ParseRequest) => {
  if (!msg || typeof msg.requestId !== 'number') return;
  try {
    const result =
      msg.mode === 'prose'
        ? extractProseText(msg.html, msg.opts?.contentAreaSelector)
        : parseHtml(msg.html, msg.pageUrl, msg.opts);
    parentPort!.postMessage({ requestId: msg.requestId, ok: true, result });
  } catch (err) {
    parentPort!.postMessage({
      requestId: msg.requestId,
      ok: false,
      error: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
    });
  }
});

parentPort.postMessage({ ready: true });
