import { describe, expect, it } from 'vitest';
import { validateRobotsTxt } from './robots.js';

/*
 * B178: the `User-agent:` mid-token wildcard warning used /[*$].*[^*$]/,
 * which backtracks quadratically on a value of `$` (or `*`) characters.
 * The reference below is the old regex; the public validator must agree with
 * it on every small input and stay linear on a RFC 9309 sized file.
 */
const OLD_RE = /[*$].*[^*$]/;
const WARNING = 'User-agent wildcards are only widely supported';

function warnsFor(value: string): boolean {
  return validateRobotsTxt(`User-agent: ${value}`).some((i) => i.message.startsWith(WARNING));
}

describe('validateRobotsTxt User-agent wildcard warning (B178)', () => {
  const cases = [
    '',
    '*',
    '$',
    '**',
    '*$',
    '$*',
    '$$$',
    '$a',
    'a$',
    'a*',
    '*a',
    '*a$',
    'a*b',
    'foo*bar',
    'Googlebot',
    'Googlebot*',
    '*$a',
    '$*a*',
    '*$*$*$',
    'a b*c',
    'ünï*cödé',
    'бот*',
    '*бот',
    '日本*語',
    '😀*😀',
    '*😀',
    '😀*',
  ];

  it.each(cases)('agrees with the old regex on %j', (value) => {
    // The validator trims the value and treats a lone `*` as fine.
    const trimmed = value.trim();
    const expected = trimmed !== '' && OLD_RE.test(trimmed) && trimmed !== '*';
    expect(warnsFor(value)).toBe(expected);
  });

  it('stays linear on a 500 KB robots.txt of adversarial User-agent lines', { timeout: 20_000 }, () => {
    const line = `User-agent: ${'$'.repeat(50_000)}\n`;
    const text = line.repeat(10); // ~500 KB
    expect(text.length).toBeGreaterThan(500_000);
    const t0 = performance.now();
    const issues = validateRobotsTxt(text);
    const ms = performance.now() - t0;
    expect(issues.some((i) => i.message.startsWith(WARNING))).toBe(false);
    expect(ms).toBeLessThan(50);
  });

  it('stays fast on one 50 000 char adversarial value (red step size)', { timeout: 60_000 }, () => {
    const t0 = performance.now();
    validateRobotsTxt(`User-agent: ${'*$'.repeat(25_000)}`);
    expect(performance.now() - t0).toBeLessThan(50);
  });
});
