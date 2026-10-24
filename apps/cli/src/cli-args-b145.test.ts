import { spawnSync } from 'node:child_process';
import { availableParallelism } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// Drives the built CLI as a process (`npm run build:cli` first). Bad values fail before any request.
const CLI = join(__dirname, '../dist/index.js');
const run = (...args: string[]) =>
  spawnSync(process.execPath, [CLI, 'http://127.0.0.1:9/', ...args], { encoding: 'utf8' });

describe('numeric flag values (B145, B149)', () => {
  it('--night-rps -1 as two arguments reaches our own check', () => {
    const r = run('--night-rps', '-1');
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('Invalid --night-rps: -1');
  });

  it('a negative number after another value option is checked the same way', () => {
    const r = run('--max', '-5');
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('Invalid --max: -5');
  });

  it('--parse-workers above the number of CPU cores exits 2', () => {
    const r = run('--parse-workers', '100000');
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('Invalid --parse-workers: 100000');
    expect(r.stderr).toContain(`at most ${availableParallelism()}`);
  });
});
