/**
 * Monitoring rules: one JSON file format shared by the alerts (B88) and
 * the release gate (B89). A rule fires when `<measured> <op> <value>` is
 * true, where `measured` is the metric itself (`vs: absolute`) or its
 * change since the previous crawl (`vs: previous`, as a count or percent).
 */
import type { CrawlSnapshot } from '@freecrawl/shared-types';
import { assertMetric, metricValue } from './snapshot.js';

export type RuleOp = '>' | '>=' | '<' | '<=' | '==' | '!=';

/** One rule with every default filled in. */
export interface Rule {
  name: string;
  metric: string;
  vs: 'absolute' | 'previous';
  change: 'count' | 'percent';
  op: RuleOp;
  value: number;
  level: 'fail' | 'warn';
}

/** One evaluated rule; what the gate, the CLI and the alert senders read. */
export interface AlertRuleResult {
  name: string;
  metric: string;
  level: 'fail' | 'warn';
  status: 'pass' | 'fired' | 'skipped' | 'error';
  previous: number | null;
  current: number | null;
  change: number | null;
  /** How `change` is expressed; defaults to a plain count. */
  changeUnit?: 'count' | 'percent';
  threshold: { op: string; value: number };
}

const OPS: Record<RuleOp, (a: number, b: number) => boolean> = {
  '>': (a, b) => a > b,
  '>=': (a, b) => a >= b,
  '<': (a, b) => a < b,
  '<=': (a, b) => a <= b,
  '==': (a, b) => a === b,
  '!=': (a, b) => a !== b,
};

function oneOf<T extends string>(v: unknown, allowed: readonly T[], fallback?: T): T | undefined {
  if (v === undefined) return fallback;
  return allowed.includes(v as T) ? (v as T) : undefined;
}

/**
 * Reads a rule file's parsed JSON and fills in the defaults. Throws on
 * the first problem, naming the rule as `rules[<index>]` and the reason.
 */
export function parseRules(json: unknown): Rule[] {
  const file = json as { version?: unknown; rules?: unknown } | null;
  if (typeof file !== 'object' || file === null || file.version !== 1) {
    throw new Error('Rule file must be a JSON object with "version": 1');
  }
  if (!Array.isArray(file.rules)) throw new Error('Rule file needs a "rules" list');
  return file.rules.map((raw: unknown, i) => {
    const fail = (why: string): never => {
      throw new Error(`rules[${i}]: ${why}`);
    };
    const r = (typeof raw === 'object' && raw !== null ? raw : fail('must be an object')) as Record<string, unknown>;
    if (typeof r.name !== 'string' || !r.name) fail('"name" must be a non-empty string');
    if (typeof r.metric !== 'string') fail('"metric" must be a string');
    try {
      assertMetric(r.metric as string);
    } catch (err) {
      fail((err as Error).message);
    }
    const op = oneOf(r.op, Object.keys(OPS) as RuleOp[]) ?? fail(`"op" ${JSON.stringify(r.op)} is not one of ${Object.keys(OPS).join(', ')}`);
    if (typeof r.value !== 'number' || !Number.isFinite(r.value)) fail('"value" must be a number');
    const vs = oneOf(r.vs, ['absolute', 'previous'] as const, 'absolute') ?? fail('"vs" must be absolute or previous');
    const change = oneOf(r.change, ['count', 'percent'] as const, 'count') ?? fail('"change" must be count or percent');
    if (change === 'percent' && vs !== 'previous') fail('"change": "percent" needs "vs": "previous"');
    const level = oneOf(r.level, ['fail', 'warn'] as const, 'fail') ?? fail('"level" must be fail or warn');
    return { name: r.name as string, metric: r.metric as string, vs, change, op, value: r.value as number, level };
  });
}

/** Evaluates every rule against the current crawl and, when there is one, the previous. */
export function evaluateRules(
  rules: Rule[],
  current: CrawlSnapshot,
  previous: CrawlSnapshot | null,
): AlertRuleResult[] {
  return rules.map((rule) => {
    const cur = metricValue(current, rule.metric);
    const prev = previous ? metricValue(previous, rule.metric) : null;
    // The change is shown for absolute rules too, so an alert can say how far it moved.
    let change: number | null = null;
    if (cur !== null && prev !== null) {
      if (rule.change === 'count') change = cur - prev;
      else if (prev !== 0) change = ((cur - prev) / prev) * 100;
    }
    const result = {
      name: rule.name,
      metric: rule.metric,
      level: rule.level,
      previous: prev,
      current: cur,
      change,
      changeUnit: rule.change,
      threshold: { op: rule.op, value: rule.value },
    };
    // Not computed now, or in the previous crawl a rule compares with (check
    // off or never filled): an error, so a silenced check cannot pass a gate.
    // No previous crawl at all: skipped.
    if (cur === null) return { ...result, status: 'error' };
    if (rule.vs === 'previous' && previous && prev === null) return { ...result, status: 'error' };
    const measured = rule.vs === 'absolute' ? cur : change;
    if (measured === null) return { ...result, status: 'skipped' };
    return { ...result, status: OPS[rule.op](measured, rule.value) ? 'fired' : 'pass' };
  });
}

/** The gate's verdict: true when any `fail` rule fired or could not be computed. */
export function gateFails(results: AlertRuleResult[]): boolean {
  return results.some((r) => r.level === 'fail' && (r.status === 'fired' || r.status === 'error'));
}
