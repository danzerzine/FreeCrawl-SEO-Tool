import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ProjectDb } from '@freecrawl/db';
import { stripBlockComments, trimDots, trimTrailingSlashes } from '@freecrawl/shared-types';
import { classifyRequest } from './log-threats.js';
import { exportTabular } from './tabular-export.js';

/** Milliseconds `fn` takes. */
const time = (fn: () => void): number => {
  const t = performance.now();
  fn();
  return performance.now() - t;
};

describe('no quadratic regex on long runs (B199)', () => {
  it('trimTrailingSlashes drops only the trailing slashes, in linear time', () => {
    expect(trimTrailingSlashes('https://ex.test///')).toBe('https://ex.test');
    expect(trimTrailingSlashes('https://ex.test/a/b')).toBe('https://ex.test/a/b');
    expect(trimTrailingSlashes('///')).toBe('');
    expect(trimTrailingSlashes('')).toBe('');
    for (const v of ['https://ex.test/', 'a//b//', '/', 'x', 'https://ex.test/v4///']) {
      expect(trimTrailingSlashes(v), v).toBe(v.replace(/\/+$/, ''));
    }
    const attack = 'a' + '/'.repeat(256_000) + 'b';
    expect(time(() => expect(trimTrailingSlashes(attack)).toBe(attack))).toBeLessThan(200);
  });

  it('trimDots drops leading and trailing dots, in linear time', () => {
    expect(trimDots('..a.b..')).toBe('a.b');
    expect(trimDots('...')).toBe('');
    expect(trimDots('a')).toBe('a');
    for (const v of ['.', '..', '.a', 'a.', '..a..b..', 'a..b', '']) expect(trimDots(v), v).toBe(v.replace(/^\.+|\.+$/g, ''));
    const attack = 'a' + '.'.repeat(256_000) + 'b';
    expect(time(() => expect(trimDots(attack)).toBe(attack))).toBeLessThan(200);
  });

  it('stripBlockComments matches the lazy /* */ regex and stays linear without a closing */', () => {
    const regex = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, ' ');
    for (const s of ['a/*x*/b', '/**/', '/*/', '/*a*/b/*c*/d', 'a/*b', '*/a/*', '/*/*/ x */', 'plain']) {
      expect(stripBlockComments(s), s).toBe(regex(s));
    }
    const attack = '/x' + '/*a'.repeat(85_000);
    expect(time(() => stripBlockComments(attack))).toBeLessThan(200);
  });

  it('a 256 KB request target with unclosed comments is scored in well under a second', () => {
    const path = '/x' + '/*a'.repeat(85_000);
    expect(time(() => classifyRequest({ path, method: 'GET' }))).toBeLessThan(1000);
  });

  it('a comment-split attack in a log line still scores as before', () => {
    const hit = classifyRequest({ path: '/item?id=1/**/UNION/**/SELECT/**/1,2--', method: 'GET' });
    expect(hit?.category).toBe('sqli');
  });

  it('an export named with long runs of dots gets the same file name, fast', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-b199-'));
    const db = new ProjectDb(path.join(dir, 'p.seoproject'));
    const run = (filename: string) =>
      exportTabular(db, path.join(dir, 'out'), { format: 'csv', sections: [{ label: 'x', category: 'all', filename }], columns: ['url'] });
    try {
      db.upsertUrl({ url: 'https://ex.test/', depth: 0, statusCode: 200, contentKind: 'html' });
      const { files } = await run('...report...');
      expect(files.map((f) => path.basename(f))).toEqual(['report.csv']);
      // A long run of dots inside the name stays in it, so the file cannot be written;
      // the name is still worked out in linear time before the write fails.
      const t = performance.now();
      await expect(run(`a${'.'.repeat(64_000)}b`)).rejects.toThrow(/ENAMETOOLONG/);
      expect(performance.now() - t).toBeLessThan(1000);
    } finally {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
