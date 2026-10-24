/**
 * The audit report page: one self-contained HTML file (fonts inlined, no
 * request leaves the page) that reads on a phone and prints on A4. Colour,
 * type and radius names follow the report's design tokens.
 */

import type { ReportBranding } from '@freecrawl/shared-types';
import type { AuditData, AuditIssue } from './data.js';
import { AUDIT_FONT_FACES } from './fonts.generated.js';
import { UI, type Ui } from './strings.js';
import {
  checkText,
  fmtDec,
  fmtNum,
  fmtPct,
  groupName,
  type AuditLang,
  type CheckText,
} from './texts.js';

export interface AuditRenderOptions {
  lang?: AuditLang;
  /** White-label header: logo, brand name, accent colour, «prepared by». */
  branding?: ReportBranding;
}

/** Groups that matter less for search: half weight when choosing «Start here». */
const LOW_SEARCH_WEIGHT: Record<string, number> = { 'Security Headers': 0.5, Accessibility: 0.5 };
/** Page-level rows shown in the full table before «N more». */
const PAGE_ROWS = 8;

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const lowerFirst = (s: string): string => (s ? s[0]!.toLowerCase() + s.slice(1) : s);
const upperFirst = (s: string): string => (s ? s[0]!.toUpperCase() + s.slice(1) : s);

function fontCss(): string {
  return AUDIT_FONT_FACES.map(
    (f) =>
      `@font-face{font-family:"${f.family}";font-style:normal;font-weight:${f.weight};font-display:swap;` +
      `src:url(data:font/woff2;base64,${f.woff2Base64}) format("woff2");unicode-range:${f.unicodeRange}}`,
  ).join('\n');
}

