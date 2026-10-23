/**
 * Crawl-trap watch (B90): counts the page URLs a crawl admits per section and
 * per parameter pattern, and names a pattern that has grown far beyond what the
 * site is expected to hold. Pure and Electron-free; the crawler feeds it from
 * one place (`Crawler.enqueue`) and asks `check()` every `checkEvery` URLs.
 *
 * Memory is bounded: two aggregate tables (section + parameter names, host +
 * parameter names) and one count-only section map, each at most `maxKeys`
 * keys of at most 200 characters. A pattern key keeps, per parameter name (at
 * most 6), 64 value hashes, so «how many different values» costs 256 bytes.
 * Facts only: counts and example URLs, no verdict word and no score.
 */

export interface TrapFloors {
  /** R1: crawl found at least this many URLs ... */
  r1Count: number;
  /** ... and this many times the sitemap's. */
  r1Ratio: number;
  /** R2: URLs in one parameter pattern. */
  r2Count: number;
  /** R2: and this share of everything counted. */
  r2Share: number;
  /** R2: and this many times the sitemap's count for the pattern. */
  r2Ratio: number;
  /** R3: URLs in one section. */
  r3Count: number;
  r3Share: number;
  r3Ratio: number;
  /** `observe` says «check now» every this many counted URLs. */
  checkEvery: number;
}

export const TRAP_FLOORS: Readonly<TrapFloors> = {
  r1Count: 5000,
  r1Ratio: 5,
  r2Count: 2000,
  r2Share: 0.2,
  r2Ratio: 10,
  r3Count: 5000,
  r3Share: 0.5,
  r3Ratio: 10,
  checkEvery: 500,
};

export interface CrawlTrapOptions {
  /** Test-only: lower floors. Never a global, never a user setting. */
  floors?: Partial<TrapFloors>;
  /** Cap of keys per table. */
  maxKeys?: number;
}

export interface TrapFinding {
  rule: 'R2' | 'R3';
  key: string;
  count: number;
  /** Sitemap count for this key (S_pattern, S_section), null without a baseline. */
  expected: number | null;
  /** count / URLs counted so far. */
  share: number;
  samples: string[];
  /** URLs counted when it first fired. */
  atCount: number;
  host: string;
  /** R2: the parameter names of the pattern, sorted. */
  names?: string;
  /** R2: the names that vary (>= 3 values, not id-like or routing). */
  varying?: string[];
}

export interface CheckResult {
  /** Findings that fired in this call (never one that fired before). */
  findings: TrapFinding[];
  /** R1, once per crawl: set in the call where it first holds. */
  sitemapShort: { found: number; listed: number } | null;
}

export interface CrawlTrapSnapshot {
  v: 1;
  at: string;
  discovered: number;
  sitemapUrls: number | null;
  findings: TrapFinding[];
  sitemapShort?: { found: number; listed: number };
}

export const CRAWL_TRAP_META_KEY = 'crawlTrapWatch';

const MAX_KEY = 200;
const MAX_NAMES = 6;
const VALUES = 64;
const MAX_FINDINGS = 5;
const MAX_SAMPLES = 3;
const MAX_BASELINE_KEYS = 20_000;
const SCRIPT_EXT = /\.(php|asp|aspx|cgi|jsp)$/i;
const ROUTE_KEYS = new Set(['route', 'option', 'controller', 'page_id']);
const ROUTING = new Set(['route', 'option', 'controller', 'view', 'layout', 'task', 'action']);
const TRAP_PRONE = new Set([
  'q',
  's',
  'search',
  'query',
  'keyword',
  'date',
  'day',
  'month',
  'year',
  'sort',
  'order',
  'dir',
  'ref',
]);
const ID_NAMES = new Set(['id', 'p', 't', 'tid', 'pid']);

const idLikeName = (n: string): boolean => ID_NAMES.has(n) || n.endsWith('id');

interface Parts {
  host: string;
  path: string;
  query: string;
}

