import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ProjectDb } from '@freecrawl/db';
import { listExportSets } from '@freecrawl/core';
import { runSavedExportSet, saveDesktopExportSet } from './export-sets.js';
import { runScheduledExport } from './scheduled-export.js';

// M10 review round 1 (std M4 / spec M5): the PDF and screenshot exports have
// no desktop options yet, so they stay command-line only.
let dir: string;
let db: ProjectDb;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-clionly-'));
  db = new ProjectDb(path.join(dir, 'p.seoproject'));
});
afterAll(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('desktop export sets and schedules leave out the CLI-only exports', () => {
  it('saving a set that holds pdfs or screenshots is refused with a message, nothing saved', () => {
    expect(() => saveDesktopExportSet(db, { name: 'media', what: ['issues', 'pdfs'] })).toThrow(
      /"pdfs".*command line/s,
    );
    expect(() => saveDesktopExportSet(db, { name: 'media', what: ['screenshots'] })).toThrow(/"screenshots"/);
    expect(listExportSets(db)).toEqual([]);
    expect(saveDesktopExportSet(db, { name: 'ok', what: ['issues'] }).what).toEqual(['issues']);
  });

  it('a set saved by the CLI with pdfs runs without them and reports why', async () => {
    // As `freecrawl export --save-set` stores it.
    db.setMeta('exportSets', JSON.stringify([{ name: 'cli', what: ['issues', 'pdfs', 'screenshots'] }]));
    const out = path.join(dir, 'set-out');
    const r = await runSavedExportSet(db, out, 'cli', {});
    expect(r.files.map((f) => path.basename(f.path))).toContain('issues-summary.csv');
    expect(fs.existsSync(path.join(out, 'pdfs'))).toBe(false);
    expect(r.errors.map((e) => e.error).join('\n')).toMatch(/"pdfs" is only available in the command line/);
    expect(r.errors.map((e) => e.error).join('\n')).toMatch(/"screenshots" is only available/);
  });

  it('a schedule running a set with only pdfs runs nothing for it and puts the reason in its errors', async () => {
    db.setMeta('exportSets', JSON.stringify([{ name: 'media', what: ['pdfs'] }]));
    const out = path.join(dir, 'sched-out');
    fs.mkdirSync(out);
    const r = await runScheduledExport(
      db,
      { export: 'set', exportSet: 'media', outputDir: dir, sheets: false, webhook: false },
      { exportDir: out, toolVersion: 'test', writePdf: async () => {} },
    );
    expect(r.files).toEqual([]);
    expect(r.errors.join('\n')).toMatch(/pdfs: "pdfs" is only available in the command line/);
    expect(fs.readdirSync(out)).toEqual([]);
  });
});
