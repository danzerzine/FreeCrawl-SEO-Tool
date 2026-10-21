/**
 * Many CSV files drawn from the urls table in one pass. Every category
 * file lists its rows in id order, so a single walk over all URLs feeds
 * them all: a file keeps a row when its category's id list holds it (the
 * same rows `iterateUrlsByCategory` would yield, in the same order). One
 * `SELECT *` pass replaces one per file, and each category's filter runs
 * once as a plain id query instead of once per keyset batch.
 *
 * Each file still goes through its own `<name>.part` + rename
 * (`writeExportFile`), and fails alone: a write error, a category it
 * cannot list or a row it cannot build fails that file only. A failure of the shared read fails every
 * file of the pass. Reads through SQLite's page cache: see `withoutMmap`.
 */

import { createWriteStream, type WriteStream } from 'node:fs';
import { once } from 'node:events';
import type { ProjectDb } from '@freecrawl/db';
import type { CrawlUrlRow, UrlCategory } from '@freecrawl/shared-types';
import { writeExportFile } from './export-file.js';

export interface UrlPassFile {
  filePath: string;
  /** Rows of this category, in id order. */
  category: UrlCategory;
  /** Written first (BOM and header row included). */
  head: string;
  /** The row's line, or null to leave the row out. A throw fails this file only. */
  line: (row: CrawlUrlRow) => string | null;
  /** Keep the file for this row count; otherwise none is left (default: always). */
  keep?: (rows: number) => boolean;
}

/** One output file of the shared pass: its rows, its open `.part` stream. */
interface Sink {
  file: UrlPassFile;
  /** Ids of the file's category, ascending; null when it is every URL. */
  ids: Uint32Array | null;
  next: number;
  out: WriteStream;
  buf: string;
  rows: number;
  failed: boolean;
}

const FLUSH_CHARS = 1 << 16;

async function writePass(
  db: ProjectDb,
  targets: { file: UrlPassFile; partPath: string }[],
): Promise<Map<UrlPassFile, Promise<number>>> {
  const results = new Map<UrlPassFile, Promise<number>>();
  const sinks: Sink[] = [];
  const pendingDrains: Promise<void>[] = [];
  const write = (sink: Sink, flushAt: number): void => {
    if (sink.failed || sink.buf.length < flushAt) return;
    const ok = sink.out.write(sink.buf);
    sink.buf = '';
    if (!ok)
      pendingDrains.push(
        once(sink.out, 'drain').then(
          () => undefined,
          () => undefined,
        ),
      );
  };
  for (const { file, partPath } of targets) {
    // Listed before the file's `.part` is opened: a category that cannot
    // be listed fails its file only, and leaves no `.part` open.
    let ids: Uint32Array | null;
    try {
      ids = file.category === 'all' ? null : db.urlIdsByCategory(file.category);
    } catch (err) {
      results.set(file, Promise.reject(err as Error));
      results.get(file)!.catch(() => undefined);
      continue;
    }
    const out = createWriteStream(partPath, { encoding: 'utf8' });
    const sink: Sink = { file, ids, next: 0, out, buf: file.head, rows: 0, failed: false };
    results.set(
      file,
      new Promise<number>((resolve, reject) => {
        out.on('error', (err) => {
          sink.failed = true;
          reject(err);
        });
        out.on('finish', () => resolve(sink.rows));
      }),
    );
    // A failed file must not stop the others; its error is read from `results`.
    results.get(file)!.catch(() => undefined);
    sinks.push(sink);
  }
  // Every file's rows are in one id list or another: a file whose list
  // is empty takes no part in the walk.
  const active = sinks.filter((s) => s.ids === null || s.ids.length > 0);
  try {
    if (active.length > 0) {
      for (const row of db.iterateUrlsByCategory('all')) {
        for (const sink of active) {
          if (sink.failed) continue;
          if (sink.ids) {
            const ids = sink.ids;
            while (sink.next < ids.length && ids[sink.next]! < row.id) sink.next++;
            if (sink.next >= ids.length || ids[sink.next] !== row.id) continue;
            sink.next++;
          }
          let line: string | null;
          try {
            line = sink.file.line(row);
          } catch (err) {
            // A row this file cannot build fails this file only.
            sink.failed = true;
            sink.out.destroy(err as Error);
            continue;
          }
          if (line === null) continue;
          sink.rows++;
          sink.buf += line;
          write(sink, FLUSH_CHARS);
        }
        if (pendingDrains.length) await Promise.all(pendingDrains.splice(0));
      }
    }
  } catch (err) {
    for (const sink of sinks) if (!sink.failed) sink.out.destroy(err as Error);
    return results;
  }
  for (const sink of sinks) {
    write(sink, 0);
    sink.out.end();
  }
  return results;
}

/**
 * Writes `files` in one pass over the urls table. Settles per file, in
 * the order given: the row count, or that file's error.
 */
export async function writeUrlFilesInOnePass(
  db: ProjectDb,
  files: readonly UrlPassFile[],
): Promise<PromiseSettledResult<number>[]> {
  // Each file keeps its own `.part` + rename; the writes share one pass,
  // started once every file's `.part` path is known.
  const targets: { file: UrlPassFile; partPath: string }[] = [];
  let ready!: () => void;
  const allReady = new Promise<void>((resolve) => (ready = resolve));
  let pass: Promise<Map<UrlPassFile, Promise<number>>> | undefined;
  let waiting = files.length;
  const settle = (): void => {
    if (--waiting === 0) ready();
  };
  const runs = files.map((file) =>
    writeExportFile(
      file.filePath,
      async (partPath) => {
        targets.push({ file, partPath });
        settle();
        await allReady;
        pass ??= writePass(db, targets);
        return (await pass).get(file)!;
      },
      file.keep,
    ).catch((err: unknown) => {
      // Failed before its write started (folder not creatable): the pass
      // must not wait for it.
      if (!targets.some((t) => t.file === file)) settle();
      throw err;
    }),
  );
  if (files.length === 0) ready();
  return Promise.allSettled(runs);
}
