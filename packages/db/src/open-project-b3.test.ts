import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openProject, packProject, ProjectDb } from './index.js';

let dir: string;
let tmp: string;
const savedTmp = process.env['TMPDIR'];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'b3-'));
  // Working copies go to the temp directory; a private one keeps the
  // listing exact.
  tmp = join(dir, 'tmp');
  mkdirSync(tmp);
  process.env['TMPDIR'] = tmp;
});
afterEach(() => {
  if (savedTmp === undefined) delete process.env['TMPDIR'];
  else process.env['TMPDIR'] = savedTmp;
  rmSync(dir, { recursive: true, force: true });
});

/** A bare project with one URL, and the same packed as the desktop saves it. */
async function fixture(): Promise<{ bare: string; archive: string }> {
  const bare = join(dir, 'bare.seoproject');
  const db = new ProjectDb(bare);
  (db as unknown as { db: { exec(s: string): void } }).db.exec(
    `INSERT INTO urls (url, status_code, is_external) VALUES ('https://ex.com/', 200, 0)`,
  );
  db.walCheckpoint();
  db.close();
  const archive = join(dir, 'saved.seoproject');
  await packProject(bare, archive);
  return { bare, archive };
}

const workingCopies = () => readdirSync(tmp).filter((n) => n.startsWith('freecrawl-cli-'));

describe('openProject (B3)', () => {
  it('opens a bare project in place and a desktop-saved one from a working copy', async () => {
    const { bare, archive } = await fixture();
    const a = await openProject(bare, { readOnly: true });
    expect(a.db.countUrls()).toBe(1);
    expect(workingCopies()).toEqual([]);
    a.dispose();
    const b = await openProject(archive, { readOnly: true });
    expect(b.db.countUrls()).toBe(1);
    expect(workingCopies()).toHaveLength(1);
    b.dispose();
    expect(workingCopies()).toEqual([]);
  });

  it('read-only: a write fails and dispose never repacks', async () => {
    const { archive } = await fixture();
    const before = readdirSync(dir);
    const p = await openProject(archive, { readOnly: true });
    expect(() => p.db.setMeta('x', 'y')).toThrow();
    p.dispose();
    expect(readdirSync(dir)).toEqual(before);
  });

  it('registers its cleanup in the given set until dispose', async () => {
    const { archive } = await fixture();
    const cleanups = new Set<() => void>();
    const p = await openProject(archive, { readOnly: true, cleanups });
    expect(cleanups.size).toBe(1);
    for (const c of cleanups) c();
    expect(cleanups.size).toBe(0);
    expect(workingCopies()).toEqual([]);
    expect(p).toBeDefined();
  });

  it('removes a working copy whose owner is gone and keeps a live one', async () => {
    const { archive } = await fixture();
    const dead = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], {
      encoding: 'utf8',
    }).stdout;
    const owner = (pid: number) => JSON.stringify({ pid, startedAt: new Date().toISOString(), id: String(pid) });
    mkdirSync(join(tmp, 'freecrawl-cli-dead'));
    writeFileSync(join(tmp, 'freecrawl-cli-dead', 'owner.lock'), owner(Number(dead)));
    mkdirSync(join(tmp, 'freecrawl-cli-live'));
    writeFileSync(join(tmp, 'freecrawl-cli-live', 'owner.lock'), owner(process.pid));
    const p = await openProject(archive, { readOnly: true });
    expect(existsSync(join(tmp, 'freecrawl-cli-dead'))).toBe(false);
    expect(existsSync(join(tmp, 'freecrawl-cli-live'))).toBe(true);
    p.dispose();
  });

  it('refuses a file that is no project', async () => {
    const junk = join(dir, 'junk.seoproject');
    writeFileSync(junk, 'not a database at all');
    await expect(openProject(junk, { readOnly: true })).rejects.toThrow(/not a FreeCrawl project/);
  });
});
