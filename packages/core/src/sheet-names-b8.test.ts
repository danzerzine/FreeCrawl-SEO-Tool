import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import zlib from 'node:zlib';
import { DatabaseSync } from 'node:sqlite';
import { ProjectDb } from '@freecrawl/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { exportTabular } from './tabular-export.js';

/** Size knob: just over one sheet's 1,000,000-row cap. */
const QUEUE_ROWS = 1_000_001;

let dir: string;
let file: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-b8-'));
  file = path.join(dir, 'p.seoproject');
  new ProjectDb(file).close();
  const raw = new DatabaseSync(file);
  raw.exec(`
    INSERT INTO urls (id, url, is_external, status_code) VALUES (1,'https://ex.com/a',0,200);
    WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${QUEUE_ROWS})
    INSERT INTO crawl_queue (url) SELECT 'https://ex.com/q' || i FROM n;
  `);
  raw.close();
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

/** Sheet names from xl/workbook.xml (stored after the sheets, small). */
function sheetNames(xlsx: string): string[] {
  const buf = fs.readFileSync(xlsx);
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  let p = buf.readUInt32LE(eocd + 16);
  for (let i = 0; i < buf.readUInt16LE(eocd + 10); i++) {
    const csize = buf.readUInt32LE(p + 20);
    const nlen = buf.readUInt16LE(p + 28);
    const name = buf.toString('utf8', p + 46, p + 46 + nlen);
    if (name === 'xl/workbook.xml') {
      const local = buf.readUInt32LE(p + 42);
      const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
      const xml = zlib.inflateRawSync(buf.subarray(start, start + csize)).toString('utf8');
      return [...xml.matchAll(/<sheet name="([^"]*)"/g)].map((m) => m[1]!);
    }
    p += 46 + nlen + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32);
  }
  throw new Error('no workbook.xml');
}

describe('XLSX sheet names (B8)', () => {
  it('a continued sheet of a renamed section gets the next free number, not a second suffix', async () => {
    const db = new ProjectDb(file);
    const out = path.join(dir, 'q.xlsx');
    await exportTabular(db, out, {
      format: 'xlsx',
      columns: ['url'],
      sections: [
        { label: 'Queue', category: 'internal:all' },
        { label: 'Queue', dataset: 'crawl-queue', columns: ['url'] },
      ],
    });
    db.close();
    expect(sheetNames(out)).toEqual(['Queue', 'Queue (2)', 'Queue (3)']);
  }, 60_000);
});
