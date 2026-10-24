import { spawnSync } from 'node:child_process';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// The desktop main bundle is CommonJS and loads the built worker with require(), which
// refuses an ES module with top-level await. Load the built file the same way.
const built = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dist/link-suggestions-worker.js');

describe('link-suggestions worker loads with require()', () => {
  it('gets as far as its own worker_threads check', () => {
    const run = spawnSync(process.execPath, ['-e', `require(${JSON.stringify(built)})`], {
      encoding: 'utf8',
    });
    expect(run.stderr).not.toContain('ERR_REQUIRE_ASYNC_MODULE');
    expect(run.stderr).toContain('must be loaded via worker_threads');
  });
});