const CSS = `
:root{--paper-mist:#f4f5f2;--card-white:#fff;--ink-pine:#14201b;--ink-muted:#56615b;--hairline:#dfe3df;--soft-fill:#eceeeb;
--alarm-brick:#9b2c1f;--alarm-wash:#f3e2dc;--alarm-text:#8f1f10;--amber-signal:#d98c1a;--amber-wash:#fdf0d9;--amber-text:#7a3d04;
--accent-pine:#1f5c45;--ok-green:#13804f;--ok-wash:#e1f3e9;--ok-text:#0c5c38;--info-indigo:#3b4fd1;--info-tint:#d9ddfb;
--series-slate:#8c96a8;--series-slate-light:#b9c0cc;--series-slate-pale:#d6dae1;--print-hairline:#d5d9e0;
--font-body:"Golos Text",-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif;--font-display:Literata,Georgia,"Times New Roman",serif;
--font-path:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
--r-key:2px;--r-meter:3px;--r-bar-top:4px;--r-callout:8px;--r-card:10px;--r-pill:999px}
*{box-sizing:border-box}
html{-webkit-print-color-adjust:exact;print-color-adjust:exact}
body{margin:0;background:var(--paper-mist);color:var(--ink-pine);font:400 15px/1.5 var(--font-body);font-variant-numeric:tabular-nums}
::selection{background:var(--info-tint)}
a{color:var(--info-indigo);text-underline-offset:2px}
a:focus-visible{outline:2px solid var(--info-indigo);outline-offset:2px}
.bar{border-bottom:1px solid var(--ink-pine);padding:18px max(16px,4vw) 12px}
.bar-in{max-width:1240px;margin:0 auto;display:flex;flex-wrap:wrap;gap:6px 24px;align-items:center;justify-content:space-between}
.bar p{font-size:14px;margin:0}.bar p b{font-weight:600}
.bar p span{color:var(--ink-muted)}
.meta{display:flex;flex-wrap:wrap;align-items:center;gap:4px 18px;color:var(--ink-muted);font-size:13px}
.brand{display:flex;align-items:center;gap:8px;color:var(--ink-pine);font-weight:500}
.brand img{max-height:28px;max-width:140px;display:block}
main{max-width:1240px;margin:0 auto;padding:24px max(16px,4vw) 56px;display:grid;grid-template-columns:minmax(0,1fr);gap:20px}
.grid2>*{min-width:0}
.card{background:var(--card-white);border:1px solid var(--hairline);border-radius:var(--r-card);padding:20px;min-width:0}
.card h2{font:600 19px/1.3 var(--font-display);margin:0}
.card-h{display:flex;flex-wrap:wrap;gap:6px 12px;align-items:baseline;justify-content:space-between;margin-bottom:4px}
.sub{color:var(--ink-muted);font-size:13px;margin:2px 0 14px}
.score{display:grid;justify-items:center;text-align:center;gap:10px}
.ring{--p:0;width:168px;aspect-ratio:1;border-radius:50%;display:grid;place-items:center;
background:radial-gradient(closest-side,var(--card-white) 80%,transparent 81%),conic-gradient(var(--c) calc(var(--p)*1%),var(--soft-fill) 0)}
.ring.good{--c:var(--accent-pine)}.ring.mid{--c:var(--amber-signal)}.ring.bad{--c:var(--alarm-brick)}.ring.none{--c:var(--soft-fill)}
.ring b{font:600 46px/1 var(--font-display)}.ring small{display:block;font-size:12px;color:var(--ink-muted);font-weight:400}
.score p{margin:0;font-size:13px;color:var(--ink-muted);max-width:30ch}
.lead{display:grid;grid-template-columns:1fr 300px;gap:20px 48px;align-items:start;padding:12px 0 8px}
.letter h1{font:600 clamp(30px,3.6vw,46px)/1.1 var(--font-display);letter-spacing:-.02em;margin:0 0 18px;text-wrap:balance;max-width:20ch}
.letter p{max-width:64ch;margin:0 0 12px;font-size:16px}
.letter p.fine{font-size:13px;color:var(--ink-muted)}
sup a{font-size:10px;color:var(--accent-pine);font-weight:600;text-decoration:none;margin-left:1px}
.tiles{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:20px}
.sevrow{display:flex;justify-content:center;gap:18px;flex-wrap:wrap;border-top:1px solid var(--hairline);padding-top:12px;width:100%}
.sevrow span{display:flex;align-items:center;gap:6px;font-size:13px;color:var(--ink-muted)}.sevrow b{color:var(--ink-pine);font-size:15px}
.start{background:var(--alarm-wash);border-radius:var(--r-card);padding:22px 24px;display:grid;grid-template-columns:220px 1fr;gap:20px 32px}
.start h2{font:600 24px/1.15 var(--font-display);color:var(--alarm-brick);margin:0}
.start h2 svg{vertical-align:-2px;margin-right:8px}
.start p{font-size:13px;color:var(--ink-muted);margin:8px 0 0}
.start ol{list-style:none;margin:0;padding:0;display:grid;grid-template-columns:repeat(3,1fr);gap:24px}
.start li{border-top:1px solid var(--alarm-brick);padding-top:10px;min-width:0}
.sn{display:block;font:600 28px/1 var(--font-display)}
.st{display:block;font-weight:600;margin:6px 0 4px}
.sw{display:block;font-size:13px;color:var(--ink-muted);overflow-wrap:anywhere}
.notes{margin:14px 0 0;padding-left:18px;font-size:13px;color:var(--ink-muted);max-width:90ch}
.notes li{margin-bottom:4px}
.kpi b{display:block;font:600 28px/1.15 var(--font-display)}
.kpi span{color:var(--ink-muted);font-size:13px}
.kpi em{font-style:normal;font-size:15px;color:var(--ink-muted);font-weight:500}
.dot{width:10px;height:10px;border-radius:50%;flex:none}
.dot.crit{background:var(--alarm-brick)}.dot.warn{background:var(--amber-signal)}.dot.info{background:var(--info-indigo)}
.scroll{overflow-x:auto}
table{border-collapse:collapse;width:100%}
table.data th{text-align:left;font-size:12px;font-weight:500;color:var(--ink-muted);padding:8px 10px;border-bottom:1px solid var(--hairline);white-space:nowrap}
table.data td{padding:12px 10px;border-bottom:1px solid var(--hairline);vertical-align:top;font-size:14px}
table.data tr.grp td{background:var(--soft-fill);font-size:12px;font-weight:600;color:var(--ink-muted);padding:6px 10px;letter-spacing:.02em}
.what b{display:block;font-weight:600}
.why{display:block;color:var(--ink-muted);font-size:13px;margin-top:2px;max-width:70ch}
.why em{font-style:normal;color:var(--ink-pine);font-weight:500}
.ex{display:block;font-size:12px;color:var(--ink-muted);margin-top:4px;overflow-wrap:anywhere}
.n{text-align:right;white-space:nowrap}
td.n small{display:block;font-size:11px;color:var(--ink-muted)}
.share{width:170px}
.share span:last-child{font-size:12px;color:var(--ink-muted);margin-left:6px}
.pill{display:inline-block;font-size:12px;font-weight:600;padding:2px 9px;border-radius:var(--r-pill);white-space:nowrap}
.pill.crit{background:var(--alarm-wash);color:var(--alarm-text)}.pill.warn{background:var(--amber-wash);color:var(--amber-text)}
.meter{display:inline-block;width:100px;height:6px;border-radius:var(--r-meter);background:var(--soft-fill);overflow:hidden;vertical-align:middle}
.meter i{display:block;height:100%;background:var(--ink-muted)}
.meter.ok i{background:var(--ok-green)}.meter.pages i{background:var(--series-slate)}.meter.visits i{background:var(--accent-pine)}
.more{font-size:13px;color:var(--ink-muted);margin:12px 0 0}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:20px;align-items:start}
.big{font:600 30px/1.1 var(--font-display)}
.big span{font:500 16px/1.5 var(--font-body);color:var(--ink-muted)}
.stack{display:flex;height:14px;border-radius:7px;overflow:hidden;background:var(--soft-fill);margin:6px 0 14px}
.stack i{display:block;height:100%}
.s1{--k:var(--ok-green)}.s2{--k:var(--series-slate)}.s3{--k:var(--series-slate-light)}.s4{--k:var(--series-slate-pale)}
.stack i,.k{background:var(--k)}
.k{display:inline-block;width:10px;height:10px;border-radius:var(--r-key);margin-right:6px;vertical-align:-1px}
.k.pages{--k:var(--series-slate)}.k.visits{--k:var(--accent-pine)}
table.mini td{padding:7px 0;border-bottom:1px solid var(--hairline);font-size:14px}
table.mini tr:last-child td{border-bottom:0}
table.mini td.bar-c{width:45%;padding:0 12px}
table.mini td.bar-c .meter{width:100%}
.cols{display:flex;align-items:flex-end;gap:8px;height:150px;margin-top:22px}
.cols div{flex:1;background:var(--series-slate);border-radius:var(--r-bar-top) var(--r-bar-top) 0 0;position:relative;min-height:2px}
.cols div.o{background:var(--ink-muted)}
.cols div span{position:absolute;bottom:100%;left:0;right:0;text-align:center;font-size:12px;padding-bottom:3px}
.cols-l{display:flex;gap:8px;font-size:12px;color:var(--ink-muted);margin-top:6px}
.cols-l span{flex:1;min-width:0;text-align:center;overflow-wrap:normal;hyphens:manual}
.cols>:first-child,.cols>:last-child,.cols-l>:first-child,.cols-l>:last-child{flex:1.5}
.callout{background:var(--soft-fill);border-radius:var(--r-callout);padding:12px 14px;font-size:14px;margin-bottom:14px;max-width:90ch}
.legend{display:flex;flex-wrap:wrap;gap:6px 18px;font-size:12px;color:var(--ink-muted);margin-bottom:6px}
.path{font-family:var(--font-path);font-size:13px}
.pair{min-width:220px}
.pr{display:flex;align-items:center;gap:8px;font-size:12px;color:var(--ink-muted)}
.pr .meter{width:180px;height:8px}
.pr+.pr{margin-top:4px}
.chips{display:flex;flex-wrap:wrap;gap:8px;margin:0;padding:0;list-style:none}
.chips li{display:flex;align-items:center;gap:6px;background:var(--ok-wash);color:var(--ok-text);border-radius:var(--r-pill);padding:4px 12px;font-size:13px}
dl.facts{display:grid;grid-template-columns:max-content 1fr;gap:6px 20px;margin:0;font-size:14px}
dl.facts dt{color:var(--ink-muted)}dl.facts dd{margin:0;min-width:0;overflow-wrap:anywhere}
.wide{grid-column:1/-1}
@media (max-width:1100px){.start{grid-template-columns:1fr}}
@media (max-width:860px){.lead{display:contents}.letter{order:1}.start{order:2}.score{order:3}.tiles{order:4}main>*{order:5}.lead{grid-template-columns:1fr}.tiles{grid-template-columns:repeat(2,minmax(0,1fr))}.start ol{grid-template-columns:1fr}}
@media (max-width:720px){.grid2{grid-template-columns:1fr}.share{width:auto}.share .meter{display:none}
 .cols,.cols-l{gap:4px}.cols-l{font-size:10px}
 table.issues thead{display:none}table.issues tr:not(.grp){display:grid;grid-template-columns:auto 1fr auto;gap:6px 10px;padding:12px 0;border-bottom:1px solid var(--hairline)}
 table.issues td{border:0;padding:0}table.issues td.what{grid-column:1/-1;grid-row:2}table.issues tr.grp{display:block}table.issues tr.grp td{display:block}
 table.issues td.share{text-align:right}.pr .meter{width:110px}.card{padding:16px}.ring{width:150px}}
@media print{@page{size:A4;margin:12mm}.scroll{overflow:visible}.card{-webkit-box-decoration-break:clone;box-decoration-break:clone}table.data td{padding:6px 8px;font-size:11px}.lead{display:grid}main>*,.start,.tiles{order:0}body{background:var(--card-white);font-size:12px}.bar,main{padding-left:0;padding-right:0}
 .card{break-inside:avoid;border-color:var(--print-hairline)}.card.fixes{break-inside:auto}table.data tr{break-inside:avoid}h2{break-after:avoid}
 .lead{grid-template-columns:1fr 240px}.tiles{grid-template-columns:repeat(4,1fr)}.start{grid-template-columns:1fr}.start ol{grid-template-columns:repeat(3,1fr)}.grid2{grid-template-columns:1fr 1fr}a{color:inherit;text-decoration:none}.cols,.cols-l{gap:5px}.cols-l{font-size:10px}}
`;

