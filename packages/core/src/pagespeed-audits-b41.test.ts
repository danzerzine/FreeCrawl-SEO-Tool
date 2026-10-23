import * as fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parsePagespeedAudits } from './pagespeed-audits.js';

const fixture = (name: string): unknown =>
  JSON.parse(fs.readFileSync(new URL(`./fixtures/psi/${name}`, import.meta.url), 'utf8'));
const real = (): unknown => fixture('lighthouse-13.5.0-trimmed.json');

const byId = (j: unknown, id: string) => parsePagespeedAudits(j).audits.find((a) => a.auditId === id);

describe('B41 R1-R3: which audits are kept, with which kind (real Lighthouse 13.5.0 report)', () => {
  it('reads the Lighthouse version and keeps only audits that are not passed', () => {
    const r = parsePagespeedAudits(real());
    expect(r.lighthouseVersion).toBe('13.5.0');
    const ids = r.audits.map((a) => a.auditId);
    // score < 1, or a saving > 0
    expect(ids).toContain('image-delivery-insight');
    expect(ids).toContain('unused-javascript');
    expect(ids).toContain('bf-cache');
    // passed (score 1, zero savings), not applicable, hidden/metrics groups
    expect(ids).not.toContain('unminified-css');
    expect(ids).not.toContain('modern-http-insight');
    expect(ids).not.toContain('inp-breakdown-insight');
    expect(ids).not.toContain('first-contentful-paint');
  });

  it('maps the audit group to the kind: insights -> insight, diagnostics -> diagnostic', () => {
    expect(byId(real(), 'image-delivery-insight')?.kind).toBe('insight');
    expect(byId(real(), 'unused-javascript')?.kind).toBe('diagnostic');
  });

  it('considers all 17 insight audits of the report (the not passed ones)', () => {
    const r = parsePagespeedAudits(real());
    const insights = r.audits.filter((a) => a.kind === 'insight').map((a) => a.auditId);
    expect(insights).toEqual(
      expect.arrayContaining([
        'cache-insight',
        'document-latency-insight',
        'image-delivery-insight',
        'legacy-javascript-insight',
        'network-dependency-tree-insight',
        'render-blocking-insight',
      ]),
    );
    expect(insights).not.toContain('viewport-insight');
  });

  it('fills the row fields: score, display value, title', () => {
    const a = byId(real(), 'unused-javascript')!;
    expect(a.title).toMatch(/unused javascript/i);
    expect(a.score).toBe(0);
    expect(typeof a.displayValue === 'string' || a.displayValue === null).toBe(true);
  });
});

/** A one-audit PSI response in the given group. */
function oneAudit(group: string, audit: Record<string, unknown>, id = 'x-audit'): unknown {
  return {
    lighthouseResult: {
      lighthouseVersion: '12.0.0',
      categories: { performance: { auditRefs: [{ id, group, weight: 0 }] } },
      audits: { [id]: { id, title: 'X', scoreDisplayMode: 'metricSavings', ...audit } },
    },
  };
}
const first = (j: unknown) => parsePagespeedAudits(j).audits[0];

