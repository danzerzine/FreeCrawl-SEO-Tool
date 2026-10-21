import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, expect, it } from 'vitest';
import { ProjectDb } from '@freecrawl/db';
import { listProjectRules, saveProjectRules } from './project-rules.js';

const dir = mkdtempSync(join(tmpdir(), 'b88d-rules-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

it('saved rules survive a reopen, with defaults filled in, as a rule file', () => {
  const file = join(dir, 'p.seoproject');
  let db = new ProjectDb(file);
  saveProjectRules(db, {
    version: 1,
    rules: [{ name: 'No server errors', metric: 'status.5xx', op: '>', value: 0 }],
  });
  db.close();
  db = new ProjectDb(file);
  const expected = [
    { name: 'No server errors', metric: 'status.5xx', vs: 'absolute', change: 'count', op: '>', value: 0, level: 'fail' },
  ];
  expect(listProjectRules(db)).toEqual(expected);
  // Stored as the CLI's rule file shape.
  expect(JSON.parse(db.getMeta('monitorRules')!)).toEqual({ version: 1, rules: expected });
  db.close();
});

it('a bad rule throws naming its index and saves nothing', () => {
  const db = new ProjectDb(join(dir, 'bad.seoproject'));
  expect(() =>
    saveProjectRules(db, { version: 1, rules: [{ name: 'x', metric: 'nope', op: '>', value: 1 }] }),
  ).toThrow(/rules\[0\]/);
  expect(listProjectRules(db)).toEqual([]);
  db.setMeta('monitorRules', '{not json');
  expect(listProjectRules(db)).toEqual([]);
  db.close();
});
