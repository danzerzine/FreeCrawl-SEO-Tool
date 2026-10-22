/** A date as an instant plus its UTC calendar day (`YYYY-MM-DD`). */
export interface ParsedDate {
  day: string;
  ms: number;
}

const W3C =
  /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|[+-]\d{2}:\d{2}))?$/;

function toParsed(ms: number): ParsedDate | null {
  return Number.isFinite(ms) ? { day: new Date(ms).toISOString().slice(0, 10), ms } : null;
}

/**
 * A sitemap `<lastmod>` (W3C datetime) as a UTC instant. `YYYY-MM-DD` is that
 * day at 00:00 UTC; the time forms need `Z` or `±hh:mm` and are converted to
 * UTC before the day is cut. Year-only and year-month are too coarse, and
 * free text or out-of-range values (`0000-00-00`) give no value.
 */
export function parseSitemapLastmod(text: string): ParsedDate | null {
  const m = W3C.exec(text.trim());
  if (!m) return null;
  const [, y, mo, d, hh = '00', mi = '00', ss = '00', tz] = m;
  const fraction = /\.(\d+)/.exec(text)?.[1];
  const hour = Number(hh);
  const minute = Number(mi);
  const second = Number(ss);
  if (hour > 23 || minute > 59 || second > 59) return null;
  const base = Date.UTC(Number(y), Number(mo) - 1, Number(d), hour, minute, second);
  const check = new Date(base);
  // A rolled-over date (April 31st, month 13, 0000-00-00) is not a date.
  if (
    check.getUTCFullYear() !== Number(y) ||
    check.getUTCMonth() !== Number(mo) - 1 ||
    check.getUTCDate() !== Number(d)
  ) {
    return null;
  }
  let offsetMin = 0;
  if (tz && tz !== 'Z') {
    const oh = Number(tz.slice(1, 3));
    const om = Number(tz.slice(4, 6));
    if (oh > 23 || om > 59) return null;
    offsetMin = (tz[0] === '-' ? -1 : 1) * (oh * 60 + om);
  }
  const ms =
    base + (fraction ? Math.round(Number(`0.${fraction}`) * 1000) : 0) - offsetMin * 60_000;
  return toParsed(ms);
}

const GUARD_MS = 60_000;

/** `urls.crawled_at` is SQLite's `YYYY-MM-DD HH:MM:SS` in UTC: read it as UTC, not local time. */
function crawledAtMs(crawledAt: string): number {
  const t = crawledAt.trim();
  return Date.parse(
    /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(t) ? `${t.replace(' ', 'T')}Z` : t,
  );
}

/**
 * The page's own `Last-Modified` as a date, or null when it cannot be trusted.
 * Rejected: missing or unparsable; later than `now`; within 60 s of the
 * response's `date` header (of `crawledAt` when that is missing or unparsable),
 * because such a server stamps "now" on dynamic pages and the value is the
 * crawl date again. A cache hit (an `Age` header) is rejected too when the
 * value falls within 60 s of `date - age` on the response's own UTC day.
 * Known limit: a cache that sends no `Age` can still yield a near-crawl date.
 * `headers` keys are lowercase, as stored.
 */
export function acceptedLastModified(
  headers: { 'last-modified'?: string | null; date?: string | null; age?: string | null },
  crawledAt: string,
  now: number,
): ParsedDate | null {
  const raw = headers['last-modified'];
  const lm = raw ? toParsed(Date.parse(raw)) : null;
  if (!lm || lm.ms > now) return null;
  const dateMs = headers.date ? Date.parse(headers.date) : NaN;
  const responseMs = Number.isFinite(dateMs) ? dateMs : crawledAtMs(crawledAt);
  if (!Number.isFinite(responseMs)) return lm;
  if (Math.abs(responseMs - lm.ms) <= GUARD_MS) return null;
  const age =
    headers.age?.trim() && /^\d+$/.test(headers.age.trim()) ? Number(headers.age.trim()) : NaN;
  if (
    Number.isFinite(age) &&
    Number.isFinite(dateMs) &&
    new Date(dateMs).toISOString().slice(0, 10) === lm.day &&
    Math.abs(dateMs - age * 1000 - lm.ms) <= GUARD_MS
  ) {
    return null;
  }
  return lm;
}
