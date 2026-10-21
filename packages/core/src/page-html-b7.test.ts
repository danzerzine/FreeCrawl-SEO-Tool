import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ProjectDb } from '@freecrawl/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EXPORT_DATASET_COLUMNS } from '@freecrawl/shared-types';
import { exportTabular } from './tabular-export.js';

let dir: string;
let db: ProjectDb;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-b7-'));
  const file = path.join(dir, 'p.seoproject');
  new ProjectDb(file).close();
  const raw = new DatabaseSync(file);
  raw.exec(`INSERT INTO urls (id, url, status_code, content_type) VALUES
    (1,'https://ex.com/js',200,'text/html'),(2,'https://ex.com/plain',200,'text/html');`);
  raw.close();
  db = new ProjectDb(file);
  db.setUrlSource(1, '<html><body><div id="app"></div></body></html>');
  db.setUrlRenderedBody(1, '<html><body><div id="app"><h1>Rendered</h1></div></body></html>', 50);
  db.setUrlSource(2, '<html><body><p>Plain</p></body></html>');
});
afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('page-html carries the rendered DOM (B7)', () => {
  it('JSONL rows have renderedHtml when the crawl rendered the page, null otherwise', async () => {
    const out = path.join(dir, 'html.jsonl');
    await exportTabular(db, out, {
      format: 'jsonl',
      sections: [{ label: 'Page HTML', dataset: 'page-html' }],
      columns: EXPORT_DATASET_COLUMNS['page-html'].map((c) => c.key),
    });
    const [js, plain] = fs.readFileSync(out, 'utf8').trimEnd().split('\n').map((l) => JSON.parse(l));
    expect(js.html).not.toContain('Rendered');
    expect(js.renderedHtml).toContain('<h1>Rendered</h1>');
    expect(plain.renderedHtml).toBeNull();
  });
});
