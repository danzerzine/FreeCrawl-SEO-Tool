import * as fs from 'node:fs';
import { expect, it } from 'vitest';

// The reader worker only dispatches the methods in ALLOWED_METHODS; without the new one the
// Lighthouse detail tab could not read its rows. The worker runs on import, so read the source.
it('the reader-worker whitelist holds queryPagespeedAudits next to queryPagespeed (B41 R9)', () => {
  const src = fs.readFileSync(new URL('./db-reader-worker.ts', import.meta.url), 'utf8');
  const block = /const ALLOWED_METHODS = new Set<string>\(\[([\s\S]*?)\]\);/.exec(src)?.[1] ?? '';
  const names = [...block.matchAll(/'([A-Za-z]+)'/g)].map((x) => x[1]);
  expect(names).toContain('queryPagespeed');
  expect(names).toContain('queryPagespeedAudits');
});