const CHECK_SVG =
  '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 12 5 5 9-10"/></svg>';
const FLAG_SVG =
  '<svg width="14" height="18" viewBox="0 0 14 18" aria-hidden="true"><path d="M0 0h14v18l-7-5-7 5z" fill="currentColor"/></svg>';

/** Path (and query) of a URL for display; the URL itself if it does not parse. */
function pathOf(url: string): string {
  try {
    const u = new URL(url);
    return u.pathname + u.search;
  } catch {
    return url;
  }
}

/** `2026-10-24 02:30:02` (SQLite UTC) → parts. */
function splitStamp(s: string | null): { date: string; time: string } | null {
  if (!s) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}:\d{2}:\d{2})/.exec(s);
  if (!m) return null;
  return { date: `${m[1]}-${m[2]}-${m[3]}`, time: m[4]! };
}

function fmtDate(iso: string, lang: AuditLang): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return iso;
  return lang === 'ru' ? `${m[3]}.${m[2]}.${m[1]}` : `${m[1]}-${m[2]}-${m[3]}`;
}

function fmtPeriod(a: string | null, b: string | null, lang: AuditLang): string | null {
  if (!a || !b) return null;
  if (lang === 'en') return `${a} – ${b}`;
  const [ay, am, ad] = a.split('-');
  const [by, bm, bd] = b.split('-');
  return ay === by ? `${ad}.${am}–${bd}.${bm}.${by}` : `${ad}.${am}.${ay}–${bd}.${bm}.${by}`;
}

