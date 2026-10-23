import type { ProjectDb } from '@freecrawl/db';
import type {
  LinkSuggestionInput,
  LinkSuggestionResult,
  LinkSuggestionRow,
} from '@freecrawl/shared-types';
import { isTopWordStopword, sectionOf, tokenizeForTopWords } from './top-words.js';

/** Test and tuning hooks of {@link linkSuggestions}; the product never sets them. */
export interface LinkSuggestionInternals {
  /** Posting lists longer than this are not walked (default 20000). */
  postingCap?: number;
  /** Time budget of the candidate step in ms (default 120000). */
  budgetMs?: number;
  /** Total postings the term index may hold (default 60M). */
  maxPostings?: number;
  /** Terms with a document frequency above this are dropped (default max(2% of pages, 50)). */
  dfCut?: number;
  /** Filled while running. */
  stats?: { maxListWalked: number; listsSkipped: number };
}

export const LINK_SUGGESTION_DEFAULTS = {
  maxInlinks: 3,
  perTarget: 5,
  perSource: 10,
  minCloseness: 20,
  maxTargets: 1000,
  maxSourceOutlinks: 150,
} as const;

/** Same share as the link-target reports use for menu and footer links. */
const TEMPLATE_LINK_SHARE = 0.8;
const PAGE_BLOCK = 50_000;
const MAX_TERMS_PER_PAGE = 24;
const TERMS_PER_WALK = 8;
const FIELD_WEIGHTS = { title: 3, h1: 2, description: 1 } as const;
const DEFAULT_POSTING_CAP = 20_000;
const DEFAULT_BUDGET_MS = 120_000;
const DEFAULT_MAX_POSTINGS = 60_000_000;
const ANCHOR_MAX = 80;
const SUFFIX_SEPARATORS = [' | ', ' - ', ' — '];
const SUFFIX_MAP_LIMIT = 50_000;
const LINKER_BATCH = 500;

function clamp(v: number | undefined, def: number, lo: number, hi: number): number {
  if (v === undefined || !Number.isFinite(v)) return def;
  return Math.min(hi, Math.max(lo, Math.floor(v)));
}

function hash32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

const normText = (s: string | null): string =>
  s ? s.toLowerCase().replace(/\s+/g, ' ').trim() : '';

/** Never 0, so 0 can mean "none". */
function nonZeroHash(s: string): number {
  return hash32(s) | 1;
}

function suffixOf(title: string): string | null {
  let at = -1;
  for (const sep of SUFFIX_SEPARATORS) {
    const i = title.lastIndexOf(sep);
    if (i > at) at = i;
  }
  return at > 0 ? title.slice(at) : null;
}

function shorten(text: string): string {
  const t = text.trim().replace(/\s+/g, ' ');
  if (t.length <= ANCHOR_MAX) return t;
  const cut = t.lastIndexOf(' ', ANCHOR_MAX);
  return (cut > 0 ? t.slice(0, cut) : t.slice(0, ANCHOR_MAX)).trim();
}

class GrowU32 {
  buf = new Uint32Array(1 << 16);
  push(v: number, n: number): void {
    if (n >= this.buf.length) {
      const next = new Uint32Array(this.buf.length * 2);
      next.set(this.buf);
      this.buf = next;
    }
    this.buf[n] = v;
  }
}

class GrowU8 {
  buf = new Uint8Array(1 << 16);
  push(v: number, n: number): void {
    if (n >= this.buf.length) {
      const next = new Uint8Array(this.buf.length * 2);
      next.set(this.buf);
      this.buf = next;
    }
    this.buf[n] = v;
  }
}

interface Candidate {
  idx: number;
  closeness: number;
}

/**
 * B93: for each weakly linked page, pages that are about the same thing, are worth linking from
 * and do not link to it yet. Computed on request from `urls` and `links`; no stored state.
 * `null` when the crawl did not compute inlinks. Synchronous: run it in a worker for big projects.
 */