function split(url: string): Parts {
  const i = url.indexOf('://');
  const start = i < 0 ? 0 : i + 3;
  let end = url.indexOf('#', start);
  if (end < 0) end = url.length;
  let q = url.indexOf('?', start);
  if (q >= end) q = -1;
  const pathEnd = q < 0 ? end : q;
  const slash = url.indexOf('/', start);
  const hostEnd = slash >= 0 && slash < pathEnd ? slash : pathEnd;
  return {
    host: url.slice(start, hostEnd),
    path: hostEnd < pathEnd ? url.slice(hostEnd, pathEnd) : '/',
    query: q < 0 ? '' : url.slice(q + 1, end),
  };
}

function sectionOf(p: Parts): string {
  const path = p.path;
  const body = path.charCodeAt(0) === 47 ? path.slice(1) : path;
  const e = body.indexOf('/');
  const first = e < 0 ? body : body.slice(0, e);
  const multi = e >= 0 && /[^/]/.test(body.slice(e + 1));
  const last = multi ? body.slice(body.lastIndexOf('/', body.length - 2) + 1) : first;
  const lastSeg = last.endsWith('/') ? last.slice(0, -1) : last;
  const script = SCRIPT_EXT.test(lastSeg);
  const root = first === '';
  let key: string;
  if (multi && first !== '') key = `${p.host}/${first}`;
  else if (script) key = `${p.host}/${lastSeg}`;
  else key = `${p.host}/(root)`;
  if ((script || root) && p.query !== '') {
    let from = 0;
    while (from < p.query.length) {
      let amp = p.query.indexOf('&', from);
      if (amp < 0) amp = p.query.length;
      const eq = p.query.indexOf('=', from);
      const nameEnd = eq >= 0 && eq < amp ? eq : amp;
      const name = p.query.slice(from, nameEnd).toLowerCase();
      if (ROUTE_KEYS.has(name)) {
        key += ` ${name}=${eq >= 0 && eq < amp ? p.query.slice(eq + 1, amp) : ''}`;
        break;
      }
      from = amp + 1;
    }
  }
  return key.length > MAX_KEY ? key.slice(0, MAX_KEY) : key;
}

/** Section a URL belongs to: host + first path segment (2+ segments), else `(root)`. */
export function trapSectionKey(url: string): string {
  return sectionOf(split(url));
}

function cut(s: string): string {
  return s.length > MAX_KEY ? s.slice(0, MAX_KEY) : s;
}

class PatternEntry {
  count = 0;
  /**
   * One block: `k` x 64 value hashes (k = tracked names, the first 6 of the
   * sorted name set), then `k` state words: distinct values seen (capped at
   * 64) | bit 8 saturated (64+) | bit 9 a non-digit value seen.
   */
  readonly vals: Uint32Array;
  samples: string[] | null = null;
  constructor(
    readonly k: number,
    readonly host: string,
    readonly nameSet: string,
  ) {
    this.vals = new Uint32Array(k * (VALUES + 1));
  }
}

interface SectionEntry {
  count: number;
  samples: string[] | null;
}

interface Table<E extends { count: number }> {
  map: Map<string, E>;
  /** New keys are dropped until this many inserts were attempted (a scan freed too little). */
  blockedUntil: number;
  attempts: number;
}

const newTable = <E extends { count: number }>(): Table<E> => ({
  map: new Map(),
  blockedUntil: 0,
  attempts: 0,
});

export class CrawlTrapWatch {
  readonly floors: TrapFloors;
  private readonly maxKeys: number;
  private n = 0;
  private readonly bySection: Table<PatternEntry> = newTable();
  private readonly byHost: Table<PatternEntry> = newTable();
  private readonly sections: Table<SectionEntry> = newTable();
  /** Map iterations spent on batch drops (the test counts them). */
  evictIterations = 0;
  evictScans = 0;

