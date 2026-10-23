import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { ProjectDb } from '@freecrawl/db';

// B136: the page-signals dataset through the built CLI.
const cli = fileURLToPath(new URL('../dist/index.js', import.meta.url));
const run = promisify(execFile);
let dir: string;
let project: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'b136-'));
  project = join(dir, 'p.seoproject');
  const db = new ProjectDb(project);
  db.upsertUrl({
    url: 'https://ex.com/a',
    depth: 0,
    statusCode: 200,
    indexability: 'indexable',
    contentKind: 'html',
    h2Count: 1,
    h2First: 'a',
    titleOutsideHead: 2,
  });
  db.setMeta('checksFilled', JSON.stringify(['issues:title-outside-head']));
  db.close();
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

it('--what dataset:page-signals writes page-signals.csv with URL,Signal,Detail', async () => {
  const out = join(dir, 'one');
  await run(process.execPath, [cli, 'export', '--project', project, '--out', out, '--what', 'dataset:page-signals'], {
    timeout: 60_000,
  });
  const csv = readFileSync(join(out, 'page-signals.csv'), 'utf8').replace(/^﻿/, '').split('\n');
  expect(csv[0]).toBe('URL,Signal,Detail');
  expect(csv).toContain('https://ex.com/a,issues:title-outside-head,2');
}, 90_000);

it('--what bulk writes page-signals.csv and lists it in the manifest', async () => {
  const out = join(dir, 'bulk');
  await run(process.execPath, [cli, 'export', '--project', project, '--out', out, '--what', 'bulk'], { timeout: 60_000 });
  expect(existsSync(join(out, 'page-signals.csv'))).toBe(true);
  const m = JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8')) as { files: { path: string }[] };
  expect(m.files.map((f) => f.path)).toContain('page-signals.csv');
}, 90_000);

it('a bad dataset key still errors and lists page-signals among the valid keys', async () => {
  const err = await run(process.execPath, [cli, 'export', '--project', project, '--out', join(dir, 'bad'), '--what', 'dataset:nope'], {
    timeout: 60_000,
  }).then(
    () => null,
    (e: { stderr?: string; stdout?: string }) => `${e.stderr ?? ''}${e.stdout ?? ''}`,
  );
  expect(err).toMatch(/page-signals/);
}, 90_000);
