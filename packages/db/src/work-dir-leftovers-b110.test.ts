import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { saveTempPid, sweepCrashLeftovers, sweepWorkingFolder } from './work-dir.js';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 9, 23, 12, 0, 0);
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'fc-b110-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** A file (or a folder with one file in it) whose mtime is `ageMs` before NOW. */
function make(name: string, ageMs: number, asDir = false): string {
  const full = join(dir, name);
  const t = new Date(NOW - ageMs);
  if (asDir) {
    mkdirSync(full);
    const inner = join(full, 'copy.seoproject');
    writeFileSync(inner, 'x');
    utimesSync(inner, t, t);
  } else {
    writeFileSync(full, 'x');
  }
  utimesSync(full, t, t);
  return full;
}

describe('crash leftovers (B152, B110)', () => {
  it('recognises the SQLite journal of a save snapshot', () => {
    expect(saveTempPid('freecrawl-save-4242-3-99.seoproject-journal')).toBe(4242);
  });

  it('removes an old journal of a dead save, keeps one of this process', () => {
    make('freecrawl-save-4242-3-99.seoproject-journal', 5 * DAY);
    make('freecrawl-save-7-1-1.seoproject-journal', 5 * DAY);
    sweepWorkingFolder(dir, (p) => p.includes('freecrawl-save-7-'));
    expect(existsSync(join(dir, 'freecrawl-save-4242-3-99.seoproject-journal'))).toBe(false);
    expect(existsSync(join(dir, 'freecrawl-save-7-1-1.seoproject-journal'))).toBe(true);
  });

  it('removes unpack .part files and compare copies older than a day', () => {
    make('work-12-1.seoproject.part', 2 * DAY);
    make('agent-3-12.seoproject.part', 2 * DAY);
    make('freecrawl-compare-aB3dE9', 2 * DAY, true);
    const removed = sweepCrashLeftovers(dir, { now: NOW });
    expect(removed.sort()).toEqual(
      ['agent-3-12.seoproject.part', 'freecrawl-compare-aB3dE9', 'work-12-1.seoproject.part'].sort(),
    );
    expect(existsSync(join(dir, 'freecrawl-compare-aB3dE9'))).toBe(false);
  });

  it('keeps anything younger than a day, also a compare folder whose copy was written lately', () => {
    make('work-12-1.seoproject.part', DAY / 2);
    // The folder itself is old; the copy inside is still growing.
    const cmp = make('freecrawl-compare-zzzzzz', 3 * DAY, true);
    const t = new Date(NOW - 60_000);
    utimesSync(join(cmp, 'copy.seoproject'), t, t);
    expect(sweepCrashLeftovers(dir, { now: NOW })).toEqual([]);
    expect(existsSync(join(dir, 'work-12-1.seoproject.part'))).toBe(true);
    expect(existsSync(cmp)).toBe(true);
  });

  it('never touches a project or other look-alike files, however old', () => {
    const names = [
      'site.seoproject',
      'site.seoproject.part',
      'work-plan.xlsx.part',
      'freecrawl-compare-notes.txt',
      'freecrawl-compare-toolongname',
      'work-12-1.seoproject',
    ];
    for (const n of names) make(n, 30 * DAY);
    expect(sweepCrashLeftovers(dir, { now: NOW })).toEqual([]);
    for (const n of names) expect(existsSync(join(dir, n))).toBe(true);
  });

  it('honours a custom age and a missing folder', () => {
    make('work-1-1.seoproject.part', 2 * 60 * 60 * 1000);
    expect(sweepCrashLeftovers(dir, { now: NOW, minAgeMs: 60 * 60 * 1000 })).toEqual([
      'work-1-1.seoproject.part',
    ]);
    expect(sweepCrashLeftovers(join(dir, 'nope'), { now: NOW })).toEqual([]);
  });
});
