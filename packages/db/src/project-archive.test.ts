import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { detectProjectFormat, packProject, unpackProject } from './project-archive.js';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-archive-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function makeDb(file: string, rows = 500): void {
  const db = new DatabaseSync(file);
  db.exec('CREATE TABLE urls (id INTEGER PRIMARY KEY, url TEXT NOT NULL)');
  const ins = db.prepare('INSERT INTO urls (url) VALUES (?)');
  for (let i = 0; i < rows; i++) ins.run(`https://example.com/page/${i}`);
  db.close();
}

describe('project archive', () => {
  it('round-trips a SQLite database byte for byte', async () => {
    const src = path.join(dir, 'src.db');
    const packed = path.join(dir, 'p.seoproject');
    const out = path.join(dir, 'out.db');
    makeDb(src);

    const packRes = await packProject(src, packed);
    const unpackRes = await unpackProject(packed, out);

    expect(packRes.sourceBytes).toBe(fs.statSync(src).size);
    expect(packRes.bytesWritten).toBe(fs.statSync(packed).size);
    expect(unpackRes.bytesWritten).toBe(fs.statSync(src).size);
    expect(fs.readFileSync(out).equals(fs.readFileSync(src))).toBe(true);

    const db = new DatabaseSync(out);
    const row = db.prepare('SELECT COUNT(*) AS n FROM urls').get() as { n: number };
    db.close();
    expect(row.n).toBe(500);
  });

  it('compresses repetitive database pages', async () => {
    const src = path.join(dir, 'src.db');
    const packed = path.join(dir, 'p.seoproject');
    makeDb(src, 2000);
    const { bytesWritten, sourceBytes } = await packProject(src, packed);
    expect(bytesWritten).toBeLessThan(sourceBytes);
  });

  it('leaves no .part file after a successful pack or unpack', async () => {
    const src = path.join(dir, 'src.db');
    const packed = path.join(dir, 'p.seoproject');
    const out = path.join(dir, 'out.db');
    makeDb(src);
    await packProject(src, packed);
    await unpackProject(packed, out);
    expect(fs.readdirSync(dir).filter((f) => f.endsWith('.part'))).toEqual([]);
  });

  it('replaces an existing destination when unpacking', async () => {
    const src = path.join(dir, 'src.db');
    const packed = path.join(dir, 'p.seoproject');
    const out = path.join(dir, 'out.db');
    makeDb(src);
    fs.writeFileSync(out, 'stale');
    await packProject(src, packed);
    await unpackProject(packed, out);
    expect(fs.readFileSync(out).equals(fs.readFileSync(src))).toBe(true);
  });

  it('detects a packed file as archive and a bare database as sqlite', async () => {
    const src = path.join(dir, 'src.db');
    const packed = path.join(dir, 'p.seoproject');
    makeDb(src);
    await packProject(src, packed);
    expect(detectProjectFormat(packed)).toBe('archive');
    expect(detectProjectFormat(src)).toBe('sqlite');
  });

  it('detects random bytes, an empty file and a missing file as unknown', () => {
    const rnd = path.join(dir, 'rnd.bin');
    const empty = path.join(dir, 'empty.bin');
    fs.writeFileSync(rnd, randomBytes(64));
    fs.writeFileSync(empty, '');
    expect(detectProjectFormat(rnd)).toBe('unknown');
    expect(detectProjectFormat(empty)).toBe('unknown');
    expect(detectProjectFormat(path.join(dir, 'missing'))).toBe('unknown');
  });

  it('rejects a truncated archive and leaves no partial destination or .part file', async () => {
    const src = path.join(dir, 'src.db');
    const packed = path.join(dir, 'p.seoproject');
    const cut = path.join(dir, 'cut.seoproject');
    const out = path.join(dir, 'out.db');
    makeDb(src, 2000);
    await packProject(src, packed);
    const bytes = fs.readFileSync(packed);
    fs.writeFileSync(cut, bytes.subarray(0, Math.floor(bytes.length / 2)));

    await expect(unpackProject(cut, out)).rejects.toThrow();
    expect(fs.existsSync(out)).toBe(false);
    expect(fs.existsSync(`${out}.part`)).toBe(false);
  });

  it('keeps an existing destination untouched when unpacking a truncated archive', async () => {
    const src = path.join(dir, 'src.db');
    const packed = path.join(dir, 'p.seoproject');
    const cut = path.join(dir, 'cut.seoproject');
    const out = path.join(dir, 'out.db');
    makeDb(src, 2000);
    await packProject(src, packed);
    const bytes = fs.readFileSync(packed);
    fs.writeFileSync(cut, bytes.subarray(0, Math.floor(bytes.length / 2)));
    fs.writeFileSync(out, 'previous');

    await expect(unpackProject(cut, out)).rejects.toThrow();
    expect(fs.readFileSync(out, 'utf8')).toBe('previous');
  });

  it('refuses a file without the archive signature', async () => {
    const src = path.join(dir, 'src.db');
    makeDb(src);
    await expect(unpackProject(src, path.join(dir, 'out.db'))).rejects.toThrow(/bad signature/);
  });

  it('refuses an archive written by a newer format version', async () => {
    const packed = path.join(dir, 'future.seoproject');
    fs.writeFileSync(packed, Buffer.concat([Buffer.from('FCPROJ01'), Buffer.from([0x02])]));
    await expect(unpackProject(packed, path.join(dir, 'out.db'))).rejects.toThrow(/newer version/);
  });

  it('removes its .part file when packing fails', async () => {
    const dst = path.join(dir, 'p.seoproject');
    await expect(packProject(path.join(dir, 'missing.db'), dst)).rejects.toThrow();
    expect(fs.readdirSync(dir)).toEqual([]);
  });
});