  private baselineHost: string | null = null;
  private sitemapTotal: number | null = null;
  private sSection = new Map<string, number>();
  private sPattern = new Map<string, number>();
  private settled = false;

  private findings: TrapFinding[] = [];
  private fired = new Set<string>();
  private short: { found: number; listed: number } | null = null;

  // Scratch for one observe call.
  private readonly sNames: string[] = [];
  private readonly sHash: number[] = [];
  private readonly sDigits: boolean[] = [];

  constructor(opts: CrawlTrapOptions = {}) {
    this.floors = { ...TRAP_FLOORS, ...(opts.floors ?? {}) };
    this.maxKeys = opts.maxKeys ?? 5000;
  }

  /** URLs counted so far. */
  get discovered(): number {
    return this.n;
  }

  /** Sitemap URLs of the crawled host, null without a baseline. */
  get sitemapUrls(): number | null {
    return this.sitemapTotal;
  }

  /** Whether a clean sitemap baseline is set. */
  get hasBaseline(): boolean {
    return this.sitemapTotal !== null;
  }

  /** The sitemap read has finished, failed or timed out (or there is none). */
  markSettled(): void {
    this.settled = true;
  }

  /**
   * A clean, complete sitemap read. Only entries of `host` count; none of
   * them leaves the baseline off.
   */
  setBaseline(host: string, urls: Iterable<string>): void {
    const want = host.toLowerCase();
    const seen = new Set<string>();
    const sec = new Map<string, number>();
    const pat = new Map<string, number>();
    const bump = (m: Map<string, number>, k: string): void => {
      const v = m.get(k);
      if (v !== undefined) m.set(k, v + 1);
      else if (m.size < MAX_BASELINE_KEYS) m.set(k, 1);
    };
    for (const url of urls) {
      const p = split(url);
      if (p.host.toLowerCase() !== want || seen.has(url)) continue;
      seen.add(url);
      const s = sectionOf(p);
      bump(sec, s);
      if (p.query !== '') {
        const names = this.parseQuery(p.query);
        if (names !== null) {
          bump(pat, cut(`${s}?${names}`));
          bump(pat, cut(`${p.host}?${names}`));
        }
      }
    }
    this.settled = true;
    if (seen.size === 0) {
      this.baselineHost = null;
      this.sitemapTotal = null;
      this.sSection = new Map();
      this.sPattern = new Map();
      return;
    }
    this.baselineHost = want;
    this.sitemapTotal = seen.size;
    this.sSection = sec;
    this.sPattern = pat;
  }

  /** Keep what an earlier run found: those keys never warn again. */
  restore(prev: CrawlTrapSnapshot | null | undefined): void {
    if (!prev || prev.v !== 1) return;
    this.findings = prev.findings.slice(0, MAX_FINDINGS);
    for (const f of prev.findings) this.markFired(f);
    if (prev.sitemapShort) this.short = prev.sitemapShort;
  }

  snapshot(at: string): CrawlTrapSnapshot {
    return {
      v: 1,
      at,
      discovered: this.n,
      sitemapUrls: this.sitemapTotal,
      findings: this.findings,
      ...(this.short ? { sitemapShort: this.short } : {}),
    };
  }

  /** Keys held per table (for the memory-bound tests and diagnostics). */
  tableSizes(): { sections: number; bySection: number; byHost: number } {
    return {
      sections: this.sections.map.size,
      bySection: this.bySection.map.size,
      byHost: this.byHost.map.size,
    };
  }

  /** Count held for a pattern key in the host or section table, 0 when none. */
  patternCount(key: string): number {
    return (this.byHost.map.get(key) ?? this.bySection.map.get(key))?.count ?? 0;
  }

  /** Findings kept so far, largest first. */
  get kept(): readonly TrapFinding[] {
    return this.findings;
  }

