import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Built from pieces so this file never holds the literals it forbids.
const REAL_HOSTS = ['api.' + 'github.com', 'basecamp' + 'api.com'];
/** The one file allowed to name the real hosts (desktop layer, part 2). */
const ALLOWED = ['apps', 'desktop', 'src', 'main', 'tracker-constants.ts'].join('/');

/** Paths (repo-relative, `/`-separated) whose text names a real tracker host. */
function realHostHits(files: Record<string, string>): string[] {
  return Object.entries(files)
    .filter(([path, text]) => path !== ALLOWED && REAL_HOSTS.some((h) => text.includes(h)))
    .map(([path]) => path);
}

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (['node_modules', 'dist', 'out', 'out-types', 'build', 'release', '.git'].includes(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

/** Test files, test support and the tracker modules: where a real host must never appear. */
function scanned(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const top of ['packages', 'apps']) {
    for (const p of walk(join(ROOT, top))) {
      if (!/\.(ts|tsx|mjs)$/.test(p)) continue;
      const rel = relative(ROOT, p).split(sep).join('/');
      if (/\.test\.|\.test-support\.|\/issue-task|tracker/.test(rel)) out[rel] = readFileSync(p, 'utf8');
    }
  }
  return out;
}

describe('no real tracker host in tests or tracker code', () => {
  it('finds nothing outside the desktop constants file', () => {
    expect(realHostHits(scanned())).toEqual([]);
  });

  it('would fail on an injected GitHub or Basecamp host in a test file', () => {
    expect(realHostHits({ 'packages/core/src/x.test.ts': `fetch("https://${REAL_HOSTS[0]}/repos")` })).toEqual([
      'packages/core/src/x.test.ts',
    ]);
    expect(realHostHits({ 'apps/desktop/src/main/x.test.ts': `base = '${REAL_HOSTS[1]}'` })).toHaveLength(1);
  });

  it('allows the host in the desktop constants file only', () => {
    expect(realHostHits({ [ALLOWED]: `export const GH = 'https://${REAL_HOSTS[0]}'` })).toEqual([]);
  });
});
