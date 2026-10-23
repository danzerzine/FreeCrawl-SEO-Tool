import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ProjectDb } from '@freecrawl/db';
import { buildCrawlSnapshot } from '@freecrawl/core';

// Drives the built CLI as a process (`npx tsc -b && npm run build:cli` first).
const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dist/index.js');
const run = (args: string[], env: Record<string, string> = {}) =>
  spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', timeout: 30000, env: { ...process.env, ...env } });
const runAsync = (args: string[], env: Record<string, string>) =>
  new Promise<{ status: number | null; stdout: string; stderr: string }>((res) => {
    const p = spawn(process.execPath, [CLI, ...args], { env: { ...process.env, ...env } });
    let stdout = '';
    let stderr = '';
    p.stdout.on('data', (d) => (stdout += d));
    p.stderr.on('data', (d) => (stderr += d));
    p.on('close', (status) => res({ status, stdout, stderr }));
  });

let dir: string;
const START = 'https://example.test/';
const rulesFile = (name: string, rules: unknown[]) => {
  const f = path.join(dir, name);
  fs.writeFileSync(f, JSON.stringify({ version: 1, rules }));
  return f;
};
const fixture = (name: string, indexable: number[], startUrl = START) => {
  const p = path.join(dir, name);
  const db = new ProjectDb(p);
  const base = buildCrawlSnapshot(db);
  indexable.forEach((n, i) => {
    const snapshot = structuredClone(base);
    snapshot.counts.indexability.indexable = n;
    db.appendCrawlRun({ finishedAt: `2026-0${i + 1}-01T00:00:00.000Z`, startUrl, mode: 'spider', durationMs: 1, toolVersion: null, snapshot });
  });
  db.close();
  return p;
};
let project: string;
let single: string;
let empty: string;
let passRules: string;
let failRules: string;
let warnRules: string;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-check-'));
  project = fixture('p.seoproject', [100, 80]);
  single = fixture('s.seoproject', [100]);
  empty = fixture('e.seoproject', []);
  passRules = rulesFile('pass.json', [{ name: 'enough', metric: 'indexable', op: '<', value: 10 }]);
  failRules = rulesFile('fail.json', [
    { name: 'ok one', metric: 'indexable', op: '<', value: 10 },
    { name: 'drop', metric: 'indexable', vs: 'previous', change: 'percent', op: '<=', value: -10 },
  ]);
  warnRules = rulesFile('warn.json', [{ name: 'drop', metric: 'indexable', vs: 'previous', op: '<', value: 0, level: 'warn' }]);
});
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('check', () => {
  it('all pass: exit 0', () => {
    const r = run(['check', '--project', project, '--rules', passRules, '--json']);
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.ok).toBe(true);
    expect(out.results[0].status).toBe('pass');
    expect(out.notified).toEqual([]);
  });
  it('a fail rule fired: exit 1, every rule listed with its status', () => {
    const r = run(['check', '--project', project, '--rules', failRules, '--json']);
    expect(r.status).toBe(1);
    const out = JSON.parse(r.stdout);
    expect(out.ok).toBe(false);
    expect(out.results.map((x: { status: string }) => x.status)).toEqual(['pass', 'fired']);
    expect(out.results[1]).toMatchObject({ previous: 100, current: 80, change: -20 });
  });
  it('only a warn rule fired: exit 0; text output lists rules', () => {
    expect(run(['check', '--project', project, '--rules', warnRules, '--json']).status).toBe(0);
    const t = run(['check', '--project', project, '--rules', warnRules]);
    expect(t.status).toBe(0);
    expect(t.stdout).toContain('drop');
  });
  it('first crawl has no previous: previous rules skipped, exit 0', () => {
    const r = run(['check', '--project', single, '--rules', failRules, '--json']);
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout).results[1].status).toBe('skipped');
  });
  it('uses the saved monitorRules without --rules', () => {
    const p = path.join(dir, 'saved.seoproject');
    fs.copyFileSync(project, p);
    const db = new ProjectDb(p);
    db.setMeta('monitorRules', fs.readFileSync(failRules, 'utf8'));
    db.close();
    expect(run(['check', '--project', p, '--json']).status).toBe(1);
    expect(run(['check', '--project', project, '--json']).status).toBe(2);
  });
  it('bad rules, project, no history: exit 2 with a JSON error', () => {
    const bad = rulesFile('bad.json', [{ name: 'x', metric: 'indexable', op: '~', value: 1 }]);
    const r = run(['check', '--project', project, '--rules', bad, '--json']);
    expect(r.status).toBe(2);
    expect(JSON.parse(r.stdout).error).toContain('rules[0]');
    const notJson = path.join(dir, 'nj.json');
    fs.writeFileSync(notJson, '{');
    expect(run(['check', '--project', project, '--rules', notJson]).status).toBe(2);
    expect(run(['check', '--project', path.join(dir, 'missing'), '--rules', passRules]).status).toBe(2);
    expect(run(['check', '--rules', passRules]).status).toBe(2);
    const e = run(['check', '--project', empty, '--rules', passRules, '--json']);
    expect(e.status).toBe(2);
    expect(JSON.parse(e.stdout).error).toContain('no crawl history');
  });
  it('--baseline snapshot.json from --write-snapshot equals the baseline project', () => {
    const snap = path.join(dir, 'snap.json');
    // The older crawl as a baseline project of its own.
    expect(run(['check', '--project', single, '--rules', passRules, '--write-snapshot', snap]).status).toBe(0);
    expect(JSON.parse(fs.readFileSync(snap, 'utf8')).version).toBe(1);
    const viaProject = run(['check', '--project', project, '--rules', failRules, '--baseline', single, '--json']);
    const viaFile = run(['check', '--project', project, '--rules', failRules, '--baseline', snap, '--json']);
    expect(viaFile.status).toBe(1);
    expect(JSON.parse(viaFile.stdout).results).toEqual(JSON.parse(viaProject.stdout).results);
    expect(run(['check', '--project', project, '--rules', failRules, '--baseline', path.join(dir, 'nope.json')]).status).toBe(2);
    expect(run(['check', '--project', project, '--rules', failRules, '--baseline', empty]).status).toBe(2);
  });
  it('baseline project of another site, unwritable snapshot path: exit 2', () => {
    const other = fixture('o.seoproject', [100], 'https://other.test/');
    const r = run(['check', '--project', project, '--rules', failRules, '--baseline', other, '--json']);
    expect(r.status).toBe(2);
    expect(JSON.parse(r.stdout).error).toContain('https://example.test/');
    const bad = path.join(dir, 'no-such-dir', 'snap.json');
    const w = run(['check', '--project', project, '--rules', passRules, '--write-snapshot', bad, '--json']);
    expect(w.status).toBe(2);
    expect(JSON.parse(w.stdout).ok).toBe(false);
  });
  it('an empty rule list never passes: exit 2 «No rules», saved or from a file', () => {
    const p = path.join(dir, 'emptyrules.seoproject');
    fs.copyFileSync(project, p);
    const db = new ProjectDb(p);
    db.setMeta('monitorRules', JSON.stringify({ version: 1, rules: [] }));
    db.close();
    const saved = run(['check', '--project', p, '--json']);
    expect(saved.status).toBe(2);
    expect(JSON.parse(saved.stdout).error).toContain('No rules');
    const file = run(['check', '--project', project, '--rules', rulesFile('none.json', []), '--json']);
    expect(file.status).toBe(2);
    expect(JSON.parse(file.stdout).error).toContain('No rules');
  });
  it('--write-snapshot carries the start URL; a snapshot of another site or of no named site is refused', () => {
    const snap = path.join(dir, 'snap-url.json');
    expect(run(['check', '--project', project, '--rules', passRules, '--write-snapshot', snap]).status).toBe(0);
    expect(JSON.parse(fs.readFileSync(snap, 'utf8')).startUrl).toBe(START);
    const other = fixture('o2.seoproject', [100], 'https://other.test/');
    const otherSnap = path.join(dir, 'snap-other.json');
    expect(run(['check', '--project', other, '--rules', passRules, '--write-snapshot', otherSnap]).status).toBe(0);
    const r = run(['check', '--project', project, '--rules', failRules, '--baseline', otherSnap, '--json']);
    expect(r.status).toBe(2);
    expect(JSON.parse(r.stdout).error).toContain('https://other.test/');
    expect(JSON.parse(r.stdout).error).toContain(START);
    const old = JSON.parse(fs.readFileSync(otherSnap, 'utf8'));
    delete old.startUrl;
    const oldSnap = path.join(dir, 'snap-old.json');
    fs.writeFileSync(oldSnap, JSON.stringify(old));
    const o = run(['check', '--project', project, '--rules', failRules, '--baseline', oldSnap, '--json']);
    expect(o.status).toBe(2);
    expect(JSON.parse(o.stdout).error).toContain('--write-snapshot');
  });
  it('no test-only Telegram API base in the shipped CLI', () => {
    expect(fs.readFileSync(CLI, 'utf8')).not.toContain('FREECRAWL_TELEGRAM_API_BASE');
  });
  it('--notify slack: one post when a rule fired, none otherwise', async () => {
    const posts: string[] = [];
    const server = http.createServer((req, res) => {
      let b = '';
      req.on('data', (d) => (b += d));
      req.on('end', () => {
        posts.push(b);
        res.end('ok');
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/hook`;
    try {
      const env = { FREECRAWL_SLACK_WEBHOOK_URL: url };
      const fired = await runAsync(['check', '--project', project, '--rules', failRules, '--notify', 'slack', '--json'], env);
      expect(fired.status).toBe(1);
      expect(posts).toHaveLength(1);
      expect(JSON.parse(posts[0] ?? '').text).toContain('drop');
      // The alert names the site, so two projects in one channel can be told apart.
      expect(JSON.parse(posts[0] ?? '').text).toContain(`FreeCrawl alert for ${START}: `);
      expect(JSON.parse(fired.stdout).notified[0]).toMatchObject({ channel: 'slack', ok: true });
      await runAsync(['check', '--project', project, '--rules', passRules, '--notify', 'slack', '--json'], env);
      expect(posts).toHaveLength(1);
      // A failed delivery never changes the gate result.
      const dead = await runAsync(['check', '--project', project, '--rules', warnRules, '--notify', 'slack', '--json'], { FREECRAWL_SLACK_WEBHOOK_URL: 'http://127.0.0.1:1/x' });
      expect(dead.status).toBe(0);
      expect(JSON.parse(dead.stdout).notified[0].ok).toBe(false);
    } finally {
      server.close();
    }
  });
  it('missing env var: exit 2 naming the variable only', () => {
    const r = run(['check', '--project', project, '--rules', passRules, '--notify', 'telegram', '--json'], {
      FREECRAWL_TELEGRAM_BOT_TOKEN: 'secret-token-123',
      FREECRAWL_TELEGRAM_CHAT_ID: '',
    });
    expect(r.status).toBe(2);
    expect(JSON.parse(r.stdout).error).toContain('FREECRAWL_TELEGRAM_CHAT_ID');
    expect(r.stdout).not.toContain('secret-token-123');
    expect(run(['check', '--project', project, '--rules', passRules, '--notify', 'carrier-pigeon']).status).toBe(2);
  });
  it('SIGINT: exit 130', async () => {
    // A hung webhook keeps the process alive; its request arriving is the signal that the CLI is
    // in the notify step, however slow the machine starts it.
    let gotRequest!: () => void;
    const requested = new Promise<void>((r) => (gotRequest = r));
    const server = http.createServer(() => gotRequest());
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/h`;
    const p = spawn(process.execPath, [CLI, 'check', '--project', project, '--rules', failRules, '--notify', 'webhook'], {
      env: { ...process.env, FREECRAWL_WEBHOOK_URL: url },
    });
    try {
      const code = new Promise<number | null>((r) => p.on('close', r));
      await requested;
      p.kill('SIGINT');
      expect(await code).toBe(130);
    } finally {
      if (p.exitCode === null && p.signalCode === null) p.kill('SIGKILL');
      server.closeAllConnections();
      server.close();
    }
  }, 120_000);
});
