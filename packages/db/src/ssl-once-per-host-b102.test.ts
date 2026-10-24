import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { ProjectDb } from './project-db.js';

// B102: an SSL / TLS finding belongs to the host, so it shows once per host
// (on its first crawled page), not on every page of that host.
let dir: string;
let file: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'b102-'));
  file = path.join(dir, 'p.seoproject');
  new ProjectDb(file).close();
  const raw = new DatabaseSync(file);
  const ins = raw.prepare(
    `INSERT INTO urls (id, url, is_external, content_kind, status_code, indexability)
     VALUES (?, ?, 0, 'html', 200, 'indexable')`,
  );
  ins.run(1, 'https://a.example/');
  ins.run(2, 'https://a.example/one');
  ins.run(3, 'https://a.example/two');
  ins.run(4, 'https://b.example/');
  ins.run(5, 'https://b.example/one');
  raw.close();
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

it('each SSL check lists one page per flagged host', () => {
  const db = new ProjectDb(file);
  const cert = {
    validFrom: null,
    validTo: null,
    issuer: null,
    subject: null,
    probeStatus: 200,
    probeError: null,
  };
  db.setHostCert({
    ...cert,
    host: 'a.example',
    daysUntilExpiry: -3,
    signatureAlgorithm: 'sha1WithRSAEncryption',
    protocol: 'TLSv1',
  });
  db.setHostCert({
    ...cert,
    host: 'b.example',
    daysUntilExpiry: 10,
    signatureAlgorithm: 'sha256WithRSAEncryption',
    protocol: 'TLSv1.3',
  });
  const urls = (category: Parameters<ProjectDb['queryUrls']>[0]['category']) =>
    db
      .queryUrls({ limit: 100, offset: 0, category })
      .rows.map((r) => r.url)
      .sort();
  try {
    expect(urls('issues:ssl-cert-expired')).toEqual(['https://a.example/']);
    expect(urls('issues:ssl-protocol-old')).toEqual(['https://a.example/']);
    expect(urls('issues:ssl-signature-weak')).toEqual(['https://a.example/']);
    expect(urls('issues:ssl-cert-expiring-soon')).toEqual(['https://b.example/']);
    expect(db.countIssuePages('issues:ssl-cert-expired')).toBe(1);
  } finally {
    db.close();
  }
});