function fmtMs(ms: number, lang: AuditLang): string {
  return ms >= 100 || Number.isInteger(ms) ? fmtNum(ms, lang) : fmtDec(ms, 1, lang);
}

class Page {
  readonly ui: Ui;
  readonly N: number;
  readonly I: number;
  constructor(
    readonly d: AuditData,
    readonly lang: AuditLang,
  ) {
    this.ui = UI[lang];
    this.N = d.totals.html;
    this.I = d.totals.indexable;
  }

  num = (n: number): string => fmtNum(n, this.lang);
  pct = (a: number, b: number): string => fmtPct(a, b, this.lang);
  text = (it: AuditIssue): CheckText => checkText(it, this.lang, this.d.thresholds);

  meter(v: number, total: number, cls = ''): string {
    const w = total ? (100 * v) / total : 0;
    return (
      `<span class="meter${cls ? ` ${cls}` : ''}" role="img" aria-label="${this.pct(v, total)}">` +
      `<i style="width:${Math.max(w, v ? 0.6 : 0).toFixed(1)}%"></i></span>`
    );
  }

  /** Pages the issue is counted on, and the denominator: pages open to search, or all pages. */
  base(it: AuditIssue): { base: number; total: number; onIdx: boolean } {
    const onIdx = it.urlsIndexable > 0;
    return onIdx
      ? { base: it.urlsIndexable, total: this.I, onIdx }
      : { base: it.urls, total: this.N, onIdx };
  }

  /** One template fix: template-wide, or on 90%+ of the pages open to search. */
  oneFix(it: AuditIssue): boolean {
    const { base, onIdx } = this.base(it);
    return it.templateWide || (onIdx && this.I > 0 && base / this.I >= 0.9);
  }
}

function issueRow(p: Page, it: AuditIssue): string {
  const t = p.text(it);
  const { base, total, onIdx } = p.base(it);
  const ex = it.examples[0];
  const sev = it.severity === 'critical' ? 'crit' : 'warn';
  return (
    `<tr>\n<td class="what"><b>${esc(t.title)}</b><span class="why">${esc(upperFirst(t.why))}. <em>${esc(p.ui.whatToDo)}</em> ${esc(t.fix)}</span>` +
    (ex ? `<a class="ex" href="${esc(ex)}">${esc(pathOf(ex))}</a>` : '') +
    `</td>\n<td><span class="pill ${sev}">${esc(p.ui.sevPill[it.severity === 'critical' ? 'critical' : 'warning'])}</span></td>\n` +
    `<td class="n">${p.num(base)}<small>${esc(onIdx ? p.ui.smallOpen : p.ui.smallAll)}</small></td>\n` +
    `<td class="share">${p.meter(base, total)}<span>${p.pct(base, total)}</span></td></tr>`
  );
}

function renderHeader(p: Page, branding: ReportBranding | undefined): string {
  const { d, ui } = p;
  const first = splitStamp(d.crawlFirst);
  const logo =
    branding?.logoDataUrl && /^data:image\//.test(branding.logoDataUrl)
      ? `<img src="${esc(branding.logoDataUrl)}" alt="">`
      : '';
  const name = (branding?.brandName ?? '').trim();
  const by = (branding?.preparedBy ?? '').trim();
  const brand = logo || name ? `<span class="brand">${logo}${esc(name)}</span>` : '';
  return (
    `<header class="bar"><div class="bar-in">\n<p><b>${esc(d.host || d.startUrl)}</b> <span>· ${esc(ui.kind)}</span></p>\n` +
    `<div class="meta">${first ? `<span>${esc(ui.crawledOn(fmtDate(first.date, p.lang)))}</span>` : ''}` +
    `<span>${esc(ui.pagesCount(p.N, p.num(p.N)))}</span>` +
    (by ? `<span>${esc(ui.preparedBy(by))}</span>` : '') +
    brand +
    `</div>\n</div></header>`
  );
}

/** «Start here»: the three checks with the most impact on search. */
export function startItems(d: Pick<AuditData, 'issues'>): AuditIssue[] {
  const iss = d.issues.filter((it) => it.severity !== 'info');
  // Stable sort over the impact order: security headers and accessibility
  // rank at half weight here (they keep their place in the full table).
  return [...iss]
    .map((it, i) => ({ it, i, k: it.impact * (LOW_SEARCH_WEIGHT[it.group] ?? 1) }))
    .sort((a, b) => b.k - a.k || a.i - b.i)
    .slice(0, 3)
    .map((x) => x.it);
}

