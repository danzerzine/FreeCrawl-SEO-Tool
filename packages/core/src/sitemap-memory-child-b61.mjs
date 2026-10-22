// Child process of sitemap-memory-b61.test.ts: export the sitemap of one
// fixture project and print this process's own peak memory (maxRSS).
// Uses the built packages (`npx tsc -b` first), like the CLI tests.
import { ProjectDb } from '@freecrawl/db';
import { exportSitemap } from '@freecrawl/core';

const [dbFile, outFile] = process.argv.slice(2);
const db = new ProjectDb(dbFile);
// SQLite's page cache fills up to its size (128 MB by default) as the file is
// read, which would look like growth with N until the file outgrows it. A small
// cache leaves what the generator itself holds.
db.db.exec('PRAGMA cache_size = -16384');
const r = await exportSitemap(db, outFile);
db.close();
console.log(
  JSON.stringify({
    urlsWritten: r.urlsWritten,
    files: r.files.length,
    maxRssMb: Math.round(process.resourceUsage().maxRSS / 1024),
  }),
);
