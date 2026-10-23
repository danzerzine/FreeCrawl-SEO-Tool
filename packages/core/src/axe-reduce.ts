/**
 * Reduces a raw axe-core result to what a project stores (B40 R5, R10).
 *
 * `reduceAxeResults` is pure and self-contained: its source is injected into
 * the page next to `axe.run`, so the whole axe result (hundreds of KB on a big
 * page) never crosses the CDP wire. It must not reference anything outside its
 * own body (no helpers, no imports, no nested named functions: a bundler's
 * name-keeping wrapper would be undefined in the page).
 */

import type { AxeAudit, AxeRuleResult, AxeSample } from '@freecrawl/shared-types';

export type { AxeAudit, AxeRuleResult, AxeSample };

/** At most this many rules (violations first, then needs-review) are stored per page. */
export const AXE_MAX_RULES = 100;
/** One page's stored axe JSON never exceeds this many characters. */
export const AXE_MAX_JSON_BYTES = 30 * 1024;

export function reduceAxeResults(raw: {
  testEngine?: { version?: string };
  violations?: unknown[];
  incomplete?: unknown[];
}): AxeAudit {
  const MAX_RULES = 100;
  const MAX_JSON = 30 * 1024;
  const out: AxeAudit = {
    version: String(raw && raw.testEngine && raw.testEngine.version ? raw.testEngine.version : ''),
    violations: [],
    incomplete: [],
    violationsTotal: 0,
    seriousTotal: 0,
    incompleteTotal: 0,
  };
  const lists: Array<[unknown[], AxeRuleResult[], boolean]> = [
    [raw && Array.isArray(raw.violations) ? raw.violations : [], out.violations, true],
    [raw && Array.isArray(raw.incomplete) ? raw.incomplete : [], out.incomplete, false],
  ];
  let truncated = false;
  let stored = 0;
  for (let li = 0; li < lists.length; li++) {
    const entry = lists[li] as [unknown[], AxeRuleResult[], boolean];
    const src = entry[0];
    const dst = entry[1];
    const isViolation = entry[2];
    for (let i = 0; i < src.length; i++) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const r = src[i] as any;
      if (!r || typeof r.id !== 'string') continue;
      // Cross-origin frames are not audited (iframes:false); that is not a finding.
      if (!isViolation && r.id === 'frame-tested') continue;
      const impact = typeof r.impact === 'string' ? r.impact : null;
      if (isViolation) {
        out.violationsTotal++;
        if (impact === 'critical' || impact === 'serious') out.seriousTotal++;
      } else {
        // Counted here, before the rule cap and the byte trim below can drop the rule.
        out.incompleteTotal = (out.incompleteTotal || 0) + 1;
      }
      if (stored >= MAX_RULES) {
        truncated = true;
        continue;
      }
      const nodes = Array.isArray(r.nodes) ? r.nodes : [];
      const samples: AxeSample[] = [];
      for (let n = 0; n < nodes.length && n < 3; n++) {
        const nd = nodes[n] || {};
        let target = '';
        if (Array.isArray(nd.target)) {
          const parts: string[] = [];
          for (let t = 0; t < nd.target.length; t++) {
            const p = nd.target[t];
            parts.push(Array.isArray(p) ? p.join(' >> ') : String(p));
          }
          target = parts.join(' | ');
        }
        samples.push({
          target: target.slice(0, 300),
          html: String(nd.html || '').slice(0, 200),
          summary: String(nd.failureSummary || '').slice(0, 300),
        });
      }
      dst.push({
        id: r.id,
        impact,
        help: String(r.help || '').slice(0, 300),
        helpUrl: String(r.helpUrl || '').slice(0, 300),
        tags: Array.isArray(r.tags) ? r.tags.map(String) : [],
        nodes: nodes.length,
        samples,
      });
      stored++;
    }
  }
  // Byte cap: needs-review rules go first, then the tail of the violations.
  while (JSON.stringify(out).length > MAX_JSON && (out.incomplete.length > 0 || out.violations.length > 1)) {
    truncated = true;
    if (out.incomplete.length > 0) out.incomplete.pop();
    else out.violations.pop();
  }
  if (truncated) out.truncated = true;
  return out;
}
