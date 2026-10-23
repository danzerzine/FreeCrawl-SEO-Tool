import * as fs from 'node:fs';
import { describe, expect, it } from 'vitest';

const names = (file: string, setName: string): string[] => {
  const src = fs.readFileSync(new URL(file, import.meta.url), 'utf8');
  const block = new RegExp(`const ${setName} = new Set<string>\\(\\[([\\s\\S]*?)\\n\\]\\);`).exec(src)?.[1] ?? '';
  return [...block.matchAll(/'([A-Za-z0-9]+)'/g)].map((x) => x[1]!);
};

// Both workers run on import and dispatch only the methods listed in their sets, so read the source.
describe('worker whitelists for axe (B40 R8, R13)', () => {
  it('the writer worker may call setUrlAxe next to setUrlA11y', () => {
    const w = names('./db-writer-worker.ts', 'ALLOWED_METHODS');
    expect(w).toContain('setUrlA11y');
    expect(w).toContain('setUrlAxe');
  });
  it('the reader worker may call queryAxe next to queryPagespeedAudits', () => {
    const r = names('./db-reader-worker.ts', 'ALLOWED_METHODS');
    expect(r).toContain('queryAxe');
  });
});
