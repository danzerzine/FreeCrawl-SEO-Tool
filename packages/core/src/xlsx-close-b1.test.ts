import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ProjectDb } from '@freecrawl/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** Size knob: issue rows, enough for several 256 KB worksheet chunks. */
const ROWS = 40_000;

// The disk is the boundary: a write that fails mid-workbook (disk full).
const failWrites = { after: Infinity };
vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...real,
    open: async (...args: Parameters<typeof real.open>) => {
      const fh = await real.open(...args);
      let writes = 0;
      const write = fh.write.bind(fh) as (...a: unknown[]) => Promise<unknown>;
      (fh as unknown as { write: unknown }).write = (...a: unknown[]) => {
        if (++writes > failWrites.after) {
          return Promise.reject(Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' }));
        }
        return write(...a);
      };
      return fh;
    },
  };
});

const { exportTabular } = await import('./tabular-export.js');

let dir: string;
let file: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-b1-'));
  file = path.join(dir, 'p.seoproject');
  new ProjectDb(file).close();
  const raw = new DatabaseSync(file);
  raw.exec('BEGIN');
  const ins = raw.prepare('INSERT INTO urls (id, url, status_code) VALUES (?, ?, 200)');
  const iss = raw.prepare('INSERT INTO urls_issues (url_id, issue_key) VALUES (?, ?)');
  for (let i = 1; i <= ROWS; i++) {
    ins.run(i, `https://ex.com/section-${i % 97}/page-${i}-${(i * 7919) % 100003}`);
    iss.run(i, 'issues:title-missing');
  }
  raw.exec('COMMIT');
  raw.close();
});

afterEach(() => {
  failWrites.after = Infinity;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('XLSX export that fails mid-sheet (B1)', () => {
  it('releases the dataset query: the project can be checkpointed afterwards', async () => {
    const db = new ProjectDb(file);
    failWrites.after = 3;
    await expect(
      exportTabular(db, path.join(dir, 'out.xlsx'), {
        format: 'xlsx',
        columns: ['url', 'issueKey'],
        sections: [{ label: 'Issues', dataset: 'issues-long' }],
      }),
    ).rejects.toThrow(/ENOSPC/);
    failWrites.after = Infinity;
    // Another connection writes, then a full checkpoint: an open read on the
    // export's connection keeps its snapshot and the checkpoint stays busy.
    const other = new DatabaseSync(file);
    other.exec("INSERT INTO project_meta (key, value) VALUES ('b1', 'x')");
    const res = other.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get() as { busy: number };
    other.close();
    db.close();
    expect(res.busy).toBe(0);
  }, 60_000);
});
