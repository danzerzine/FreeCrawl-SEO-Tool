import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ProjectDb } from '@freecrawl/db';

// Drives the built CLI as a process (`npx tsc -b && npm run build:cli` first).
const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dist/index.js');
let dir: string;
let project: string;
let out: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-b84c-'));
  project = path.join(dir, 'p.seoproject');
  out = path.join(dir, 'd');
  new ProjectDb(project).close();
  const raw = new DatabaseSync(project);
  const pages: [number, string, string][] = [
    [1, 'https://ex.test/news/a/1', 'Кофе новости Москвы'],
    [2, 'https://ex.test/news/a/2', 'Кофе новости недели'],
    [3, 'https://ex.test/shop/x/1', 'Чай купить дёшево'],
    [4, 'https://ex.test/shop/x/2', 'Чай купить подарок'],
  ];
  for (const [id, url, title] of pages) {
    raw.exec(
      `INSERT INTO urls (id, url, is_external, content_kind, status_code, indexability, title) VALUES (${id}, '${url}', 0, 'html', 200, 'indexable', '${title}')`,
    );
  }
  raw.close();
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

function run(...args: string[]) {
  return spawnSync(process.execPath, [CLI, 'export', '--project', project, ...args], {
    encoding: 'utf8',
    timeout: 30000,
  });
}
const csv = (): string[] =>
  fs.readFileSync(path.join(out, 'top-words.csv'), 'utf8').replace(/^\uFEFF/, '').trimEnd().split('\n');

describe('B84 CLI: dataset:top-words', () => {
  it('--ngram 2 --by-section --section-depth 2: exact header, rows ordered section, count desc, gram', () => {
    const r = run('--what', 'dataset:top-words', '--ngram', '2', '--by-section', '--section-depth', '2', '--out', out);
    expect(r.status, r.stderr).toBe(0);
    expect(csv()).toEqual([
      'Scope,Section,N,Gram,Count,Pages,Capped',
      'section,news/a,2,кофе новости,2,2,false',
      'section,shop/x,2,чай купить,2,2,false',
    ]);
  });

  it('--by-section does not swallow the next option (--out)', () => {
    const r = run('--what', 'dataset:top-words', '--ngram', '2', '--by-section', '--out', out);
    expect(r.status, r.stderr).toBe(0);
    expect(csv().slice(1)).toEqual(['section,news,2,кофе новости,2,2,false', 'section,shop,2,чай купить,2,2,false']);
  });

  it('without flags the output is the words of the site (n=1)', () => {
    const r = run('--what', 'dataset:top-words', '--out', out);
    expect(r.status, r.stderr).toBe(0);
    expect(csv()[1]).toBe('site,,1,кофе,2,2,false');
  });

  it('--word-locale en keeps the Russian function words that ru drops', () => {
    const raw = new DatabaseSync(project);
    raw.exec(`UPDATE urls SET title = 'Кофе для дома' WHERE id IN (1, 2)`);
    raw.close();
    expect(run('--what', 'dataset:top-words', '--word-locale', 'ru', '--out', out).status).toBe(0);
    expect(csv().join('\n')).not.toContain(',для,');
    fs.rmSync(out, { recursive: true, force: true });
    expect(run('--what', 'dataset:top-words', '--word-locale', 'en', '--out', out).status).toBe(0);
    expect(csv().join('\n')).toContain(',для,');
  });

  it.each([
    [['--ngram', '4'], /--ngram must be 1, 2 or 3/],
    [['--ngram', 'x'], /--ngram must be 1, 2 or 3/],
    [['--section-depth', '3', '--by-section'], /--section-depth must be 1 or 2/],
    [['--section-depth', '2'], /--section-depth needs --by-section/],
    [['--word-locale', 'de'], /--word-locale must be en, ru, tr or all/],
  ] as const)('%j exits 2 with a message', (flags, message) => {
    const r = run('--what', 'dataset:top-words', ...flags, '--out', out);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(message);
    expect(fs.existsSync(path.join(out, 'top-words.csv'))).toBe(false);
  });

  it('--with-bodies adds the words of the stored bodies', () => {
    const raw = new DatabaseSync(project);
    const body = '<html><body><article><p>Эспрессо эспрессо обжарка</p></article></body></html>';
    raw.exec(`INSERT INTO url_sources (url_id, body, body_length) VALUES (1, '${body}', ${body.length})`);
    raw.close();
    expect(run('--what', 'dataset:top-words', '--out', out).status).toBe(0);
    expect(csv().join('\n')).not.toContain('эспрессо');
    fs.rmSync(out, { recursive: true, force: true });
    expect(run('--what', 'dataset:top-words', '--with-bodies', '--out', out).status).toBe(0);
    expect(csv().join('\n')).toContain(',эспрессо,');
  });

  it('--help lists the five flags with their text', () => {
    const r = spawnSync(process.execPath, [CLI, '--help'], { encoding: 'utf8' });
    const help = (r.stdout + r.stderr).replace(/\s+/g, ' ');
    for (const line of [
      '--ngram <1|2|3> With dataset:top-words: words (1) or 2-3 word phrases (default 1)',
      '--word-locale <l> With dataset:top-words: stopword list: en, ru, tr or all (default all)',
      '--by-section With dataset:top-words: one block per folder of the site (see --section-depth). At most 50 sections are kept (the biggest by pages; the rest are summed into "(other)"); each keeps up to max(20 000, 200 000 / sections) distinct phrases, so rare phrases may be dropped',
      '--section-depth <n> With --by-section: folder depth, 1 or 2 (default 1)',
      '--with-bodies With dataset:top-words: also read stored page bodies (slower; needs bodies saved by the crawl)',
    ]) {
      expect(help).toContain(line);
    }
  });
});
