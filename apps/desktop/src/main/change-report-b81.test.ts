import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { ProjectDb } from '@freecrawl/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { keepPreviousCrawl, previousCrawlPath, runChangeReport } from './change-report.js';

const CLI = path.resolve(__dirname, '../../../cli/dist/index.js');
let dir: string;
let server: http.Server;
let base: string;
let project: string;
// The second crawl sees a new title on /p/1.
let secondCrawl = false;

function crawl(): Promise<number | null> {
  const child = spawn(process.execPath, [CLI, base, '--no-robots', '--db', project, '--json'], { stdio: 'ignore' });
  return new Promise((r) => child.on('exit', (c) => r(c)));
}

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-b81-'));
  server = http.createServer((req, res) => {
    const url = req.url ?? '/';
    const title = url === '/p/1' && secondCrawl ? 'Renamed' : `Page ${url}`;
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(
      `<html><head><title>${title}</title></head><body>${[0, 1, 2].map((k) => `<a href="/p/${k}">p${k}</a>`).join('')}</body></html>`,
    );
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  project = path.join(dir, 'site.seoproject');
  await crawl();
  if (!fs.existsSync(project)) throw new Error('fixture crawl wrote no project');
}, 90000);

afterAll(async () => {
  await new Promise((r) => server.close(r));
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('scheduled change report (B81)', () => {
  it('the previous copy sits next to the project as <name>.previous.seoproject', () => {
    expect(previousCrawlPath(project)).toBe(path.join(dir, 'site.previous.seoproject'));
  });

  it('copies the saved project, crawls again, and reports what changed into the folder', async () => {
    await keepPreviousCrawl(project);
    const previous = previousCrawlPath(project);
    expect(fs.readFileSync(previous).equals(fs.readFileSync(project))).toBe(true);

    secondCrawl = true;
    await crawl();
    const out = path.join(dir, 'report');
    fs.mkdirSync(out);
    const db = new ProjectDb(project);
    try {
      const summary = await runChangeReport(previous, db, out);
      expect(summary?.counts.title).toBe(1);
      expect(fs.existsSync(path.join(out, 'compare-summary.json'))).toBe(true);
      expect(fs.readFileSync(path.join(out, 'compare-title.csv'), 'utf8')).toContain('Renamed');
    } finally {
      db.close();
    }

    // The next scheduled run replaces the copy with the file as it is now.
    await keepPreviousCrawl(project);
    expect(fs.readFileSync(previous).equals(fs.readFileSync(project))).toBe(true);
  }, 90000);

  it('no previous copy: no report, no error', async () => {
    const db = new ProjectDb(project);
    try {
      expect(await runChangeReport(path.join(dir, 'missing.seoproject'), db, null)).toBeNull();
    } finally {
      db.close();
    }
  });
});
