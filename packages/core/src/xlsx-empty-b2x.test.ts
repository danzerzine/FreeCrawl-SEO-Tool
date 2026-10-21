import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ProjectDb } from '@freecrawl/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { exportTabular } from './tabular-export.js';

let dir: string;
let db: ProjectDb;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-b2x-'));
  db = new ProjectDb(path.join(dir, 'p.seoproject'));
});
afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('B2x: empty size-dependent dataset', () => {
  for (const format of ['csv', 'xlsx'] as const) {
    it(`${format} writes no file and reports why`, async () => {
      const out = path.join(dir, `h.${format}`);
      const res = await exportTabular(db, out, {
        format,
        sections: [{ label: 'Response Headers', dataset: 'response-headers' }],
        columns: ['url', 'name', 'value'],
      });
      expect(res.rowsWritten).toBe(0);
      expect(res.files).toEqual([]);
      expect(fs.existsSync(out)).toBe(false);
      expect(res.skipped?.[0]?.reason).toMatch(/No response headers/);
    });
  }
});
