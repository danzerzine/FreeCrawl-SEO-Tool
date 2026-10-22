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

const DESKTOP_WORKING_COPY = /^work-\d+-\d+\.seoproject(-wal|-shm)?$/;
const AGENT_SCRATCH = /^agent-\d+-\d+\.seoproject(-wal|-shm)?$/;
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

const SAVE_TEMP = /^freecrawl-save-(\d+)-\d+-\d+\.seoproject(-wal|-shm)?$/;

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
