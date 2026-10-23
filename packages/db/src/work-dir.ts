import { mkdirSync, readdirSync, rmSync, statfsSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { WorkDirProblem } from '@freecrawl/shared-types';

/*
 * Where projects are unpacked and worked on. The desktop app, the CLI and
 * the MCP server use a folder the user chose (a big disk instead of C:) via
 * a dedicated subfolder in it, so a sweep there can never touch the user's
 * own files.
 */

/** The subfolder FreeCrawl keeps its working files in, inside a chosen folder. */
export const WORK_SUBDIR = 'FreeCrawl-work';

/**
 * Unpacked bytes per packed byte, for the free-space check before an
 * unpack: the largest ratio measured (10.9, a 5.5 GB crawl of 261k URLs;
 * a 108 MB one gave 1.73), plus 25 %.
 */
export const UNPACKED_PER_PACKED = 13.6;

/**
 * Packed bytes per database byte, for the check before a save: from the
 * smallest ratio measured (1.73), plus 25 %. The largest would promise a
 * small project an eighth of the space its archive takes.
 */
export const PACKED_PER_UNPACKED = 0.72;

/** `<dir>/FreeCrawl-work`: the working folder inside a chosen folder. */
export function workFolder(dir: string): string {
  return join(dir, WORK_SUBDIR);
}

const PROBLEM_TEXT: Record<WorkDirProblem, string> = {
  network: 'a network folder, where the project database is not safe',
  missing: 'the folder does not exist',
  'not-a-folder': 'not a folder',
  'not-writable': 'the folder is not writable',
};

/** The problem in words, for the command line and logs. */
export function workDirProblemText(problem: WorkDirProblem): string {
  return PROBLEM_TEXT[problem];
}

/**
 * Why a chosen folder cannot hold working copies, or null when it can. A
 * network path is refused: SQLite's write-ahead log is not safe there. On
 * success the working subfolder exists.
 */
export function workDirProblem(dir: string): WorkDirProblem | null {
  if (/^(\\\\|\/\/)/.test(dir)) return 'network';
  try {
    if (!statSync(dir).isDirectory()) return 'not-a-folder';
  } catch {
    return 'missing';
  }
  // Write access is tried, not read from the mode bits: Windows ACLs and
  // read-only mounts do not show there.
  try {
    const sub = workFolder(dir);
    mkdirSync(sub, { recursive: true });
    const probe = join(sub, `.probe-${process.pid}`);
    writeFileSync(probe, '');
    rmSync(probe, { force: true });
  } catch {
    return 'not-writable';
  }
  return null;
}

const DESKTOP_WORKING_COPY = /^work-\d+-\d+\.seoproject(-wal|-shm|-journal)?$/;
const AGENT_SCRATCH = /^agent-\d+-\d+\.seoproject(-wal|-shm|-journal)?$/;
const CLI_WORKING_COPY = /^freecrawl-cli-[A-Za-z0-9]{6}$/;

/** A desktop working copy (`work-<pid>-<n>.seoproject`) or one of its SQLite sidecars. */
export function isDesktopWorkingCopy(name: string): boolean {
  return DESKTOP_WORKING_COPY.test(name);
}

/** An MCP agent session's scratch project (`agent-<n>-<pid>.seoproject`) or a sidecar. */
export function isAgentScratch(name: string): boolean {
  return AGENT_SCRATCH.test(name);
}

/** A CLI / MCP working-copy folder, as `mkdtemp` names it. */
export function isCliWorkingCopy(name: string): boolean {
  return CLI_WORKING_COPY.test(name);
}

const SAVE_TEMP = /^freecrawl-save-(\d+)-\d+-\d+\.seoproject(-wal|-shm|-journal)?$/;

/** The desktop's snapshot before a pack (`freecrawl-save-<pid>-…`): the pid that wrote it, else null. */
export function saveTempPid(name: string): number | null {
  const m = SAVE_TEMP.exec(name);
  return m ? Number(m[1]) : null;
}

/**
 * Delete the desktop's throwaway files in `dir`: working copies, agent
 * scratch projects and save snapshots, each by its exact name, unless
 * `keep(path)` says it is live. Nothing else in the folder is touched.
 */
export function sweepWorkingFolder(dir: string, keep: (path: string) => boolean): void {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (!isDesktopWorkingCopy(name) && !isAgentScratch(name) && saveTempPid(name) === null)
      continue;
    const full = join(dir, name);
    if (keep(full)) continue;
    try {
      rmSync(full, { force: true });
    } catch {
      /* still locked by a second instance — leave it */
    }
  }
}

/** Older than this, a half-written unpack or a compare copy is a crash leftover, not work in progress. */
export const LEFTOVER_MIN_AGE_MS = 24 * 60 * 60 * 1000;

const PARTIAL_UNPACK = /^(work|agent)-\d+-\d+\.seoproject\.part$/;
const COMPARE_COPY = /^freecrawl-compare-[A-Za-z0-9]{6}$/;

