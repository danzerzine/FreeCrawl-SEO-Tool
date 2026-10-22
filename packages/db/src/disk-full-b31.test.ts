import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type * as Fs from 'node:fs';
import { Transform } from 'node:stream';
import type * as Zlib from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// A disk that is too small or fills up, without filling a real one.
const disk = vi.hoisted(() => ({ freeBytes: Infinity, fullOn: null as 'pack' | 'unpack' | null }));

vi.mock('node:fs', async (orig) => {
  const fs = await orig<typeof Fs>();
  return {
    ...fs,
    statfsSync: (p: string) =>
      disk.freeBytes === Infinity ? fs.statfsSync(p) : { ...fs.statfsSync(p), bavail: disk.freeBytes, bsize: 1 },
  };
});

vi.mock('node:zlib', async (orig) => {
  const zlib = await orig<typeof Zlib>();
  const failing = () =>
    new Transform({
      transform(_chunk, _enc, cb) {
        cb(Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' }));
      },
    });
  return {
    ...zlib,
    createBrotliCompress: (o?: object) => (disk.fullOn === 'pack' ? failing() : zlib.createBrotliCompress(o)),
    createBrotliDecompress: () => (disk.fullOn === 'unpack' ? failing() : zlib.createBrotliDecompress()),
  };
});

const { openProject, packProject, ProjectDb } = await import('./index.js');

let dir: string;
let work: string;
let path: string;

beforeEach(async () => {
  disk.freeBytes = Infinity;
  disk.fullOn = null;
  dir = mkdtempSync(join(tmpdir(), 'fc-b31-'));
  work = join(dir, 'work');
  mkdirSync(work);
  const bare = join(dir, 'bare.seoproject');
  const db = new ProjectDb(bare);
  (db as unknown as { db: { exec(s: string): void } }).db.exec(
    `INSERT INTO urls (url, status_code, is_external) VALUES ('https://ex.com/', 200, 0)`,
  );
  db.walCheckpoint();
  db.close();
  path = join(dir, 'saved.seoproject');
  await packProject(bare, path);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const workingCopies = () => readdirSync(join(work, 'FreeCrawl-work'));

describe('a disk too small for a project (B31)', () => {
  it('refuses to open before unpacking, with the sizes', async () => {
    disk.freeBytes = 100;
    await expect(openProject(path, { readOnly: true, workDir: work })).rejects.toThrow(
      /^Not enough free space in .*freecrawl-cli-\w+: 0\.0 GB free, 0\.0 GB needed\.$/,
    );
    expect(workingCopies()).toEqual([]);
  });

  it('refuses to save before packing, and the saved file stays as it was', async () => {
    const before = readFileSync(path);
    const p = await openProject(path, { forWrite: true, workDir: work });
    disk.freeBytes = 100;
    await expect(p.save()).rejects.toThrow(/^Not enough free space in /);
    p.dispose();
    expect(readFileSync(path).equals(before)).toBe(true);
  });
});

describe('a disk that fills up mid-way (B31)', () => {
  it('an unpack says the disk is full and leaves no working copy', async () => {
    disk.fullOn = 'unpack';
    await expect(openProject(path, { readOnly: true, workDir: work })).rejects.toThrow(/^Not enough free space in /);
    expect(workingCopies()).toEqual([]);
  });

  it('a save says the disk is full, removes the half-written file and keeps the saved one', async () => {
    const before = readFileSync(path);
    const p = await openProject(path, { forWrite: true, workDir: work });
    disk.fullOn = 'pack';
    await expect(p.save()).rejects.toThrow(/^Not enough free space in /);
    p.dispose();
    expect(existsSync(`${path}.part`)).toBe(false);
    expect(readFileSync(path).equals(before)).toBe(true);
  });
});