describe('B41 R2: savings rule', () => {
  it('uses overallSavingsMs when it is a number (new table shape, test 1b)', () => {
    const a = first(oneAudit('insights', { score: 0.5, details: { type: 'table', overallSavingsMs: 450, items: [] } }));
    expect(a?.savingsMs).toBe(450);
  });

  it('takes the MAX of the metricSavings object, not the sum (cache-insight: {FCP:0, LCP:3100})', () => {
    expect(byId(real(), 'cache-insight')?.savingsMs).toBe(3100);
    const a = first(oneAudit('insights', { score: 0, metricSavings: { FCP: 200, LCP: 900, TBT: 400 } }));
    expect(a?.savingsMs).toBe(900);
  });

  it('prefers overallSavingsMs over metricSavings', () => {
    const a = first(oneAudit('diagnostics', { score: 0, metricSavings: { LCP: 900 }, details: { overallSavingsMs: 580 } }));
    expect(a?.savingsMs).toBe(580);
  });

  it('falls back to numericValue only when the unit is millisecond and nothing else gives savings', () => {
    expect(first(oneAudit('diagnostics', { score: 0.4, numericValue: 1234, numericUnit: 'millisecond' }))?.savingsMs).toBe(1234);
    expect(first(oneAudit('diagnostics', { score: 0.4, numericValue: 1234, numericUnit: 'byte' }))?.savingsMs).toBeNull();
  });

  it('keeps savings_bytes NULL when the response has no bytes, never 0 for unknown', () => {
    expect(byId(real(), 'cache-insight')?.savingsBytes).not.toBeUndefined();
    expect(first(oneAudit('insights', { score: 0.2, metricSavings: { LCP: 100 } }))?.savingsBytes).toBeNull();
  });

  it('uses overallSavingsBytes when present (unused-javascript: 94194)', () => {
    expect(byId(real(), 'unused-javascript')?.savingsBytes).toBe(94194);
    expect(byId(real(), 'unused-javascript')?.savingsMs).toBe(580);
  });

  it('sums the items wastedBytes when overallSavingsBytes is absent (image-delivery-insight, NULL for all 17 insights in 13.5.0)', () => {
    const raw = real() as { lighthouseResult: { audits: Record<string, { details: { items: { wastedBytes?: number }[] } }> } };
    const sum = raw.lighthouseResult.audits['image-delivery-insight']!.details.items.reduce((s, i) => s + (i.wastedBytes ?? 0), 0);
    expect(sum).toBeGreaterThan(0);
    const a = byId(real(), 'image-delivery-insight');
    expect(a?.savingsBytes).toBe(sum);
    expect(a?.savingsMs).toBe(1200);
  });

  it('keeps an informative audit (score null) only with a saving > 0 (test 1e/1i around it)', () => {
    expect(first(oneAudit('diagnostics', { score: null, scoreDisplayMode: 'informative', metricSavings: { TBT: 0 } }))).toBeUndefined();
    expect(first(oneAudit('diagnostics', { score: null, scoreDisplayMode: 'informative', metricSavings: { TBT: 90 } }))?.savingsMs).toBe(90);
  });

  it('skips a passed audit (score 1) whose metricSavings object holds only zeros (1e, 1i)', () => {
    expect(first(oneAudit('insights', { score: 1, metricSavings: { FCP: 0, LCP: 0 } }))).toBeUndefined();
    expect(first(oneAudit('insights', { score: 1, details: { overallSavingsMs: 0, overallSavingsBytes: 0 } }))).toBeUndefined();
  });

  it('skips notApplicable, error and manual audits even with a low score', () => {
    for (const scoreDisplayMode of ['notApplicable', 'error', 'manual']) {
      expect(first(oneAudit('insights', { score: 0, scoreDisplayMode }))).toBeUndefined();
    }
  });

  it('maps the legacy load-opportunities group to kind opportunity, with the old `opportunity` details (1c, 1h)', () => {
    const a = first(oneAudit('load-opportunities', { score: 0.3, details: { type: 'opportunity', overallSavingsMs: 800, overallSavingsBytes: 5000, items: [] } }));
    expect(a?.kind).toBe('opportunity');
    expect(a?.savingsMs).toBe(800);
    expect(a?.savingsBytes).toBe(5000);
  });

  it('returns no audits, no throw, when there are no auditRefs (1d)', () => {
    const r = parsePagespeedAudits({ lighthouseResult: { lighthouseVersion: '9.0.0', audits: { a: { score: 0 } } } });
    expect(r).toEqual({ lighthouseVersion: '9.0.0', audits: [] });
    expect(parsePagespeedAudits(null).audits).toEqual([]);
    expect(parsePagespeedAudits({}).audits).toEqual([]);
  });
});

