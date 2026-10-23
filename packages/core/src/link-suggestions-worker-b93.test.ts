import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { ProjectDb } from '@freecrawl/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { linkSuggestions } from './link-suggestions.js';
import { runLinkSuggestionsInWorker } from './link-suggestions-run.js';

const WORKER = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../dist/link-suggestions-worker.js',
);

let dir: string;
let file: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'fc-b93w-'));
  file = path.join(dir, 'p.seoproject');
  new ProjectDb(file).close();
  const raw = new DatabaseSync(file);
  raw.exec(`
    INSERT INTO project_meta (key, value) VALUES ('inlinksComputed', '1');
    INSERT INTO urls (id, url, is_external, content_kind, status_code, title) VALUES
      (1, 'https://ex.com/a', 0, 'html', 200, 'Espresso machine guide'),
      (2, 'https://ex.com/b', 0, 'html', 200, 'Espresso machine care');
  `);
  raw.close();
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('runLinkSuggestionsInWorker (B93)', () => {
  it('gives the same answer as the direct call, on its own read-only connection', async () => {
    const db = new ProjectDb(file);
    const direct = linkSuggestions(db, {});
    db.close();
    const viaWorker = await runLinkSuggestionsInWorker(file, {}, { workerPath: WORKER });
    expect(viaWorker).toEqual(direct);
    expect(viaWorker!.rows.length).toBeGreaterThan(0);
  });

  it('answers null when inlinks were not computed', async () => {
    const raw = new DatabaseSync(file);
    raw.exec("DELETE FROM project_meta WHERE key = 'inlinksComputed'");
    raw.close();
    expect(await runLinkSuggestionsInWorker(file, {}, { workerPath: WORKER })).toBeNull();
  });

  it('rejects at once when the signal is already aborted, and stops a running worker', async () => {
    const done = new AbortController();
    done.abort();
    await expect(
      runLinkSuggestionsInWorker(file, {}, { workerPath: WORKER, signal: done.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    const live = new AbortController();
    const p = runLinkSuggestionsInWorker(file, {}, { workerPath: WORKER, signal: live.signal });
    live.abort();
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
  });
});
