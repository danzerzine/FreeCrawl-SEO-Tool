import { describe, expect, it } from 'vitest';
import { reduceAxeResults, AXE_MAX_RULES, AXE_MAX_JSON_BYTES } from './axe-reduce.js';

const node = (i: number, html = '<img src="a.png">') => ({
  target: [`#n${i}`],
  html,
  failureSummary: `Fix any of the following:\n  Element does not have an alt attribute (${i})`,
});

const rule = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  impact: 'serious',
  help: `help ${id}`,
  helpUrl: `https://dequeuniversity.com/rules/axe/4.14/${id}`,
  tags: ['cat.text-alternatives', 'wcag2a', 'wcag111'],
  nodes: [node(1)],
  ...over,
});

const light = (id: string) => rule(id, { nodes: [], tags: [], help: 'h', helpUrl: '' });

const raw = (violations: unknown[], incomplete: unknown[] = []) => ({
  testEngine: { name: 'axe-core', version: '4.14.0' },
  violations,
  incomplete,
});

describe('reduceAxeResults (B40 R5, R10)', () => {
  it('keeps id, impact, help, helpUrl, tags and the node count per rule', () => {
    const out = reduceAxeResults(raw([rule('image-alt', { nodes: [node(1), node(2)] })]));
    expect(out.version).toBe('4.14.0');
    expect(out.violations).toHaveLength(1);
    const r = out.violations[0]!;
    expect(r.id).toBe('image-alt');
    expect(r.impact).toBe('serious');
    expect(r.help).toBe('help image-alt');
    expect(r.helpUrl).toContain('image-alt');
    expect(r.tags).toEqual(['cat.text-alternatives', 'wcag2a', 'wcag111']);
    expect(r.nodes).toBe(2);
  });

  it('keeps impact null as null', () => {
    const out = reduceAxeResults(raw([rule('x', { impact: null })]));
    expect(out.violations[0]!.impact).toBeNull();
  });

  it('cuts html to 200 chars and the summary to 300', () => {
    const long = '<p>' + 'a'.repeat(500) + '</p>';
    const n = { ...node(1, long), failureSummary: 's'.repeat(900) };
    const out = reduceAxeResults(raw([rule('x', { nodes: [n] })]));
    const s = out.violations[0]!.samples[0]!;
    expect(s.html.length).toBe(200);
    expect(s.summary.length).toBe(300);
    expect(s.target).toBe('#n1');
  });

  it('keeps 3 samples out of 200 nodes but counts all 200', () => {
    const nodes = Array.from({ length: 200 }, (_, i) => node(i));
    const out = reduceAxeResults(raw([rule('x', { nodes })]));
    expect(out.violations[0]!.nodes).toBe(200);
    expect(out.violations[0]!.samples).toHaveLength(3);
  });

  it('joins a nested (iframe/shadow) target path with a separator', () => {
    const n = { ...node(1), target: [['#host', '.inner'], '#x'] };
    const out = reduceAxeResults(raw([rule('x', { nodes: [n] })]));
    expect(out.violations[0]!.samples[0]!.target).toContain('#host');
    expect(out.violations[0]!.samples[0]!.target).toContain('#x');
  });

  it('keeps incomplete separate from violations', () => {
    const out = reduceAxeResults(raw([rule('a')], [rule('b', { impact: null })]));
    expect(out.violations.map((r) => r.id)).toEqual(['a']);
    expect(out.incomplete.map((r) => r.id)).toEqual(['b']);
  });

  it('ignores the frame-tested incomplete result (iframes are off)', () => {
    const out = reduceAxeResults(raw([], [rule('frame-tested'), rule('color-contrast')]));
    expect(out.incomplete.map((r) => r.id)).toEqual(['color-contrast']);
  });

  it('stores at most AXE_MAX_RULES rules, violations first, and says so', () => {
    const v = Array.from({ length: 90 }, (_, i) => light(`v${i}`));
    const inc = Array.from({ length: 40 }, (_, i) => light(`i${i}`));
    const out = reduceAxeResults(raw(v, inc));
    expect(out.violations).toHaveLength(90);
    expect(out.violations.length + out.incomplete.length).toBe(AXE_MAX_RULES);
    expect(out.truncated).toBe(true);
  });

  it('counts a violation that did not fit as still a violation (more than the cap)', () => {
    const v = Array.from({ length: 130 }, (_, i) => light(`v${i}`));
    const out = reduceAxeResults(raw(v));
    expect(out.violations).toHaveLength(AXE_MAX_RULES);
    expect(out.violationsTotal).toBe(130);
  });

  it('keeps the stored JSON under the byte cap, dropping needs-review rules first', () => {
    const big = (id: string) =>
      rule(id, { nodes: Array.from({ length: 3 }, (_, i) => node(i, 'x'.repeat(400))) });
    const v = Array.from({ length: 20 }, (_, i) => big(`v${i}`));
    const inc = Array.from({ length: 60 }, (_, i) => big(`i${i}`));
    const out = reduceAxeResults(raw(v, inc));
    expect(JSON.stringify(out).length).toBeLessThanOrEqual(AXE_MAX_JSON_BYTES);
    expect(out.violations).toHaveLength(20);
    expect(out.truncated).toBe(true);
  });

  it('survives a missing violations list (hostile or partial result)', () => {
    const out = reduceAxeResults({} as never);
    expect(out.violations).toEqual([]);
    expect(out.incomplete).toEqual([]);
  });

  it('runs as a string inside a function-free eval, with no outside names', () => {
    const src = reduceAxeResults.toString();
    const f = new Function(`return (${src})`)() as typeof reduceAxeResults;
    expect(f(raw([rule('a')])).violations[0]!.id).toBe('a');
  });
});
