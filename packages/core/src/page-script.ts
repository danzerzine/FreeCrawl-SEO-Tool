import type { Page } from 'playwright';

/** Marks the wrapper expression so a test double can tell it from the module's other evaluates. */
export const PAGE_SCRIPT_MARK = '/*fc-page-script*/';

/** A returned value above this many characters is replaced, never truncated. */
export const PAGE_SCRIPT_RESULT_MAX = 16 * 1024;

/** Longest `jsRender.pageScript` the config accepts. */
export const PAGE_SCRIPT_MAX_CHARS = 20_000;

/** Default and bounds of `jsRender.pageScriptTimeoutMs`. */
export const PAGE_SCRIPT_TIMEOUT_DEFAULT_MS = 5_000;
export const PAGE_SCRIPT_TIMEOUT_MIN_MS = 500;
export const PAGE_SCRIPT_TIMEOUT_MAX_MS = 30_000;

/** How long a page may take to answer a trivial evaluate after the script timed out. */
export const PAGE_SCRIPT_PROBE_MS = 2_000;

/** Margin added to goto + wait + script time for the whole render limit. */
export const RENDER_LIMIT_MARGIN_MS = 5_000;

export function clampPageScriptTimeout(ms: number | undefined): number {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return PAGE_SCRIPT_TIMEOUT_DEFAULT_MS;
  return Math.min(PAGE_SCRIPT_TIMEOUT_MAX_MS, Math.max(PAGE_SCRIPT_TIMEOUT_MIN_MS, Math.round(ms)));
}

/**
 * The script as one expression: an async function around the user's text.
 * The page returns the value already as JSON (so a circular value is an
 * error here, not a failed serialisation on the way out) or the error text.
 */
export function wrapPageScript(script: string): string {
  return (
    `${PAGE_SCRIPT_MARK}(async () => { try { const __v = await (async () => {\n${script}\n})();` +
    ` return { v: __v === undefined ? undefined : JSON.stringify(__v) }; }` +
    ` catch (e) { return { e: String((e && e.message) || e) }; } })()`
  );
}

export interface PageScriptOutcome {
  /** JSON stored under `$script`; undefined when the script returned nothing. */
  json: string | undefined;
  /** The script did not finish within its timeout. */
  timedOut: boolean;
}

const errJson = (message: string): string => JSON.stringify({ error: message.slice(0, 300) });

/**
 * Runs the user's script once on a rendered page. Errors and timeouts never
 * throw: they come back as `{"error": ...}`. The script text is never logged.
 */
export async function runPageScript(
  page: Pick<Page, 'evaluate'>,
  script: string,
  timeoutMs: number,
): Promise<PageScriptOutcome> {
  const run = Promise.resolve().then(
    () => page.evaluate(wrapPageScript(script)) as Promise<{ v?: string; e?: string } | undefined>,
  );
  // The loser of the race must never become an unhandled rejection (page closed later).
  run.catch(() => {});
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), timeoutMs);
  });
  try {
    const won = await Promise.race([run, timeout]);
    if (won === 'timeout') return { json: errJson('timeout'), timedOut: true };
    if (won?.e !== undefined) return { json: errJson(won.e), timedOut: false };
    if (won?.v === undefined) return { json: undefined, timedOut: false };
    if (won.v.length > PAGE_SCRIPT_RESULT_MAX) {
      return { json: errJson('result too large'), timedOut: false };
    }
    return { json: won.v, timedOut: false };
  } catch (err) {
    return { json: errJson(err instanceof Error ? err.message : String(err)), timedOut: false };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