describe('B41 R4: stored resources (items)', () => {
  it('flat table: keeps only whitelisted keys, drops subItems and raw node objects', () => {
    const a = byId(real(), 'unused-javascript')!;
    expect(a.items.length).toBeGreaterThan(0);
    const allowed = new Set(['url', 'source', 'wastedMs', 'wastedBytes', 'totalBytes', 'selector', 'snippet', 'label', 'value', 'section']);
    for (const row of a.items) for (const k of Object.keys(row)) expect(allowed.has(k)).toBe(true);
    expect(a.items[0]?.url).toMatch(/^http/);
    expect(typeof a.items[0]?.wastedBytes).toBe('number');
  });

  it('unwraps node objects to selector and snippet (image-delivery-insight)', () => {
    const row = byId(real(), 'image-delivery-insight')!.items[0]!;
    expect(row.selector).toBe('body > img');
    expect(row.snippet).toContain('<img');
    expect(row.url).toContain('lighthouse-rotating.gif');
  });

  it('unwraps {type:url,value} and {type:code,value} values', () => {
    const a = first(
      oneAudit('insights', {
        score: 0,
        details: {
          type: 'table',
          items: [{ url: { type: 'url', value: 'https://a.test/x.js' }, source: { type: 'source-location', url: 'https://a.test/y.js', line: 3 }, label: { type: 'code', value: 'fn()' } }],
        },
      }),
    );
    expect(a?.items[0]).toMatchObject({ url: 'https://a.test/x.js', label: 'fn()' });
    expect(a?.items[0]?.source).toContain('https://a.test/y.js');
  });

  it('top-level checklist whose items is an OBJECT keyed by names is read as label/value rows (document-latency-insight)', () => {
    const a = byId(real(), 'document-latency-insight')!;
    expect(a.items).toEqual([
      { label: 'Avoids redirects', value: true },
      { label: 'Server responds quickly (observed 8 ms)', value: true },
      { label: 'No compression applied', value: false },
    ]);
  });

  it('an unknown details shape stores no items and does not throw', () => {
    for (const details of [{ type: 'weird', items: 'nope' }, { type: 'weird', items: { a: 1 } }, { type: 'list', items: [{ type: 'mystery', foo: 1 }, 7, null] }, { type: 'table' }, 'str', 5]) {
      const a = first(oneAudit('insights', { score: 0, details }));
      expect(a?.items).toEqual([]);
      expect(a?.itemsTruncated).toBe(false);
    }
  });

  it('nested list: flattens inner tables and node entries, tags each row with its section (lcp-breakdown-insight)', () => {
    const a = byId(real(), 'lcp-breakdown-insight')!;
    const labels = a.items.filter((r) => r.label).map((r) => r.label);
    expect(labels).toContain('Time to first byte');
    expect(a.items.some((r) => r.selector !== undefined)).toBe(true);
    expect(a.items.every((r) => typeof r.section === 'string')).toBe(true);
    expect(new Set(a.items.map((r) => r.section)).size).toBeGreaterThan(1);
  });

  it('nested list with a checklist entry: its booleans become {label, value} (lcp-discovery-insight)', () => {
    const a = byId(real(), 'lcp-discovery-insight')!;
    expect(a.items.some((r) => typeof r.value === 'boolean' && typeof r.label === 'string')).toBe(true);
  });

  it('list-section entries (network-dependency-tree-insight) store no items', () => {
    const a = byId(real(), 'network-dependency-tree-insight')!;
    expect(a).toBeDefined();
    expect(a.items).toEqual([]);
  });

  it('walks nested lists to depth 2 and no deeper', () => {
    const table = (u: string) => ({ type: 'table', items: [{ url: u }] });
    const a = first(oneAudit('insights', { score: 0, details: { type: 'list', items: [{ type: 'list', items: [table('https://d2.test/')] }, { type: 'list', items: [{ type: 'list', items: [table('https://d3.test/')] }] }] } }));
    expect(a?.items.map((r) => r.url)).toEqual(['https://d2.test/']);
  });

  it('caps rows at 20 and flags the cut (1f)', () => {
    const items = Array.from({ length: 50 }, (_, i) => ({ url: `https://a.test/${i}.js`, wastedBytes: 10 }));
    const a = first(oneAudit('diagnostics', { score: 0, details: { type: 'opportunity', items } }));
    expect(a?.items).toHaveLength(20);
    expect(a?.itemsTruncated).toBe(true);
    // the saving still counts every row, not only the stored ones
    expect(a?.savingsBytes).toBe(500);
  });

  it('cuts a hostile 10 KB snippet to 200 chars and any other string to 300 (1g)', () => {
    const a = first(
      oneAudit('insights', {
        score: 0,
        details: { type: 'table', items: [{ node: { type: 'node', selector: 's'.repeat(5000), snippet: 'x'.repeat(10_000) }, url: 'u'.repeat(5000), label: 'l'.repeat(5000) }] },
      }),
    );
    const row = a!.items[0]!;
    expect(row.snippet).toHaveLength(200);
    expect(row.selector).toHaveLength(300);
    expect(row.url).toHaveLength(300);
    expect(row.label).toHaveLength(300);
  });

  it('keeps the JSON of one audit under 8 KB, dropping rows from the end and flagging it', () => {
    const items = Array.from({ length: 20 }, (_, i) => ({ url: `https://a.test/${'p'.repeat(280)}${i}`, label: 'l'.repeat(290), source: 's'.repeat(290) }));
    const a = first(oneAudit('diagnostics', { score: 0, details: { type: 'table', items } }));
    expect(JSON.stringify(a!.items).length).toBeLessThanOrEqual(8192);
    expect(a!.items.length).toBeLessThan(20);
    expect(a!.items.length).toBeGreaterThan(0);
    expect(a!.itemsTruncated).toBe(true);
    expect(a!.items[0]!.url).toContain('0');
  });
});
