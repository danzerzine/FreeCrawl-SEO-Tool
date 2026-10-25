import type * as Fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

// B203: when the copy of a read-only project runs out of space, the message names the folder the user
// chose for working files, not the temp folder made inside it.
const disk = vi.hoisted(() => ({ full: false }));

vi.mock('node:fs', async (orig) => {
  const fs = await orig<typeof Fs>();
  return {
    ...fs,
    copyFileSync: (from: string, to: string) => {
      if (disk.full) throw Object.assign(new Error('ENOSPC: no space left on device, copyfile'), { code: 'ENOSPC' });
      return fs.copyFileSync(from, to);
    },
  };
});

const fs = await import('node:fs');
const { ProjectDb, workFolder } = await import('@freecrawl/db');
const { openCompareProject } = await import('./compare.js');

let dir: string;
let work: string;

beforeEach(() => {
  disk.full = false;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-b203-'));
  work = path.join(dir, 'work-root');
  fs.mkdirSync(work);
});
afterEach(() => {
  disk.full = false;
  fs.rmSync(dir, { recursive: true, force: true });
});

it('a read-only project whose copy does not fit: the message names the chosen working folder (B203)', async () => {
  const file = path.join(dir, 'site.seoproject');
  new ProjectDb(file).close();
  fs.chmodSync(file, 0o444);
  disk.full = true;
  const err = await openCompareProject(file, work).then(
    () => null,
    (e: unknown) => e as Error,
  );
  expect(err).not.toBeNull();
  expect(err!.message).toMatch(/^Not enough free space in /);
  expect(err!.message).toContain(workFolder(work));
  expect(err!.message).not.toContain('freecrawl-compare-');
});
