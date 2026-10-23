import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { ProjectDb } from '@freecrawl/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Ctrl-C ends `freecrawl export` through process.exit, whose exit hook
// removes the `.part` files being written. libuv still runs the file work
// queued in its thread pool after that hook, before the process ends: a
// `.part` whose create was still queued (a busy pool, a loaded machine)
// came back after the cleanup. The child makes the pool busy on purpose.
// Needs `npx tsc -b` first: the child imports the built packages.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const CHILD = path.join(HERE, 'export-interrupt-child-b118.mjs');
const missingBuild = ['../dist/url-files-pass.js', '../../db/dist/index.js']
  .map((p) => path.resolve(HERE, p))
  .filter((p) => !fs.existsSync(p));
if (missingBuild.length > 0) {
  console.warn(`B118 interrupt test skipped: build output missing (${missingBuild.join(', ')}); run \`npx tsc -b\` first.`);
}

let dir: string;
let project: string;
beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-b118-'));
  project = path.join(dir, 'p.seoproject');
  new ProjectDb(project).close();
  const raw = new DatabaseSync(project);
  raw.exec(`INSERT INTO urls (id, url, is_external, status_code) VALUES
    (1,'https://ex.com/a',0,200),(2,'https://ex.com/b',0,404);`);
  raw.close();
});
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('B118 export interrupted by process.exit', () => {
  it.skipIf(missingBuild.length > 0)('leaves no .part file of the shared urls pass, even with the thread pool busy', () => {
    const out = path.join(dir, 'out');
    const r = spawnSync(process.execPath, [CHILD, project, out, '20'], {
      encoding: 'utf8',
      timeout: 60_000,
      env: { ...process.env, UV_THREADPOOL_SIZE: '1' },
    });
    expect(r.status, r.stderr).toBe(130);
    const left = fs.existsSync(out) ? fs.readdirSync(out).filter((f) => f.endsWith('.part')) : [];
    expect(left).toEqual([]);
  }, 90_000);
});
