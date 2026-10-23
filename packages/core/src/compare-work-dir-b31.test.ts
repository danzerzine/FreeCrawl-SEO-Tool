import { mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { packProject, ProjectDb } from '@freecrawl/db';
import { openCompareProject } from './compare.js';

let dir: string;
let tmp: string;
const savedTmp = process.env['TMPDIR'];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'fc-b31-'));
  tmp = join(dir, 'tmp');
  mkdirSync(tmp);
  process.env['TMPDIR'] = tmp;
});
afterEach(() => {
  if (savedTmp === undefined) delete process.env['TMPDIR'];
  else process.env['TMPDIR'] = savedTmp;
  rmSync(dir, { recursive: true, force: true });
});

it('unpacks the other project of a comparison into the working folder (B31)', async () => {
  const bare = join(dir, 'bare.db');
  new ProjectDb(bare).close();
  const saved = join(dir, 'saved.seoproject');
  await packProject(bare, saved);
  const work = join(dir, 'big-disk');
  mkdirSync(work);
  const p = await openCompareProject(saved, work);
  expect(readdirSync(join(work, 'FreeCrawl-work'))).toEqual([expect.stringMatching(/^freecrawl-compare-/)]);
  expect(readdirSync(tmp)).toEqual([]);
  p.dispose();
  expect(readdirSync(join(work, 'FreeCrawl-work'))).toEqual([]);
  // Without one, the temp folder as before.
  const q = await openCompareProject(saved);
  expect(readdirSync(tmp)).toEqual([expect.stringMatching(/^freecrawl-compare-/)]);
  q.dispose();
});

it('refuses a comparison that will not fit, before anything is copied (B110)', async () => {
  const bare = join(dir, 'bare2.db');
  new ProjectDb(bare).close();
  const saved = join(dir, 'saved2.seoproject');
  await packProject(bare, saved);
  const noRoom = () => ({ bavail: 1, bsize: 1024 });
  await expect(openCompareProject(saved, undefined, { statfs: noRoom })).rejects.toThrow(
    /^Not enough free space in .*: .* GB free, .* GB needed\.$/,
  );
  // No copy, and no empty folder either.
  expect(readdirSync(tmp)).toEqual([]);
});