function renderLead(p: Page, start: AuditIssue[]): string {
  const { d, ui, lang } = p;
  const top = start[0];
  const median = d.response.median;
  const fast = median !== null && median < 200;
  let headline: string;
  if (top) {
    headline =
      (fast ? ui.headlineFast : '') +
      (p.oneFix(top) ? ui.headlineOneFix : ui.headlineMain(lowerFirst(p.text(top).title)));
  } else {
    headline = ui.headlineNone;
  }
  const paras: string[] = [];
  const r0 = d.nonIndexable[0];
  let first =
    esc(ui.letterCrawl(p.N, p.num(p.N), p.I, p.num(p.I))) + '<sup><a href="#n1">1</a></sup>.';
  if (r0) {
    const forms = ui.reasonLetter[r0.reason];
    const phrase = forms
      ? lang === 'ru'
        ? r0.count % 10 === 1 && r0.count % 100 !== 11
          ? forms[0]
          : forms[1]
        : r0.count === 1
          ? forms[0]
          : forms[1]
      : lowerFirst(ui.reasonRow[r0.reason] ?? r0.reason);
    first += esc(ui.letterMore(r0.count, p.num(r0.count), phrase));
  }
  paras.push(first);
  if (top) {
    const t = p.text(top);
    const { base, total } = p.base(top);
    paras.push(
      esc(ui.letterTop(lowerFirst(t.title), p.num(base), total, p.num(total), upperFirst(t.why))) +
        (p.oneFix(top) ? esc(ui.letterOneFix) : ''),
    );
  }
  if (median !== null)
    paras.push(esc(fast ? ui.letterFast(fmtMs(median, lang)) : ui.letterSlow(fmtMs(median, lang))));
  const fine = d.limitHit
    ? `<p class="fine">${esc(
        ui.fineCap(
          d.pageLimit ? p.num(d.pageLimit) : null,
          d.sitemap.inSitemapNotCrawled > 0 ? p.num(d.sitemap.inSitemap) : null,
        ),
      )}<sup><a href="#n3">3</a></sup>.</p>`
    : '';

  const s = d.score.value;
  const band = s === null ? 'none' : s >= 80 ? 'good' : s >= 50 ? 'mid' : 'bad';
  const shown = s === null ? '—' : String(s);
  const sc = d.severityCounts;
  const score =
    `<div class="card score"><h2>${esc(ui.scoreTitle)}<sup><a href="#n2">2</a></sup></h2>\n` +
    `<div class="ring ${band}" style="--p:${s ?? 0}" role="img" aria-label="${esc(ui.scoreOf(shown))}"><div><b>${shown}</b><small>${esc(ui.outOf100)}</small></div></div>\n` +
    `<p>${esc(s === null ? ui.scoreNone : ui.scoreMean(p.I, p.num(p.I)))}</p>\n` +
    `<div class="sevrow" aria-label="${esc(ui.sevAria)}">` +
    `<span><i class="dot crit"></i><b>${p.num(sc.critical)}</b> ${esc(ui.sevCritical(sc.critical))}</span>` +
    `<span><i class="dot warn"></i><b>${p.num(sc.warning)}</b> ${esc(ui.sevWarning(sc.warning))}</span>` +
    `<span><i class="dot info"></i><b>${p.num(sc.info)}</b> ${esc(ui.sevInfo(sc.info))}</span></div></div>`;
  return (
    `<section class="lead" aria-label="${esc(ui.leadLabel)}">\n<div class="letter"><h1>${esc(headline)}</h1>\n` +
    paras.map((x) => `<p>${x}</p>`).join('') +
    `\n${fine}\n</div>\n${score}\n</section>`
  );
}

function renderTiles(p: Page): string {
  const { d, ui } = p;
  const m = d.response.median;
  return (
    `<section class="tiles" aria-label="${esc(ui.tilesAria)}">\n` +
    `<div class="card kpi"><b>${p.num(p.N)}</b><span>${esc(ui.tilePages)}</span></div>\n` +
    `<div class="card kpi"><b>${p.num(p.I)} <em>${p.pct(p.I, p.N)}</em></b><span>${esc(ui.tileIndexable)}</span></div>\n` +
    `<div class="card kpi"><b>${m === null ? '—' : `${fmtMs(m, p.lang)} ${esc(ui.ms)}`}</b><span>${esc(ui.tileMedian)}</span></div>\n` +
    `<div class="card kpi"><b>${p.num(d.sitemap.inSitemap)}</b><span>${esc(ui.tileSitemap)}</span></div>\n</section>`
  );
}

function renderStart(p: Page, start: AuditIssue[]): string {
  if (start.length === 0) return '';
  const { ui } = p;
  const items = start
    .map((it) => {
      const t = p.text(it);
      const { base, total, onIdx } = p.base(it);
      const tail =
        (p.oneFix(it) ? ui.oneFix : '') + p.pct(base, total) + (onIdx ? ui.ofOpen : ui.ofAll);
      return `<li><b class="sn">${p.num(base)}</b><span class="st">${esc(t.short)}</span>\n<span class="sw">${esc(t.fix)} ${esc(tail)}</span></li>`;
    })
    .join('');
  return (
    `<section class="start" aria-labelledby="st-h"><div><h2 id="st-h">${FLAG_SVG}${esc(ui.startTitle)}</h2>\n` +
    `<p>${esc(ui.startSub(start.length))}</p></div>\n<ol>${items}</ol></section>`
  );
}

