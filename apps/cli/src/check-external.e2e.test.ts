import { afterAll, describe, it, expect } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { killAllChildren, spawnTracked } from './test-proc.js';

function listen(hits: string[], body: (port: number) => string): Promise<{ s: Server; port: number }> {
  return new Promise((resolve) => {
    const s = createServer((req, res) => {
      hits.push(`${req.method} ${req.url}`);
      res.setHeader('content-type', 'text/html');
      res.end(body((s.address() as { port: number }).port));
    });
    s.listen(0, '127.0.0.1', () => resolve({ s, port: (s.address() as { port: number }).port }));
  });
}

// Servers and temp dirs of a run, closed in afterAll too: a test that times out never reaches run()'s finally.
const open: Array<() => void> = [];
afterAll(() => {
  killAllChildren();
  for (const f of open.splice(0)) f();
});

async function run(extra: string[]): Promise<string[]> {
  const extHits: string[] = [];
  const ext = await listen(extHits, () => '<html><body>ext</body></html>');
  const site = await listen([], () =>
    `<html><head><title>t</title><meta property="og:image" content="http://localhost:${ext.port}/og.png"></head><body><a href="http://localhost:${ext.port}/x">ext</a>` +
    `<img src="http://localhost:${ext.port}/i.png" alt="i"></body></html>`);
  const dir = mkdtempSync(join(tmpdir(), 'b11-'));
  open.push(() => { site.s.close(); ext.s.close(); rmSync(dir, { recursive: true, force: true }); });
  try {
    await new Promise<void>((resolve) => {
      const p = spawnTracked(process.execPath, [join(__dirname, '../dist/index.js'), `http://127.0.0.1:${site.port}/`,
        '--db', join(dir, 'c.seoproject'), '--json', '--no-robots', ...extra], { stdio: 'ignore' });
      p.on('exit', () => resolve());
    });
  } finally {
    killAllChildren();
    site.s.close(); ext.s.close();
    rmSync(dir, { recursive: true, force: true });
  }
  return extHits;
}

describe('check external links (CLI e2e)', () => {
  it('off: zero requests to external host', async () => {
    expect(await run(['--no-check-external'])).toEqual([]);
  }, 180000);
  it('off wins over --external', async () => {
    expect(await run(['--external', '--no-check-external'])).toEqual([]);
  }, 180000);
  it('on (default): external link target requested once, external image probed', async () => {
    const hits = await run([]);
    expect(hits.filter((h) => h.endsWith(' /x'))).toHaveLength(1);
    expect(hits.some((h) => h.endsWith(' /i.png'))).toBe(true);
    expect(hits.some((h) => h.endsWith(' /og.png'))).toBe(true);
  }, 180000);
});
