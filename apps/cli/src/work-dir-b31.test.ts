import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { packProject, ProjectDb } from '@freecrawl/db';

// Drives the built CLI as a process (`npx tsc -b` and `npm run build:cli` first).
const CLI = join(__dirname, '../dist/index.js');

let dir: string;
let tmp: string;
let work: string;
let project: string;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'fc-b31-'));
  tmp = join(dir, 'tmp');
  work = join(dir, 'big-disk');
  mkdirSync(tmp);
  mkdirSync(work);
  const bare = join(dir, 'bare.db');
  const db = new ProjectDb(bare);
  (db as unknown as { db: { exec(s: string): void } }).db.exec(
    `INSERT INTO urls (url, status_code, is_external) VALUES ('https://ex.com/', 200, 0)`,
  );
  db.walCheckpoint();
  db.close();
  project = join(dir, 'saved.seoproject');
  await packProject(bare, project);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** A working copy left by a process that is gone, in `base`. */
function orphan(base: string): string {
  const dead = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], {
    encoding: 'utf8',
  }).stdout;
  const copy = join(base, 'freecrawl-cli-dead00');
  mkdirSync(copy, { recursive: true });
  writeFileSync(join(copy, 'owner.lock'), JSON.stringify({ pid: Number(dead), startedAt: new Date().toISOString(), id: dead }));
  return copy;
}

function run(args: string[], env: NodeJS.ProcessEnv = {}): Promise<{ status: number | null; stderr: string }> {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [CLI, ...args], { env: { ...process.env, TMPDIR: tmp, ...env } });
    let stderr = '';
    p.stderr.on('data', (d) => (stderr += d));
    p.on('exit', (status) => resolve({ status, stderr }));
  });
}

describe('working folder for the CLI (B31)', () => {
  // The run sweeps orphaned copies where it puts its own, so the swept
  // folder shows where that was.
  it.each([
    ['--work-dir', (w: string) => [['--work-dir', w], {}] as const],
    ['FREECRAWL_WORK_DIR', (w: string) => [[], { FREECRAWL_WORK_DIR: w }] as const],
  ])('%s puts the working copy in <folder>/FreeCrawl-work, not the temp folder', async (_name, opt) => {
    const inWork = orphan(join(work, 'FreeCrawl-work'));
    const inTmp = orphan(tmp);
    const [flags, env] = opt(work);
    const r = await run(['export', '--project', project, '--out', join(dir, 'out'), '--what', 'issues', ...flags], env);
    expect(r.stderr).not.toContain('Cannot use');
    expect(r.status).toBe(0);
    expect(existsSync(inWork)).toBe(false);
    expect(existsSync(inTmp)).toBe(true);
  });

  it('without one, the temp folder as before', async () => {
    const inTmp = orphan(tmp);
    const r = await run(['export', '--project', project, '--out', join(dir, 'out'), '--what', 'issues']);
    expect(r.status).toBe(0);
    expect(existsSync(inTmp)).toBe(false);
    expect(existsSync(join(work, 'FreeCrawl-work'))).toBe(false);
  });

  it('a folder it cannot use exits 2 and says why', async () => {
    const missing = join(dir, 'unplugged');
    const flag = await run(['compare', project, project, '--work-dir', missing]);
    expect(flag.status).toBe(2);
    expect(flag.stderr).toContain(`Cannot use --work-dir ${missing}: the folder does not exist.`);
    const env = await run(['compare', project, project], { FREECRAWL_WORK_DIR: '//nas/crawls' });
    expect(env.status).toBe(2);
    expect(env.stderr).toContain(
      'Cannot use FREECRAWL_WORK_DIR //nas/crawls: a network folder, where the project database is not safe.',
    );
  });
});
