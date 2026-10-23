import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ProjectDb } from './project-db.js';

// A reader that opens a project while the crawl is still creating it (the
// file exists, its tables do not yet) fails. That failed reader must not
// stay connected: an open connection keeps the writer's last close from
// folding the WAL into the file and removing it.
let dir: string;
let file: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-b118db-'));
  file = path.join(dir, 'p.seoproject');
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('B118 a ProjectDb that fails to open', () => {
  it('closes its connection, so the writer still removes the WAL when it closes', () => {
    const writer = new DatabaseSync(file);
    writer.exec('PRAGMA journal_mode = WAL; CREATE TABLE t (x)');
    expect(() => new ProjectDb(file, { readOnly: true })).toThrow(/no such table/);
    writer.exec('INSERT INTO t VALUES (1)');
    writer.close();
    expect(fs.existsSync(`${file}-wal`)).toBe(false);
  });
});