  /**
   * Count one admitted page URL. Returns true every `checkEvery` URLs: the
   * caller then runs `check()`.
   */
  observe(url: string): boolean {
    this.n++;
    const p = split(url);
    const sec = sectionOf(p);
    this.touchSection(sec, url);
    if (p.query !== '') {
      const names = this.parseQuery(p.query);
      if (names !== null) {
        const k = this.sNames.length > MAX_NAMES ? MAX_NAMES : this.sNames.length;
        this.touchPattern(this.bySection, cut(`${sec}?${names}`), k, url, p.host, names);
        this.touchPattern(this.byHost, cut(`${p.host}?${names}`), k, url, p.host, names);
      }
    }
    return this.n % this.floors.checkEvery === 0;
  }

  /**
   * Parses a query string into the scratch arrays (sorted by name) and returns
   * the comma-joined name set, or null when the query holds no name.
   */
  private parseQuery(query: string): string | null {
    const names = this.sNames;
    const hashes = this.sHash;
    const digits = this.sDigits;
    names.length = 0;
    hashes.length = 0;
    digits.length = 0;
    let from = 0;
    const len = query.length;
    while (from <= len) {
      let amp = query.indexOf('&', from);
      if (amp < 0) amp = len;
      if (amp > from) {
        const eq = query.indexOf('=', from);
        const hasEq = eq >= 0 && eq < amp;
        const nameEnd = hasEq ? eq : amp;
        if (nameEnd > from) {
          const name = query.slice(from, nameEnd).toLowerCase();
          if (names.indexOf(name) < 0) {
            let h = 0x811c9dc5;
            let dig = hasEq && eq + 1 < amp;
            for (let i = hasEq ? eq + 1 : amp; i < amp; i++) {
              const c = query.charCodeAt(i);
              if (c < 48 || c > 57) dig = false;
              h = Math.imul(h ^ c, 0x01000193);
            }
            // insertion into sorted position
            let j = names.length;
            names.push(name);
            hashes.push(h >>> 0);
            digits.push(dig);
            while (j > 0 && names[j - 1]! > name) {
              names[j] = names[j - 1]!;
              hashes[j] = hashes[j - 1]!;
              digits[j] = digits[j - 1]!;
              j--;
            }
            names[j] = name;
            hashes[j] = h >>> 0;
            digits[j] = dig;
          }
        }
      }
      from = amp + 1;
    }
    return names.length === 0 ? null : names.join(',');
  }

  private room<E extends { count: number }>(t: Table<E>, dropBelow: number): boolean {
    t.attempts++;
    if (t.map.size < this.maxKeys) return true;
    if (t.attempts < t.blockedUntil) return false;
    this.evictScans++;
    let freed = 0;
    for (const [k, e] of t.map) {
      this.evictIterations++;
      if (e.count < dropBelow) {
        t.map.delete(k);
        freed++;
      }
    }
    if (freed < Math.max(1, this.maxKeys / 20)) t.blockedUntil = t.attempts + this.maxKeys / 5;
    return t.map.size < this.maxKeys;
  }

  private touchSection(key: string, url: string): void {
    const t = this.sections;
    let e = t.map.get(key);
    if (e === undefined) {
      if (!this.room(t, this.floors.r3Count / 4)) return;
      e = { count: 0, samples: null };
      t.map.set(key, e);
    }
    e.count++;
    if (
      e.count >= this.floors.r3Count / 4 &&
      (e.samples === null || e.samples.length < MAX_SAMPLES)
    ) {
      (e.samples ??= []).push(url.length > 300 ? url.slice(0, 300) : url);
    }
  }