function renderFixes(p: Page, start: AuditIssue[]): string {
  const { d, ui } = p;
  const iss = d.issues.filter((it) => it.severity !== 'info');
  if (iss.length === 0) return '';
  const inStart = new Set(start.map((it) => it.key));
  const tmpl = iss.filter((it) => it.templateWide && !inStart.has(it.key));
  const crit = iss.filter(
    (it) => it.severity === 'critical' && !it.templateWide && !inStart.has(it.key),
  );
  const warn = iss
    .filter((it) => it.severity === 'warning' && !it.templateWide && !inStart.has(it.key))
    .map((it, i) => ({ it, i, k: it.urlsIndexable || it.urls * 0.5 }))
    .sort((a, b) => b.k - a.k || a.i - b.i)
    .map((x) => x.it);
  const pageRows = [...crit, ...warn].slice(0, PAGE_ROWS);
  const rest = crit.length + warn.length - pageRows.length;
  const info = d.severityCounts.info;
  const grp = (label: string): string => `<tr class="grp"><td colspan="4">${esc(label)}</td></tr>`;
  let body = '';
  if (start.length) body += grp(ui.grpStart) + start.map((it) => issueRow(p, it)).join('');
  if (tmpl.length)
    body += grp(ui.grpTemplate(tmpl.length)) + tmpl.map((it) => issueRow(p, it)).join('');
  if (pageRows.length) body += grp(ui.grpPages) + pageRows.map((it) => issueRow(p, it)).join('');
  const more =
    rest || info ? `<p class="more">${esc(ui.more(rest, p.num(rest), info, p.num(info)))}</p>` : '';
  return (
    `<section class="card fixes" aria-labelledby="fix-h">\n<div class="card-h"><h2 id="fix-h">${esc(ui.fixesTitle)}</h2></div>\n` +
    `<p class="sub">${esc(ui.fixesSub)}</p>\n<div class="scroll"><table class="data issues"><thead><tr>` +
    `<th>${esc(ui.thIssue)}</th><th>${esc(ui.thSeverity)}</th><th class="n">${esc(ui.thPages)}</th><th>${esc(ui.thShare)}</th>` +
    `</tr></thead><tbody>\n${body}\n</tbody></table></div>\n${more}\n</section>`
  );
}

function renderIndexability(p: Page): string {
  const { d, ui } = p;
  const segs: { key: string; label: string; count: number }[] = [
    { key: 's1', label: ui.reasonRow['indexable']!, count: p.I },
  ];
  const reasons = d.nonIndexable;
  const shown = reasons.length > 3 ? reasons.slice(0, 2) : reasons;
  shown.forEach((r, i) =>
    segs.push({ key: `s${i + 2}`, label: ui.reasonRow[r.reason] ?? r.reason, count: r.count }),
  );
  if (reasons.length > 3) {
    segs.push({
      key: 's4',
      label: ui.reasonOther,
      count: reasons.slice(2).reduce((s, r) => s + r.count, 0),
    });
  }
  const bar = segs
    .filter((s) => s.count > 0)
    .map(
      (s) =>
        `<i class="${s.key}" style="width:${p.N ? ((100 * s.count) / p.N).toFixed(2) : 0}%" title="${esc(s.label)}"></i>`,
    )
    .join('');
  const rows = segs
    .map(
      (s) =>
        `<tr><td><i class="k ${s.key}"></i>${esc(s.label)}</td><td class="n">${p.num(s.count)}</td></tr>`,
    )
    .join('\n');
  return (
    `<section class="card" aria-labelledby="idx-h"><h2 id="idx-h">${esc(ui.idxTitle)}</h2>\n` +
    `<p class="sub">${esc(ui.idxSub(p.num(p.N)))}</p>\n` +
    `<div class="big">${p.num(p.I)} <span>${esc(ui.idxOpen)} · ${p.pct(p.I, p.N)}</span></div>\n` +
    `<div class="stack" role="img" aria-label="${esc(ui.idxAria)}">${bar}</div>\n` +
    `<table class="mini"><tbody>${rows}</tbody></table>\n</section>`
  );
}

function renderDepth(p: Page): string {
  const { d, ui } = p;
  const values = [...d.clickDepth, d.orphans];
  const max = Math.max(1, ...values);
  const deep = (d.clickDepth[4] ?? 0) + (d.clickDepth[5] ?? 0) + (d.clickDepth[6] ?? 0);
  const cols = values
    .map(
      (v, i) =>
        `<div${i === values.length - 1 ? ' class="o"' : ''} style="height:${((100 * v) / max).toFixed(1)}%"><span>${p.num(v)}</span></div>`,
    )
    .join('');
  const labels = [ui.depthHome, '1', '2', '3', '4', '5', '6+', ui.depthOrphan]
    .map((l) => `<span>${esc(l)}</span>`)
    .join('');
  return (
    `<section class="card" aria-labelledby="dep-h"><h2 id="dep-h">${esc(ui.depthTitle)}</h2>\n` +
    `<p class="sub">${esc(ui.depthSub(deep, p.num(deep), p.pct(deep, p.N), d.orphans, p.num(d.orphans)))}</p>\n` +
    `<div class="cols" role="img" aria-label="${esc(ui.depthAria)}">${cols}</div>\n` +
    `<div class="cols-l">${labels}</div>\n</section>`
  );
}

