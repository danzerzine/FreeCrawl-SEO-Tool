/**
 * Where a project's screenshot PNGs may live, shared by the desktop's
 * screenshot viewer and `--what screenshots`: only PNG files inside a
 * sidecar folder named after the project file (`<name>.screenshots/`).
 */

import { basename, dirname, join, resolve, sep } from 'node:path';

/** The sidecar folder of the project file (or scratch database) `basePath`. */
export function screenshotDirFor(basePath: string): string {
  return join(dirname(basePath), `${basename(basePath)}.screenshots`);
}

/**
 * `candidate` resolved, when it is a `.png` inside one of `roots`;
 * otherwise null. Both sides are resolved first so `..` cannot climb out,
 * and the root gets a separator so `<root>2` does not match `<root>`.
 */
export function pngInsideRoots(candidate: string, roots: readonly string[]): string | null {
  if (typeof candidate !== 'string' || candidate.length === 0) return null;
  const resolved = resolve(candidate);
  const inside = roots.some((root) => {
    const r = resolve(root);
    return resolved === r || resolved.startsWith(r + sep);
  });
  if (!inside) return null;
  return resolved.toLowerCase().endsWith('.png') ? resolved : null;
}

/**
 * The file a stored screenshot path stands for under the project's current
 * `roots`. A path inside a root is itself. A path from a sidecar of another
 * place or name (the project was moved, renamed or Save-As'd; the stored
 * path still names the old `<name>.screenshots/` folder) is looked up by
 * file name in the current root. Anything else is null: outside the project.
 */
export function locateScreenshot(stored: string, roots: readonly string[]): string | null {
  const direct = pngInsideRoots(stored, roots);
  if (direct) return direct;
  if (!basename(dirname(stored)).endsWith('.screenshots')) return null;
  for (const root of roots) {
    const moved = pngInsideRoots(join(root, basename(stored)), [root]);
    if (moved) return moved;
  }
  return null;
}
