import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ProjectDb } from '@freecrawl/db';
import { EXPORT_DATASET_COLUMNS } from '@freecrawl/shared-types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CLI_EXPORT_DATASETS, parseExportWhat, runExportItems } from './export-items.js';

let dir: string;
let file: string;
let out: string;
const esc = (s: string): string => s.replace(/'/g, "''");

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-b84d-'));
  file = path.join(dir, 'p.seoproject');
  out = path.join(dir, 'out');
  fs.mkdirSync(out);
  new ProjectDb(file).close();
  const pages: [number, string, string][] = [
    [1, 'https://ex.test/news/a', 'Кофе новости Москвы'],
    [2, 'https://ex.test/news/b', 'Кофе новости недели'],
    [3, 'https://ex.test/shop/a', 'Чай купить дёшево'],
    [4, 'https://ex.test/shop/b', 'Чай купить подарок'],
  ];
  const raw = new DatabaseSync(file);
  for (const [id, url, title] of pages) {
    raw.exec(
      `INSERT INTO urls (id, url, is_external, content_kind, status_code, indexability, title) VALUES (${id}, '${url}', 0, 'html', 200, 'indexable', '${esc(title)}')`,
    );
  }
  raw.close();
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const HEADER = ['Scope', 'Section', 'N', 'Gram', 'Count', 'Pages', 'Capped'];

async function run(topWords: Record<string, unknown>): Promise<string[]> {
  const db = new ProjectDb(file);
  await runExportItems(db, out, parseExportWhat('dataset:top-words'), { topWords } as never);
  db.close();
  return fs.readFileSync(path.join(out, 'top-words.csv'), 'utf8').replace(/^\uFEFF/, '').trimEnd().split('\n');
}

describe('B84 dataset:top-words', () => {
  it('is a CLI dataset with the exact column list', () => {
    expect(CLI_EXPORT_DATASETS).toContain('top-words');
    expect(EXPORT_DATASET_COLUMNS['top-words'].map((c) => c.header)).toEqual(HEADER);
  });

  it('site words: header exact, rows unsorted = count desc then word', async () => {
    const lines = await run({});
    expect(lines[0]).toBe(HEADER.join(','));
    expect(lines.slice(1)).toEqual([
      'site,,1,кофе,2,2,false',
      'site,,1,купить,2,2,false',
      'site,,1,новости,2,2,false',
      'site,,1,чай,2,2,false',
      'site,,1,дёшево,1,1,false',
      'site,,1,москвы,1,1,false',
      'site,,1,недели,1,1,false',
      'site,,1,подарок,1,1,false',
    ]);
  });

  it('bigrams by section: section name, then count desc, then gram', async () => {
    const lines = await run({ n: 2, bySection: true });
    expect(lines.slice(1)).toEqual(['section,news,2,кофе новости,2,2,false', 'section,shop,2,чай купить,2,2,false']);
  });

  it('manifest.json lists the file with rows, ms and peakRssMb', async () => {
    await run({ n: 2 });
    const m = JSON.parse(fs.readFileSync(path.join(out, 'manifest.json'), 'utf8')) as {
      what: string[];
      files: { path: string; rows: number; ms: number; peakRssMb: number }[];
    };
    expect(m.what).toEqual(['dataset:top-words']);
    expect(m.files).toHaveLength(1);
    expect(m.files[0]).toMatchObject({ path: 'top-words.csv', rows: 2 });
    expect(Number.isInteger(m.files[0]!.ms)).toBe(true);
    expect(Number.isInteger(m.files[0]!.peakRssMb)).toBe(true);
  });

  it('an interrupted run leaves no manifest', async () => {
    const db = new ProjectDb(file);
    await expect(
      runExportItems(db, out, parseExportWhat('dataset:top-words,issues'), {
        onProgress: (l) => {
          if (l === 'Exporting issues…') throw new Error('interrupted');
        },
      }),
    ).rejects.toThrow('interrupted');
    db.close();
    expect(fs.existsSync(path.join(out, 'manifest.json'))).toBe(false);
  });
});