function renderLengths(p: Page, which: 'titles' | 'descriptions'): string {
  const { d, ui } = p;
  const b = d[which];
  const [min, max] =
    which === 'titles'
      ? [d.thresholds.titleMinChars, d.thresholds.titleMaxChars]
      : [d.thresholds.descriptionMinChars, d.thresholds.descriptionMaxChars];
  const total = b.ok + b.long + b.short + b.missing;
  const rows: [string, number, string][] = [
    [ui.lenOk(min, max), b.ok, 'ok'],
    [ui.lenLong(max), b.long, ''],
    [ui.lenShort(min), b.short, ''],
    [which === 'titles' ? ui.titleMissing : ui.descMissing, b.missing, ''],
  ];
  const body = rows
    .map(
      ([label, v, cls]) =>
        `<tr><td>${esc(label)}</td><td class="bar-c">${p.meter(v, total, cls)}</td><td class="n">${p.num(v)}</td></tr>`,
    )
    .join('');
  return (
    `<div class="card"><h2>${esc(which === 'titles' ? ui.titlesTitle : ui.descTitle)}</h2>` +
    `<p class="sub">${esc(ui.lenSub)}</p><table class="mini"><tbody>${body}</tbody></table></div>`
  );
}

function renderSitemap(p: Page): string {
  const { d, ui } = p;
  const s = d.sitemap;
  const body =
    s.inSitemap === 0
      ? `<p class="sub">${esc(ui.sitemapNone)}</p>`
      : `<table class="mini"><tbody><tr><td>${esc(ui.sitemapUrls)}</td><td class="n">${p.num(s.inSitemap)}</td></tr>\n` +
        `<tr><td>${esc(ui.sitemapClosed)}</td><td class="n">${p.num(s.nonIndexableInSitemap)}</td></tr>\n` +
        `<tr><td>${esc(ui.sitemapMissing)}</td><td class="n">${p.num(s.indexableNotInSitemap)}</td></tr></tbody></table>`;
  return `<section class="card" aria-labelledby="sm-h"><h2 id="sm-h">${esc(ui.sitemapTitle)}</h2><p class="sub">sitemap.xml</p>\n${body}</section>`;
}

function renderSections(p: Page): string {
  const { d, ui } = p;
  if (d.sections.length === 0) return '';
  const rows = d.sections
    .slice(0, 8)
    .map(
      (s) =>
        `<tr><td class="path">${esc(s.section)}</td><td class="n">${p.num(s.pages)}</td><td class="n">${p.pct(s.indexable, s.pages)}</td>` +
        `<td class="n">${s.medianMs === null ? '—' : p.num(s.medianMs)}</td></tr>`,
    )
    .join('');
  return (
    `<section class="card" aria-labelledby="sec-h"><h2 id="sec-h">${esc(ui.sectionsTitle)}</h2><p class="sub">${esc(ui.sectionsSub)}</p>\n` +
    `<div class="scroll"><table class="data"><thead><tr><th>${esc(ui.thSection)}</th><th class="n">${esc(ui.thSecPages)}</th>` +
    `<th class="n">${esc(ui.thSecOpen)}</th><th class="n">${esc(ui.thSecMs)}</th></tr></thead><tbody>\n${rows}\n</tbody></table></div></section>`
  );
}

function renderTraffic(p: Page): string {
  const { d, ui, lang } = p;
  const t = d.traffic;
  if (!t) return '';
  const share = (v: number): string => `${fmtDec(100 * v, 1, lang)}%`;
  const whole = (v: number): string => `${Math.round(100 * v)}%`;
  const first = splitStamp(d.crawlFirst);
  const lead = [...t.rows].filter((r) => r.crawled).sort((a, b) => b.indexable - a.indexable)[0];
  let callout = '';
  if (lead) {
    callout = ui.trafficCallout(
      lead.section,
      whole(lead.indexableShare),
      whole(lead.visitsShare),
      lead.zeroVisitPages,
      p.num(lead.zeroVisitPages),
      t.source,
    );
  }
  if (t.totalVisits && t.uncrawledVisits / t.totalVisits >= 0.005) {
    callout += ui.trafficUncrawled(
      whole(t.uncrawledVisits / t.totalVisits),
      t.uncrawledTop?.section ?? null,
      t.source,
    );
  }
  const rows = t.rows
    .slice(0, 10)
    .map(
      (r) =>
        `<tr><td class="path">${esc(r.section)}</td>\n<td class="pair">` +
        `<span class="pr"><span class="meter pages"><i style="width:${(100 * r.indexableShare).toFixed(1)}%"></i></span><span>${share(r.indexableShare)}</span></span>\n` +
        `<span class="pr"><span class="meter visits"><i style="width:${(100 * r.visitsShare).toFixed(1)}%"></i></span><span>${share(r.visitsShare)}</span></span></td>\n` +
        `<td class="n">${p.num(r.zeroVisitPages)}</td></tr>`,
    )
    .join('');
  return (
    `<section class="card wide" aria-labelledby="own-h">\n<div class="card-h"><h2 id="own-h">${esc(ui.trafficTitle)}</h2></div>\n` +
    `<p class="sub">${esc(ui.trafficSub(first ? fmtDate(first.date, lang) : '—', t.source, fmtPeriod(t.periodStart, t.periodEnd, lang)))}</p>\n` +
    (callout ? `<div class="callout">${esc(callout.trim())}</div>\n` : '') +
    `<div class="legend"><span><i class="k pages"></i>${esc(ui.legendPages)}</span><span><i class="k visits"></i>${esc(ui.legendVisits(t.source))}</span></div>\n` +
    `<div class="scroll"><table class="data"><thead><tr><th>${esc(ui.thSection)}</th><th>${esc(ui.thPagesVisits(t.source))}</th>` +
    `<th class="n">${esc(ui.thZero(t.source))}</th></tr></thead><tbody>${rows}</tbody></table></div>\n</section>`
  );
}

