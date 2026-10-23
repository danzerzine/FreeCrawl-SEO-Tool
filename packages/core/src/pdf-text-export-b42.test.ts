import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ProjectDb } from '@freecrawl/db';
import { parseExportWhat, runExportItems } from './export-items.js';

// B42: `pdf-text` as a --what entry. The downloads themselves are covered by apps/cli/src/pdf-text-b42.test.ts.
let dir: string;
let db: ProjectDb;
beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-b42-core-'));
  db = new ProjectDb(path.join(dir, 'p.seoproject'));
});
afterAll(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('pdf-text in --what', () => {
  it('parses as its own item', () => {
    expect(parseExportWhat('pdf-text')).toEqual([{ kind: 'pdf-text', name: 'pdf-text' }]);
  });

  it('is not part of bulk', () => {
    expect(parseExportWhat('bulk')).toEqual([{ kind: 'bulk', name: 'bulk' }]);
  });

  it('an interrupted run (cut at "Exporting pdf-text…") leaves no manifest', async () => {
    const out = path.join(dir, 'cut');
    fs.mkdirSync(out);
    await expect(
      runExportItems(db, out, parseExportWhat('pdf-text'), {
        onProgress: (line) => {
          if (line === 'Exporting pdf-text…') throw new Error('interrupted');
        },
      }),
    ).rejects.toThrow('interrupted');
    expect(fs.existsSync(path.join(out, 'manifest.json'))).toBe(false);
  });
});
