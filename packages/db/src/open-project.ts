import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { detectProjectFormat, packProject, unpackProject } from './project-archive.js';
import { ProjectDb } from './project-db.js';
import {
  asNoSpaceError,
  checkFreeSpace,
  isCliWorkingCopy,
  PACKED_PER_UNPACKED,
  UNPACKED_PER_PACKED,
  workFolder,
} from './work-dir.js';

/*
 * Opening a project file the desktop app may have saved, shared by the CLI
 * and the MCP server: one lock and one working-copy scheme, so each removes
 * the copies the other left behind.
 */

/** An existing project a command reads or updates. */
export interface OpenedProject {
  db: ProjectDb;
  /** Close the database and, for a desktop-saved project, pack the working
   *  copy back onto the original file. Call only after a successful write. */
  save(): Promise<void>;
  /** Close the database if still open and delete any working copy. Runs
   *  on every exit path; never repacks. */
  dispose(): void;
}

/**
 * Take `<project>.lock` for a write to a desktop-saved project, so two CLI
 * commands can't each repack the archive and drop the other's data. A lock
 * whose process is gone (killed, crashed) is taken over. Returns the
 * release function, which deletes the lock only while it is still ours;
 * throws a user-facing message when the lock is held.
 */
export function lockProject(path: string): () => void {
  const lockPath = `${path}.lock`;
  const inUse = (holder: number | string): Error =>
    new Error(
      `The project is in use by another FreeCrawl CLI command (pid ${holder}). ` +
        `Wait for it to finish, or delete ${lockPath} if no such command is running.`,
    );
  for (let attempt = 0; attempt < 3; attempt++) {
    const mine = createExclusive(lockPath);
    if (mine !== null) return () => removeIfUnchanged(lockPath, mine);
    const seen = readIfExists(lockPath);
    if (seen === null) continue; // released meanwhile
    const holder = lockHolder(lockPath, seen);
    if (holder !== null) throw inUse(holder);
    removeStale(lockPath, seen, inUse);
  }
  throw inUse('unknown');
}

/**
 * Delete the stale `file`, which held `content`, so that only one process
 * ever does it. A plain check-then-delete would let a slow process delete
 * the fresh lock a faster one had just created. Instead the delete happens
 * only under an exclusive guard named after `content`: every lock and guard
 * is written with unique content, which never reappears once deleted, so
 * the guard holder knows the file it re-reads is the same stale one (a
 * half-written file has no id, so for it the age is checked again). A
 * guard left by a crashed process is cleared the same way, one level up.
 */
function removeStale(
  file: string,
  content: string,
  inUse: (holder: number | string) => Error,
  depth = 0,
): void {
  const guardPath = `${file.replace(/\.takeover-[0-9a-f]+$/, '')}.takeover-${createHash('sha256')
    .update(content)
    .digest('hex')
    .slice(0, 16)}`;
  let guard = createExclusive(guardPath);
  if (guard === null) {
    const guardSeen = readIfExists(guardPath);
    if (guardSeen !== null) {
      const holder = lockHolder(guardPath, guardSeen);
      if (holder !== null) throw inUse(holder);
      if (depth >= 3) throw inUse('unknown');
      removeStale(guardPath, guardSeen, inUse, depth + 1);
    }
    guard = createExclusive(guardPath);
    if (guard === null) throw inUse('unknown');
  }
  try {
    const now = readIfExists(file);
    if (now === content && lockHolder(file, now) === null) rmSync(file, { force: true });
  } finally {
    removeIfUnchanged(guardPath, guard);
  }
}

/** Create `file` exclusively with this process's pid, start time and a
 *  unique id; returns what was written, or null when it already exists. */
function createExclusive(file: string): string | null {
  let fd: number;
  try {
    fd = openSync(file, 'wx');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return null;
    throw err;
  }
  const content = JSON.stringify({
    pid: process.pid,
    startedAt: new Date().toISOString(),
    id: randomUUID(),
  });
  try {
    writeSync(fd, content);
  } finally {
    closeSync(fd);
  }
  return content;
}

