import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ProjectDb } from './project-db.js';

let dir: string;
let file: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-b20-'));
  file = path.join(dir, 'p.seoproject');
  new ProjectDb(file).close();
  const raw = new DatabaseSync(file);
  raw.exec(`
    INSERT INTO urls (id, url, status_code, redirect_final_url, is_external) VALUES
      (1, 'https://ex.com/', 200, NULL, 0),
      (2, 'https://ex.com/tag', 301, 'https://ex.com/tag/1/', 0),
      (3, 'https://ex.com/tag/1/', 200, NULL, 0);
    INSERT INTO links (from_url_id, to_url, type, is_internal) VALUES
      (1, 'https://ex.com/tag', 'hyperlink', 1),
      (1, 'https://ex.com/tag/1/', 'hyperlink', 1);
  `);
  raw.close();
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('final redirect target in links', () => {
  it('inlinks of a 301 carry the final URL and its status', () => {
    const db = new ProjectDb(file);
    const r = db.getInlinks('https://ex.com/tag', 10).rows[0]!;
    expect(r.toStatusCode).toBe(301);
    expect(r.toFinalUrl).toBe('https://ex.com/tag/1/');
    expect(r.toFinalStatusCode).toBe(200);
    db.close();
  });
  it('outlinks to a 301 carry the final URL; a plain 200 target has none', () => {
    const db = new ProjectDb(file);
    const rows = db.getOutlinks(1, 10).rows;
    const redir = rows.find((x) => x.toUrl === 'https://ex.com/tag')!;
    const plain = rows.find((x) => x.toUrl === 'https://ex.com/tag/1/')!;
    expect(redir.toFinalUrl).toBe('https://ex.com/tag/1/');
    expect(redir.toFinalStatusCode).toBe(200);
    expect(plain.toFinalUrl).toBeNull();
    expect(plain.toFinalStatusCode).toBeNull();
    db.close();
  });
});
