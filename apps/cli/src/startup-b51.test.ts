import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { nodeVersionProblem } from './startup.js';

// Drives the built CLI as a process (`npm run build:cli` first).
const DIST = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dist');
const BIN = path.join(DIST, 'bin.js');

describe('Node version check (B51)', () => {
  it.each([
    ['21.9.0', false],
    ['22.12.0', false],
    ['22.13.0', true],
    ['22.17.1', true],
    ['23.0.0', false],
    ['23.3.0', false],
    ['23.4.0', true],
    ['24.0.0', true],
  ])('%s is %s', (v, ok) => {
    const problem = nodeVersionProblem(v);
    if (ok) expect(problem).toBeNull();
    else expect(problem).toContain(v);
  });
});

describe('startup entry (B51)', () => {
  it('mutes only the SQLite ExperimentalWarning', () => {
    const startup = pathToFileURL(path.join(DIST, 'startup.js')).href;
    const script =
      `const m = await import(${JSON.stringify(startup)}); m.muteSqliteWarning();` +
      `process.emitWarning('SQLite is an experimental feature and might change at any time', 'ExperimentalWarning');` +
      `process.emitWarning('something else', 'DeprecationWarning');`;
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' });
    expect(r.status).toBe(0);
    expect(r.stderr).not.toContain('SQLite');
    expect(r.stderr).toContain('something else');
  });

  it('bin.js refuses an old Node before anything loads node:sqlite', () => {
    // A preload fakes the version; a static import of node:sqlite anywhere
    // in bin.js's graph would run before the check and the message would
    // never print.
    const fake = `data:text/javascript,Object.defineProperty(process.versions,'node',{value:'23.1.0'})`;
    const r = spawnSync(process.execPath, ['--import', fake, BIN, '--help'], { encoding: 'utf8', timeout: 20000 });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('FreeCrawl needs Node 22.13+');
    expect(r.stdout).toBe('');
  });

  it('bin.js --help runs the CLI with a clean stderr', () => {
    const r = spawnSync(process.execPath, [BIN, '--help'], { encoding: 'utf8', timeout: 20000 });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('--pid-file');
    expect(r.stderr).not.toContain('ExperimentalWarning');
  });
});

describe('--pid-file (B51)', () => {
  let dir: string;
  let server: http.Server;
  let base: string;
  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-pid-'));
    server = http.createServer((req, res) => {
      const m = /^\/p\/(\d+)$/.exec(req.url ?? '');
      const i = m ? Number(m[1]) : 0;
      // Slow enough that the crawl is still running when the file is read.
      setTimeout(() => {
        res.setHeader('content-type', 'text/html');
        res.end(`<html><head><title>p${i}</title></head><body><a href="/p/${i + 1}">n</a></body></html>`);
      }, 200);
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  });
  afterEach(async () => {
    await new Promise((r) => server.close(r));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('holds the crawler pid while it runs and is removed at exit', async () => {
    const pidFile = path.join(dir, 'crawl.pid');
    const child = spawn(process.execPath, [BIN, base, '--max', '12', '--no-robots', '--pid-file', pidFile,
      '--db', path.join(dir, 'p.seoproject')], { stdio: 'ignore' });
    const exited = new Promise<number | null>((r) => child.on('exit', (code) => r(code)));
    let seen: string | null = null;
    for (let i = 0; i < 50 && seen === null; i++) {
      await new Promise((r) => setTimeout(r, 100));
      if (fs.existsSync(pidFile)) seen = fs.readFileSync(pidFile, 'utf8').trim();
    }
    expect(seen).toBe(String(child.pid));
    await exited;
    expect(fs.existsSync(pidFile)).toBe(false);
  }, 30000);
});