export function readIfExists(file: string): string | null {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

/** Delete `file` only if it still holds `content`. */
function removeIfUnchanged(file: string, content: string): void {
  if (readIfExists(file) === content) rmSync(file, { force: true });
}

/** The pid of a live holder of the lock `file`, which holds `content`, or
 *  null when the lock is stale. */
function lockHolder(file: string, content: string): number | string | null {
  let pid: unknown;
  try {
    pid = (JSON.parse(content) as { pid?: unknown }).pid;
  } catch {
    // Unreadable or half-written: its owner may be writing it right now,
    // so only an old one counts as stale.
    try {
      return Date.now() - statSync(file).mtimeMs < 10_000 ? 'unknown' : null;
    } catch {
      return null;
    }
  }
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return null;
  try {
    process.kill(pid, 0);
    return pid;
  } catch (err) {
    // EPERM: the process exists but belongs to someone else.
    return (err as NodeJS.ErrnoException).code === 'EPERM' ? pid : null;
  }
}

const WORKING_COPY_PREFIX = 'freecrawl-cli-';
/** Owner file in each working copy directory, written like a lock. */
const WORKING_COPY_OWNER = 'owner.lock';

/**
 * Remove the working copies that commands killed outright (a hard kill,
 * a crash, a shutdown) left in the temp directory: no exit hook runs then,
 * and each copy is the size of the unpacked project. A copy is orphaned
 * when the process in its owner file is gone, or, with no owner file, when
 * it is over an hour old. Best effort: anything still in use stays.
 */
function removeOrphanedWorkingCopies(base: string): void {
  let entries;
  try {
    entries = readdirSync(base, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !isCliWorkingCopy(entry.name)) continue;
    const dir = join(base, entry.name);
    try {
      const ownerPath = join(dir, WORKING_COPY_OWNER);
      const owner = readIfExists(ownerPath);
      const orphaned =
        owner === null
          ? Date.now() - statSync(dir).mtimeMs > 3_600_000
          : lockHolder(ownerPath, owner) === null;
      if (orphaned) rmSync(dir, { recursive: true, force: true });
    } catch {
      /* in use or not ours to remove; tried again on the next run */
    }
  }
}

export interface OpenProjectOptions {
  /** A missing path becomes a new bare project. */
  createIfMissing?: boolean;
  /** Lock a desktop-saved project until `dispose()`. */
  forWrite?: boolean;
  /** Open the database read-only; `save()` never packs back. */
  readOnly?: boolean;
  /** A folder for the working copy of a desktop-saved project, which goes
   *  into its `FreeCrawl-work` subfolder; default the OS temp folder. */
  workDir?: string;
  /** Cleanups the caller runs on exit: `dispose` is in it from before the
   *  first await until it has run, so an exit at any point removes the
   *  working copy and the lock. */
  cleanups?: Set<() => void>;
}

/**
 * Open an existing project file. The desktop app saves projects as a
 * compressed container (`packProject`), which is unpacked into a fresh temp
 * directory and opened there; `save()` packs it back. A bare SQLite project
 * (a CLI crawl, or a desktop save from before the container) opens in place,
 * as it always has. With `createIfMissing`, a missing path becomes a new
 * bare project. With `forWrite`, a desktop-saved project is locked (see
 * `lockProject`) until `dispose()`; bare SQLite relies on SQLite's own
 * locking. With `readOnly` the database opens read-only and nothing is ever
 * packed back (the MCP server). Throws with a user-facing message on a
 * missing, unrecognised or locked file.
 *
 * The desktop app works on its own working copy, so if it has the same
 * project open, its next Save overwrites whatever the CLI wrote.
 */
export async function openProject(
  path: string,
  opts: OpenProjectOptions = {},
): Promise<OpenedProject> {
  let dir: string | null = null;
  let workingPath: string | null = null;
  let unlock: (() => void) | null = null;
  if (!existsSync(path)) {
    if (!opts.createIfMissing) throw new Error(`Project not found: ${path}`);
  } else {
    const format = detectProjectFormat(path);
    if (format === 'unknown') {
      throw new Error(
        'This file is not a FreeCrawl project (unrecognised format). It may be corrupt or a different file type.',
      );
    }
    if (format === 'archive') {
      const base = opts.workDir ? workFolder(opts.workDir) : tmpdir();
      if (opts.workDir) mkdirSync(base, { recursive: true });
      removeOrphanedWorkingCopies(base);
      if (opts.forWrite) unlock = lockProject(path);
      // Created synchronously and registered below before anything awaits,
      // so an exit at any later point still removes it (and the lock).
      try {
        dir = mkdtempSync(join(base, WORKING_COPY_PREFIX));
        try {
          if (createExclusive(join(dir, WORKING_COPY_OWNER)) === null) {
            throw new Error(`Could not create the working copy in ${dir}`);
          }
        } catch (err) {
          rmSync(dir, { recursive: true, force: true });
          throw err;
        }
      } catch (err) {
        unlock?.();
        throw err;
      }
      workingPath = join(dir, basename(path));
    }
  }

  let db: ProjectDb | undefined;
  let packing = false;
  const close = (): void => {
    const open = db;
    db = undefined;
    open?.close();
  };
  const dispose = (): void => {
    opts.cleanups?.delete(dispose);
    try {
      close();
    } catch {
      /* already gone — the files are removed regardless */
    }
    // Separate steps, so one busy file (Windows refuses files an
    // interrupted pack still holds open) doesn't stop the others.
    if (packing) {
      // Interrupted mid-pack: drop the half-written file; the original
      // project is only replaced by the final rename.
      try {
        rmSync(`${path}.part`, { force: true });
      } catch {
        /* left beside the project; the next save overwrites it */
      }
    }
    if (dir) {
      try {
        // The SQLite sidecars (-wal / -shm) live in the same directory.
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* left in the temp directory */
      }
    }
    if (unlock) {
      try {
        unlock();
      } catch {
        /* a stale lock is taken over by the next command */
      }
    }
  };
  opts.cleanups?.add(dispose);

  try {
    if (dir && workingPath) {
      const needed = statSync(path).size * UNPACKED_PER_PACKED;
      // Named in the message: the chosen folder, not the copy's temporary one.
      const spaceDir = opts.workDir ?? dirname(dir);
      checkFreeSpace(spaceDir, needed);
      try {
        await unpackProject(path, workingPath);
      } catch (err) {
        throw asNoSpaceError(err, spaceDir, needed);
      }
    }
    db = new ProjectDb(workingPath ?? path, { readOnly: opts.readOnly });
  } catch (err) {
    dispose();
    throw err;
  }
  return {
    db,
    async save() {
      close();
      if (!workingPath || opts.readOnly) return;
      // The archive is written beside the project, then renamed over it.
      const target = dirname(path);
      const needed = statSync(workingPath).size * PACKED_PER_UNPACKED;
      checkFreeSpace(target, needed);
      packing = true;
      try {
        await packProject(workingPath, path);
      } catch (err) {
        throw asNoSpaceError(err, target, needed);
      }
      packing = false;
    },
    dispose,
  };
}
