import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ProjectDb } from '@freecrawl/db';
import { listExportSets } from '@freecrawl/core';
import { runSavedExportSet, saveDesktopExportSet } from './export-sets.js';
import { runScheduledExport } from './scheduled-export.js';

// M10 review round 1 (std M4 / spec M5): a command-line-only export stays out
// of desktop sets and schedules. Since B154 that is `pdf-text` alone (the PDF
// files and screenshots run in the app: export-media-b154.test.ts).
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
  it('saving a set that holds pdf-text is refused with a message, nothing saved', () => {
    expect(() => saveDesktopExportSet(db, { name: 'media', what: ['issues', 'pdf-text'] })).toThrow(
      /"pdf-text".*command line/s,
    );
    expect(listExportSets(db)).toEqual([]);
    expect(saveDesktopExportSet(db, { name: 'ok', what: ['issues'] }).what).toEqual(['issues']);
  });

  it('a CLI-saved set with pdf-text can be saved again from the editor; its CLI-only token stays, a new one is refused', () => {
    db.setMeta('exportSets', JSON.stringify([{ name: 'cli2', what: ['issues', 'pdf-text'] }]));
    const saved = saveDesktopExportSet(db, { name: 'cli2', what: ['issues', 'tab:redirects', 'pdf-text'] });
    expect(saved.what).toEqual(['issues', 'tab:redirects', 'pdf-text']);
    expect(() => saveDesktopExportSet(db, { name: 'cli3', what: ['issues', 'pdf-text'] })).toThrow(/"pdf-text"/);
    db.setMeta('exportSets', JSON.stringify([]));
  });

  it('a set saved by the CLI with pdf-text runs without it and reports why', async () => {
    // As `freecrawl export --save-set` stores it.
    db.setMeta('exportSets', JSON.stringify([{ name: 'cli', what: ['issues', 'pdf-text'] }]));
    const out = path.join(dir, 'set-out');
    const r = await runSavedExportSet(db, out, 'cli', {});
    expect(r.files.map((f) => path.basename(f.path))).toContain('issues-summary.csv');
    expect(fs.existsSync(path.join(out, 'pdfs'))).toBe(false);
    expect(r.errors.map((e) => e.error).join('\n')).toMatch(/"pdf-text" is only available in the command line/);
  });

  it('a schedule running a set with only pdf-text runs nothing for it and puts the reason in its errors', async () => {
    db.setMeta('exportSets', JSON.stringify([{ name: 'media', what: ['pdf-text'] }]));
    const out = path.join(dir, 'sched-out');
    fs.mkdirSync(out);
    const r = await runScheduledExport(
      db,
      { export: 'set', exportSet: 'media', outputDir: dir, sheets: false, webhook: false },
      { exportDir: out, toolVersion: 'test', writePdf: async () => {} },
    );
    expect(r.files).toEqual([]);
    expect(r.errors.join('\n')).toMatch(/pdf-text: "pdf-text" is only available in the command line/);
    expect(fs.readdirSync(out)).toEqual([]);
  });
});
