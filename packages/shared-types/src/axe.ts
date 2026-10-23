/**
 * What an axe-core run on one rendered page stores (B40). The reducer that
 * builds it lives in packages/core (`reduceAxeResults`, runs inside the page);
 * the types sit here so the database and the products can name them too.
 */
export interface AxeSample {
  /** CSS selector path of the element (frames and shadow roots joined). */
  target: string;
  /** Opening markup of the element, cut to 200 characters. */
  html: string;
  /** axe's "how to fix" text, cut to 300 characters. */
  summary: string;
}

export interface AxeRuleResult {
  id: string;
  /** critical | serious | moderate | minor, or null when axe gives none. */
  impact: string | null;
  help: string;
  helpUrl: string;
  tags: string[];
  /** Elements that failed (or need review); all of them, not only the samples. */
  nodes: number;
  samples: AxeSample[];
}

export interface AxeAudit {
  /** axe-core version that ran. */
  version: string;
  violations: AxeRuleResult[];
  /** "Needs review": axe could not decide; never counted as an issue. */
  incomplete: AxeRuleResult[];
  /** Violated rules axe found, also those the cap did not store. */
  violationsTotal: number;
  /** Of those, rules with impact critical or serious. */
  seriousTotal: number;
  /** Rules or samples were dropped to stay inside the caps. */
  truncated?: boolean;
}

/** One stored rule result of one page (`axe_results`), as the readers return it. */
export interface AxeResultRow {
  url: string;
  ruleId: string;
  kind: 'violation' | 'incomplete';
  impact: string | null;
  help: string;
  helpUrl: string | null;
  tags: string[];
  nodes: number;
  samples: AxeSample[];
}