  private touchPattern(
    t: Table<PatternEntry>,
    key: string,
    k: number,
    url: string,
    host: string,
    nameSet: string,
  ): void {
    let e = t.map.get(key);
    if (e === undefined) {
      if (!this.room(t, this.floors.r2Count / 4)) return;
      e = new PatternEntry(k, host, nameSet);
      t.map.set(key, e);
    }
    e.count++;
    const vals = e.vals;
    const st = e.k * VALUES;
    for (let i = 0; i < e.k; i++) {
      let state = vals[st + i]!;
      if (!this.sDigits[i]) state |= 0x200;
      if (state & 0x100) {
        vals[st + i] = state;
        continue;
      }
      const h = this.sHash[i]!;
      const cnt = state & 0xff;
      const base = i * VALUES;
      let found = false;
      for (let j = 0; j < cnt; j++) {
        if (vals[base + j] === h) {
          found = true;
          break;
        }
      }
      if (!found) {
        vals[base + cnt] = h;
        state = (state & ~0xff) | (cnt + 1);
        if (cnt + 1 >= VALUES) state |= 0x100;
      }
      vals[st + i] = state;
    }
    if (
      e.count >= this.floors.r2Count / 4 &&
      (e.samples === null || e.samples.length < MAX_SAMPLES)
    ) {
      (e.samples ??= []).push(url.length > 300 ? url.slice(0, 300) : url);
    }
  }

  private varyingOf(e: PatternEntry): string[] {
    const out: string[] = [];
    const names = e.nameSet.split(',');
    const st = e.k * VALUES;
    for (let i = 0; i < e.k; i++) {
      const name = names[i]!;
      if (ROUTING.has(name) || idLikeName(name)) continue;
      const state = e.vals[st + i]!;
      if (state & 0x100 && !(state & 0x200)) continue; // digits-only, 64+ values: an id
      if ((state & 0xff) >= 3) out.push(name);
    }
    return out;
  }

  private markFired(f: TrapFinding): void {
    this.fired.add(`${f.rule}|${f.key}`);
    if (f.rule === 'R2' && f.names !== undefined) this.fired.add(`P|${f.host}|${f.names}`);
  }

  /** Evaluates the rules. Cheap: one pass over the tables, only keys above a floor are looked at. */
  check(): CheckResult {
    const fl = this.floors;
    const N = this.n;
    const fresh: TrapFinding[] = [];
    const S = this.sitemapTotal;
    let sitemapShort: CheckResult['sitemapShort'] = null;

    if (S !== null && this.short === null && N >= fl.r1Count && N >= fl.r1Ratio * S) {
      this.short = { found: N, listed: S };
      sitemapShort = this.short;
    }

    // R2
    const cands: { key: string; e: PatternEntry; host: boolean }[] = [];
    for (const [table, host] of [
      [this.byHost, true],
      [this.bySection, false],
    ] as const) {
      for (const [key, e] of table.map) {
        if (e.count < fl.r2Count || e.count < fl.r2Share * N) continue;
        if (this.fired.has(`R2|${key}`)) continue;
        const expected = S === null ? null : (this.sPattern.get(key) ?? 0);
        if (e.count < fl.r2Ratio * Math.max(1, expected ?? 0)) continue;
        if (S === null && !this.settled && e.count < 2 * fl.r2Count) continue;
        cands.push({ key, e, host });
      }
    }
    cands.sort((a, b) => b.e.count - a.e.count || Number(b.host) - Number(a.host));
    for (const { key, e } of cands) {
      const varying = this.varyingOf(e);
      if (!(varying.length >= 2 || varying.some((v) => TRAP_PRONE.has(v)))) continue;
      const h = e.host;
      const names = e.nameSet;
      if (this.fired.has(`P|${h}|${names}`)) continue;
      const f: TrapFinding = {
        rule: 'R2',
        key,
        count: e.count,
        expected: S === null ? null : (this.sPattern.get(key) ?? 0),
        share: e.count / N,
        samples: e.samples ? e.samples.slice() : [],
        atCount: N,
        host: h,
        names,
        varying,
      };
      this.markFired(f);
      fresh.push(f);
    }

    // R3
    if (S !== null) {
      for (const [key, e] of this.sections.map) {
        if (e.count < fl.r3Count || e.count < fl.r3Share * N) continue;
        if (this.fired.has(`R3|${key}`)) continue;
        const inMap = this.sSection.get(key) ?? 0;
        if (e.count < fl.r3Ratio * Math.max(1, inMap)) continue;
        if (inMap >= 0.5 * S) continue; // the sitemap is about this section
        const f: TrapFinding = {
          rule: 'R3',
          key,
          count: e.count,
          expected: inMap,
          share: e.count / N,
          samples: e.samples ? e.samples.slice() : [],
          atCount: N,
          host: key.slice(0, key.indexOf('/')),
        };
        this.markFired(f);
        fresh.push(f);
      }
    }

    // Counts of findings already kept follow the tables (a resume re-evaluates them).
    for (const f of this.findings) {
      const e =
        f.rule === 'R3'
          ? this.sections.map.get(f.key)
          : (this.byHost.map.get(f.key) ?? this.bySection.map.get(f.key));
      if (e && e.count > f.count) {
        f.count = e.count;
        f.share = e.count / Math.max(1, N);
      }
    }
    if (fresh.length > 0) {
      this.findings = [...this.findings, ...fresh]
        .sort((a, b) => b.count - a.count)
        .slice(0, MAX_FINDINGS);
    }
    return { findings: fresh, sitemapShort };
  }
}

