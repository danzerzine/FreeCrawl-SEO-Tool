import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ProjectDb } from '@freecrawl/db';
import type { AxeAudit, AxeRuleResult } from '@freecrawl/shared-types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildTools } from './tools.js';

const A = 'https://ex.test/a';
const B = 'https://ex.test/b';
const rule = (id: string, impact: string, nodes = 1): AxeRuleResult => ({
  id, impact, help: `help ${id}`, helpUrl: `https://x/${id}`, tags: ['wcag2a'], nodes,
  samples: [{ target: '#t', html: '<b>', summary: 's' }],
});
const audit = (v: AxeRuleResult[], inc: AxeRuleResult[] = []): AxeAudit => ({
  version: '4.14.0', violations: v, incomplete: inc, violationsTotal: v.length,
  seriousTotal: v.filter((r) => r.impact === 'critical' || r.impact === 'serious').length,
});

let dir: string;
let db: ProjectDb;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-b40m-'));
  const file = path.join(dir, 'p.seoproject');
  new ProjectDb(file).close();
  const raw = new DatabaseSync(file);
  raw.exec(`INSERT INTO urls (id, url, is_external, content_kind, status_code) VALUES (1,'${A}',0,'html',200),(2,'${B}',0,'html',200)`);
  raw.close();
  db = new ProjectDb(file);
  db.setUrlAxe(1, audit([rule('minor-one', 'minor', 9), rule('image-alt', 'critical', 2), rule('label', 'serious', 5)], [rule('color-contrast', 'serious', 4)]));
  db.setUrlAxe(2, audit([rule('image-alt', 'critical', 1)]));
});
afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

interface Out { total: number; rows: { url: string; ruleId: string; kind: string; impact: string | null }[] }
const tool = () => buildTools().find((t) => t.name === 'query_axe');
const run = (args: Record<string, unknown>) => tool()!.handler(args, db) as Out;

describe('B40 R14: MCP query_axe', () => {
  it('exists, describes its filters and caps limit at 1000', () => {
    const t = tool();
    expect(t).toBeDefined();
    const props = (t!.inputSchema as { properties: Record<string, { maximum?: number }> }).properties;
    expect(Object.keys(props).sort()).toEqual(['impact', 'kind', 'limit', 'offset', 'rule_id', 'url']);
    expect(props.limit!.maximum).toBe(1000);
    expect(t!.description).toMatch(/needs.review/i);
    expect(t!.description).toMatch(/--axe|Settings/);
  });

  it('names the settings panel as the app does and says how a missing impact is counted (B177)', () => {
    const d = tool()!.description;
    expect(d).toContain('Settings → Rendering');
    expect(d).not.toContain('Settings -> JavaScript rendering');
    expect(d).toMatch(/no impact.*moderate or minor/i);
  });

  it('lists violations worst impact first, then needs-review, and filters', () => {
    expect(run({ url: A }).rows.map((r) => `${r.ruleId}:${r.kind}`)).toEqual([
      'image-alt:violation', 'label:violation', 'minor-one:violation', 'color-contrast:incomplete',
    ]);
    expect(run({ rule_id: 'image-alt' }).rows.map((r) => r.url).sort()).toEqual([A, B]);
    expect(run({ impact: 'serious' }).rows.map((r) => r.ruleId)).toEqual(['label', 'color-contrast']);
    expect(run({ kind: 'incomplete' }).total).toBe(1);
    const r = run({ limit: 1, offset: 1 });
    expect(r.total).toBe(5);
    expect(r.rows).toHaveLength(1);
  });

  it('get_url_detail carries the axe counts of the page', () => {
    const t = buildTools().find((x) => x.name === 'get_url_detail')!;
    const d = t.handler({ url: A }, db) as { row: { axeViolations?: number; axeSerious?: number; axeIncomplete?: number } };
    expect([d.row.axeViolations, d.row.axeSerious, d.row.axeIncomplete]).toEqual([3, 2, 1]);
  });
});
