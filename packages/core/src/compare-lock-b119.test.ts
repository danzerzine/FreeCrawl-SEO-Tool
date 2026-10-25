import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { ProjectDb } from '@freecrawl/db';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { openCompareProject } from './compare.js';

// B119: rebuilding the stored checks of a bare project in place must not hold the write lock for the whole
// pass: a crawl writing the same file in another process gets no "database is locked" while it runs.
let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-b119-'));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

function staleProject(rows: number): string {
  const file = path.join(dir, 'p.seoproject');
  new ProjectDb(file).close();
  const raw = new DatabaseSync(file);
  raw.exec('BEGIN');
  const ins = raw.prepare(
    `INSERT INTO urls (url, is_external, content_kind, status_code, indexability, title, title_length, word_count) VALUES (?, 0, 'html', 200, 'indexable', ?, ?, 5)`,
  );
  for (let i = 0; i < rows; i++) ins.run(`https://ex.com/p${i}`, `Title ${i % 50}`, 8);
  raw.exec('COMMIT');
  raw.exec(`UPDATE project_meta SET value = 'old' WHERE key = 'urlsIssuesVersion'`);
  raw.close();
  return file;
}

/** A second process that writes small transactions into the file with a short lock wait until its stdin closes. */
function startWriter(file: string): { done: Promise<{ writes: number; errors: string[] }>; stop: () => void } {
  const code = `
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(process.argv[1]);
    db.exec('PRAGMA busy_timeout = 100');
    let stop = false, writes = 0; const errors = [];
    process.stdin.on('data', () => {}); process.stdin.on('end', () => { stop = true; });
    process.stdin.resume();
    const ins = db.prepare("INSERT INTO urls (url, is_external, content_kind, status_code) VALUES (?, 0, 'html', 200)");
    const tick = () => {
      if (stop) { console.log(JSON.stringify({ writes, errors })); return; }
      try { ins.run('https://ex.com/live-' + writes + '-' + Date.now()); writes++; } catch (e) { errors.push(String(e.message)); }
      setTimeout(tick, 5);
    };
    tick();
  `;
  const child = spawn(process.execPath, ['-e', code, file], { stdio: ['pipe', 'pipe', 'inherit'] });
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  const done = new Promise<{ writes: number; errors: string[] }>((resolve) =>
    child.on('exit', () => resolve(JSON.parse(out) as { writes: number; errors: string[] })),
  );
  return { done, stop: () => child.stdin.end() };
}

it('a concurrent writer in another process meets no lock error while the in-place rebuild runs', async () => {
  const file = staleProject(250_000);
  const writer = startWriter(file);
  await new Promise((r) => setTimeout(r, 300));
  const t0 = Date.now();
  const project = await openCompareProject(file);
  const ms = Date.now() - t0;
  expect(project.db.issueMaterialisationStale()).toBe(false);
  project.dispose();
  writer.stop();
  const res = await writer.done;
  expect(res.errors).toEqual([]);
  expect(res.writes).toBeGreaterThan(10);
}, 120_000);
