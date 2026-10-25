import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));
const INDEX = fs.readFileSync(path.join(here, 'index.ts'), 'utf8');

// The BigQuery pull keeps its state per window (BqSlot) and its overlap guard reads the run's
// own ledger. That is safe only while no two windows write one database: each open gets its
// own working copy, even of the same project file (B182).
describe('one working database per opened project (B182)', () => {
  it('openProjectAtPath opens the project as a new working copy, never the file another window has', () => {
    const start = INDEX.indexOf('async function openProjectAtPath(');
    expect(start).toBeGreaterThan(0);
    const body = INDEX.slice(start, INDEX.indexOf('\n}\n', start));
    expect(body).toMatch(/const workingPath = newWorkingDbPath\(\);/);
    expect(body).toMatch(/s\.db = new ProjectDb\(workingPath\);/);
    expect(body.match(/new ProjectDb\(/g)).toHaveLength(1);
  });

  it('every working path is new: a per-process counter, never reused', () => {
    const start = INDEX.indexOf('function newWorkingDbPath(): string {');
    const body = INDEX.slice(start, INDEX.indexOf('\n}\n', start));
    expect(body).toMatch(/workingDbCounter \+= 1;/);
    expect(body).toMatch(/work-\$\{process\.pid\}-\$\{workingDbCounter\}/);
  });
});