function renderClean(p: Page): string {
  const { d, ui, lang } = p;
  if (d.cleanGroups.length === 0) return '';
  const { median, p90 } = d.response;
  const speed =
    median !== null && p90 !== null ? ui.okSpeed(fmtMs(median, lang), fmtMs(p90, lang)) : '';
  const chips = d.cleanGroups
    .map((g) => `<li>${CHECK_SVG}${esc(groupName(g, lang))}</li>`)
    .join('');
  return (
    `<section class="card wide" aria-labelledby="ok-h"><h2 id="ok-h">${esc(ui.okTitle)}</h2>\n` +
    `<p class="sub">${esc(ui.okSub + speed)}</p>\n<ul class="chips">${chips}</ul></section>`
  );
}

function renderMethod(p: Page): string {
  const { d, ui } = p;
  const facts: [string, string][] = [[ui.factStart, d.startUrl]];
  const a = splitStamp(d.crawlFirst);
  const b = splitStamp(d.crawlLast);
  if (a && b)
    facts.push([
      ui.factTime,
      `${a.date} ${a.time} – ${a.date === b.date ? b.time : `${b.date} ${b.time}`} UTC`,
    ]);
  if (d.settings.maxUrls) facts.push([ui.factLimit, p.num(d.settings.maxUrls)]);
  if (d.settings.respectRobotsTxt !== null)
    facts.push([ui.factRobots, d.settings.respectRobotsTxt ? ui.robotsYes : ui.robotsNo]);
  if (d.settings.userAgent) facts.push([ui.factAgent, d.settings.userAgent]);
  const dl = facts.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('\n');
  const mean = d.score.pageMean === null ? '—' : String(Math.round(d.score.pageMean));
  const notes =
    `<li id="n1">${esc(ui.note1)}</li>\n<li id="n2">${esc(ui.note2(mean, d.score.templatePenalty))}</li>` +
    (d.limitHit
      ? `\n<li id="n3">${esc(ui.note3(d.pageLimit ? p.num(d.pageLimit) : null))}</li>`
      : '');
  return (
    `<section class="card wide" aria-labelledby="how-h"><h2 id="how-h">${esc(ui.howTitle)}</h2><p class="sub">${esc(ui.howSub)}</p>\n` +
    `<dl class="facts">${dl}</dl>\n<ol class="notes">${notes}</ol></section>`
  );
}

/** The whole audit report as one HTML string. */
export function renderAuditReport(d: AuditData, options: AuditRenderOptions = {}): string {
  const lang = options.lang ?? 'ru';
  const p = new Page(d, lang);
  const accent = (options.branding?.accentColor ?? '').trim();
  const accentCss = /^#[0-9a-fA-F]{3}([0-9a-fA-F]{3})?$/.test(accent)
    ? `\n:root{--accent-pine:${accent}}`
    : '';
  const start = startItems(d);
  return (
    `<!doctype html><html lang="${p.ui.htmlLang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">\n` +
    `<title>${esc(p.ui.docTitle(d.host || d.startUrl))}</title>\n<style>\n` +
    `/* Literata and Golos Text: SIL Open Font License 1.1 */\n${fontCss()}\n${CSS}${accentCss}\n</style></head><body>\n` +
    `${renderHeader(p, options.branding)}\n<main>\n` +
    `${renderLead(p, start)}\n${renderTiles(p)}\n${renderStart(p, start)}\n${renderFixes(p, start)}\n` +
    `<div class="grid2">\n${renderIndexability(p)}\n${renderDepth(p)}\n${renderLengths(p, 'titles')}\n` +
    `${renderLengths(p, 'descriptions')}\n${renderSitemap(p)}\n${renderSections(p)}\n${renderTraffic(p)}\n` +
    `${renderClean(p)}\n${renderMethod(p)}\n</div>\n</main></body></html>\n`
  );
}
