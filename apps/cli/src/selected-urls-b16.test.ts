import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { ProjectDb } from '@freecrawl/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dist/index.js');
let dir: string;
let project: string;
const run = (args: string[]) =>
  spawnSync(process.execPath, [CLI, 'export', '--project', project, ...args], { encoding: 'utf8' });

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-b16cli-'));
  project = path.join(dir, 'p.seoproject');
  new ProjectDb(project).close();
  const raw = new DatabaseSync(project);
  raw.exec(`
    INSERT INTO urls (id, url, status_code) VALUES
      (1,'https://ex.com/a',200),(2,'https://ex.com/b',200),(3,'https://ex.com/c',200);
    INSERT INTO links (from_url_id, to_url, anchor, is_internal) VALUES
      (3,'https://ex.com/a','c-a',1),(1,'https://ex.com/b','a-b',1),(3,'https://ex.com/b','c-b',1);
  `);
  raw.close();
});
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('export --urls', () => {
  it('writes the two files; unknown URLs reported, exit 1', () => {
    const list = path.join(dir, 'u.txt');
    fs.writeFileSync(list, 'https://ex.com/a\nhttps://ex.com/nope\n');
    const out = path.join(dir, 'out');
    const r = run(['--out', out, '--urls', list, '--json']);
    expect(r.status).toBe(1);
    const j = JSON.parse(r.stdout);
    expect(j.errors[0].error).toContain('https://ex.com/nope');
    expect(r.stderr).toContain('https://ex.com/nope');
    expect(fs.readdirSync(out).sort()).toEqual(['manifest.json', 'selected-inlinks.csv', 'selected-outlinks.csv']);
    expect(fs.readFileSync(path.join(out, 'selected-inlinks.csv'), 'utf8').split('\n').filter(Boolean)).toHaveLength(2);
    expect(fs.readFileSync(path.join(out, 'selected-outlinks.csv'), 'utf8')).toContain('a-b');
    // The folder's manifest tells the same story as the JSON on stdout.
    const manifest = JSON.parse(fs.readFileSync(path.join(out, 'manifest.json'), 'utf8'));
    expect(manifest.errors).toEqual(j.errors);
  });
  it('exit 2 when no URL matches', () => {
    const list = path.join(dir, 'n.txt');
    fs.writeFileSync(list, 'https://ex.com/nope\n');
    expect(run(['--out', path.join(dir, 'o2'), '--urls', list]).status).toBe(2);
  });
});
