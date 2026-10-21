import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ProjectDb } from '@freecrawl/db';
import { shingleHashes, tokenizeContent } from '@freecrawl/shared-types';
import { computeContentFingerprint } from './simhash.js';

/*
 * freezeTemplateSet on a fixture DB (B98): one transaction writes the set
 * to project_meta and re-fingerprints the sample rows from their hashes.
 */
let dir: string;
let file: string;
const words = (seed: string, n: number) => Array.from({ length: n }, (_, i) => `${seed}${i % 41} x${i}`).join(' ');
const TEASER = words('teaser', 300);
const TEXTS = ['one', 'two', 'three'].map((s) => `${words(s, 80)} ${TEASER}`);
const URL = (i: number) => `https://ex.com/a${i}`;
const SET = { id: 123456, hashes: shingleHashes(tokenizeContent(TEASER)).h32.slice().sort() };
const hex = (b: Uint8Array | null) => (b ? Buffer.from(b).toString('hex') : null);

type Row = { url: string; simhash: string | null; minhash: Uint8Array | null; template_set_id: number | null };
function rows(): Row[] {
  const raw = new DatabaseSync(file);
  const r = raw.prepare('SELECT url, simhash, minhash, template_set_id FROM urls ORDER BY url').all() as Row[];
  raw.close();
  return r.map((x) => ({ ...x, minhash: x.minhash ? new Uint8Array(x.minhash) : null }));
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-b98f-'));
  file = path.join(dir, 'p.seoproject');
  new ProjectDb(file).close();
  const raw = new DatabaseSync(file);
  const ins = raw.prepare(
    `INSERT INTO urls (url, is_external, content_kind, status_code, indexability, simhash, minhash)
     VALUES (?, 0, 'html', 200, 'indexable', ?, ?)`,
  );
  TEXTS.forEach((t, i) => {
    const fp = computeContentFingerprint(t);
    ins.run(URL(i), fp.simhash, fp.minhash);
  });
  raw.close();
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const freezeArgs = () => ({
  id: SET.id,
  hashes: SET.hashes,
  sample: { pages: 3, entries: 999 },
  rows: TEXTS.map((t, i) => ({ url: URL(i), shingles: shingleHashes(tokenizeContent(t)) })),
});

describe('freezeTemplateSet is one transaction (B98)', () => {
  it('writes the set and re-fingerprints every sample row with it', () => {
    const db = new ProjectDb(file);
    db.freezeTemplateSet(freezeArgs());
    const id = db.getMeta('templateSetId');
    const sample = db.getMeta('templateSample');
    db.close();
    expect(id).toBe('123456');
    expect(JSON.parse(sample!)).toEqual({ pages: 3, entries: 999 });
    rows().forEach((r, i) => {
      const want = computeContentFingerprint(TEXTS[i]!, { set: SET });
      expect({ s: r.simhash, m: hex(r.minhash), id: r.template_set_id }).toEqual({ s: want.simhash, m: hex(want.minhash), id: 123456 });
    });
  });

  it('a failure on the last row leaves no set and every row as it was', () => {
    const before = rows();
    const raw = new DatabaseSync(file);
    raw.exec(`CREATE TRIGGER fail_last BEFORE UPDATE ON urls WHEN NEW.url = '${URL(2)}' BEGIN SELECT RAISE(ABORT, 'forced'); END`);
    raw.close();
    const db = new ProjectDb(file);
    expect(() => db.freezeTemplateSet(freezeArgs())).toThrow(/forced/);
    const meta = ['templateSetId', 'templateShingles', 'templateSample'].map((k) => db.getMeta(k));
    db.close();
    expect(meta).toEqual([null, null, null]);
    expect(rows()).toEqual(before);
  });
});

describe('a page write reconciles with the set frozen before it (B98)', () => {
  const page = `${words('late', 80)} ${TEASER}`;
  const write = (db: ProjectDb, withHashes: boolean) => {
    const fp = computeContentFingerprint(page, { collectShingles: true });
    db.writeFetchedUrl({
      upsert: { url: 'https://ex.com/late', depth: 1, contentKind: 'html', statusCode: 200, indexability: 'indexable', simhash: fp.simhash, minhash: fp.minhash, contentHash: fp.contentHash, templateSetId: null },
      headers: null,
      storeBody: null,
      links: [],
      images: [],
      fromDepth: 1,
      shingles: withHashes ? fp.shingles! : undefined,
    });
  };
  const late = () => rows().find((r) => r.url === 'https://ex.com/late')!;

  it('a page parsed without the set but carrying its hashes is stored with the set', () => {
    const db = new ProjectDb(file);
    db.freezeTemplateSet(freezeArgs());
    write(db, true);
    const res = db.recomputeDuplicateClusters(3, false, 90);
    db.close();
    const want = computeContentFingerprint(page, { set: SET });
    expect({ s: late().simhash, m: hex(late().minhash), id: late().template_set_id }).toEqual({ s: want.simhash, m: hex(want.minhash), id: 123456 });
    expect(res.notCompared).toBe(0);
  });

  it('the same page without hashes keeps its own id and is counted as not compared', () => {
    const db = new ProjectDb(file);
    db.freezeTemplateSet(freezeArgs());
    write(db, false);
    const res = db.recomputeDuplicateClusters(3, false, 90);
    const meta = db.getMeta('nearDuplicateNotCompared');
    db.close();
    expect(late().template_set_id).toBeNull();
    expect(late().simhash).toBe(computeContentFingerprint(page).simhash);
    expect(res.notCompared).toBe(1);
    expect(meta).toBe('1');
  });
});
