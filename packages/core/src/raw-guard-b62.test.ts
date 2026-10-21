import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ProjectDb } from '@freecrawl/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { exportUrlsToCsv } from './csv-export.js';
import { exportTabular } from './tabular-export.js';
import { escapeCsv } from './spreadsheet.js';

let dir: string;
let db: ProjectDb;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-b62-'));
  const file = path.join(dir, 'p.seoproject');
  new ProjectDb(file).close();
  const raw = new DatabaseSync(file);
  raw.exec(`INSERT INTO urls (id, url, is_external, status_code, meta_description) VALUES
    (1,'https://ex.com/a',0,200,'- foo'),(2,'https://ex.com/b',0,200,'=1+1');`);
  raw.close();
  db = new ProjectDb(file);
});
afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
const body = (f: string) => fs.readFileSync(f, 'utf8');

describe('B62 escapeCsv', () => {
  it('guards by default, never prefixes numbers', () => {
    expect(escapeCsv('=1+1')).toBe("'=1+1");
    expect(escapeCsv('+x')).toBe("'+x");
    expect(escapeCsv('@x')).toBe("'@x");
    expect(escapeCsv(-33.4)).toBe('-33.4');
  });
  it('formulaGuard:false keeps text, still quotes', () => {
    expect(escapeCsv('- foo', { formulaGuard: false })).toBe('- foo');
    expect(escapeCsv('=a,"b"', { formulaGuard: false })).toBe('"=a,""b"""');
  });
});

describe('B62 writers', () => {
  it('URL CSV: default guards, keys mode is raw', async () => {
    const a = path.join(dir, 'a.csv');
    await exportUrlsToCsv(db, a);
    expect(body(a)).toContain("'- foo");
    const k = path.join(dir, 'k.csv');
    await exportUrlsToCsv(db, k, { headers: 'keys', columns: ['url', 'metaDescription'] });
    expect(body(k)).toContain('\n' + 'https://ex.com/a,- foo\n');
    expect(body(k)).toContain('https://ex.com/b,=1+1\n');
  });
  it('tabular CSV: default guards, keys mode is raw', async () => {
    const opts = { format: 'csv' as const, columns: ['url', 'metaDescription'], sections: [{ label: 'All', category: 'all' as const }] };
    const a = path.join(dir, 'ta.csv');
    await exportTabular(db, a, opts);
    expect(body(a)).toContain("'- foo");
    const k = path.join(dir, 'tk.csv');
    await exportTabular(db, k, { ...opts, headers: 'keys' });
    expect(body(k)).toContain('https://ex.com/a,- foo\n');
  });
});
