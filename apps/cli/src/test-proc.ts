import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';

// Test helper: every CLI child a test spawns is killed, with its whole process
// group, when the test file ends or a test fails, so no `freecrawl` process
// outlives the run. Children lead their own group (detached) so that worker
// processes they start go with them.
const live = new Set<ChildProcess>();

export function spawnTracked(cmd: string, args: string[], opts: SpawnOptions = {}): ChildProcess {
  const child = spawn(cmd, args, { ...opts, detached: true });
  live.add(child);
  child.on('exit', () => live.delete(child));
  return child;
}

export function killChild(child: ChildProcess): void {
  if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) return;
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    try {
      child.kill('SIGKILL');
    } catch {
      /* already gone */
    }
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
