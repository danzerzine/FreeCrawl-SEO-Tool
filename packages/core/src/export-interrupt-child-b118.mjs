// Child process of export-interrupt-b118.test.ts: the shared pass of the
// bulk export, interrupted the way Ctrl-C ends the CLI (process.exit, whose
// exit hook removes the `.part` files) while libuv's thread pool is busy,
// as it is on a loaded machine. Uses the built packages (`npx tsc -b` first).
import { pbkdf2 } from 'node:crypto';
import { join } from 'node:path';
import { ProjectDb } from '@freecrawl/db';
import { removePartialExportFiles } from '../dist/export-file.js';
import { writeUrlFilesInOnePass } from '../dist/url-files-pass.js';

const [dbFile, outDir, count] = process.argv.slice(2);
process.on('exit', removePartialExportFiles);
const db = new ProjectDb(dbFile);
let first = true;
const line = (row) => {
  if (first) {
    first = false;
    // The only pool thread (UV_THREADPOOL_SIZE=1) is busy for a while: file
    // work queued from here on waits behind it.
    pbkdf2('x', 'y', 300_000, 32, 'sha256', () => undefined);
    // Exit once this tick's queued work (the streams' own setup) has run.
    process.nextTick(() => process.exit(130));
  }
  return `${row.url}\n`;
};
void writeUrlFilesInOnePass(
  db,
  Array.from({ length: Number(count) }, (_, i) => ({
    filePath: join(outDir, `f${i}.csv`),
    category: 'all',
    head: 'url\n',
    line,
  })),
);
