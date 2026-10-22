import { spawnSync } from 'node:child_process';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

// Drives the built CLI (`npm run build:cli` first).
const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dist/index.js');

it('--help lists --concurrency and --page-script, and the script has no default (B34)', () => {
  const r = spawnSync(process.execPath, [CLI, '--help'], { encoding: 'utf8', timeout: 20000 });
  expect(r.status).toBe(0);
  expect(r.stdout).toMatch(/--concurrency <n>\s+Max parallel requests \(default: \d+\)/);
  const entry = r.stdout.slice(r.stdout.indexOf('--page-script'), r.stdout.indexOf('--rps'));
  expect(entry).toContain('--page-script <file>');
  expect(entry).not.toContain('(default:');
});
