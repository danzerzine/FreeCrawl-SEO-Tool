import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ProjectDb } from '@freecrawl/db';
import { CLI_ONLY_EXPORTS, runSavedExportSet, saveDesktopExportSet } from './export-sets.js';

// B42: `pdf-text` loads unpdf, which is not verified in Electron, so the
// desktop skips it like pdfs and screenshots (B154 moved pdfs and screenshots into the app; pdf-text waits for the Electron check).
let dir: string;
let db: ProjectDb;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-clionly-b42-'));
  db = new ProjectDb(path.join(dir, 'p.seoproject'));
});
afterAll(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('pdf-text is a command-line-only export', () => {
  it('is in CLI_ONLY_EXPORTS', () => {
    // B154 moved pdfs and screenshots into the app; pdf-text waits for the check of unpdf in the packaged app.
    expect([...CLI_ONLY_EXPORTS]).toEqual(['pdf-text']);
  });

  it('the desktop refuses to save a set with it', () => {
    expect(() => saveDesktopExportSet(db, { name: 'text', what: ['issues', 'pdf-text'] })).toThrow(
      /"pdf-text".*command line/s,
    );
  });

  it('a set saved by the CLI with pdf-text runs without it, reports why, and runs the other items', async () => {
    db.setMeta('exportSets', JSON.stringify([{ name: 'cli', what: ['issues', 'pdf-text'] }]));
    const out = path.join(dir, 'set-out');
    const r = await runSavedExportSet(db, out, 'cli', {});
    expect(r.files.map((f) => path.basename(f.path))).toContain('issues-summary.csv');
    expect(fs.existsSync(path.join(out, 'pdf-text.jsonl'))).toBe(false);
    expect(fs.existsSync(path.join(out, 'pdfs'))).toBe(false);
    expect(r.errors.map((e) => e.error)).toContain(
      '"pdf-text" is only available in the command line for now (freecrawl export --what pdf-text); the desktop app skipped it.',
    );
  });
});
