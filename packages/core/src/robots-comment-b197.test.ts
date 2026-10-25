import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { validateRobotsTxt } from './robots.js';

// B197: the comment is cut at the first '#' with indexOf, not with a regex that CodeQL reads as polynomial.
describe('robots.txt comment stripping (B197)', () => {
  it('cuts a comment at the first # and keeps the directive before it', () => {
    expect(validateRobotsTxt('User-agent: *\nDisallow: /a # not allowed\n# whole line\nAllow: /b#x\n')).toEqual([]);
  });

  it('a line that is only a comment, or becomes empty, is not a syntax error', () => {
    expect(validateRobotsTxt('   # just a note\n#\n')).toEqual([]);
  });

  it('a # inside the value ends the value there: the rest is a comment, so the directive can lose its colon', () => {
    const issues = validateRobotsTxt('User-agent: *\nDisallow #: /x\n');
    expect(issues.length).toBeGreaterThan(0);
  });

  it('a very long line made of # and line separators is read in one pass (no regex over the line)', () => {
    const line = 'Disallow: /x' + '#\r  '.repeat(50_000);
    expect(() => validateRobotsTxt(`User-agent: *\n${line}\n`)).not.toThrow();
  });

  it('the comment is cut with indexOf, not a backtracking-prone regex', () => {
    const src = readFileSync(new URL('./robots.ts', import.meta.url), 'utf8');
    const fn = src.slice(src.indexOf('export function validateRobotsTxt'));
    expect(fn.slice(0, fn.indexOf('\n}\n'))).not.toMatch(/\.replace\(\/#\.\*\$\//);
  });
});