export function linkSuggestions(
  db: ProjectDb,
  input: LinkSuggestionInput = {},
  internals: LinkSuggestionInternals = {},
): LinkSuggestionResult | null {
  const setup = db.linkSuggestionSetup();
  if (!setup.inlinksComputed) return null;
  const cols = setup.columns;
  const maxInlinks = clamp(input.maxInlinks, LINK_SUGGESTION_DEFAULTS.maxInlinks, 0, 50);
  const perTarget = clamp(input.perTarget, LINK_SUGGESTION_DEFAULTS.perTarget, 1, 20);
  const perSource = clamp(input.perSource, LINK_SUGGESTION_DEFAULTS.perSource, 1, 100);
  const minCloseness = clamp(input.minCloseness, LINK_SUGGESTION_DEFAULTS.minCloseness, 0, 100);
  const maxTargets = clamp(input.maxTargets, LINK_SUGGESTION_DEFAULTS.maxTargets, 1, 20000);
  const maxSourceOutlinks = clamp(
    input.maxSourceOutlinks,
    LINK_SUGGESTION_DEFAULTS.maxSourceOutlinks,
    0,
    Number.MAX_SAFE_INTEGER,
  );
  const postingCap = internals.postingCap ?? DEFAULT_POSTING_CAP;
  const budgetMs = internals.budgetMs ?? DEFAULT_BUDGET_MS;
  const maxPostings = internals.maxPostings ?? DEFAULT_MAX_POSTINGS;
  const stats = internals.stats;

  const missingColumns: string[] = [];
  if (!cols.linkScore) missingColumns.push('link_score');
  if (!cols.linkPosition) missingColumns.push('link_position');
  if (!cols.clusterId) missingColumns.push('cluster_id');
  if (!cols.contentHash) missingColumns.push('content_hash');
  if (!cols.canonicalResolved) missingColumns.push('canonical_resolved');
  if (!cols.redirectFinalUrl) missingColumns.push('redirect_final_url');
  if (!cols.redirectTarget) missingColumns.push('redirect_target');

  // ---- 1. One scan of the eligible pages: texts become weighted term hashes ----
  const urls: string[] = [];
  const ids: number[] = [];
  const outlinksArr: number[] = [];
  const scoreArr: number[] = [];
  const clusterArr: number[] = [];
  const contentArr: number[] = [];
  const titleH1Arr: number[] = [];
  const pageStart: number[] = [];
  const termH = new GrowU32();
  const termW = new GrowU8();
  let nTerms = 0;
  const suffixCounts = new Map<string, number>();
  let titled = 0;
  {
    let after = 0;
    const hs: number[] = [];
    const ws: number[] = [];
    const addField = (text: string | null, weight: number): void => {
      if (!text || hs.length >= MAX_TERMS_PER_PAGE) return;
      for (const tok of tokenizeForTopWords(text, 3)) {
        if (isTopWordStopword(tok)) continue;
        const h = hash32(tok);
        if (hs.includes(h)) continue;
        hs.push(h);
        ws.push(weight);
        if (hs.length >= MAX_TERMS_PER_PAGE) return;
      }
    };
    for (;;) {
      const block = db.linkSuggestionPages(cols, after, PAGE_BLOCK);
      for (const p of block) {
        ids.push(p.id);
        urls.push(p.url);
        outlinksArr.push(p.outlinks);
        scoreArr.push(p.linkScore === null ? Number.NaN : p.linkScore);
        clusterArr.push(p.clusterId);
        contentArr.push(p.contentHash ? nonZeroHash(p.contentHash) : 0);
        const th = normText(p.title) + '\u0000' + normText(p.h1);
        titleH1Arr.push(th.length > 1 ? nonZeroHash(th) : 0);
        if (p.title) {
          titled++;
          const sfx = suffixOf(p.title);
          if (sfx !== null) {
            const n = suffixCounts.get(sfx);
            if (n !== undefined) suffixCounts.set(sfx, n + 1);
            else if (suffixCounts.size < SUFFIX_MAP_LIMIT) suffixCounts.set(sfx, 1);
          }
        }
        hs.length = 0;
        ws.length = 0;
        addField(p.title, FIELD_WEIGHTS.title);
        addField(p.h1, FIELD_WEIGHTS.h1);
        addField(p.metaDescription, FIELD_WEIGHTS.description);
        pageStart.push(nTerms);
        for (let k = 0; k < hs.length; k++) {
          termH.push(hs[k]!, nTerms);
          termW.push(ws[k]!, nTerms);
          nTerms++;
        }
      }
      if (block.length < PAGE_BLOCK) break;
      after = block[block.length - 1]!.id;
    }
  }
  const E = ids.length;
  pageStart.push(nTerms);
  const result = (over: Partial<LinkSuggestionResult> = {}): LinkSuggestionResult => ({
    rows: [],
    targets: 0,
    withoutSuggestion: 0,
    truncated: false,
    degraded: false,
    missingColumns,
    ...over,
  });
  if (E === 0) return result();

  const urlIdx = new Map<string, number>();
  for (let i = 0; i < E; i++) urlIdx.set(urls[i]!, i);
  const idToIdx = new Int32Array(ids[E - 1]! + 1).fill(-1);
  for (let i = 0; i < E; i++) idToIdx[ids[i]!] = i;

  // ---- 2. Redirect folding: a link to a redirecting URL counts for the page it ends on ----
  const foldMap = new Map<string, string>();
  for (const r of db.linkSuggestionRedirects(cols)) {
    const end = setup.redirectChainsComputed ? r.finalUrl : r.target;
    if (end && end !== r.url) foldMap.set(r.url, end);
  }
  const redirectsFolded: 'one-hop' | undefined =
    !setup.redirectChainsComputed && foldMap.size > 0 ? 'one-hop' : undefined;
  const fold = (url: string): number => {
    const i = urlIdx.get(foldMap.get(url) ?? url);
    return i === undefined ? -1 : i;
  };

  // ---- 3. Effective inlinks: distinct eligible sources, one pass over the links ----
  const eff = new Int32Array(E);
  const contentIn = new Int32Array(E);
  {
    let current = -2;
    let cur = -1;
    const seen = new Set<number>();
    const seenContent = new Set<number>();
    for (const l of db.linkSuggestionLinks(cols)) {
      if (l.fromId !== current) {
        current = l.fromId;
        cur = l.fromId < idToIdx.length ? idToIdx[l.fromId]! : -1;
        seen.clear();
        seenContent.clear();
      }
      if (cur < 0) continue;
      const t = fold(l.toUrl);
      if (t < 0 || t === cur) continue;
      if (!seen.has(t)) {
        seen.add(t);
        eff[t]!++;
      }
      if (l.position === 'content' && !seenContent.has(t)) {
        seenContent.add(t);
        contentIn[t]!++;
      }
    }
  }

  // ---- 4. Term index: hashes reduced to the table size, pruned, then CSR postings ----
  const bits = E < 250_000 ? 22 : 24;
  const shift = 32 - bits;
  const size = 1 << bits;
  const tH = termH.buf;
  const tW = termW.buf;
  const start = new Int32Array(E + 1);
  {
    let w = 0;
    for (let i = 0; i < E; i++) {
      start[i] = w;
      const e = pageStart[i + 1]!;
      for (let k = pageStart[i]!; k < e; k++) {
        const h = tH[k]! >>> shift;
        let dup = false;
        for (let j = start[i]!; j < w; j++) {
          if (tH[j] === h) {
            dup = true;
            break;
          }
        }
        if (dup) continue;
        tH[w] = h;
        tW[w] = tW[k]!;
        w++;
      }
    }
    start[E] = w;
  }
  const df = new Uint32Array(size);
  for (let k = 0; k < start[E]!; k++) df[tH[k]!]!++;
  const dfCut = internals.dfCut ?? Math.max(Math.floor(E * 0.02), 50);
  let total = 0;
  for (let h = 0; h < size; h++) {
    if (df[h]! > dfCut) df[h] = 0;
    total += df[h]!;
  }
  let degraded = false;
  if (total > maxPostings) {
    degraded = true;
    const live: number[] = [];
    for (let h = 0; h < size; h++) if (df[h]! > 0) live.push(h);
    live.sort((a, b) => df[b]! - df[a]!);
    for (const h of live) {
      if (total <= maxPostings) break;
      total -= df[h]!;
      df[h] = 0;
    }
  }
  const idfOf = (d: number): number => Math.log((E + 1) / (d + 1)) + 1;
  // Drop pruned terms from the pages, then the page norms.
  const norm = new Float64Array(E);
  {
    let w = 0;
    for (let i = 0; i < E; i++) {
      const s = start[i]!;
      const e = start[i + 1]!;
      start[i] = w;
      let n2 = 0;
      for (let k = s; k < e; k++) {
        const h = tH[k]!;
        if (df[h] === 0) continue;
        tH[w] = h;
        tW[w] = tW[k]!;
        const v = tW[k]! * idfOf(df[h]!);
        n2 += v * v;
        w++;
      }
      norm[i] = Math.sqrt(n2);
    }
    start[E] = w;
  }
  const offsets = new Uint32Array(size + 1);
  for (let h = 0; h < size; h++) offsets[h + 1] = offsets[h]! + df[h]!;
  const postings = new Int32Array(offsets[size]!);
  const postW = new Uint8Array(offsets[size]!);
  {
    const cursor = offsets.slice(0, size);
    for (let i = 0; i < E; i++) {
      for (let k = start[i]!; k < start[i + 1]!; k++) {
        const h = tH[k]!;
        const at = cursor[h]!++;
        postings[at] = i;
        postW[at] = tW[k]!;
      }
    }
  }

  // ---- 5. Targets: weak pages, worst first ----
  const threshold = TEMPLATE_LINK_SHARE * E;
  const weak: number[] = [];
  for (let i = 0; i < E; i++) {
    if (eff[i]! <= maxInlinks && eff[i]! < threshold) weak.push(i);
  }
  const scoreDesc = (a: number, b: number): number => {
    const x = scoreArr[a]!;
    const y = scoreArr[b]!;
    if (Number.isNaN(x)) return Number.isNaN(y) ? 0 : 1;
    if (Number.isNaN(y)) return -1;
    return y - x;
  };
  const cmpUrl = (a: number, b: number): number =>
    urls[a]! < urls[b]! ? -1 : urls[a]! > urls[b]! ? 1 : 0;
  weak.sort((a, b) => eff[a]! - eff[b]! || scoreDesc(a, b) || cmpUrl(a, b));
  const targetList = weak.slice(0, maxTargets);
  let truncated = weak.length > maxTargets;

  const reverse = new Map<string, string[]>();
  for (const [from, to] of foldMap) {
    const list = reverse.get(to);
    if (list) list.push(from);
    else reverse.set(to, [from]);
  }

  // ---- 6. Candidates per target, exclusions applied while walking ----
  const scratch = new Float32Array(E);
  const touched = new Int32Array(E);
  const linkedMark = new Uint8Array(E);
  const spent = new Uint8Array(E);
  const used = new Int32Array(E);
  const srcOk = new Uint8Array(E);
  for (let i = 0; i < E; i++) srcOk[i] = outlinksArr[i]! <= maxSourceOutlinks ? 1 : 0;
  const clock = performance.now();
  const picks: { target: number; chosen: Candidate[] }[] = [];

  const better = (a: Candidate, b: Candidate): number =>
    b.closeness - a.closeness ||
    scoreDesc(a.idx, b.idx) ||
    outlinksArr[a.idx]! - outlinksArr[b.idx]! ||
    cmpUrl(a.idx, b.idx);

  outer: for (let b0 = 0; b0 < targetList.length; b0 += LINKER_BATCH) {
    const batch = targetList.slice(b0, b0 + LINKER_BATCH);
    // Who links each target already (any link, also through a redirect), for the whole batch.
    const queryUrls: string[] = [];
    for (const t of batch) {
      queryUrls.push(urls[t]!);
      const via = reverse.get(urls[t]!);
      if (via) queryUrls.push(...via);
    }
    const linkers = new Map<number, number[]>();
    for (const l of db.linkSuggestionLinkers(queryUrls)) {
      const s = l.fromId < idToIdx.length ? idToIdx[l.fromId]! : -1;
      if (s < 0) continue;
      const t = fold(l.toUrl);
      if (t < 0) continue;
      const list = linkers.get(t);
      if (list) list.push(s);
      else linkers.set(t, [s]);
    }

    for (const t of batch) {
      if (performance.now() - clock >= budgetMs) {
        truncated = true;
        break outer;
      }
      const chosen: Candidate[] = [];
      picks.push({ target: t, chosen });
      const mine = linkers.get(t);
      if (mine) for (const s of mine) linkedMark[s] = 1;

      // The target's terms, most informative first.
      const tt: { h: number; w: number; idf: number }[] = [];
      for (let k = start[t]!; k < start[t + 1]!; k++) {
        tt.push({ h: tH[k]!, w: tW[k]!, idf: idfOf(df[tH[k]!]!) });
      }
      tt.sort((a, b) => b.idf - a.idf || b.w - a.w);
      if (tt.length === 0 || norm[t] === 0) {
        if (mine) for (const s of mine) linkedMark[s] = 0;
        continue;
      }

      let nt = 0;
      const tCluster = clusterArr[t]!;
      const tContent = contentArr[t]!;
      const tTitleH1 = titleH1Arr[t]!;
      const walk = (from: number, to: number): void => {
        for (let q = from; q < Math.min(to, tt.length); q++) {
          const term = tt[q]!;
          const lo = offsets[term.h]!;
          const hi = offsets[term.h + 1]!;
          const len = hi - lo;
          if (len > postingCap) {
            if (stats) stats.listsSkipped++;
            continue;
          }
          if (stats && len > stats.maxListWalked) stats.maxListWalked = len;
          const weightIdf = term.idf * term.idf * term.w;
          for (let k = lo; k < hi; k++) {
            const s = postings[k]!;
            if (s === t || srcOk[s] === 0 || spent[s] === 1 || linkedMark[s] === 1) continue;
            if (tCluster > 0 && clusterArr[s] === tCluster) continue;
            if (tContent !== 0 && contentArr[s] === tContent) continue;
            if (tTitleH1 !== 0 && titleH1Arr[s] === tTitleH1) continue;
            if (scratch[s] === 0) touched[nt++] = s;
            scratch[s]! += weightIdf * postW[k]!;
          }
        }
      };
      const pick = (): Candidate[] => {
        const top: Candidate[] = [];
        for (let n = 0; n < nt; n++) {
          const s = touched[n]!;
          const denom = norm[t]! * norm[s]!;
          if (denom === 0) continue;
          const closeness = Math.min(100, Math.round((100 * scratch[s]!) / denom));
          if (closeness < minCloseness) continue;
          const cand: Candidate = { idx: s, closeness };
          if (top.length === perTarget && better(cand, top[top.length - 1]!) >= 0) continue;
          let at = top.length;
          while (at > 0 && better(cand, top[at - 1]!) < 0) at--;
          top.splice(at, 0, cand);
          if (top.length > perTarget) top.pop();
        }
        return top;
      };

      walk(0, TERMS_PER_WALK);
      let top = pick();
      if (top.length < perTarget && tt.length > TERMS_PER_WALK) {
        walk(TERMS_PER_WALK, TERMS_PER_WALK * 2);
        top = pick();
      }
      for (let n = 0; n < nt; n++) scratch[touched[n]!] = 0;
      if (mine) for (const s of mine) linkedMark[s] = 0;

      for (const c of top) {
        chosen.push(c);
        used[c.idx]!++;
        if (used[c.idx]! >= perSource) spent[c.idx] = 1;
      }
    }
  }

  // ---- 7. Rows ----
  const wantTexts = new Set<number>();
  for (const p of picks) {
    wantTexts.add(ids[p.target]!);
    for (const c of p.chosen) wantTexts.add(ids[c.idx]!);
  }
  const texts = db.linkSuggestionTexts([...wantTexts]);
  const suffix = ((): string | null => {
    let best: string | null = null;
    let bestN = 0;
    for (const [s, n] of suffixCounts) {
      if (n > bestN) {
        best = s;
        bestN = n;
      }
    }
    return best !== null && bestN >= 2 && bestN >= titled * 0.5 ? best : null;
  })();
  const anchorOf = (id: number): string | null => {
    const tx = texts.get(id);
    if (!tx) return null;
    const h1 = tx.h1?.trim();
    if (h1) return shorten(h1);
    let title = tx.title?.trim() ?? '';
    if (suffix !== null && title.endsWith(suffix) && title.length > suffix.length) {
      title = title.slice(0, title.length - suffix.length).trim();
    }
    return title ? shorten(title) : null;
  };
  const nullable = (v: number): number | null => (Number.isNaN(v) ? null : v);

  const rows: LinkSuggestionRow[] = [];
  let withoutSuggestion = 0;
  for (const p of picks) {
    const t = p.target;
    const base = {
      targetUrl: urls[t]!,
      targetTitle: texts.get(ids[t]!)?.title ?? null,
      targetInlinks: eff[t]!,
      targetContentInlinks: contentIn[t]!,
      targetLinkScore: nullable(scoreArr[t]!),
    };
    if (p.chosen.length === 0) {
      withoutSuggestion++;
      rows.push({
        ...base,
        rank: 0,
        sourceUrl: null,
        sourceTitle: null,
        closeness: null,
        sourceLinkScore: null,
        sourceOutlinks: null,
        sameSection: null,
        suggestedAnchor: null,
      });
      continue;
    }
    const anchor = anchorOf(ids[t]!);
    const tSection = sectionOf(urls[t]!, 1);
    p.chosen.forEach((c, n) => {
      const sSection = sectionOf(urls[c.idx]!, 1);
      rows.push({
        ...base,
        rank: n + 1,
        sourceUrl: urls[c.idx]!,
        sourceTitle: texts.get(ids[c.idx]!)?.title ?? null,
        closeness: c.closeness,
        sourceLinkScore: nullable(scoreArr[c.idx]!),
        sourceOutlinks: outlinksArr[c.idx]!,
        sameSection: tSection !== null && sSection !== null ? tSection === sSection : null,
        suggestedAnchor: anchor,
      });
    });
  }

  return result({
    rows,
    targets: picks.length,
    withoutSuggestion,
    truncated,
    degraded,
    ...(redirectsFolded ? { redirectsFolded } : {}),
  });
}