const fmt = (n: number): string => n.toLocaleString('en-US');

/** English text of one finding, for the `warn` event, the CLI and the sidebar. */
export function describeTrap(f: TrapFinding, found: number, sitemapUrls: number | null): string {
  const pct = `${Math.round(f.share * 100)} %`;
  const examples = f.samples.length > 0 ? ` Examples: ${f.samples.join(' ')}` : '';
  const stop = (what: string): string =>
    ` The crawl goes on. To stop it, add an exclude pattern (e.g. "${what}") or lower the page limit.`;
  if (f.rule === 'R2') {
    const q = f.key.lastIndexOf('?');
    const shown = `${f.key.slice(0, q)}?${f.key
      .slice(q + 1)
      .split(',')
      .join('&')}`;
    const sm =
      sitemapUrls !== null
        ? `; the sitemap lists ${fmt(f.expected ?? 0)} of them and ${fmt(sitemapUrls)} pages in total`
        : '';
    const what = `${f.varying?.[0] ?? f.names?.split(',')[0] ?? ''}=`;
    return `Possible crawl trap: ${fmt(f.count)} URLs share the pattern ${shown} (${pct} of the ${fmt(found)} found so far)${sm}.${stop(what)}${examples}`;
  }
  const sm = ` the sitemap lists ${fmt(f.expected ?? 0)} there and ${fmt(sitemapUrls ?? 0)} pages in total`;
  const path = f.key.split(' ')[0]!;
  const seg = path.slice(path.indexOf('/'));
  return `Possible crawl trap: ${fmt(f.count)} URLs sit in the section ${f.key} (${pct} of the ${fmt(found)} found so far);${sm}.${stop(seg + '/')}${examples}`;
}

/** Parses the saved meta value; anything unreadable or of another version is null. */
export function parseTrapSnapshot(raw: string | null | undefined): CrawlTrapSnapshot | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<CrawlTrapSnapshot>;
    if (v.v !== 1 || !Array.isArray(v.findings)) return null;
    return v as CrawlTrapSnapshot;
  } catch {
    return null;
  }
}

/**
 * A sitemap read is a baseline only when every file was read without error,
 * abort or truncation and at least one file was parsed (B90: a partial read
 * would make the site look smaller than it is).
 */
export function isCleanSitemapRead(
  res: {
    truncated: boolean;
    errors: readonly unknown[];
    sitemapsParsed: readonly unknown[];
    sitemapsTried: readonly unknown[];
    files: readonly { error: string | null; reason: string | null }[];
  },
  aborted: boolean,
): boolean {
  return (
    !aborted &&
    !res.truncated &&
    res.errors.length === 0 &&
    res.sitemapsParsed.length > 0 &&
    res.sitemapsParsed.length === res.sitemapsTried.length &&
    res.files.every((f) => f.error === null && f.reason === null)
  );
}
