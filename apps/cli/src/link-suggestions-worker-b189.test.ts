import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ProjectDb } from '@freecrawl/db';

// B189: the CLI computes `dataset:link-suggestions` in the capped worker thread, not in its own
// process. Drives the built CLI with a preload that records every Worker it starts.
const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dist/index.js');
let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'fc-b189c-'));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('B189 CLI: dataset:link-suggestions runs in the worker', () => {
  it('starts the link-suggestions worker and still writes the file', () => {
    const project = path.join(dir, 'p.seoproject');
    new ProjectDb(project).close();
    const raw = new DatabaseSync(project);
    raw.exec(`
      INSERT INTO project_meta (key, value) VALUES ('inlinksComputed', '1');
      INSERT INTO urls (id, url, is_external, content_kind, status_code, indexability, title, outlinks) VALUES
        (1, 'https://ex.test/a', 0, 'html', 200, 'indexable', 'Espresso machine guide', 10),
        (2, 'https://ex.test/b', 0, 'html', 200, 'indexable', 'Espresso machine care', 10);
    `);
    raw.close();

    const log = path.join(dir, 'workers.log');
    const preload = path.join(dir, 'preload.cjs');
    fs.writeFileSync(
      preload,
      `const wt = require('node:worker_threads');
       const fs = require('node:fs');
       const Real = wt.Worker;
       wt.Worker = class extends Real {
         constructor(file, options) {
           fs.appendFileSync(${JSON.stringify(log)}, String(file) + '\\n');
           super(file, options);
         }
       };`,
    );
    const out = path.join(dir, 'd');
    const r = spawnSync(
      process.execPath,
      ['--require', preload, CLI, 'export', '--project', project, '--what', 'dataset:link-suggestions', '--out', out],
      { encoding: 'utf8', timeout: 60000 },
    );
    expect(r.status, r.stderr).toBe(0);
    expect(fs.readFileSync(path.join(out, 'link-suggestions.csv'), 'utf8')).toContain('ex.test/a');
    const workers = fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '';
    expect(workers).toContain('link-suggestions-worker');
  });
});
