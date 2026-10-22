import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isDiskFull } from './work-dir.js';
import {
  asNoSpaceError,
  checkFreeSpace,
  openProject,
  packProject,
  ProjectDb,
  sweepWorkingFolder,
  workDirProblem,
  workDirProblemText,
} from './index.js';

let dir: string;
let tmp: string;
const savedTmp = process.env['TMPDIR'];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'fc-b31-'));
  // A private temp folder shows whether anything still lands there.
  tmp = join(dir, 'tmp');
  mkdirSync(tmp);
  process.env['TMPDIR'] = tmp;
});
afterEach(() => {
  if (savedTmp === undefined) delete process.env['TMPDIR'];
  else process.env['TMPDIR'] = savedTmp;
  chmodSync(dir, 0o700);
  rmSync(dir, { recursive: true, force: true });
});

describe('workDirProblem (B31)', () => {
  it('accepts a local folder and makes its FreeCrawl-work subfolder', () => {
    expect(workDirProblem(dir)).toBeNull();
    expect(readdirSync(join(dir, 'FreeCrawl-work'))).toEqual([]);
  });

  it('refuses a network path, a missing folder and a file', () => {
    expect(workDirProblem('\\\\server\\share\\crawls')).toBe('network');
    expect(workDirProblem('//server/share/crawls')).toBe('network');
    expect(workDirProblem(join(dir, 'nope'))).toBe('missing');
    writeFileSync(join(dir, 'file'), '');
    expect(workDirProblem(join(dir, 'file'))).toBe('not-a-folder');
    expect(workDirProblemText('missing')).toBe('the folder does not exist');
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('refuses a folder it cannot write to', () => {
    const ro = join(dir, 'ro');
    mkdirSync(ro);
    chmodSync(ro, 0o500);
    try {
      expect(workDirProblem(ro)).toBe('not-writable');
    } finally {
      chmodSync(ro, 0o700);
    }
  });
});

describe('sweepWorkingFolder (B31)', () => {
  it('removes only FreeCrawl working files, by exact name, and keeps live ones', () => {
    const names = [
      'work-12-1.seoproject',
      'work-12-1.seoproject-wal',
      'work-12-2.seoproject',
      'agent-3-12.seoproject-shm',
      'freecrawl-save-12-5-6.seoproject',
      // The user's own files that only look alike.
      'work-plan.xlsx',
      'work-12-1.seoproject.bak',
      'site.seoproject',
      'agent-notes.seoproject',
    ];
    for (const n of names) writeFileSync(join(dir, n), '');
    sweepWorkingFolder(dir, (p) => p === join(dir, 'work-12-2.seoproject'));
    expect(readdirSync(dir).sort()).toEqual(
      ['agent-notes.seoproject', 'site.seoproject', 'tmp', 'work-12-1.seoproject.bak', 'work-12-2.seoproject', 'work-plan.xlsx'].sort(),
    );
  });
});

describe('free space (B31)', () => {
  const statfs = (freeGb: number) => () => ({ bavail: freeGb * 1024, bsize: 1024 ** 2 });

  it('refuses a step with the folder, the free and the needed size', () => {
    expect(() => checkFreeSpace('/big', 3 * 1024 ** 3, statfs(1.5))).toThrow(
      'Not enough free space in /big: 1.5 GB free, 3.0 GB needed.',
    );
    expect(() => checkFreeSpace('/big', 1024 ** 3, statfs(1.5))).not.toThrow();
  });

  it('turns a full-disk write into that message and leaves other errors alone', () => {
    const full = Object.assign(new Error('write failed'), { code: 'ENOSPC' });
    expect(isDiskFull(full)).toBe(true);
    expect(isDiskFull(new Error('SqliteError: database or disk is full'))).toBe(true);
    expect((asNoSpaceError(full, dir, 10) as Error).message).toMatch(/^Not enough free space in .*: .* GB free, 0\.0 GB needed\.$/);
    const other = new Error('EACCES');
    expect(asNoSpaceError(other, dir, 10)).toBe(other);
  });
});

/** A desktop-saved project with one URL. */
async function archive(): Promise<string> {
  const bare = join(dir, 'bare.seoproject');
  const db = new ProjectDb(bare);
  (db as unknown as { db: { exec(s: string): void } }).db.exec(
    `INSERT INTO urls (url, status_code, is_external) VALUES ('https://ex.com/', 200, 0)`,
  );
  db.walCheckpoint();
  db.close();
  const path = join(dir, 'saved.seoproject');
  await packProject(bare, path);
  return path;
}

describe('openProject with a working folder (B31)', () => {
  it('unpacks into <folder>/FreeCrawl-work, not the temp folder', async () => {
    const path = await archive();
    const work = join(dir, 'big-disk');
    mkdirSync(work);
    const p = await openProject(path, { forWrite: true, workDir: work });
    expect(p.db.countUrls()).toBe(1);
    expect(readdirSync(join(work, 'FreeCrawl-work'))).toEqual([expect.stringMatching(/^freecrawl-cli-/)]);
    expect(readdirSync(tmp)).toEqual([]);
    await p.save();
    p.dispose();
    expect(readdirSync(join(work, 'FreeCrawl-work'))).toEqual([]);
    expect(existsSync(`${path}.part`)).toBe(false);
  });

  it('leaves a user file in the working folder alone', async () => {
    const path = await archive();
    const work = join(dir, 'big-disk');
    mkdirSync(join(work, 'FreeCrawl-work'), { recursive: true });
    mkdirSync(join(work, 'FreeCrawl-work', 'freecrawl-cli-notes'));
    writeFileSync(join(work, 'work-plan.xlsx'), 'x');
    const p = await openProject(path, { readOnly: true, workDir: work });
    p.dispose();
    expect(readdirSync(join(work, 'FreeCrawl-work'))).toEqual(['freecrawl-cli-notes']);
    expect(existsSync(join(work, 'work-plan.xlsx'))).toBe(true);
  });
});
