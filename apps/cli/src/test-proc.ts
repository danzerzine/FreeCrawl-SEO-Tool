import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams, type SpawnOptions } from 'node:child_process';

// Test helper: every CLI child a test spawns is killed when the test file ends or
// a test fails, so no `freecrawl` process outlives the run. The CLI starts no
// subprocesses of its own, so the child pid is killed directly. Children are not
// detached: a detached child would stop receiving the abort signal on Ctrl-C.
const live = new Set<ChildProcess>();

// Default stdio is three pipes, so the streams are typed non-null as with node's own spawn.
export function spawnTracked(cmd: string, args: string[]): ChildProcessWithoutNullStreams;
export function spawnTracked(cmd: string, args: string[], opts: SpawnOptions): ChildProcess;
export function spawnTracked(cmd: string, args: string[], opts: SpawnOptions = {}): ChildProcess {
  const child = spawn(cmd, args, opts);
  live.add(child);
  child.on('exit', () => live.delete(child));
  return child;
}

export function killChild(child: ChildProcess): void {
  if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) return;
  try {
    child.kill('SIGKILL');
  } catch {
    /* already gone */
  }
}

/** Call from afterEach / afterAll. */
export function killAllChildren(): void {
  for (const c of [...live]) killChild(c);
  live.clear();
}

/** Poll until `cond` holds. The ceiling is generous: it only matters when the event never comes. */
export async function waitFor(cond: () => boolean, ceilingMs = 90_000, stepMs = 25): Promise<boolean> {
  for (const end = Date.now() + ceilingMs; Date.now() < end; ) {
    try {
      if (cond()) return true;
    } catch {
      /* file or database not ready yet */
    }
    await new Promise((r) => setTimeout(r, stepMs));
  }
  return cond();
}
