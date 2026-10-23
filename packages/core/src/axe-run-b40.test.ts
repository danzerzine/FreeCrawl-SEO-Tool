import { describe, expect, it } from 'vitest';
import { AXE_PROBE_MS, AXE_RUN_MS, loadAxeSource } from './axe-run.js';

describe('loadAxeSource (B40 R3)', () => {
  it('reads the unmodified axe-core build from the npm package once and caches it', () => {
    const a = loadAxeSource();
    expect(a).not.toBeNull();
    expect(a!.length).toBeGreaterThan(400_000);
    expect(a).toContain('axe.run');
    expect(loadAxeSource()).toBe(a);
  });

  it('answers null, never throws, when the package cannot be found or read', () => {
    expect(loadAxeSource(() => { throw new Error('Cannot find module'); })).toBeNull();
    expect(loadAxeSource(() => '/nonexistent/axe.min.js')).toBeNull();
  });

  it('has the documented time budget', () => {
    expect(AXE_RUN_MS).toBe(10_000);
    expect(AXE_PROBE_MS).toBe(2_000);
  });
});