/** `work-<pid>-<n>.seoproject.part`: an unpack that crashed before its rename. */
export function isPartialUnpack(name: string): boolean {
  return PARTIAL_UNPACK.test(name);
}

/** `freecrawl-compare-XXXXXX`: the temporary copy of a comparison, as `mkdtemp` names it. */
export function isCompareCopy(name: string): boolean {
  return COMPARE_COPY.test(name);
}

/** Newest modification time of a file, or of a folder and its direct files (a copy being written grows a file, not the folder). */
function newestMtimeMs(path: string): number {
  const st = statSync(path);
  let newest = st.mtimeMs;
  if (st.isDirectory()) {
    for (const child of readdirSync(path)) {
      try {
        newest = Math.max(newest, statSync(join(path, child)).mtimeMs);
      } catch {
        /* vanished meanwhile */
      }
    }
  }
  return newest;
}

/**
 * Delete what a crash leaves in `dir` that no later step cleans: unpack
 * `.part` files and compare copies. Only entries untouched for `minAgeMs`
 * (default a day) go, so a project being opened or compared right now,
 * here or in a second instance, is never hit. Returns the names removed.
 */
export function sweepCrashLeftovers(
  dir: string,
  opts: { now?: number; minAgeMs?: number } = {},
): string[] {
  const now = opts.now ?? Date.now();
  const minAge = opts.minAgeMs ?? LEFTOVER_MIN_AGE_MS;
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const removed: string[] = [];
  for (const name of names) {
    if (!isPartialUnpack(name) && !isCompareCopy(name)) continue;
    const full = join(dir, name);
    try {
      if (now - newestMtimeMs(full) < minAge) continue;
      rmSync(full, { recursive: true, force: true });
      removed.push(name);
    } catch {
      /* locked or gone — leave it */
    }
  }
  return removed;
}

type StatFs = (path: string) => { bavail: number | bigint; bsize: number | bigint };

/** Bytes free for this user on the disk holding `dir`. */
export function freeBytes(dir: string, statfs: StatFs = statfsSync): number {
  const s = statfs(dir);
  return Number(s.bavail) * Number(s.bsize);
}

const gb = (n: number) => `${(n / 1024 ** 3).toFixed(1)} GB`;

/** The message for a disk too full for a step: folder, free and needed size. */
export function noSpaceMessage(dir: string, free: number, needed: number): string {
  return `Not enough free space in ${dir}: ${gb(free)} free, ${gb(needed)} needed.`;
}

/** Throws the no-space message when `dir` has less than `needed` bytes free. */
export function checkFreeSpace(dir: string, needed: number, statfs: StatFs = statfsSync): void {
  const free = freeBytes(dir, statfs);
  if (free < needed) throw new Error(noSpaceMessage(dir, free, needed));
}

/** True for a write that failed on a full disk (Node or SQLite). */
export function isDiskFull(err: unknown): boolean {
  const e = err as { code?: unknown; message?: unknown } | null;
  return (
    e?.code === 'ENOSPC' ||
    e?.code === 'SQLITE_FULL' ||
    (typeof e?.message === 'string' && /ENOSPC|database or disk is full/i.test(e.message))
  );
}

/** A full-disk failure of a step in `dir` as the no-space message; any other error as it is. */
export function asNoSpaceError(err: unknown, dir: string, needed: number): unknown {
  return isDiskFull(err) ? new Error(noSpaceMessage(dir, freeBytes(dir), needed)) : err;
}

const MAX_PREVIOUS_WORK_DIRS = 10;

/**
 * The remembered list of working folders left behind (B152), newest first,
 * after switching from `left` to `dir`: the folder being left goes on top
 * (still holds files that may be open), the new one comes off the list.
 */
export function nextPreviousWorkDirs(
  previous: readonly string[],
  left: unknown,
  dir: string | null,
): string[] {
  const others = previous.filter((d) => d !== left && d !== dir);
  return typeof left === 'string' && left !== dir
    ? [left, ...others].slice(0, MAX_PREVIOUS_WORK_DIRS)
    : others;
}

/**
 * Folders the startup sweep covers: the app's own folder, the active one and
 * every previous working folder; plus the OS temp folder, where a comparison
 * copy lands when no working folder is set (B110).
 */
export function sweepTargets(input: {
  defaultDir: string;
  activeDir: string;
  previous: readonly string[];
  tmp: string;
}): { workingFolders: string[]; tmpDir: string } {
  return {
    workingFolders: [
      ...new Set([input.defaultDir, input.activeDir, ...input.previous.map((d) => workFolder(d))]),
    ],
    tmpDir: input.tmp,
  };
}

/** A working copy's path without a SQLite sidecar suffix (`-wal`, `-shm`, `-journal`). */
export function bareWorkingCopyPath(full: string): string {
  return full.replace(/-(wal|shm|journal)$/, '');
}
