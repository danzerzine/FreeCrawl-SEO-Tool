import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import zlib from 'node:zlib';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ProjectDb } from '@freecrawl/db';
import { exportGrid, exportTabular } from './tabular-export.js';

/** Rows for the split test: just over one sheet's 1,000,000-row cap. */
const SPLIT_ROWS = 1_200_000;

/** Minimal zip reader: central directory → inflated entries. */
function readZip(file: string): Map<string, string> {
  const buf = fs.readFileSync(file);
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = new Map<string, string>();
  for (let i = 0; i < count; i++) {
    expect(buf.readUInt32LE(p)).toBe(0x02014b50);
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const csize = buf.readUInt32LE(p + 20);
    const usize = buf.readUInt32LE(p + 24);
    const nlen = buf.readUInt16LE(p + 28);
    const xlen = buf.readUInt16LE(p + 30);
    const clen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nlen);
    expect(buf.readUInt32LE(local)).toBe(0x04034b50);
    // Local header must agree with the central directory (no data descriptor).
    expect(buf.readUInt32LE(local + 14)).toBe(crc);
    expect(buf.readUInt32LE(local + 18)).toBe(csize);
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const data = buf.subarray(start, start + csize);
    const raw = method === 8 ? zlib.inflateRawSync(data) : data;
    expect(raw.length).toBe(usize);
    expect(zlib.crc32(raw)).toBe(crc);
    out.set(name, raw.toString('utf8'));
    p += 46 + nlen + xlen + clen;
  }
  return out;
}

function sheetNames(entries: Map<string, string>): string[] {
  return [...entries.get('xl/workbook.xml')!.matchAll(/<sheet name="([^"]*)"/g)].map((m) => m[1]!);
}

/** Worksheet XML per sheet, in workbook order (resolved through the rels). */
function sheets(entries: Map<string, string>): string[] {
  const rels = entries.get('xl/_rels/workbook.xml.rels')!;
  const target = new Map(
    [...rels.matchAll(/Id="([^"]+)"[^>]*Target="([^"]+)"/g)].map((m) => [m[1]!, m[2]!]),
  );
  return [...entries.get('xl/workbook.xml')!.matchAll(/<sheet [^>]*r:id="([^"]+)"/g)].map(
    (m) => entries.get(`xl/${target.get(m[1]!)}`)!,
  );
}

const rowCount = (xml: string): number => xml.split('<row ').length - 1;

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-xlsx-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('XLSX export', () => {
  it(
    'exportGrid splits rows past 1,000,000 into "<name> (2)"',
    async () => {
      const file = path.join(dir, 'grid.xlsx');
      const rows = Array.from({ length: SPLIT_ROWS }, (_, i) => [`https://ex.com/${i}`, i]);
      const res = await exportGrid(file, {
        format: 'xlsx',
        headers: ['URL', 'N'],
        rows,
        sheetName: 'Inlinks',
      });
      expect(res.rowsWritten).toBe(SPLIT_ROWS);
      execFileSync('unzip', ['-tq', file]);
      const entries = readZip(file);
      expect(sheetNames(entries)).toEqual(['Inlinks', 'Inlinks (2)']);
      const [first, second] = sheets(entries);
      // Header row on every sheet, data continues where the first sheet stopped.
      expect(rowCount(first!)).toBe(1_000_001);
      expect(rowCount(second!)).toBe(SPLIT_ROWS - 1_000_000 + 1);
      expect(second).toContain('<row r="1"><c r="A1" t="inlineStr"><is><t>URL</t>');
      expect(second).toContain('<row r="2"><c r="A2" t="inlineStr"><is><t>https://ex.com/1000000</t>');
      expect(first).toContain('<v>999999</v>');
      expect(first).not.toContain('<v>1000000</v>');
    },
    60_000,
  );

  it('exportGrid writes exactly one sheet at the cap and a header-only sheet for no rows', async () => {
    const empty = path.join(dir, 'empty.xlsx');
    await exportGrid(empty, { format: 'xlsx', headers: ['A'], rows: [], sheetName: 'S' });
    const e = readZip(empty);
    expect(sheetNames(e)).toEqual(['S']);
    expect(rowCount(sheets(e)[0]!)).toBe(1);
  });

  it('exportTabular keeps sheet names within 31 chars, overflow suffix included', async () => {
    const proj = path.join(dir, 'p.seoproject');
    new ProjectDb(proj).close();
    const raw = new DatabaseSync(proj);
    raw.exec(`INSERT INTO urls (id, url, is_external, status_code) VALUES
      (1, 'https://ex.com/a', 0, 200), (2, 'https://ex.com/b', 0, 404);`);
    raw.close();
    const db = new ProjectDb(proj);
    const file = path.join(dir, 'tab.xlsx');
    const label = 'A very long section label that overflows';
    const res = await exportTabular(db, file, {
      format: 'xlsx',
      columns: ['url', 'statusCode'],
      sections: [
        { label, category: 'internal:all' },
        { label, category: 'internal:all' },
      ],
    });
    db.close();
    expect(res.rowsWritten).toBe(4);
    execFileSync('unzip', ['-tq', file]);
    const entries = readZip(file);
    const names = sheetNames(entries);
    expect(names).toEqual([label.slice(0, 31), `${label.slice(0, 27)} (2)`]);
    for (const xml of sheets(entries)) {
      expect(rowCount(xml)).toBe(3);
      expect(xml).toContain('<t>https://ex.com/b</t>');
      expect(xml).toContain('<v>404</v>');
    }
  });
});
