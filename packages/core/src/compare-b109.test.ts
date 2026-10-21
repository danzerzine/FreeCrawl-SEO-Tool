import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { detectProjectFormat, packProject, ProjectDb, unpackProject } from '@freecrawl/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openCompareProject } from './compare.js';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-b109-'));
});
afterEach(() => {
  if (fs.existsSync(path.join(dir, 'ro'))) fs.chmodSync(path.join(dir, 'ro'), 0o755);
  fs.rmSync(dir, { recursive: true, force: true });
});

/** A closed bare project with one page whose stored checks predate this build. */
function staleProject(name: string): string {
  const file = path.join(dir, `${name}.seoproject`);
  new ProjectDb(file).close();
  const raw = new DatabaseSync(file);
  raw.exec(`
    INSERT INTO urls (id, url, is_external, content_kind, status_code, indexability, title)
      VALUES (1, 'https://ex.com/a', 0, 'html', 200, 'indexable', NULL);
    UPDATE project_meta SET value = 'old' WHERE key = 'urlsIssuesVersion';
  `);
  raw.close();
  return file;
}

/** Whether a closed project file's stored checks are behind this build. */
async function storedStale(file: string): Promise<boolean> {
  const handle = await openCompareProjectRaw(file);
  try {
    return handle.issueMaterialisationStale();
  } finally {
    handle.close();
  }
}

/** Opens the file as it is on disk (a temp copy for an archive), without bringing anything current. */
async function openCompareProjectRaw(file: string): Promise<ProjectDb> {
  if (detectProjectFormat(file) !== 'archive') return new ProjectDb(file, { readOnly: true });
  const copy = path.join(dir, `raw-${Date.now()}.db`);
  await unpackProject(file, copy);
  return new ProjectDb(copy, { readOnly: true });
}

describe('openCompareProject saves the rebuilt checks once (B109)', () => {
  it('an archive: the rebuilt checks go back into the file, still an archive; the next open rebuilds nothing', async () => {
    const archive = path.join(dir, 'old.seoproject');
    await packProject(staleProject('src'), archive);
    expect(await storedStale(archive)).toBe(true);

    const first = await openCompareProject(archive);
    expect(first.rebuiltSaved).toBe(true);
    expect(first.db.issueMaterialisationStale()).toBe(false);
    first.dispose();

    expect(detectProjectFormat(archive)).toBe('archive');
    expect(await storedStale(archive)).toBe(false);
    const second = await openCompareProject(archive);
    expect(second.rebuiltSaved).toBe(false);
    second.dispose();
  });

  it('a bare project: saved back in place, still bare', async () => {
    const file = staleProject('bare');
    const first = await openCompareProject(file);
    expect(first.rebuiltSaved).toBe(true);
    first.dispose();
    expect(detectProjectFormat(file)).not.toBe('archive');
    expect(await storedStale(file)).toBe(false);
  });

  it('a file that cannot be written: compared from the rebuilt copy, the file left as it was', async () => {
    const archive = path.join(dir, 'ro', 'old.seoproject');
    fs.mkdirSync(path.dirname(archive));
    await packProject(staleProject('src'), archive);
    const bytes = fs.readFileSync(archive);
    fs.chmodSync(path.dirname(archive), 0o555);

    const handle = await openCompareProject(archive);
    expect(handle.rebuiltSaved).toBe(false);
    expect(handle.db.issueMaterialisationStale()).toBe(false);
    handle.dispose();

    fs.chmodSync(path.dirname(archive), 0o755);
    expect(fs.readFileSync(archive).equals(bytes)).toBe(true);
    expect(fs.readdirSync(path.dirname(archive))).toEqual(['old.seoproject']);
  });

  it('a bare project another process still writes: rebuilt in place through SQLite, the file stays whole', async () => {
    const file = staleProject('live');
    const writer = new DatabaseSync(file);
    writer.exec('PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0;');
    writer.exec(`INSERT INTO urls (id, url, is_external, content_kind, status_code, indexability)
      VALUES (2, 'https://ex.com/b', 0, 'html', 200, 'indexable')`);

    const handle = await openCompareProject(file);
    expect(handle.rebuiltSaved).toBe(true);
    expect(rowCount(handle.db)).toBe(2);
    handle.dispose();

    writer.close();
    const check = new DatabaseSync(file);
    expect(check.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' });
    expect(check.prepare('SELECT count(*) AS n FROM urls').get()).toEqual({ n: 2 });
    check.close();
  });

  it('a bare project that cannot be written: compared from a copy holding the rows still in its log', async () => {
    fs.mkdirSync(path.join(dir, 'ro'));
    const file = path.join(dir, 'ro', 'log.seoproject');
    fs.renameSync(staleProject('log'), file);
    const writer = new DatabaseSync(file);
    writer.exec('PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0;');
    writer.exec(`INSERT INTO urls (id, url, is_external, content_kind, status_code, indexability)
      VALUES (2, 'https://ex.com/b', 0, 'html', 200, 'indexable')`);
    fs.chmodSync(file, 0o444);
    const handle = await openCompareProject(file);
    try {
      expect(handle.rebuiltSaved).toBe(false);
      expect(handle.db.issueMaterialisationStale()).toBe(false);
      expect(rowCount(handle.db)).toBe(2);
    } finally {
      handle.dispose();
      writer.close();
      fs.chmodSync(file, 0o644);
    }
    expect(await storedStale(file)).toBe(true);
  });

  it('a bare project left with a log by a crashed crawl: the next open still finds it whole', async () => {
    const file = staleProject('crashed');
    const crash = `const { DatabaseSync } = require('node:sqlite');
      const db = new DatabaseSync(process.argv[1]);
      db.exec('PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0;');
      for (let i = 2; i <= 51; i++) db.exec("INSERT INTO urls (id, url, is_external, content_kind, status_code, indexability) VALUES (" + i + ", 'https://ex.com/" + i + "', 0, 'html', 200, 'indexable')");
      process.kill(process.pid, 'SIGKILL');`;
    spawnSync(process.execPath, ['-e', crash, file]);
    expect(fs.statSync(`${file}-wal`).size).toBeGreaterThan(0);

    const handle = await openCompareProject(file);
    expect(rowCount(handle.db)).toBe(51);
    handle.dispose();

    const check = new DatabaseSync(file);
    expect(check.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' });
    expect(check.prepare('SELECT count(*) AS n FROM urls').get()).toEqual({ n: 51 });
    check.close();
  });
});

function rowCount(db: ProjectDb): number {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return ((db as any).db.prepare('SELECT count(*) AS n FROM urls').get() as { n: number }).n;
}
