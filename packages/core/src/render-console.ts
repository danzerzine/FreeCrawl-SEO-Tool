import type { Page } from 'playwright';

/** At most this many entries are kept per page; the counts stay true. */
export const CONSOLE_LOG_MAX_ENTRIES = 50;
/** Console text is clipped to this many characters. */
export const CONSOLE_TEXT_MAX_CHARS = 300;

export interface ConsoleLogEntry {
  /** console: a console error; pageerror: an uncaught error; failed: a request that failed; http: a subresource answered >= 400. */
  kind: 'console' | 'pageerror' | 'failed' | 'http';
  text?: string;
  url?: string;
  /** Resource type of the request (script, image, ...). */
  type?: string;
  status?: number;
}

export interface ConsoleLog {
  /** Console errors plus uncaught page errors. */
  errors: number;
  /** Failed requests plus subresource responses >= 400. */
  failed: number;
  entries: ConsoleLogEntry[];
}

interface Collector {
  /** Detaches every listener and returns what was collected. Safe to call twice. */
  finish(): ConsoleLog;
}

const clip = (s: string): string =>
  s.length > CONSOLE_TEXT_MAX_CHARS ? s.slice(0, CONSOLE_TEXT_MAX_CHARS) : s;
// Chromium echoes each failed or blocked subresource as a console error.
const RESOURCE_ECHO = /^Failed to load resource/;

/**
 * Listens to one page for one render (B35): console errors, uncaught errors,
 * failed requests and subresource responses >= 400. Pages are reused, so the
 * caller must call `finish()` in a `finally`. Only requests that started
 * after attaching are counted, and each request counts once.
 */
export function attachConsoleCollector(
  page: Pick<Page, 'on' | 'off'>,
  opts: { blockedTypes?: ReadonlySet<string> } = {},
): Collector {
  const log: ConsoleLog = { errors: 0, failed: 0, entries: [] };
  const started = new WeakSet<object>();
  const counted = new WeakSet<object>();
  const push = (e: ConsoleLogEntry): void => {
    if (log.entries.length < CONSOLE_LOG_MAX_ENTRIES) log.entries.push(e);
  };

  type Req = {
    url(): string;
    resourceType(): string;
    failure(): { errorText: string } | null;
    isNavigationRequest(): boolean;
  };
  const onRequest = (r: Req): void => {
    started.add(r);
  };
  const onConsole = (m: { type(): string; text(): string }): void => {
    if (m.type() !== 'error') return;
    const text = m.text();
    if (RESOURCE_ECHO.test(text)) return;
    log.errors++;
    push({ kind: 'console', text: clip(text) });
  };
  const onPageError = (e: unknown): void => {
    log.errors++;
    push({ kind: 'pageerror', text: clip(e instanceof Error ? e.message : String(e)) });
  };
  const onResponse = (resp: { status(): number; url(): string; request(): Req }): void => {
    const status = resp.status();
    if (status < 400) return;
    const r = resp.request();
    if (!started.has(r) || counted.has(r) || r.isNavigationRequest()) return;
    counted.add(r);
    log.failed++;
    push({ kind: 'http', url: clip(resp.url()), type: r.resourceType(), status });
  };
  const onRequestFailed = (r: Req): void => {
    if (!started.has(r) || counted.has(r)) return;
    const type = r.resourceType();
    if (opts.blockedTypes?.has(type)) return;
    counted.add(r);
    log.failed++;
    push({ kind: 'failed', url: clip(r.url()), type, text: clip(r.failure()?.errorText ?? '') });
  };

  page.on('request', onRequest as never);
  page.on('console', onConsole as never);
  page.on('pageerror', onPageError as never);
  page.on('response', onResponse as never);
  page.on('requestfailed', onRequestFailed as never);

  let done = false;
  return {
    finish(): ConsoleLog {
      if (!done) {
        done = true;
        page.off('request', onRequest as never);
        page.off('console', onConsole as never);
        page.off('pageerror', onPageError as never);
        page.off('response', onResponse as never);
        page.off('requestfailed', onRequestFailed as never);
      }
      return log;
    },
  };
}
