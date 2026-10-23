import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// Drives the built CLI as a process (`npx tsc -b && npm run build:cli` first).
const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dist/index.js');
const HEADER =
  'url,title,title_chars,title_px,title_status,title_too_short,title_too_long,title_px_short,title_px_long,description,description_chars,description_px,description_status,desc_too_short,desc_too_long,desc_px_short,desc_px_long,duplicate_title,duplicate_description';
const GOOD = 'A perfectly reasonable page title for a result';
let dir: string;
let rowsFile: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'fc-b85-'));
  rowsFile = path.join(dir, 'rows.csv');
  fs.writeFileSync(
    rowsFile,
    `url,title,description\nhttps://z.test/z,${GOOD},\nhttps://z.test/a,Short,"Has, a comma"\n`,
  );
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

function run(args: string[], input?: string) {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', timeout: 60000, input });
}
const lines = (s: string): string[] => s.trimEnd().split('\n');

describe('B85 CLI: freecrawl serp', () => {
  it('--out writes the exact header and rows in input order, exit 0 though rows fail', () => {
    const out = path.join(dir, 'o.csv');
    const r = run(['serp', rowsFile, '--out', out]);
    expect(r.status, r.stderr).toBe(0);
    const got = lines(fs.readFileSync(out, 'utf8'));
    expect(got[0]).toBe(HEADER);
    expect(got.map((l) => l.split(',')[0])).toEqual(['url', 'https://z.test/z', 'https://z.test/a']);
    expect(got[1]!.split(',')[4]).toBe('ok');
    expect(got[2]!.split(',')[4]).toBe('too-short');
  });

  it('without --out and --json the CSV goes to stdout; "-" reads stdin', () => {
    const r = run(['serp', '-'], `${GOOD}\tdesc\n`);
    expect(r.status, r.stderr).toBe(0);
    expect(lines(r.stdout)[0]).toBe(HEADER);
    expect(lines(r.stdout)).toHaveLength(2);
  });

  it('--json prints rows and counts', () => {
    const r = run(['serp', rowsFile, '--json']);
    expect(r.status, r.stderr).toBe(0);
    const j = JSON.parse(r.stdout);
    expect(j.ok).toBe(true);
    expect(j.rows).toHaveLength(2);
    expect(j.counts.rows).toBe(2);
    expect(j.counts.title['too-short']).toBe(1);
    expect(j.counts.description.missing).toBe(1);
  });

  it('--limits flips a status', () => {
    const lim = path.join(dir, 'l.json');
    fs.writeFileSync(lim, JSON.stringify({ titleMaxChars: 10 }));
    const r = run(['serp', rowsFile, '--limits', lim]);
    expect(r.status, r.stderr).toBe(0);
    expect(lines(r.stdout)[1]!.split(',')[4]).toBe('too-long');
  });

  it('an unknown --limits key exits 2 and names it', () => {
    const lim = path.join(dir, 'l.json');
    fs.writeFileSync(lim, JSON.stringify({ nope: 1 }));
    const r = run(['serp', rowsFile, '--limits', lim]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('nope');
  });

  it('bad input exits 2: no file argument, missing file, broken limits JSON', () => {
    expect(run(['serp']).status).toBe(2);
    expect(run(['serp', path.join(dir, 'absent.csv')]).status).toBe(2);
    const lim = path.join(dir, 'l.json');
    fs.writeFileSync(lim, '{oops');
    expect(run(['serp', rowsFile, '--limits', lim]).status).toBe(2);
  });

  it('--help carries the serp line', () => {
    const r = run(['--help']);
    expect(r.stdout).toContain(
      'freecrawl serp <file|-> [--out <csv>] [--json] [--limits <json>]   Check titles/descriptions from a list against Google snippet limits; nothing is fetched.',
    );
  });

  it('never fetches: a local server named in the url column gets 0 hits', async () => {
    let hits = 0;
    const server = http.createServer((_q, res) => {
      hits++;
      res.end('x');
    });
    await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
    const port = (server.address() as { port: number }).port;
    fs.writeFileSync(rowsFile, `url,title,description\nhttp://127.0.0.1:${port}/p,${GOOD},d\n`);
    const code = await new Promise<number | null>((ok) => {
      const p = spawn(process.execPath, [CLI, 'serp', rowsFile]);
      p.on('close', ok);
    });
    await new Promise((ok) => setTimeout(ok, 200));
    server.close();
    expect(code).toBe(0);
    expect(hits).toBe(0);
  });
});
