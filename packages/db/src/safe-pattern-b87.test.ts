import { describe, expect, it } from 'vitest';
import { unsafePatternReason } from './index.js';

describe('unsafePatternReason (B87)', () => {
  it.each(['(a+)+', '(.*)*x', '(x{2,})+', '(/[^x]+)+', '((a)+b)+', '(?:a|b+)+'])(
    'refuses %s: a repeat inside a repeated group',
    (p) => expect(unsafePatternReason(p, 1000)).toBe('nested-quantifier'),
  );
  it.each(['(/page/\\d+)+', '(?:/[a-z]+)*/x', '(\\.[a-z]+)+$', '/search/', 'go-to-comment', '/login', '(ab)+', 'a+b*'])(
    'accepts %s',
    (p) => expect(unsafePatternReason(p, 1000)).toBeNull(),
  );
  it('caps the length', () => {
    const list = (n: number) => Array.from({ length: n }, (_, i) => `/p${i}/`).join('|');
    expect(list(150).length).toBeLessThan(1000);
    expect(unsafePatternReason(list(150), 1000)).toBeNull();
    expect(unsafePatternReason('x'.repeat(1001), 1000)).toBe('too-long');
    expect(unsafePatternReason('x'.repeat(201), 200)).toBe('too-long');
  });
});
