/**
 * Every export file is written as `<name>.part` beside its target and
 * renamed over it only once complete, so a crash, a full disk or a
 * Ctrl-C never leaves a truncated CSV that reads as a smaller result.
 * The target's directory is created when missing.
 */

import { rmSync } from 'node:fs';
import { mkdir, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';

/** `.part` files being written right now — see {@link removePartialExportFiles}. */
const inFlight = new Set<string>();

/**
 * Run `write` against `<filePath>.part`, then rename it to `filePath`.
 * When `keep` rejects the result (an empty category), nothing is kept:
 * the `.part` and any earlier file of that name are removed, so a rerun
 * never leaves an old list next to the new ones. On failure the `.part`
 * is removed and the earlier file, if any, stays untouched.
 */
export async function writeExportFile<T>(
  filePath: string,
  write: (partPath: string) => Promise<T>,
  keep: (result: T) => boolean = () => true,
): Promise<T> {
  // Already a temp file of an outer writeExportFile: that call owns the
  // rename, so a second `.part` layer would only double the work.
  if (filePath.endsWith('.part')) return write(filePath);
  await mkdir(dirname(filePath), { recursive: true });
  const partPath = `${filePath}.part`;
  inFlight.add(partPath);
  try {
    const result = await write(partPath);
    if (keep(result)) {
      await rename(partPath, filePath);
    } else {
      await rm(partPath, { force: true });
      await rm(filePath, { force: true });
    }
    return result;
  } catch (err) {
    await rm(partPath, { force: true }).catch(() => undefined);
    throw err;
  } finally {
    inFlight.delete(partPath);
  }
}

/**
 * Synchronously delete every `.part` still being written. For exit hooks
 * (Ctrl-C in the CLI), where the pending writes never get to clean up.
 */
export function removePartialExportFiles(): void {
  for (const partPath of inFlight) {
    try {
      rmSync(partPath, { force: true });
    } catch {
      /* left behind; the next export of that file overwrites it */
    }
  }
  inFlight.clear();
}

/**
 * The lines joined into blocks of about `size` characters, for
 * `Readable.from`: one stream chunk per block rather than per line.
 * Same bytes, in the same order.
 */
export async function* inBlocks(lines: Iterable<string>, size = 1 << 16): AsyncGenerator<string> {
  let buf = '';
  for (const line of lines) {
    buf += line;
    if (buf.length >= size) {
      yield buf;
      buf = '';
    }
  }
  if (buf) yield buf;
}
